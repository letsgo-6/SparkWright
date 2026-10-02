// SPDX-License-Identifier: MPL-2.0
import type { FastifyInstance } from 'fastify'
import { db } from './db'
import { findUser, permissionError, requireAdmin, requireOwner, SAFE_USER_FIELDS, type AuthUser } from './permissions'
import { isRole } from './roles'
import { createOriginGuard, positiveInteger } from './request-validation'
import { readFileSync } from 'node:fs'

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }

export function registerAdminRoutes(app: FastifyInstance): void {
  const requireOrigin = createOriginGuard()
  app.get<{ Querystring: Record<string, unknown> }>('/api/admin/system', async (req, reply) => {
    requireAdmin(req)
    if (Object.keys(req.query).length) throw permissionError(400, 'invalid_query', '系统概览不接受额外参数')
    reply.header('Cache-Control', 'no-store')
    return db.transaction(() => {
      const { total } = db.prepare('SELECT count(*) AS total FROM users').get() as { total: number }
      const counts = db.prepare("SELECT count(*) AS total, count(CASE WHEN status = 'published' THEN 1 END) AS published FROM announcements").get() as { total: number; published: number }
      return { status: 'ok', version, uptime_seconds: Math.floor(process.uptime()), database: 'ok', users_total: total,
        announcements: { published: counts.published, draft: counts.total - counts.published } }
    })()
  })
  app.get<{ Querystring: { page?: string; pageSize?: string } }>('/api/admin/users', async (req) => {
    requireAdmin(req)
    const page = req.query.page === undefined ? 1 : positiveInteger(req.query.page, 1_000_000)
    const pageSize = req.query.pageSize === undefined ? 20 : positiveInteger(req.query.pageSize, 100)
    if (!page || !pageSize || Object.keys(req.query).some((key) => key !== 'page' && key !== 'pageSize')) {
      throw permissionError(400, 'invalid_pagination', 'page 必须为 1–1000000 的整数，pageSize 必须为 1–100 的整数')
    }
    const items = db.prepare(`SELECT ${SAFE_USER_FIELDS} FROM users ORDER BY id ASC LIMIT ? OFFSET ?`).all(pageSize, (page - 1) * pageSize) as AuthUser[]
    if (items.some((user) => !isRole(user.role))) throw permissionError(500, 'invalid_role_data', '管理操作失败，请核验角色数据')
    const { total } = db.prepare('SELECT count(*) AS total FROM users').get() as { total: number }
    return { items, page, pageSize, total }
  })

  app.patch<{ Params: { id: string }; Body: unknown }>('/api/admin/users/:id/role', async (req) => {
    requireOwner(req)
    requireOrigin(req)
    const id = positiveInteger(req.params.id)
    const body = req.body
    if (!id || !body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || !('role' in body) || !isRole(body.role)) {
      throw permissionError(400, 'invalid_role_request', '需要合法用户 ID，且请求体只能包含 role（owner/admin/user）')
    }
    const role = body.role
    return db.transaction(() => {
      requireOwner(req) // Re-read authorization under the same write lock as the owner count and update.
      const target = findUser(id)
      if (!target) throw permissionError(404, 'user_not_found', '用户不存在或角色数据异常')
      const owners = db.prepare("SELECT count(*) AS n FROM users WHERE role = 'owner'").get() as { n: number }
      if (target.role === 'owner' && role !== 'owner' && owners.n <= 1) {
        throw permissionError(409, 'last_owner', '不能降级最后一个 owner')
      }
      db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, id)
      return findUser(id)!
    }).immediate()
  })
}
