// SPDX-License-Identifier: MPL-2.0
import type { FastifyRequest } from 'fastify'
import { db, nowIso } from './db'
import { findUser, permissionError, type AuthUser } from './permissions'

export function localWorkspace(): AuthUser {
  return db.transaction(() => {
    const users = db.prepare('SELECT id FROM users ORDER BY id LIMIT 2').all() as { id: number }[]
    if (users.length > 1) throw new Error('个人版数据库包含多个账号，不能自动选择工作区。请保留数据库备份并使用多人版打开。')
    const id = users[0]?.id ?? Number(db.prepare("INSERT INTO users (name,role,created_at) VALUES (?, 'owner', ?)").run('本地工作区', nowIso()).lastInsertRowid)
    const user = findUser(id)
    if (!user) throw new Error('本地工作区身份不可用，请检查数据库。')
    return user
  }).immediate()
}

export function requireLocalRequest(req: FastifyRequest): void {
  const address = req.ip
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)
    || !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(req.headers.host || '')) {
    throw permissionError(403, 'forbidden', '个人版仅允许本机访问')
  }
  if (req.headers.origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(req.headers.origin)) {
    throw permissionError(403, 'invalid_origin', '个人版不接受外部网站请求')
  }
}
