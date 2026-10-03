// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { AuthPage } from '../src/pages/AuthPage'
import { PERSONAL_EDITION } from '../server/edition'

const previous = process.cwd(), temp = mkdtempSync(path.join(os.tmpdir(), 'sparkwright-release-edition-'))
process.chdir(temp)
process.env.AUTH_SECRET = randomBytes(48).toString('hex')
const { db } = await import('../server/db')
const { buildApp } = await import('../server/app')
const { setAuthCookie, clearAuthCookie } = await import('../server/auth')
after(async () => {
  db.close(); process.chdir(previous)
  assert.ok(path.resolve(temp).startsWith(path.join(os.tmpdir(), 'sparkwright-release-edition-')))
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

test('edition capability matches package and default personal registration cannot be used over HTTP', async () => {
  const app = await buildApp()
  try {
    const status = (await app.inject({ method: 'GET', url: '/api/auth/me' })).json()
    assert.equal(Boolean(status.user), PERSONAL_EDITION)
    assert.equal(status.personalEdition, PERSONAL_EDITION)
    if (PERSONAL_EDITION) for (const url of ['/api/auth/register', '/api/auth/register/send-code']) {
      const response = await app.inject({ method: 'POST', url, headers: { origin: 'http://127.0.0.1:5318' }, payload: { email: 'fixture@example.invalid', role: 'owner' } })
      assert.equal(response.statusCode, 404)
    }
  } finally { await app.close() }
})

test('disabled registration rejects both endpoints before mail delivery or account creation', async () => {
  let sends = 0
  const count = (db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n
  const app = await buildApp({ enabled: false, mailer: { ready() { sends++ }, async send() { sends++ } } }, false)
  try {
    for (const url of ['/api/auth/register', '/api/auth/register/send-code']) {
      const response = await app.inject({ method: 'POST', url, payload: { email: 'fixture@example.invalid' } })
      assert.equal(response.statusCode, 403, `${url}: ${response.body}`)
    }
    assert.equal(sends, 0)
    assert.equal((db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n, count)
  } finally { await app.close() }
})

test('legacy multi-user authentication component retains its registration option', () => {
  const html = (enabled: boolean) => renderToStaticMarkup(createElement(AuthPage, { onAuthed() {}, registrationEnabled: enabled }))
  assert.equal((html(false).match(/class="auth-tab(?: active)?\s*"/g) || []).length, 1)
  assert.equal((html(true).match(/class="auth-tab(?: active)?\s*"/g) || []).length, 2)
})

test('HTTPS deployment cookies set and clear Secure consistently, local HTTP remains usable', () => {
  const original = process.env.AUTH_COOKIE_SECURE
  let cookie = ''
  const reply = { header(_name: string, value: string) { cookie = value } } as any
  try {
    process.env.AUTH_COOKIE_SECURE = 'true'
    setAuthCookie(reply, 'fixture-session')
    assert.match(cookie, /; Secure$/)
    assert.match(cookie, /HttpOnly; SameSite=Lax/)
    clearAuthCookie(reply)
    assert.match(cookie, /Max-Age=0; Secure$/)
    delete process.env.AUTH_COOKIE_SECURE
    setAuthCookie(reply, 'fixture-session')
    assert.doesNotMatch(cookie, /; Secure/)
  } finally { if (original === undefined) delete process.env.AUTH_COOKIE_SECURE; else process.env.AUTH_COOKIE_SECURE = original }
})
