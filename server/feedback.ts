// SPDX-License-Identifier: MPL-2.0
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { createHash } from 'node:crypto'
import { db } from './db'
import { permissionError, requireAuth, requireAdmin } from './permissions'
import { createOriginGuard, featurePagination, positiveInteger, requireId } from './request-validation'

type Row = Record<string, any>
const categories = ['bug', 'suggestion', 'question']
const statuses = ['new', 'in_progress', 'resolved', 'closed']
const transitions: Record<string, string[]> = { new: ['in_progress','closed'], in_progress: ['resolved','closed'], resolved: ['closed','in_progress'], closed: ['in_progress'] }
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value)
const fields = 'f.id, f.user_id, f.category, f.title, f.status, f.version, f.created_at, f.updated_at, f.closed_at'
const plain = (value: unknown, min: number, max: number): string => {
  if (typeof value !== 'string' || [...value.trim()].length < min || [...value.trim()].length > max)
    throw permissionError(400, 'invalid_feedback_input', '反馈内容长度不合法')
  return value.trim()
}
function input(req: FastifyRequest, allowed: string[]): Row {
  const body = req.body
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some((key) => !allowed.includes(key)))
    throw permissionError(400, 'invalid_feedback_input', '反馈参数不合法')
  return body as Row
}
function pathValue(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null
  if (typeof value !== 'string' || value.length > 200 || !/^\/(?:$|(?:ideas|plaza|dev|orders|media|studio|wishes|consult|settings|synthesis|channels|feedback)(?:\/[A-Za-z0-9_-]+)*)$/.test(value))
    throw permissionError(400, 'invalid_feedback_input', '页面路径不合法')
  return value
}
function ownFeedback(id: number, userId: number): Row {
  const row = db.prepare('SELECT * FROM user_feedback WHERE id=? AND user_id=?').get(id, userId) as Row | undefined
  if (!row) throw permissionError(404, 'feedback_not_found', '反馈不存在或不可访问')
  return row
}
function summary(row: Row) {
  return { id: row.id, user_id: row.user_id, category: row.category, title: row.title, status: row.status,
    version: row.version, created_at: row.created_at, updated_at: row.updated_at, closed_at: row.closed_at }
}
function rateLimit(retry: number): never {
  throw Object.assign(permissionError(429, 'feedback_rate_limited', '提交过于频繁，请稍后重试'), { retryAfter: Math.max(1, Math.ceil(retry)) })
}
function notify(userId: number, type: string, feedbackId: number, actorId: number, content: string, time: string): void {
  db.prepare('INSERT INTO notifications (user_id,type,ref_id,actor_id,content,created_at) VALUES (?,?,?,?,?,?)').run(userId, type, feedbackId, actorId, content, time)
}

export class FeedbackService {
  private readonly ips = new Map<string, { start: number; count: number }>()
  constructor(private readonly clock = () => Date.now()) {}

  create(req: FastifyRequest) {
    const user = requireAuth(req)
    const body = input(req, ['category','title','content','page_path','request_id'])
    if (!categories.includes(body.category) || !uuid(body.request_id)) throw permissionError(400, 'invalid_feedback_input', '类型或请求编号不合法')
    const title = plain(body.title, 1, 80), content = plain(body.content, 10, 5000), page = pathValue(body.page_path)
    const hash = createHash('sha256').update(JSON.stringify([body.category,title,content])).digest('hex')
    const now = this.clock(), time = new Date(now).toISOString()
    return db.transaction(() => {
      requireAuth(req)
      const replay = db.prepare('SELECT * FROM user_feedback WHERE user_id=? AND request_id=?').get(user.id, body.request_id) as Row | undefined
      if (replay) {
        if (replay.content_hash !== hash || replay.page_path !== page) throw permissionError(409, 'feedback_request_conflict', '请求编号已被不同内容使用')
        return { feedback: summary(replay), created: false }
      }
      const duplicate = db.prepare('SELECT id FROM user_feedback WHERE user_id=? AND content_hash=? AND created_at > ? ORDER BY id DESC LIMIT 1')
        .get(user.id, hash, new Date(now - 600000).toISOString()) as { id: number } | undefined
      if (duplicate) throw Object.assign(permissionError(409, 'feedback_duplicate', '你已提交相同反馈'), { feedback_id: duplicate.id })
      const recent = db.prepare('SELECT created_at FROM user_feedback WHERE user_id=? AND created_at > ? ORDER BY created_at ASC')
        .all(user.id, new Date(now - 86400000).toISOString()) as { created_at: string }[]
      if (recent.length >= 10) rateLimit((Date.parse(recent[0].created_at) + 86400000 - now) / 1000)
      const last = recent.at(-1)
      if (last && now - Date.parse(last.created_at) < 60000) rateLimit((Date.parse(last.created_at) + 60000 - now) / 1000)
      for (const [ip, counter] of this.ips) if (counter.start <= now - 3600000) this.ips.delete(ip)
      const ip = this.ips.get(req.ip) || { start: now, count: 0 }
      if (ip.count >= 30) rateLimit((ip.start + 3600000 - now) / 1000)
      if (this.ips.size >= 20000 && !this.ips.has(req.ip)) rateLimit(60)
      const id = Number(db.prepare('INSERT INTO user_feedback (user_id,category,title,content,page_path,request_id,content_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)')
        .run(user.id, body.category, title, content, page, body.request_id, hash, time, time).lastInsertRowid)
      const owners = db.prepare("SELECT id FROM users WHERE role='owner'").all() as { id: number }[]
      for (const owner of owners) notify(owner.id, 'feedback_new', id, user.id, '收到新的用户反馈', time)
      this.ips.set(req.ip, { ...ip, count: ip.count + 1 })
      return { feedback: summary(ownFeedback(id, user.id)), created: true }
    }).immediate()
  }

  change(req: FastifyRequest, kind: 'status' | 'internal_note' | 'public_reply') {
    const manager = requireAdmin(req), id = requireId((req.params as { id: string }).id)
    const body = input(req, kind === 'status' ? ['status','version','request_id'] : ['content','version','request_id'])
    if (!uuid(body.request_id) || !Number.isSafeInteger(body.version) || body.version < 1 ||
      (kind === 'status' && !statuses.includes(body.status))) throw permissionError(400, 'invalid_feedback_input', '状态或版本参数不合法')
    const content = kind === 'status' ? '' : plain(body.content, 1, 2000)
    const now = this.clock(), time = new Date(now).toISOString()
    return db.transaction(() => {
      requireAdmin(req)
      const feedback = db.prepare('SELECT * FROM user_feedback WHERE id=?').get(id) as Row | undefined
      if (!feedback) throw permissionError(404, 'feedback_not_found', '反馈不存在')
      const replay = db.prepare('SELECT * FROM feedback_events WHERE feedback_id=? AND request_id=?').get(id, body.request_id) as Row | undefined
      if (replay) {
        if (replay.actor_id !== manager.id || replay.kind !== kind || replay.content !== content || (kind === 'status' && replay.to_status !== body.status))
          throw permissionError(409, 'feedback_request_conflict', '请求编号已被不同内容使用')
        return { feedback: summary(feedback), created: false }
      }
      if (feedback.version !== body.version) throw permissionError(409, 'feedback_version_conflict', '反馈已被更新，请刷新')
      if (kind === 'status' && feedback.status !== body.status && !transitions[feedback.status].includes(body.status))
        throw permissionError(400, 'invalid_feedback_transition', '状态变更不合法')
      const events = db.prepare('SELECT COUNT(*) n, MIN(created_at) oldest FROM feedback_events WHERE actor_id=? AND created_at > ?')
        .get(manager.id, new Date(now - 60000).toISOString()) as { n: number; oldest: string | null }
      if (events.n >= 30) rateLimit((Date.parse(events.oldest!) + 60000 - now) / 1000)
      db.prepare('INSERT INTO feedback_events (feedback_id,actor_id,kind,content,from_status,to_status,request_id,created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, manager.id, kind, content, kind === 'status' ? feedback.status : null, kind === 'status' ? body.status : null, body.request_id, time)
      const nextStatus = kind === 'status' ? body.status : feedback.status
      db.prepare('UPDATE user_feedback SET status=?,version=version+1,updated_at=?,closed_at=? WHERE id=?')
        .run(nextStatus, time, nextStatus === 'closed' ? feedback.closed_at || time : null, id)
      if (kind === 'public_reply') notify(feedback.user_id, 'feedback_reply', id, manager.id, '管理员回复了你的反馈', time)
      if (kind === 'status' && feedback.status !== nextStatus) notify(feedback.user_id, 'feedback_status', id, manager.id, '你的反馈状态已更新', time)
      return { feedback: summary(db.prepare('SELECT * FROM user_feedback WHERE id=?').get(id) as Row), created: true }
    }).immediate()
  }
}

export function registerFeedbackRoutes(app: FastifyInstance, activity: (userId: number) => void): void {
  const origin = createOriginGuard(), service = new FeedbackService()
  app.post('/api/feedback', { bodyLimit: 65536 }, async (req, reply) => {
    origin(req)
    const result = service.create(req)
    reply.header('Cache-Control','no-store').code(result.created ? 201 : 200)
    if (result.created) activity(req.authUser!.id)
    return result
  })
  app.get<{ Querystring: Record<string, unknown> }>('/api/feedback', async (req, reply) => {
    const user = requireAuth(req), page = featurePagination(req.query)
    reply.header('Cache-Control','no-store')
    return db.transaction(() => ({ items: db.prepare(`SELECT ${fields} FROM user_feedback f WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`).all(user.id,page.pageSize,page.offset),
      total: (db.prepare('SELECT COUNT(*) n FROM user_feedback WHERE user_id=?').get(user.id) as { n: number }).n, ...page })).deferred()
  })
  app.get<{ Querystring: Record<string, unknown> }>('/api/admin/feedback', async (req, reply) => {
    requireAdmin(req)
    const page = featurePagination(req.query, ['status','category','userId','q']), where: string[] = [], values: unknown[] = []
    for (const key of ['status','category'] as const) if (req.query[key] !== undefined) {
      if (!(key === 'status' ? statuses : categories).includes(req.query[key] as string)) throw permissionError(400,'invalid_feedback_input','筛选参数不合法')
      where.push(`f.${key}=?`); values.push(req.query[key])
    }
    if (req.query.userId !== undefined) {
      const id = positiveInteger(req.query.userId)
      if (!id) throw permissionError(400,'invalid_feedback_input','用户ID不合法')
      where.push('f.user_id=?'); values.push(id)
    }
    if (req.query.q !== undefined) {
      const q = plain(req.query.q,1,100).replace(/[\\%_]/g,'\\$&')
      where.push("(f.title LIKE ? ESCAPE '\\' OR f.content LIKE ? ESCAPE '\\')"); values.push(`%${q}%`,`%${q}%`)
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
    reply.header('Cache-Control','no-store')
    return db.transaction(() => ({ items: db.prepare(`SELECT ${fields},u.name author FROM user_feedback f JOIN users u ON u.id=f.user_id ${clause} ORDER BY f.updated_at DESC,f.id DESC LIMIT ? OFFSET ?`).all(...values,page.pageSize,page.offset),
      total: (db.prepare(`SELECT COUNT(*) n FROM user_feedback f ${clause}`).get(...values) as { n: number }).n,
      new_total: (db.prepare("SELECT COUNT(*) n FROM user_feedback WHERE status='new'").get() as { n: number }).n, ...page })).deferred()
  })
  for (const admin of [false,true]) {
    const prefix = admin ? '/api/admin/feedback' : '/api/feedback'
    app.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>(`${prefix}/:id`, async (req, reply) => {
      const user = admin ? requireAdmin(req) : requireAuth(req), id = requireId(req.params.id)
      if (Object.keys(req.query).length) throw permissionError(400,'invalid_query','不接受额外参数')
      const row = admin ? db.prepare('SELECT f.*,u.name author FROM user_feedback f JOIN users u ON u.id=f.user_id WHERE f.id=?').get(id) as Row | undefined : ownFeedback(id,user.id)
      if (!row) throw permissionError(404,'feedback_not_found','反馈不存在')
      reply.header('Cache-Control','no-store')
      return { ...summary(row), content: row.content, page_path: row.page_path, ...(admin ? { author: row.author } : {}) }
    })
    app.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>(`${prefix}/:id/events`, async (req, reply) => {
      const user = admin ? requireAdmin(req) : requireAuth(req), id = requireId(req.params.id), page = featurePagination(req.query)
      if (!admin) ownFeedback(id,user.id)
      else if (!db.prepare('SELECT id FROM user_feedback WHERE id=?').get(id)) throw permissionError(404,'feedback_not_found','反馈不存在')
      const visibility = admin ? '' : "AND e.kind != 'internal_note' AND (e.kind != 'status' OR e.from_status != e.to_status)"
      reply.header('Cache-Control','no-store')
      return db.transaction(() => ({ items: db.prepare(`SELECT e.id,e.kind,e.content,e.from_status,e.to_status,e.created_at${admin ? ', e.actor_id,u.name actor' : ''}
        FROM feedback_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.feedback_id=? ${visibility} ORDER BY e.id DESC LIMIT ? OFFSET ?`).all(id,page.pageSize,page.offset),
        total: (db.prepare(`SELECT COUNT(*) n FROM feedback_events e WHERE e.feedback_id=? ${visibility}`).get(id) as { n: number }).n, ...page })).deferred()
    })
  }
  for (const [suffix,kind,method] of [['status','status','PATCH'],['notes','internal_note','POST'],['replies','public_reply','POST']] as const)
    app.route({ method, url: `/api/admin/feedback/:id/${suffix}`, bodyLimit: 65536, handler: async (req,reply) => {
      origin(req); reply.header('Cache-Control','no-store')
      return service.change(req,kind)
    } })
}
