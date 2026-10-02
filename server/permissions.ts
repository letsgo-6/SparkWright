// SPDX-License-Identifier: MPL-2.0
import type { FastifyRequest } from 'fastify'
import { getSessionUser } from './auth'
import { db } from './db'
import { isRole, type UserRole } from './roles'

export interface AuthUser {
  id: number
  name: string
  email: string | null
  role: UserRole
  created_at: string
}

declare module 'fastify' {
  interface FastifyRequest { authUser: AuthUser | null; activitySucceeded?: boolean }
}

export const SAFE_USER_FIELDS = 'id, name, email, role, created_at'
export function findUser(id: number): AuthUser | null {
  const user = db.prepare(`SELECT ${SAFE_USER_FIELDS} FROM users WHERE id = ?`).get(id) as AuthUser | undefined
  return user && isRole(user.role) ? user : null
}

export function currentUser(req: FastifyRequest): AuthUser | null {
  const identity = getSessionUser(req)
  return identity ? findUser(identity.id) : null
}

export function permissionError(statusCode: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { statusCode, code })
}

export function requireAuth(req: FastifyRequest): AuthUser {
  const user = currentUser(req)
  if (!user) throw permissionError(401, 'unauthorized', '登录状态已失效，请重新登录')
  req.authUser = user
  return user
}

export function requireAdmin(req: FastifyRequest): AuthUser {
  const user = requireAuth(req)
  if (user.role !== 'admin' && user.role !== 'owner') throw permissionError(403, 'forbidden', '需要管理员权限')
  return user
}

export function requireOwner(req: FastifyRequest): AuthUser {
  const user = requireAuth(req)
  if (user.role !== 'owner') throw permissionError(403, 'forbidden', '需要 owner 权限')
  return user
}
