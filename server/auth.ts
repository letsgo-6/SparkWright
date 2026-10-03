// SPDX-License-Identifier: MPL-2.0
// 认证核心：移植自「起念」登录模块的思路（login00.md）
// - 密码只用 bcrypt 哈希存储
// - 会话为 JWT（HS256），放在 httpOnly Cookie 里
// - 邮箱统一小写去重
// 原实现基于 NextAuth v4（Next.js 专用）；SparkWright 是 Fastify + SQLite，
// 故 JWT 签发/校验用 node:crypto 手写等价实现，bcryptjs 与原模块一致。

import bcrypt from 'bcryptjs'
import crypto from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { PERSONAL_EDITION } from './edition'

const SECRET = process.env.AUTH_SECRET
if (!PERSONAL_EDITION && (!SECRET || SECRET.length < 32)) throw new Error('请设置至少 32 字符的 AUTH_SECRET；本地运行请先执行 npm run setup:local')
const COOKIE_NAME = 'ideabox_session'
const MAX_AGE = 60 * 60 * 24 * 7 // 7 天

export interface SessionUser {
  id: number
  name: string
}

const b64url = (input: string | Buffer) => Buffer.from(input).toString('base64url')
const hmac = (data: string) => {
  if (!SECRET || SECRET.length < 32) throw new Error('会话签发需要至少 32 字符的 AUTH_SECRET')
  return crypto.createHmac('sha256', SECRET).update(data).digest('base64url')
}

/** 签发 JWT（HS256）：header.payload.signature */
export function signToken(userId: number, name: string): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const now = Math.floor(Date.now() / 1000)
  const payload = b64url(JSON.stringify({ sub: userId, name, iat: now, exp: now + MAX_AGE }))
  return `${header}.${payload}.${hmac(`${header}.${payload}`)}`
}

/** 校验 JWT：签名 + 过期时间，通过返回会话用户，否则 null */
export function verifyToken(token: string): SessionUser | null {
  const parts = token.split('.')
  if (parts.length !== 3) return null
  const expected = hmac(`${parts[0]}.${parts[1]}`)
  const a = Buffer.from(expected)
  const b = Buffer.from(parts[2])
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf-8'))
    if (header.alg !== 'HS256') return null
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf-8'))
    if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null
    if (!Number.isSafeInteger(payload.sub) || payload.sub <= 0) return null
    return { id: payload.sub, name: String(payload.name || '') }
  } catch {
    return null
  }
}

function readCookie(req: FastifyRequest, name: string): string | null {
  const raw = req.headers.cookie
  if (!raw) return null
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    if (part.slice(0, idx).trim() === name) {
      try {
        return decodeURIComponent(part.slice(idx + 1).trim())
      } catch {
        return part.slice(idx + 1).trim()
      }
    }
  }
  return null
}

/** 从请求 Cookie 中解析出会话用户；未登录返回 null */
export function getSessionUser(req: FastifyRequest): SessionUser | null {
  const token = readCookie(req, COOKIE_NAME)
  return token ? verifyToken(token) : null
}

export function setAuthCookie(reply: FastifyReply, token: string): void {
  reply.header('set-cookie', `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${MAX_AGE}${process.env.AUTH_COOKIE_SECURE === 'true' ? '; Secure' : ''}`)
}

export function clearAuthCookie(reply: FastifyReply): void {
  reply.header('set-cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${process.env.AUTH_COOKIE_SECURE === 'true' ? '; Secure' : ''}`)
}

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 10)
}

export function comparePassword(password: string, hash: string): boolean {
  return bcrypt.compareSync(password, hash)
}
