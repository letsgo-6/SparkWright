// SPDX-License-Identifier: MPL-2.0
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db, nowIso } from './db'
import { permissionError, requireAdmin } from './permissions'
import { createOriginGuard, pagination, requireEmptyBody, requireId } from './request-validation'
import { safeActionUrl } from '../shared/links'

interface AnnouncementRow {
  id: number; title: string; content: string; status: 'draft' | 'published'
  action_label: string | null; action_url: string | null; created_by: number
  created_at: string; updated_at: string; published_at: string | null
}

function announcementBody(body: unknown, previous?: AnnouncementRow) {
  const allowed = ['title', 'content', 'action_label', 'action_url']
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length || Object.keys(body).some((key) => !allowed.includes(key))) {
    throw permissionError(400, 'invalid_announcement', '公告只接受标题、正文及动作字段')
  }
  const values = body as Record<string, unknown>
  const title = values.title === undefined ? previous?.title : typeof values.title === 'string' ? values.title.trim() : null
  const content = values.content === undefined ? previous?.content : typeof values.content === 'string' ? values.content.trim() : null
  if (!title || title.length > 120 || !content || content.length > 10000) {
    throw permissionError(400, 'invalid_announcement', '标题须为 1–120 字，纯文本正文须为 1–10000 字')
  }
  const actionLabel = values.action_label === undefined ? previous?.action_label ?? null : values.action_label
  const actionUrl = values.action_url === undefined ? previous?.action_url ?? null : values.action_url
  const emptyLabel = actionLabel === null || actionLabel === ''
  const emptyUrl = actionUrl === null || actionUrl === ''
  if (emptyLabel && emptyUrl) return { title, content, actionLabel: null, actionUrl: null }
  const safe = safeActionUrl(actionUrl)
  if (typeof actionLabel !== 'string' || !actionLabel.trim() || actionLabel.trim().length > 80 || !safe) {
    throw permissionError(400, 'invalid_action', '按钮文字与安全链接须同时填写；仅支持 HTTPS 外链或站内根路径')
  }
  return { title, content, actionLabel: actionLabel.trim(), actionUrl: safe }
}

export function registerNoticeRoutes(app: FastifyInstance, ensureFollowups: (userId: number) => void): void {
  const requireOrigin = createOriginGuard()
  const userId = (req: FastifyRequest) => req.authUser!.id
  const getAnnouncement = (id: number, publishedOnly = false) => {
    const row = db.prepare(`SELECT * FROM announcements WHERE id = ?${publishedOnly ? " AND status = 'published'" : ''}`).get(id) as AnnouncementRow | undefined
    if (!row) throw permissionError(404, 'announcement_not_found', '公告不存在或已撤下')
    return row
  }
  const managerWrite = (req: FastifyRequest) => { requireAdmin(req); requireOrigin(req) }

  app.get('/api/notification-summary', async (req) => {
    const id = userId(req)
    return db.transaction(() => {
      ensureFollowups(id)
      const notifications = db.prepare('SELECT count(*) n FROM notifications WHERE user_id = ? AND read = 0').get(id) as { n: number }
      const announcements = db.prepare(`SELECT count(*) n FROM announcements a WHERE status = 'published' AND NOT EXISTS
        (SELECT 1 FROM announcement_reads r WHERE r.announcement_id = a.id AND r.user_id = ?)`).get(id) as { n: number }
      return { notifications_unread: notifications.n, announcements_unread: announcements.n, total_unread: notifications.n + announcements.n }
    }).immediate()
  })

  app.post<{ Params: { id: string } }>('/api/notifications/:id/read', async (req) => {
    requireEmptyBody(req.body)
    const id = requireId(req.params.id)
    const row = db.prepare('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?').run(id, userId(req))
    if (!row.changes) throw permissionError(404, 'notification_not_found', '通知不存在或不可访问')
    return { ok: true }
  })

  app.get<{ Querystring: Record<string, unknown> }>('/api/announcements', async (req) => {
    const { page, pageSize, offset } = pagination(req.query)
    const rows = db.prepare(`SELECT a.*, EXISTS (SELECT 1 FROM announcement_reads r WHERE r.announcement_id = a.id AND r.user_id = ?) AS is_read
      FROM announcements a WHERE status = 'published' ORDER BY published_at DESC, id DESC LIMIT ? OFFSET ?`).all(userId(req), pageSize, offset) as (AnnouncementRow & { is_read: number })[]
    const { total } = db.prepare("SELECT count(*) total FROM announcements WHERE status = 'published'").get() as { total: number }
    return { items: rows.map((row) => ({ ...row, is_read: Boolean(row.is_read) })), page, pageSize, total }
  })
  app.get<{ Params: { id: string } }>('/api/announcements/:id', async (req) => {
    const row = getAnnouncement(requireId(req.params.id), true)
    const read = db.prepare('SELECT 1 FROM announcement_reads WHERE announcement_id = ? AND user_id = ?').get(row.id, userId(req))
    return { ...row, is_read: Boolean(read) }
  })
  app.post<{ Params: { id: string } }>('/api/announcements/:id/read', async (req) => {
    requireEmptyBody(req.body)
    return db.transaction(() => {
      const row = getAnnouncement(requireId(req.params.id), true)
      db.prepare('INSERT INTO announcement_reads (announcement_id, user_id, read_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(row.id, userId(req), nowIso())
      return { ok: true }
    }).immediate()
  })
  app.post('/api/announcements/read-all', async (req) => {
    requireEmptyBody(req.body)
    db.prepare(`INSERT INTO announcement_reads (announcement_id, user_id, read_at)
      SELECT id, ?, ? FROM announcements WHERE status = 'published' ON CONFLICT DO NOTHING`).run(userId(req), nowIso())
    return { ok: true }
  })

  app.get<{ Querystring: Record<string, unknown> }>('/api/admin/announcements', async (req) => {
    requireAdmin(req)
    const { page, pageSize, offset } = pagination(req.query)
    const items = db.prepare('SELECT * FROM announcements ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?').all(pageSize, offset)
    const { total } = db.prepare('SELECT count(*) total FROM announcements').get() as { total: number }
    return { items, page, pageSize, total }
  })
  app.post('/api/admin/announcements', async (req) => {
    managerWrite(req)
    const values = announcementBody(req.body)
    return db.transaction(() => {
      requireAdmin(req)
      const now = nowIso()
      const insert = db.prepare('INSERT INTO announcements (title, content, action_label, action_url, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(values.title, values.content, values.actionLabel, values.actionUrl, userId(req), now, now)
      return getAnnouncement(Number(insert.lastInsertRowid))
    }).immediate()
  })
  app.patch<{ Params: { id: string } }>('/api/admin/announcements/:id', async (req) => {
    managerWrite(req)
    const id = requireId(req.params.id)
    return db.transaction(() => {
      requireAdmin(req)
      const values = announcementBody(req.body, getAnnouncement(id))
      db.prepare('UPDATE announcements SET title = ?, content = ?, action_label = ?, action_url = ?, updated_at = ? WHERE id = ?')
        .run(values.title, values.content, values.actionLabel, values.actionUrl, nowIso(), id)
      return getAnnouncement(id)
    }).immediate()
  })
  for (const action of ['publish', 'unpublish'] as const) {
    app.post<{ Params: { id: string } }>(`/api/admin/announcements/:id/${action}`, async (req) => {
      managerWrite(req)
      requireEmptyBody(req.body)
      const id = requireId(req.params.id)
      return db.transaction(() => {
        requireAdmin(req)
        const row = getAnnouncement(id)
        const status = action === 'publish' ? 'published' : 'draft'
        if (row.status !== status) db.prepare('UPDATE announcements SET status = ?, published_at = ?, updated_at = ? WHERE id = ?')
          .run(status, status === 'published' ? nowIso() : null, nowIso(), id)
        return getAnnouncement(id)
      }).immediate()
    })
  }
}
