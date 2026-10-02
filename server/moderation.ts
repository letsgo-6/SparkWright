// SPDX-License-Identifier: MPL-2.0
import type { FastifyInstance } from 'fastify'
import { db, nowIso } from './db'
import { permissionError, requireOwner } from './permissions'
import { createOriginGuard, pagination, requireEmptyBody, requireId } from './request-validation'
import type { ChannelPresence } from './presence'

type Body = Record<string, unknown>

function objectBody(value: unknown, keys: string[]): Body {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some((key) => !keys.includes(key))) {
    throw permissionError(400, 'invalid_body', '请求字段不合法')
  }
  return value as Body
}

export function requirePlazaWrite(userId: number): void {
  const row = db.prepare('SELECT plaza_muted_at FROM users WHERE id = ?').get(userId) as { plaza_muted_at: string | null } | undefined
  if (row?.plaza_muted_at) throw permissionError(403, 'plaza_muted', '账号已被禁言')
}

export function registerModerationRoutes(app: FastifyInstance, presence: ChannelPresence): void {
  const origin = createOriginGuard()
  const managedChannelWhere = "(c.type = 'public' OR (c.type = 'idea' AND (i.user_id = ? OR (i.is_public = 1 AND i.plaza_removed_at IS NULL))))"
  const managedChannel = (id: number, ownerId: number) => {
    const channel = db.prepare(`SELECT c.* FROM channels c LEFT JOIN ideas i ON i.id = c.idea_id
      WHERE ${managedChannelWhere} AND c.id = ?`).get(ownerId, id) as { archived_at: string | null } | undefined
    if (!channel) throw permissionError(404, 'channel_not_found', '频道不存在或不可访问')
    return channel
  }

  app.get<{ Querystring: Record<string, unknown> }>('/api/admin/plaza/ideas', async (req) => {
    requireOwner(req)
    const { page, pageSize, offset } = pagination(Object.fromEntries(Object.entries(req.query).filter(([key]) => key !== 'status')))
    const status = req.query.status
    if (status !== 'active' && status !== 'removed') throw permissionError(400, 'invalid_status', 'status 必须是 active 或 removed')
    const where = status === 'active' ? 'i.is_public = 1 AND i.plaza_removed_at IS NULL' : 'i.plaza_removed_at IS NOT NULL'
    const items = db.prepare(`SELECT i.id, i.user_id, u.name AS author, i.title, i.public_summary, i.tags,
      i.created_at, i.plaza_removed_at, i.plaza_removed_by, i.plaza_remove_reason
      FROM ideas i JOIN users u ON u.id = i.user_id WHERE ${where} ORDER BY i.id DESC LIMIT ? OFFSET ?`).all(pageSize, offset)
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM ideas i WHERE ${where}`).get() as { n: number }).n
    return { items, total, page, pageSize }
  })

  app.post<{ Params: { id: string }; Body: unknown }>('/api/admin/plaza/ideas/:id/remove', async (req) => {
    requireOwner(req); origin(req)
    const id = requireId(req.params.id)
    const body = objectBody(req.body ?? {}, ['reason'])
    if (body.reason !== undefined && (typeof body.reason !== 'string' || body.reason.trim().length > 500))
      throw permissionError(400, 'invalid_reason', '原因不能超过 500 字')
    return db.transaction(() => {
      const owner = requireOwner(req)
      const idea = db.prepare('SELECT id, is_public, plaza_removed_at FROM ideas WHERE id = ?').get(id) as
        { id: number; is_public: number; plaza_removed_at: string | null } | undefined
      if (!idea || (!idea.is_public && !idea.plaza_removed_at)) throw permissionError(404, 'public_idea_not_found', '公开灵感不存在')
      if (idea.plaza_removed_at) throw permissionError(409, 'already_removed', '灵感已下架')
      db.prepare('UPDATE ideas SET is_public = 0, plaza_removed_at = ?, plaza_removed_by = ?, plaza_remove_reason = ? WHERE id = ?')
        .run(nowIso(), owner.id, (body.reason as string | undefined)?.trim() || null, id)
      for (const channel of db.prepare('SELECT id FROM channels WHERE idea_id = ?').all(id) as { id: number }[]) presence.clear(channel.id)
      return { ok: true }
    }).immediate()
  })

  app.post<{ Params: { id: string }; Body: unknown }>('/api/admin/plaza/ideas/:id/restore', async (req) => {
    requireOwner(req); origin(req); requireEmptyBody(req.body)
    const id = requireId(req.params.id)
    return db.transaction(() => {
      requireOwner(req)
      const idea = db.prepare('SELECT plaza_removed_at FROM ideas WHERE id = ?').get(id) as { plaza_removed_at: string | null } | undefined
      if (!idea) throw permissionError(404, 'idea_not_found', '灵感不存在')
      if (!idea.plaza_removed_at) throw permissionError(409, 'not_removed', '灵感未下架')
      db.prepare('UPDATE ideas SET is_public = 1, plaza_removed_at = NULL, plaza_removed_by = NULL, plaza_remove_reason = NULL WHERE id = ?').run(id)
      return { ok: true }
    }).immediate()
  })

  app.get<{ Querystring: Record<string, unknown> }>('/api/admin/moderation/users', async (req) => {
    requireOwner(req)
    const { page, pageSize, offset } = pagination(req.query)
    const items = db.prepare('SELECT id, name, role, plaza_muted_at, plaza_mute_reason FROM users ORDER BY id LIMIT ? OFFSET ?').all(pageSize, offset)
    const total = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n
    return { items, total, page, pageSize }
  })

  app.patch<{ Params: { id: string }; Body: unknown }>('/api/admin/users/:id/mute', async (req) => {
    requireOwner(req); origin(req)
    const id = requireId(req.params.id)
    const body = objectBody(req.body, ['muted', 'reason'])
    if (typeof body.muted !== 'boolean' || (body.reason !== undefined &&
      (typeof body.reason !== 'string' || body.reason.trim().length > 500)))
      throw permissionError(400, 'invalid_mute_request', '需要 muted 布尔值和可选原因')
    return db.transaction(() => {
      requireOwner(req)
      const target = db.prepare('SELECT id, role FROM users WHERE id = ?').get(id) as { id: number; role: string } | undefined
      if (!target) throw permissionError(404, 'user_not_found', '用户不存在')
      if (target.role === 'owner') throw permissionError(409, 'owner_mute_forbidden', '不能禁言 owner')
      db.prepare('UPDATE users SET plaza_muted_at = ?, plaza_mute_reason = ? WHERE id = ?')
        .run(body.muted ? nowIso() : null, body.muted ? (body.reason as string | undefined)?.trim() || null : null, id)
      if (body.muted) presence.leaveAll(id)
      return db.prepare('SELECT id, name, role, plaza_muted_at, plaza_mute_reason FROM users WHERE id = ?').get(id)
    }).immediate()
  })

  app.get<{ Querystring: Record<string, unknown> }>('/api/admin/channels', async (req) => {
    const owner = requireOwner(req)
    const type = req.query.type ?? 'public'
    if (type !== 'public' && type !== 'idea') throw permissionError(400, 'invalid_channel_type', '频道类型必须是 public 或 idea')
    const { page, pageSize, offset } = pagination(Object.fromEntries(Object.entries(req.query).filter(([key]) => key !== 'type')))
    const items = db.prepare(`SELECT c.*, i.title AS idea_title, i.user_id AS idea_owner_id,
      (SELECT COUNT(*) FROM messages m WHERE m.channel_id = c.id) AS message_count
      FROM channels c LEFT JOIN ideas i ON i.id = c.idea_id WHERE ${managedChannelWhere} AND c.type = ?
      ORDER BY c.id LIMIT ? OFFSET ?`).all(owner.id, type, pageSize, offset)
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM channels c LEFT JOIN ideas i ON i.id = c.idea_id
      WHERE ${managedChannelWhere} AND c.type = ?`).get(owner.id, type) as { n: number }).n
    return { items, total, page, pageSize }
  })

  app.patch<{ Params: { id: string }; Body: unknown }>('/api/admin/channels/:id', async (req) => {
    requireOwner(req); origin(req)
    const id = requireId(req.params.id)
    const body = objectBody(req.body, ['name'])
    const name = body.name
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 100)
      throw permissionError(400, 'invalid_channel_name', '频道名需为 1–100 字')
    return db.transaction(() => {
      managedChannel(id, requireOwner(req).id)
      db.prepare('UPDATE channels SET name = ? WHERE id = ?').run(name.trim(), id)
      return db.prepare('SELECT * FROM channels WHERE id = ?').get(id)
    }).immediate()
  })

  app.delete<{ Params: { id: string }; Body: unknown }>('/api/admin/channels/:id', async (req) => {
    requireOwner(req); origin(req); requireEmptyBody(req.body)
    const id = requireId(req.params.id)
    return db.transaction(() => {
      const channel = managedChannel(id, requireOwner(req).id)
      if (channel.archived_at) throw permissionError(409, 'already_archived', '频道已归档')
      db.prepare('UPDATE channels SET archived_at = ? WHERE id = ?').run(nowIso(), id)
      presence.clear(id)
      return { ok: true }
    }).immediate()
  })

  app.post<{ Params: { id: string }; Body: unknown }>('/api/admin/channels/:id/restore', async (req) => {
    requireOwner(req); origin(req); requireEmptyBody(req.body)
    const id = requireId(req.params.id)
    return db.transaction(() => {
      const channel = managedChannel(id, requireOwner(req).id)
      if (!channel.archived_at) throw permissionError(409, 'not_archived', '频道未归档')
      db.prepare('UPDATE channels SET archived_at = NULL WHERE id = ?').run(id)
      return { ok: true }
    }).immediate()
  })
}
