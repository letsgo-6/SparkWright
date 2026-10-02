// SPDX-License-Identifier: MPL-2.0
import { createHmac, randomInt, randomUUID, timingSafeEqual } from 'node:crypto'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { db } from './db'
import { hashPassword, setAuthCookie, signToken } from './auth'
import { findUser, permissionError } from './permissions'
import { emailAccountId, normalizeEmail, validEmail } from './email-identity'
import { createRegistrationMailer, type RegistrationMailer } from './email-mailer'

export interface RegistrationOptions { mailer?: RegistrationMailer; now?: () => number; enabled?: boolean }
interface CodeRow { id: string; email_normalized: string; code_hmac: string; attempt_count: number; created_at: string; expires_at: string;
  sent_at: string | null; consumed_at: string | null; invalidated_at: string | null }
const SEND = '/api/auth/register/send-code', REGISTER = '/api/auth/register'
const invalidCode = () => permissionError(400, 'verification_invalid', '验证码无效或已过期，请重新获取')
const invalidRequest = () => permissionError(400, 'invalid_request', '请填写有效邮箱、昵称、密码和六位验证码')
export function verificationKey(): Buffer {
  const value = process.env.EMAIL_VERIFICATION_SECRET || ''
  const key = Buffer.from(value, 'base64')
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || key.toString('base64') !== value || key.length < 32 || new Set(key).size < 2
    || value === process.env.AUTH_SECRET || value === process.env.EMAIL_SMTP_PASS?.trim()
    || key.toString('utf8') === process.env.AUTH_SECRET || key.toString('utf8') === process.env.EMAIL_SMTP_PASS?.trim()) {
    throw permissionError(503, 'verification_unavailable', '邮箱验证尚未配置，请联系维护者；已有账号仍可登录')
  }
  return key
}
export const codeDigest = (key: Buffer, id: string, email: string, code: string): string => createHmac('sha256', key).update(JSON.stringify(['register', id, email, code]), 'utf8').digest('hex')
function limited(reply: FastifyReply, seconds: number): never {
  reply.header('Retry-After', String(Math.max(1, Math.ceil(seconds))))
  throw permissionError(429, 'rate_limited', '请求过于频繁，请稍后重试')
}
class RequestLimits {
  private entries = new Map<string, { count: number; until: number }>()
  consume(key: string, maximum: number, windowMs: number, now: number, reply: FastifyReply) {
    for (const [id, entry] of this.entries) if (entry.until <= now) this.entries.delete(id)
    let entry = this.entries.get(key)
    if (!entry) {
      if (this.entries.size >= 10000) limited(reply, 60)
      entry = { count: 0, until: now + windowMs }; this.entries.set(key, entry)
    }
    if (entry.count >= maximum) limited(reply, (entry.until - now) / 1000)
    entry.count++
  }
}

export function registerEmailRegistration(app: FastifyInstance, options: RegistrationOptions = {}): void {
  if (options.enabled === false) {
    const disabled = async () => { throw permissionError(403, 'registration_disabled', '此实例不开放注册，请由维护者初始化账号') }
    app.post(SEND, disabled)
    app.post(REGISTER, disabled)
    return
  }
  const mailer = options.mailer || createRegistrationMailer(), clock = options.now || Date.now, limits = new RequestLimits()
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0]
    if (req.method === 'POST' && (url === SEND || url === REGISTER)) {
      reply.header('Cache-Control', 'no-store')
      limits.consume(`${url}:${req.ip}`, url === SEND ? 20 : 30, url === SEND ? 3600000 : 900000, clock(), reply)
    }
  })
  app.post<{ Body: unknown; Querystring: Record<string, unknown> }>(SEND, async (req, reply) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length !== 1 || !('email' in req.body)
      || typeof req.body.email !== 'string' || Object.keys(req.query).length) throw invalidRequest()
    const email = normalizeEmail(req.body.email)
    if (!validEmail(email)) throw invalidRequest()
    const key = verificationKey(); mailer.ready()
    const id = randomUUID(), code = randomInt(0, 1000000).toString().padStart(6, '0'), now = clock()
    const created = new Date(now).toISOString(), expires = new Date(now + 600000).toISOString()
    const result = db.transaction(() => {
      if (emailAccountId(db, email)) throw permissionError(409, 'email_already_registered', '该邮箱已注册，请使用登录')
      const rows = db.prepare('SELECT created_at FROM email_verification_codes WHERE email_normalized = ? AND created_at > ? ORDER BY created_at ASC')
        .all(email, new Date(now - 3600000).toISOString()) as { created_at: string }[]
      const latest = rows.at(-1)
      if (latest && Date.parse(latest.created_at) + 60000 > now) return { retry: (Date.parse(latest.created_at) + 60000 - now) / 1000 }
      if (rows.length >= 5) return { retry: (Date.parse(rows[0].created_at) + 3600000 - now) / 1000 }
      db.prepare('DELETE FROM email_verification_codes WHERE created_at < ? AND (consumed_at IS NOT NULL OR invalidated_at IS NOT NULL OR expires_at <= ?)')
        .run(new Date(now - 86400000).toISOString(), created)
      db.prepare('UPDATE email_verification_codes SET invalidated_at = ? WHERE email_normalized = ? AND consumed_at IS NULL AND invalidated_at IS NULL').run(created, email)
      db.prepare('INSERT INTO email_verification_codes (id,email_normalized,code_hmac,created_at,expires_at) VALUES (?,?,?,?,?)').run(id, email, codeDigest(key, id, email, code), created, expires)
      return { retry: 0 }
    }).immediate()
    if (result.retry) limited(reply, result.retry)
    try {
      await mailer.send(email, code)
      const sent = new Date(clock()).toISOString()
      const changed = db.prepare('UPDATE email_verification_codes SET sent_at = ? WHERE id = ? AND email_normalized = ? AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at > ?')
        .run(sent, id, email, sent)
      if (changed.changes !== 1) throw new Error('mail_state_expired')
    } catch {
      db.prepare('UPDATE email_verification_codes SET invalidated_at = ? WHERE id = ? AND consumed_at IS NULL AND invalidated_at IS NULL').run(new Date(clock()).toISOString(), id)
      throw permissionError(503, 'mail_unavailable', '验证码邮件未能完成发送，请稍后重新获取')
    }
    const remaining = clock()
    return { verificationId: id, expiresIn: Math.max(0, Math.ceil((now + 600000 - remaining) / 1000)), retryAfter: Math.max(0, Math.ceil((now + 60000 - remaining) / 1000)) }
  })

  app.post<{ Body: unknown; Querystring: Record<string, unknown> }>(REGISTER, async (req, reply) => {
    const body = req.body as Record<string, unknown> | null
    if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.email !== 'string' || Object.keys(req.query).length
      || Object.keys(body).some((key) => !['name', 'email', 'password', 'verificationId', 'code', 'role'].includes(key))) throw invalidRequest()
    const email = normalizeEmail(body.email)
    if (!validEmail(email)) throw invalidRequest()
    limits.consume(`email:${email}`, 10, 900000, clock(), reply)
    if (typeof body.name !== 'string' || !body.name.trim() || body.name.trim().length > 20 || typeof body.password !== 'string' || body.password.length < 6
      || typeof body.verificationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(body.verificationId)
      || typeof body.code !== 'string' || !/^\d{6}$/.test(body.code)) throw invalidRequest()
    const { verificationId: id, code } = body, name = body.name.trim(), key = verificationKey()
    const passwordHash = hashPassword(body.password)
    const result = db.transaction(() => {
      const now = new Date(clock()).toISOString()
      const record = db.prepare('SELECT * FROM email_verification_codes WHERE id = ?').get(id) as CodeRow | undefined
      if (!record || record.email_normalized !== email || !record.sent_at || record.consumed_at || record.invalidated_at || record.expires_at <= now || record.attempt_count >= 5) return { user: null }
      const digest = codeDigest(key, id, email, code)
      const correct = /^[0-9a-f]{64}$/.test(record.code_hmac) && timingSafeEqual(Buffer.from(record.code_hmac, 'hex'), Buffer.from(digest, 'hex'))
      if (!correct) {
        db.prepare('UPDATE email_verification_codes SET attempt_count = attempt_count + 1, invalidated_at = CASE WHEN attempt_count >= 4 THEN ? ELSE invalidated_at END WHERE id = ?').run(now, id)
        return { user: null } // Commit wrong-attempt accounting before returning HTTP 400.
      }
      if (emailAccountId(db, email)) throw permissionError(409, 'email_already_registered', '该邮箱已注册，请使用登录')
      if (db.prepare('SELECT id FROM users WHERE name = ?').get(name)) throw permissionError(409, 'nickname_taken', '该昵称已被使用')
      const consumed = db.prepare('UPDATE email_verification_codes SET consumed_at = ? WHERE id = ? AND email_normalized = ? AND sent_at IS NOT NULL AND consumed_at IS NULL AND invalidated_at IS NULL AND expires_at > ? AND attempt_count < 5').run(now, id, email, now)
      if (consumed.changes !== 1) return { user: null }
      const insert = db.prepare('INSERT INTO users (name,email,password_hash,created_at,email_verified_at) VALUES (?,?,?,?,?)').run(name, email, passwordHash, now, now)
      return { user: findUser(Number(insert.lastInsertRowid))! }
    }).immediate()
    if (!result.user) throw invalidCode()
    setAuthCookie(reply, signToken(result.user.id, result.user.name))
    return result.user
  })
}
