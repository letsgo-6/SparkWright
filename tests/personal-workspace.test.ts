// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { mkdtempSync, readdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'

const previous = process.cwd(), temp = mkdtempSync(path.join(os.tmpdir(), 'sparkwright-personal-workspace-'))
process.chdir(temp)
process.env.AUTH_SECRET = randomBytes(48).toString('hex')
const { db } = await import('../server/db')
const { buildApp } = await import('../server/app')

after(async () => {
  db.close(); process.chdir(previous)
  assert.ok(path.resolve(temp).startsWith(path.join(os.tmpdir(), 'sparkwright-personal-workspace-')))
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(error => {
    // Windows may retain the empty directory as a loader process's working directory.
    if (!['EBUSY', 'EPERM'].includes(error.code) || readdirSync(temp).length) throw error
  })
})

test('fresh personal workspace opens without login or cookies and persists across restarts', async () => {
  const app = await buildApp()
  let userId: number
  try {
    const response = await app.inject({ method: 'GET', url: '/api/auth/me' })
    assert.equal(response.statusCode, 200)
    assert.equal(response.headers['set-cookie'], undefined)
    const status = response.json()
    assert.equal(status.personalEdition, true)
    assert.ok(status.user, 'personal edition must supply a local identity without logging in')
    userId = status.user.id
    const credentials = db.prepare('SELECT email,password_hash FROM users WHERE id=?').get(userId) as any
    assert.equal(credentials.email, null); assert.equal(credentials.password_hash, null)
    const created = await app.inject({ method: 'POST', url: '/api/ideas', headers: { origin: 'http://127.0.0.1:5318' }, payload: { title: 'Local persistence fixture', content: 'No account or session required' } })
    assert.equal(created.statusCode, 200)
    assert.equal(created.json().user_id, userId)
    assert.equal((await app.inject({ method: 'GET', url: '/api/settings' })).statusCode, 200)
    for (const url of ['/api/auth/login', '/api/auth/logout', '/api/auth/register', '/api/auth/register/send-code']) {
      const disabled = await app.inject({ method: 'POST', url, headers: { origin: 'http://127.0.0.1:5318' }, payload: {} })
      assert.equal(disabled.statusCode, 404, `${url}: ${disabled.body}`)
    }
  } finally { await app.close() }
  const restarted = await buildApp()
  try {
    assert.equal((await restarted.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: 'ideabox_session=invalid' } })).json().user.id, userId!)
    const ideas = (await restarted.inject({ method: 'GET', url: '/api/ideas' })).json()
    assert.equal(ideas.length, 1)
    assert.equal((db.prepare('SELECT count(*) AS n FROM users').get() as any).n, 1)
  } finally { await restarted.close() }
})

test('personal workspace rejects remote hosts, remote clients and cross-site requests', async () => {
  const app = await buildApp()
  try {
    for (const headers of [{ host: 'attacker.example' }, { host: '127.0.0.1:5318', origin: 'https://attacker.example' }]) {
      assert.equal((await app.inject({ method: 'GET', url: '/api/ideas', headers })).statusCode, 403)
    }
    assert.equal((await app.inject({ method: 'GET', url: '/api/ideas', remoteAddress: '192.0.2.5' })).statusCode, 403)
    assert.equal((await app.inject({ method: 'POST', url: '/api/ideas', payload: { title: 'Rejected' } })).statusCode, 403)
    assert.equal((await app.inject({ method: 'POST', url: '/api/ideas', headers: { origin: 'https://attacker.example' }, payload: { title: 'Rejected' } })).statusCode, 403)
    assert.equal((await app.inject({ method: 'GET', url: '/api/ideas', headers: { host: 'localhost:5318' } })).statusCode, 200)
    assert.equal((await app.inject({ method: 'GET', url: '/api/ideas' })).json().length, 1)
  } finally { await app.close() }
})

test('upgrading a one-account personal database keeps its identity, ideas and settings', async () => {
  db.prepare('UPDATE users SET email=?,password_hash=? WHERE id=(SELECT id FROM users LIMIT 1)').run('legacy@example.invalid', 'legacy-fixture-hash')
  const existing = db.prepare('SELECT id,email,password_hash FROM users LIMIT 1').get() as any
  db.prepare('INSERT OR REPLACE INTO user_settings (user_id,language,model) VALUES (?,?,?)').run(existing.id, 'en', 'fixture-model')
  const app = await buildApp()
  try {
    assert.equal((await app.inject({ method: 'GET', url: '/api/auth/me' })).json().user.id, existing.id)
    assert.equal((await app.inject({ method: 'GET', url: '/api/ideas' })).json().length, 1)
    assert.equal((await app.inject({ method: 'GET', url: '/api/settings' })).json().model, 'fixture-model')
    assert.deepEqual(db.prepare('SELECT id,email,password_hash FROM users LIMIT 1').get(), existing)
  } finally { await app.close() }
})

test('personal mode refuses a multi-account database instead of silently selecting another user', async () => {
  db.prepare("INSERT INTO users (name,role) VALUES ('Second fixture','user')").run()
  await assert.rejects(buildApp(), /多个账号/)
  assert.equal((db.prepare('SELECT count(*) AS n FROM users').get() as any).n, 2)
})
