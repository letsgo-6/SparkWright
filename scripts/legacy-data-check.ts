// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict'
import path from 'node:path'
import Database from 'better-sqlite3'
import { testMailbox } from './test-mailbox'

// This helper is launched only in the smoke script's existing legacy fixture directory.
assert.ok(path.basename(process.cwd()) === 'legacy' && path.basename(path.dirname(process.cwd())).startsWith('sparkwright-role-smoke-'))
const { db } = await import('../server/db')
const { buildApp } = await import('../server/app')
const { signToken } = await import('../server/auth')
const mailbox = testMailbox()
const app = await buildApp(mailbox.options)
try {
  let owner = db.prepare("SELECT id, name FROM users WHERE name = 'legacy-data-owner'").get() as { id: number; name: string } | undefined
  if (!owner) {
    const registered = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { name: 'legacy-data-owner', email: 'legacy-data-owner@test.invalid', password: 'fixture-password-123', ...await mailbox.proof(app, 'legacy-data-owner@test.invalid') } })
    assert.equal(registered.statusCode, 200)
    owner = registered.json()
    db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(owner!.id)
  }
  const cookie = `ideabox_session=${signToken(owner!.id, owner!.name)}`
  let announcement = db.prepare("SELECT id FROM announcements WHERE title = 'legacy-stage4-announcement'").get() as { id: number } | undefined
  if (!announcement) {
    const created = await app.inject({ method: 'POST', url: '/api/admin/announcements', headers: { cookie, origin: 'http://127.0.0.1:5318' }, payload: { title: 'legacy-stage4-announcement', content: 'keep-stage4-announcement' } })
    assert.equal(created.statusCode, 200); announcement = created.json()
    const published = await app.inject({ method: 'POST', url: `/api/admin/announcements/${announcement!.id}/publish`, headers: { cookie, origin: 'http://127.0.0.1:5318' } })
    assert.equal(published.statusCode, 200)
    db.prepare('INSERT INTO announcement_reads (announcement_id, user_id, read_at) VALUES (?,42,?)').run(announcement!.id, '2026-09-29')
  }
  const system = await app.inject({ method: 'GET', url: '/api/admin/system', headers: { cookie } })
  assert.equal(system.statusCode, 200)
  assert.equal(system.json().users_total, 2); assert.equal(system.json().announcements.published, 1)
  assert.equal((db.prepare('SELECT read_at FROM announcement_reads WHERE announcement_id=? AND user_id=42').get(announcement!.id) as { read_at: string }).read_at, '2026-09-29')
  const backup = await app.inject({ method: 'POST', url: '/api/admin/backups', headers: { cookie, origin: 'http://127.0.0.1:5318' } })
  assert.equal(backup.statusCode, 200)
  const copy = new Database(path.join(process.cwd(), 'data/backups', backup.json().file_name), { readonly: true, fileMustExist: true })
  try {
    assert.equal(copy.pragma('integrity_check', { simple: true }), 'ok')
    assert.equal((copy.prepare('SELECT read FROM notifications WHERE id = 88').get() as { read: number }).read, 1)
  } finally { copy.close() }
  const personal = await app.inject({ method: 'GET', url: '/api/export/me', headers: { cookie: `ideabox_session=${signToken(42, 'legacy-fixture')}` } })
  assert.equal(personal.statusCode, 200)
  assert.equal(personal.json().data.ideas[0].id, 77)
  assert.equal(personal.json().data.notifications[0].id, 88)
  assert.equal(personal.json().data.notifications[0].read, 1)
  assert.equal((db.prepare('SELECT role FROM users WHERE id = 42').get() as { role: string }).role, 'user')
} finally { await app.close(); db.close() }
