// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict'
import type { FastifyInstance } from 'fastify'
import type Database from 'better-sqlite3'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import type { testMailbox } from './test-mailbox'

type Actor = { id: number; cookie: string }
type Check = (label: string, work: () => unknown | Promise<unknown>) => Promise<void>
export async function runAdminSmoke(app: FastifyInstance, db: Database.Database, root: string, owner: Actor, check: Check, mailbox: ReturnType<typeof testMailbox>) {
  const origin = 'http://127.0.0.1:5318'
  const request = async (method: 'GET' | 'POST' | 'PATCH', url: string, actor?: Actor, body?: unknown, expected = 200, source = origin) => {
    const response = await app.inject({ method, url, headers: { ...(actor ? { cookie: actor.cookie } : {}), origin: source,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) })
    assert.equal(response.statusCode, expected, `${method} ${url}`)
    return response
  }
  const register = async (name: string): Promise<Actor> => {
    const response = await request('POST', '/api/auth/register', undefined, { name, email: `${name}@test.invalid`, password: 'fixture-password-123', ...await mailbox.proof(app, `${name}@test.invalid`) })
    return { id: response.json().id, cookie: String(response.headers['set-cookie']).split(';')[0] }
  }
  const admin = await register('stage4-admin'), user = await register('stage4-user')
  const role = (actor: Actor, target: Actor, value: string, expected = 200, source = origin) => request('PATCH', `/api/admin/users/${target.id}/role`, actor, { role: value }, expected, source)
  await role(owner, admin, 'admin')
  let announcementId = 0
  await check('stage4 anonymous and user cannot access any management section API', async () => {
    for (const url of ['/api/admin/system', '/api/admin/users', '/api/admin/announcements', '/api/admin/backups']) {
      await request('GET', url, undefined, undefined, 401)
      await request('GET', url, user, undefined, 403)
    }
  })
  await check('stage4 system returns real counts/version, no secrets, paths or backup metadata; health stays minimal', async () => {
    for (const actor of [owner, admin]) {
      const response = await request('GET', '/api/admin/system', actor)
      const system = response.json()
      assert.deepEqual(Object.keys(system).sort(), ['announcements', 'database', 'status', 'uptime_seconds', 'users_total', 'version'])
      assert.equal(response.headers['cache-control'], 'no-store')
      assert.equal(system.version, JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version)
      assert.equal(system.users_total, (db.prepare('SELECT count(*) n FROM users').get() as { n: number }).n)
      for (const status of ['draft', 'published']) assert.equal(system.announcements[status], (db.prepare('SELECT count(*) n FROM announcements WHERE status = ?').get(status) as { n: number }).n)
      assert.equal(system.database, 'ok'); assert.equal(system.status, 'ok'); assert.ok(Number.isSafeInteger(system.uptime_seconds) && system.uptime_seconds >= 0)
      assert.ok(!response.body.includes(process.cwd()) && !response.body.includes(process.env.AUTH_SECRET!))
      assert.doesNotMatch(response.body, /password_hash|api_key|SQLITE_|Cookie|ideabox\.db|file_name|download|PRIVATE-B/)
    }
    assert.deepEqual(Object.keys((await request('GET', '/api/health')).json()).sort(), ['app', 'now', 'status'])
    await request('GET', '/api/admin/system?user_id=1', admin, undefined, 400)
  })
  await check('stage4 admin manages real draft/publication/read state with accurate system counts', async () => {
    const before = (await request('GET', '/api/admin/system', admin)).json().announcements
    const draft = (await request('POST', '/api/admin/announcements', admin, { title: 'stage4 smoke', content: '<script>plain text</script>', action_label: '站内跳转', action_url: '/ideas' })).json()
    announcementId = draft.id
    assert.deepEqual((await request('GET', '/api/admin/system', admin)).json().announcements, { published: before.published, draft: before.draft + 1 })
    await request('GET', `/api/announcements/${draft.id}`, user, undefined, 404)
    await request('POST', `/api/admin/announcements/${draft.id}/publish`, admin)
    assert.deepEqual((await request('GET', '/api/admin/system', admin)).json().announcements, { published: before.published + 1, draft: before.draft })
    await request('POST', `/api/announcements/${draft.id}/read`, user)
    await request('PATCH', `/api/admin/announcements/${draft.id}`, admin, { content: 'edited plain text' })
    assert.equal((await request('GET', `/api/announcements/${draft.id}`, user)).json().is_read, true)
    await request('POST', `/api/admin/announcements/${draft.id}/unpublish`, admin)
    assert.equal((db.prepare('SELECT count(*) n FROM announcement_reads WHERE announcement_id=? AND user_id=?').get(draft.id, user.id) as { n: number }).n, 1)
    await request('GET', `/api/announcements/${draft.id}`, user, undefined, 404)
  })
  await check('stage4 admin cannot forge owner role or backup operations; list returns only safe account fields', async () => {
    const listing = (await request('GET', '/api/admin/users?page=1&pageSize=10', admin)).json()
    assert.equal(listing.items.length, 10)
    for (const item of listing.items) assert.deepEqual(Object.keys(item).sort(), ['created_at', 'email', 'id', 'name', 'role'])
    await role(admin, user, 'owner', 403)
    for (const method of ['GET', 'POST'] as const) await request(method, '/api/admin/backups', admin, undefined, 403)
    await request('GET', '/api/admin/backups/20260101T000000000Z-00000000000000000000000000000000/download', admin, undefined, 403)
  })
  await check('stage4 manager roles retain ownership restrictions and own-only exports', async () => {
    const idea = (await request('POST', '/api/ideas', user, { title: 'stage4-private', content: 'STAGE4-PRIVATE-B-BODY' })).json()
    for (const actor of [owner, admin]) {
      await request('GET', `/api/ideas/${idea.id}`, actor, undefined, 404)
      await request('PATCH', `/api/ideas/${idea.id}`, actor, { title: 'forged' }, 404)
      const exported = await request('GET', '/api/export/me', actor)
      assert.equal(exported.json().user.id, actor.id); assert.ok(!exported.body.includes('STAGE4-PRIVATE-B-BODY'))
      await request('GET', `/api/export/me?user_id=${user.id}`, actor, undefined, 400)
    }
  })
  await check('stage4 cross-site announcement and role writes are denied without mutation', async () => {
    await request('POST', '/api/admin/announcements', admin, { title: 'csrf', content: 'csrf' }, 403, 'https://evil.test')
    await request('PATCH', `/api/admin/announcements/${announcementId}`, admin, { title: 'csrf' }, 403, 'https://evil.test')
    for (const action of ['publish', 'unpublish']) await request('POST', `/api/admin/announcements/${announcementId}/${action}`, admin, undefined, 403, 'https://evil.test')
    await role(owner, user, 'owner', 403, 'https://evil.test')
    assert.equal((db.prepare('SELECT role FROM users WHERE id=?').get(user.id) as { role: string }).role, 'user')
  })
  await check('stage4 database failure is safe and retry works without changing health contract', async () => {
    const prepare = db.prepare.bind(db)
    db.prepare = () => { throw new Error('fixture SQL/path/private content') }
    // Authentication also queries the DB; all errors must remain safe even at that earlier boundary.
    try {
      const failure = await request('GET', '/api/admin/system', admin, undefined, 500)
      assert.deepEqual(failure.json(), { error: { message: '管理操作失败，请稍后重试', code: 'admin_operation_failed' } })
    } finally { db.prepare = prepare }
    await request('GET', '/api/admin/system', admin)
  })
  await check('stage4 old admin cookie is denied after demotion; direct SPA refresh is not API authorization', async () => {
    await role(owner, admin, 'user')
    for (const url of ['/api/admin/system', '/api/admin/users', '/api/admin/announcements']) await request('GET', url, admin, undefined, 403)
    await request('POST', '/api/admin/announcements', admin, { title: 'old admin', content: 'old admin' }, 403)
    const html = await request('GET', '/admin?tab=users', user)
    assert.match(String(html.headers['content-type']), /text\/html/)
    await request('GET', '/api/stage4-not-found', owner, undefined, 404)
  })
}
