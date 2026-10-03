// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomBytes, createHmac } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'
import { migrateUserRoles } from '../server/roles'
import { isAdmin, isOwner, type User } from '../src/types'
import { githubRepositoryUrl, safeActionUrl } from '../shared/links'
import { notificationTarget } from '../src/lib/notification-target'
import { runDataSmoke } from './data-smoke'
import { runAdminSmoke } from './admin-smoke'
import { testMailbox } from './test-mailbox'

const root = path.resolve(import.meta.dirname, '..')
const loader = pathToFileURL(path.join(root, 'node_modules/tsx/dist/loader.mjs')).href
const previousCwd = process.cwd()
const temp = mkdtempSync(path.join(os.tmpdir(), 'sparkwright-role-smoke-'))
process.chdir(temp)
process.env.AUTH_SECRET = randomBytes(48).toString('hex')
process.env.PORT = '5318'
process.env.WEB_PORT = '5310'
process.env.NODE_ENV = 'development'
delete process.env.APP_ORIGIN
delete process.env.DEV_ORIGIN
delete process.env.AI_API_KEY
delete process.env.ZAI_API_KEY
mkdirSync(path.join(temp, 'dist'))
writeFileSync(path.join(temp, 'dist/index.html'), '<!doctype html><title>Isolated static fallback fixture</title>')
const { db } = await import('../server/db')
const { buildApp } = await import('../server/app')
const mailbox = testMailbox()
const app = await buildApp(mailbox.options, false)
const origin = 'http://127.0.0.1:5318'
let checks = 0
async function check(label: string, work: () => unknown | Promise<unknown>) {
  await work()
  console.log(`PASS ${++checks}: ${label}`)
}
async function request(method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, cookie?: string, payload?: unknown, status = 200, headers: Record<string, string> = {}) {
  const response = await app.inject({ method, url, ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    headers: { ...(payload === undefined ? {} : { 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}), ...headers } })
  assert.equal(response.statusCode, status, `${method} ${url}: expected ${status}, received ${response.statusCode}`)
  return response
}
async function register(name: string) {
  const response = await request('POST', '/api/auth/register', undefined, {
    name, email: `${name}@test.invalid`, password: 'fixture-password-123', role: 'owner',
    ...await mailbox.proof(app, `${name}@test.invalid`),
  })
  assert.equal(response.json().role, 'user')
  assert.deepEqual(Object.keys(response.json()).sort(), ['created_at', 'email', 'id', 'name', 'role'])
  return { id: response.json().id as number, cookie: String(response.headers['set-cookie']).split(';')[0] }
}
function bootstrap(id: number, expected: number, message: RegExp) {
  const result = spawnSync(process.execPath, ['--import', loader, path.join(root, 'scripts/bootstrap-owner.ts'), `--user-id=${id}`, '--confirm-account-control'], { cwd: temp, env: process.env, encoding: 'utf8', windowsHide: true, timeout: 15000 })
  assert.equal(result.status, expected, 'bootstrap exit code')
  assert.match(result.stdout + result.stderr, message)
  assert.doesNotMatch(result.stdout + result.stderr, /\$2[aby]\$|AUTH_SECRET=|SQLITE_|Error:|stack|ideabox\.db/)
}
const patchRole = (cookie: string, id: number, role: string, status = 200) => request('PATCH', `/api/admin/users/${id}/role`, cookie, { role }, status, { origin })
try {
  await app.ready()
  await check('new database role default, NOT NULL, CHECK and idempotent migration', () => {
    const role = (db.pragma('table_info(users)') as { name: string; notnull: number; dflt_value: string }[]).find((row) => row.name === 'role')!
    assert.equal(role.notnull, 1)
    assert.equal(role.dflt_value, "'user'")
    assert.throws(() => db.prepare('INSERT INTO users (name, role) VALUES (?, ?)').run('invalid', 'superadmin'))
    assert.throws(() => db.prepare('INSERT INTO users (name, role) VALUES (?, ?)').run('invalid', null))
    migrateUserRoles(db)
    migrateUserRoles(db)
  })
  await check('real database entry upgrades a legacy schema twice without losing IDs or business data', () => {
    const legacyDir = path.join(temp, 'legacy')
    mkdirSync(path.join(legacyDir, 'data'), { recursive: true })
    const legacy = new Database(path.join(legacyDir, 'data/ideabox.db'))
    legacy.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      INSERT INTO users (id, name, created_at) VALUES (42, 'legacy-fixture', '2026-01-01');
      CREATE TABLE ideas (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', deadline TEXT, status TEXT NOT NULL DEFAULT 'incubating', created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO ideas VALUES (77, 42, 'legacy-idea', 'keep-this-content', NULL, 'incubating', '2026-01-01', '2026-01-02');`)
    legacy.exec(`CREATE TABLE notifications (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id), type TEXT NOT NULL, ref_id INTEGER, actor_id INTEGER, content TEXT NOT NULL DEFAULT '', read INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      INSERT INTO notifications VALUES (88, 42, 'comment', 77, 42, 'keep-notification', 1, '2026-01-03');`)
    legacy.exec(`CREATE TABLE idea_scores (id INTEGER PRIMARY KEY AUTOINCREMENT, idea_id INTEGER NOT NULL REFERENCES ideas(id), user_id INTEGER NOT NULL REFERENCES users(id), score INTEGER NOT NULL, summary TEXT NOT NULL DEFAULT '', dimensions TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL DEFAULT (datetime('now')));
      INSERT INTO idea_scores VALUES (66, 77, 42, 61, 'keep-legacy-score', '[]', '2026-01-04');
      CREATE TABLE channels (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL DEFAULT 'public', idea_id INTEGER REFERENCES ideas(id), name TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      INSERT INTO channels VALUES (55, 'idea', 77, 'keep-channel', '2026-01-04');
      CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id INTEGER NOT NULL REFERENCES channels(id), user_id INTEGER NOT NULL REFERENCES users(id), content TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
      INSERT INTO messages VALUES (56, 55, 42, 'keep-message', '2026-01-04');`)
    const oldUsers = legacy.prepare('SELECT id, name, created_at FROM users').all()
    const oldIdeas = legacy.prepare('SELECT id, user_id, title, content, deadline, status, created_at, updated_at FROM ideas').all()
    const oldNotifications = legacy.prepare('SELECT * FROM notifications').all()
    legacy.close()
    for (let pass = 0; pass < 2; pass++) {
      const dbUrl = pathToFileURL(path.join(root, 'server/db.ts')).href
      const run = spawnSync(process.execPath, ['--import', loader, '--input-type=module', '-e', `const { db } = await import(${JSON.stringify(dbUrl)}); db.close()`], { cwd: legacyDir, env: process.env, encoding: 'utf8', windowsHide: true, timeout: 15000 })
      assert.equal(run.status, 0, `legacy migration pass ${pass + 1}`)
      const inspect = new Database(path.join(legacyDir, 'data/ideabox.db'), { readonly: true })
      try {
        assert.deepEqual(inspect.prepare('SELECT id, name, created_at FROM users').all(), oldUsers)
        assert.deepEqual(inspect.prepare('SELECT id, user_id, title, content, deadline, status, created_at, updated_at FROM ideas').all(), oldIdeas)
        assert.deepEqual(inspect.prepare('SELECT * FROM notifications').all(), oldNotifications)
        assert.deepEqual(inspect.prepare('SELECT id, score, summary, dimensions FROM idea_scores WHERE id = 66').get(),
          { id: 66, score: 61, summary: 'keep-legacy-score', dimensions: '[]' })
        assert.equal((inspect.prepare('SELECT validity FROM idea_scores WHERE id = 66').get() as { validity: string }).validity, 'legacy')
        assert.equal((inspect.prepare('SELECT name FROM channels WHERE id = 55').get() as { name: string }).name, 'keep-channel')
        assert.equal((inspect.prepare('SELECT content FROM messages WHERE id = 56').get() as { content: string }).content, 'keep-message')
        assert.equal((inspect.prepare("SELECT count(*) n FROM sqlite_master WHERE name = 'synthesis_runs'").get() as { n: number }).n, 1)
        assert.equal((inspect.prepare("SELECT count(*) n FROM sqlite_master WHERE name IN ('announcements', 'announcement_reads')").get() as { n: number }).n, 2)
        assert.equal((inspect.prepare('SELECT role FROM users WHERE id = 42').get() as { role: string }).role, 'user')
        assert.equal((inspect.pragma('integrity_check') as { integrity_check: string }[])[0].integrity_check, 'ok')
      } finally { inspect.close() }
    }
  })
  await check('existing unconstrained or unknown roles fail migration without overwriting data', () => {
    const conflict = new Database(':memory:')
    try {
      conflict.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, role TEXT); INSERT INTO users VALUES (1,'fixture','superadmin')")
      assert.throws(() => migrateUserRoles(conflict), /迁移冲突/)
      assert.equal((conflict.prepare('SELECT role FROM users').get() as { role: string }).role, 'superadmin')
    } finally { conflict.close() }
  })
  await check('frontend permission helpers agree with the three-role matrix', () => {
    assert.equal(isAdmin(null), false)
    assert.equal(isOwner(null), false)
    for (const role of ['user', 'admin', 'owner'] as const) {
      const user: User = { id: 1, name: 'fixture', email: null, role, created_at: '2026-01-01' }
      assert.equal(isAdmin(user), role !== 'user')
      assert.equal(isOwner(user), role === 'owner')
    }
  })
  const a = await register('roleA')
  const b = await register('roleB')
  const c = await register('roleC')
  await check('stage2 notification summary returns both independent unread totals', async () => {
    const response = await request('GET', '/api/notification-summary', b.cookie)
    assert.deepEqual(response.json(), { notifications_unread: 0, announcements_unread: 0, total_unread: 0 })
  })
  await check('registration ignores owner; all responses contain only safe fields', async () => {
    for (const user of [a, b, c]) assert.equal((await request('GET', '/api/auth/me', user.cookie)).json().user.role, 'user')
    for (const user of [a, b, c]) await request('GET', '/api/admin/system', user.cookie, undefined, 403)
    assert.equal((db.prepare("SELECT count(*) n FROM users WHERE role <> 'user'").get() as { n: number }).n, 0)
  })
  const legacyId = Number(db.prepare("INSERT INTO users (name) VALUES ('incomplete-legacy')").run().lastInsertRowid)
  await check('bootstrap refuses missing target and incomplete historical account', () => {
    bootstrap(999999, 1, /目标用户不存在/)
    bootstrap(legacyId, 1, /不完整的历史账号/)
    assert.equal((db.prepare("SELECT count(*) n FROM users WHERE role='owner'").get() as { n: number }).n, 0)
  })
  await check('bootstrap requires explicit account-control acknowledgement', () => {
    const result = spawnSync(process.execPath, ['--import', loader, path.join(root, 'scripts/bootstrap-owner.ts'), `--user-id=${a.id}`], { cwd: temp, encoding: 'utf8', windowsHide: true, timeout: 15000 })
    assert.equal(result.status, 1)
    assert.match(result.stderr, /先确认账号由你控制/)
  })
  await check('bootstrap promotes an existing complete account exactly once', async () => {
    bootstrap(a.id, 0, /初始化成功/)
    bootstrap(c.id, 1, /已有 owner/)
    assert.equal((await request('GET', '/api/auth/me', a.cookie)).json().user.role, 'owner')
  })
  await check('anonymous management is 401; ordinary user management is 403', async () => {
    await request('GET', '/api/admin/users', undefined, undefined, 401)
    await request('PATCH', `/api/admin/users/${b.id}/role`, undefined, { role: 'admin' }, 401, { origin })
    await request('GET', '/api/admin/users', b.cookie, undefined, 403)
    await patchRole(b.cookie, c.id, 'owner', 403)
    await request('POST', '/api/admin/bootstrap', undefined, {}, 401)
  })
  await check('owner can list users and promote admin; admin can list but cannot edit roles', async () => {
    const list = (await request('GET', '/api/admin/users', a.cookie)).json()
    for (const user of list.items) assert.deepEqual(Object.keys(user).sort(), ['created_at', 'email', 'id', 'name', 'role'])
    assert.equal((await patchRole(a.cookie, c.id, 'admin')).json().role, 'admin')
    await request('GET', '/api/admin/users', c.cookie)
    await patchRole(c.cookie, b.id, 'owner', 403)
  })
  await check('bounded stable pagination and invalid/extra parameters', async () => {
    const first = (await request('GET', '/api/admin/users?page=1&pageSize=1', a.cookie)).json()
    const second = (await request('GET', '/api/admin/users?page=2&pageSize=1', a.cookie)).json()
    assert.equal(first.items[0].id, a.id)
    assert.equal(second.items[0].id, b.id)
    assert.equal(first.total, 4)
    for (const query of ['page=0', 'page=1.5', 'page=-1', 'pageSize=101', 'pageSize=0', 'page=1000001', 'page=1&page=2', 'role=owner']) {
      await request('GET', `/api/admin/users?${query}`, a.cookie, undefined, 400)
    }
  })
  await check('last owner cannot be demoted; idempotent owner assignment is safe', async () => {
    await patchRole(a.cookie, a.id, 'user', 409)
    await patchRole(a.cookie, a.id, 'admin', 409)
    assert.equal((await patchRole(a.cookie, a.id, 'owner')).json().role, 'owner')
  })
  await check('strict ID/body whitelist prevents malformed roles and mass assignment', async () => {
    for (const id of ['0', '-1', '1.2', '1e2', '01', '9007199254740992', 'abc']) {
      await request('PATCH', `/api/admin/users/${id}/role`, a.cookie, { role: 'admin' }, 400, { origin })
    }
    for (const body of [{}, { role: 'superadmin' }, { role: null }, { role: 'Owner' }, { role: 'admin', name: 'changed' }, ['owner']]) {
      await request('PATCH', `/api/admin/users/${b.id}/role`, a.cookie, body, 400, { origin })
    }
    await patchRole(a.cookie, 999999, 'admin', 404)
    assert.equal((db.prepare('SELECT name FROM users WHERE id=?').get(b.id) as { name: string }).name, 'roleB')
  })
  await check('role writes reject missing/host-forged/foreign origins, accept actual Vite proxy source', async () => {
    await request('PATCH', `/api/admin/users/${c.id}/role`, a.cookie, { role: 'admin' }, 403)
    for (const attacker of ['https://attacker.test', 'null', 'http://127.0.0.1:5318.attacker.test', 'http://127.0.0.1:5318/']) {
      await request('PATCH', `/api/admin/users/${c.id}/role`, a.cookie, { role: 'admin' }, 403, { origin: attacker, host: 'attacker.test', 'x-forwarded-host': 'attacker.test' })
    }
    await request('PATCH', `/api/admin/users/${c.id}/role`, a.cookie, { role: 'admin' }, 200, { origin: 'http://127.0.0.1:5310' })
  })
  await check('configured production origin is exact and excludes default development origins', async () => {
    process.env.APP_ORIGIN = 'https://sparkwright.example.test'
    process.env.NODE_ENV = 'production'
    const deployed = await buildApp({}, false)
    try {
      for (const rejected of [origin, 'http://127.0.0.1:5310', 'https://sparkwright.example.test.attacker.test']) {
        const response = await deployed.inject({ method: 'PATCH', url: `/api/admin/users/${c.id}/role`, headers: { cookie: a.cookie, origin: rejected }, payload: { role: 'admin' } })
        assert.equal(response.statusCode, 403)
      }
      const allowed = await deployed.inject({ method: 'PATCH', url: `/api/admin/users/${c.id}/role`, headers: { cookie: a.cookie, origin: 'https://sparkwright.example.test', host: 'internal-api.test' }, payload: { role: 'admin' } })
      assert.equal(allowed.statusCode, 200)
    } finally { await deployed.close(); delete process.env.APP_ORIGIN; process.env.NODE_ENV = 'development' }
  })
  await check('spoofed client headers and signed JWT role/name claims cannot grant permission', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const payload = Buffer.from(JSON.stringify({ sub: b.id, name: 'forged-name', role: 'owner', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')
    const signature = createHmac('sha256', process.env.AUTH_SECRET!).update(`${header}.${payload}`).digest('base64url')
    const cookie = `ideabox_session=${header}.${payload}.${signature}`
    assert.equal((await request('GET', '/api/auth/me', cookie)).json().user.name, 'roleB')
    await request('GET', '/api/admin/users', cookie, undefined, 403, { 'x-role': 'owner' })
    await request('PATCH', `/api/admin/users/${b.id}/role`, cookie, { role: 'owner' }, 403, { origin })
    await request('GET', '/api/admin/users', `${cookie}x`, undefined, 401)
  })
  const bIdea = (await request('POST', '/api/ideas', b.cookie, { title: 'private-B', content: 'private-B-content' })).json()
  const bProject = (await request('POST', '/api/dev', b.cookie, { name: 'private-B-project' })).json()
  await request('PUT', '/api/settings', b.cookie, { model: 'private-B-model', apiKey: 'private-B-fixture' })
  for (const [label, actor] of [['user', b], ['admin', c], ['owner', a]] as const) {
    // Use a different ordinary account when checking the user role against B.
    const testActor = label === 'user' ? await register('privateA') : actor
    await check(`${label} retains only own ideas/projects/settings; no administrator ownership bypass`, async () => {
      const ownIdea = (await request('POST', '/api/ideas', testActor.cookie, { title: `own-${label}` })).json()
      const ownProject = (await request('POST', '/api/dev', testActor.cookie, { name: `own-${label}` })).json()
      await request('GET', `/api/ideas/${ownIdea.id}`, testActor.cookie)
      await request('PATCH', `/api/dev/${ownProject.id}`, testActor.cookie, { name: `own-updated-${label}` })
      await request('GET', `/api/ideas/${bIdea.id}`, testActor.cookie, undefined, 404)
      await request('PATCH', `/api/ideas/${bIdea.id}`, testActor.cookie, { title: 'stolen' }, 404)
      await request('PATCH', `/api/dev/${bProject.id}`, testActor.cookie, { name: 'stolen' }, 404)
      const projects = (await request('GET', `/api/dev?userId=${b.id}`, testActor.cookie)).json()
      assert.equal(projects.some((project: { id: number }) => project.id === bProject.id), false)
      assert.equal((await request('GET', `/api/settings/reveal?userId=${b.id}`, testActor.cookie)).json().apiKey, null)
      await request('PUT', '/api/settings', testActor.cookie, { userId: b.id, model: `own-${label}` })
      assert.equal((await request('GET', '/api/settings', b.cookie)).json().model, 'private-B-model')
    })
  }
  await check('administrative database errors return safe messages without SQL/path details', async () => {
    db.exec("CREATE TRIGGER smoke_error BEFORE UPDATE OF role ON users BEGIN SELECT RAISE(ABORT, 'SQL sentinel C:/private/path'); END")
    try {
      const response = await patchRole(a.cookie, c.id, 'admin', 500)
      assert.deepEqual(response.json(), { error: { message: '管理操作失败，请稍后重试', code: 'admin_operation_failed' } })
    } finally { db.exec('DROP TRIGGER smoke_error') }
  })
  await check('admin demotion invalidates privileges on its original cookie immediately', async () => {
    await patchRole(a.cookie, c.id, 'user')
    await request('GET', '/api/admin/users', c.cookie, undefined, 403)
    assert.equal((await request('GET', '/api/auth/me', c.cookie)).json().user.role, 'user')
  })
  await check('multiple owners can self-demote; the old cookie immediately loses owner rights', async () => {
    await patchRole(a.cookie, c.id, 'owner')
    await patchRole(a.cookie, a.id, 'admin')
    await request('GET', '/api/admin/users', a.cookie)
    await patchRole(a.cookie, b.id, 'admin', 403)
    await patchRole(c.cookie, a.id, 'user')
    await request('GET', '/api/admin/users', a.cookie, undefined, 403)
    await patchRole(c.cookie, c.id, 'user', 409)
  })
  await check('competing owner demotions keep exactly one owner in immediate transactions', async () => {
    await patchRole(c.cookie, a.id, 'owner')
    const responses = await Promise.all([app.inject({ method: 'PATCH', url: `/api/admin/users/${a.id}/role`, headers: { cookie: a.cookie, origin }, payload: { role: 'user' } }), app.inject({ method: 'PATCH', url: `/api/admin/users/${c.id}/role`, headers: { cookie: c.cookie, origin }, payload: { role: 'user' } })])
    assert.deepEqual(responses.map((response) => response.statusCode).sort(), [200, 409])
    assert.equal((db.prepare("SELECT count(*) n FROM users WHERE role='owner'").get() as { n: number }).n, 1)
  })
  await check('unknown database roles fail closed even with a previously valid session', async () => {
    db.pragma('ignore_check_constraints = ON')
    db.prepare("UPDATE users SET role='superadmin' WHERE id=?").run(b.id)
    try {
      await request('GET', '/api/admin/users', b.cookie, undefined, 401)
      await request('GET', '/api/ideas', b.cookie, undefined, 401)
      assert.equal((await request('GET', '/api/auth/me', b.cookie)).json().user, null)
      assert.throws(() => migrateUserRoles(db), /迁移冲突/)
    } finally { db.prepare("UPDATE users SET role='user' WHERE id=?").run(b.id); db.pragma('ignore_check_constraints = OFF') }
  })
  await check('legacy nickname cannot be claimed; normal login/logout/session restoration still work', async () => {
    await request('POST', '/api/auth/register', undefined, { name: 'incomplete-legacy', email: 'claim@test.invalid', password: 'fixture-password-123', role: 'owner' }, 400)
    await request('POST', '/api/auth/register', undefined, { name: 'incomplete-legacy', email: 'claim@test.invalid', password: 'fixture-password-123', role: 'owner', ...await mailbox.proof(app, 'claim@test.invalid') }, 409)
    const login = await request('POST', '/api/auth/login', undefined, { email: 'ROLEB@test.invalid', password: 'fixture-password-123' })
    assert.equal(login.json().role, 'user')
    assert.deepEqual(Object.keys(login.json()).sort(), ['created_at', 'email', 'id', 'name', 'role'])
    const cookie = String(login.headers['set-cookie']).split(';')[0]
    assert.equal((await request('GET', '/api/auth/me', cookie)).json().user.id, b.id)
    const logout = await request('POST', '/api/auth/logout', cookie)
    assert.match(String(logout.headers['set-cookie']), /Max-Age=0/)
    assert.equal((await request('GET', '/api/auth/me')).json().user, null)
    await request('POST', '/api/auth/login', undefined, { email: 'roleB@test.invalid', password: 'incorrect' }, 401)
  })
  const ownerId = (db.prepare("SELECT id FROM users WHERE role='owner'").get() as { id: number }).id
  const owner = [a, c].find((user) => user.id === ownerId)!
  const administrator = await register('noticeAdmin')
  await patchRole(owner.cookie, administrator.id, 'admin')
  const readerA = await register('noticeReaderA')
  const readerB = await register('noticeReaderB')
  const summary = async (cookie: string) => (await request('GET', '/api/notification-summary', cookie)).json() as { notifications_unread: number; announcements_unread: number; total_unread: number }
  const adminPost = (url: string, body?: unknown, status = 200, cookie = administrator.cookie) => request('POST', url, cookie, body, status, { origin })
  const adminPatch = (id: number, body: unknown, status = 200) => request('PATCH', `/api/admin/announcements/${id}`, administrator.cookie, body, status, { origin })
  await check('stage2 foreign keys and separate announcement tables; no seeded announcements', async () => {
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1)
    assert.equal((await request('GET', '/api/announcements', readerA.cookie)).json().total, 0)
    assert.throws(() => db.prepare('INSERT INTO announcement_reads VALUES (999999, ?, ?)').run(readerA.id, '2026-01-01'))
  })
  const addNotification = (id: number, type = 'comment', ref: number | null = 123) => Number(db.prepare('INSERT INTO notifications (user_id,type,ref_id,actor_id,content) VALUES (?,?,?,?,?)').run(id, type, ref, id, 'fixture-notification').lastInsertRowid)
  const noticeA = addNotification(readerA.id)
  addNotification(readerA.id)
  const noticeB = addNotification(readerB.id)
  await check('notification summary counts all rows, independent of current list page', async () => {
    const first = (await request('GET', '/api/notifications?pageSize=1', readerA.cookie)).json()
    assert.equal(first.items.length, 1)
    assert.equal(first.total, 2)
    assert.equal(first.unread, 2)
    assert.equal((await summary(readerA.cookie)).total_unread, 2)
  })
  await check('all roles cannot mark someone else notifications; body cannot override identity', async () => {
    for (const actor of [owner, administrator, readerB]) {
      await request('POST', `/api/notifications/${noticeA}/read`, actor.cookie, undefined, 404)
      await request('POST', '/api/notifications/read-all', actor.cookie, { user_id: readerA.id }, 400)
      await request('GET', `/api/notifications?user_id=${readerA.id}`, actor.cookie, undefined, 400)
    }
    assert.equal((await summary(readerA.cookie)).notifications_unread, 2)
  })
  await check('single notification read is idempotent and never changes another user', async () => {
    for (let i = 0; i < 2; i++) await request('POST', `/api/notifications/${noticeA}/read`, readerA.cookie)
    assert.equal((await summary(readerA.cookie)).notifications_unread, 1)
    assert.equal((await summary(readerB.cookie)).notifications_unread, 1)
    for (const id of ['0', '-1', '1.2', '01', '9007199254740992']) await request('POST', `/api/notifications/${id}/read`, readerA.cookie, undefined, 400)
  })
  await check('summary and legacy list share followup generation and do not recreate a read reminder', async () => {
    db.prepare('INSERT INTO consult_items (user_id,client,next_follow_up) VALUES (?,?,?)').run(readerA.id, 'overdue-fixture', '2020-01-01')
    const first = await summary(readerA.cookie)
    assert.equal(first.notifications_unread, 2)
    const rows = (await request('GET', '/api/notifications', readerA.cookie)).json()
    assert.equal(rows.items.length, 3)
    for (let i = 0; i < 2; i++) await request('POST', '/api/notifications/read-all', readerA.cookie)
    await summary(readerA.cookie)
    const after = (await request('GET', '/api/notifications', readerA.cookie)).json()
    assert.equal(after.items.length, 3)
    assert.equal(after.unread, 0)
    assert.equal((await summary(readerB.cookie)).notifications_unread, 1)
  })
  await check('draft creation requires admin, valid Origin, strict field whitelist and current author', async () => {
    await request('POST', '/api/admin/announcements', undefined, { title: 'x', content: 'x' }, 401, { origin })
    await adminPost('/api/admin/announcements', { title: 'x', content: 'x' }, 403, readerB.cookie)
    await request('POST', '/api/admin/announcements', administrator.cookie, { title: 'x', content: 'x' }, 403)
    await adminPost('/api/admin/announcements', { title: 'x', content: 'x', created_by: readerB.id }, 400)
    await adminPost('/api/admin/announcements', { title: 'x', content: 'x', status: 'published' }, 400)
    await adminPost('/api/admin/announcements', { title: ' ', content: 'x' }, 400)
    await adminPost('/api/admin/announcements', { title: 'x'.repeat(121), content: 'x' }, 400)
    await adminPost('/api/admin/announcements', { title: 'x', content: 'x'.repeat(10001) }, 400)
  })
  const draft = (await adminPost('/api/admin/announcements', { title: '  fixture-announcement  ', content: ' line1\nline2 ' })).json()
  await check('drafts are invisible to every role on ordinary list/detail/read/summary', async () => {
    assert.equal(draft.title, 'fixture-announcement')
    assert.equal(draft.created_by, administrator.id)
    assert.equal(draft.status, 'draft')
    assert.equal(draft.published_at, null)
    for (const actor of [owner, administrator, readerA, readerB]) {
      assert.equal((await request('GET', '/api/announcements', actor.cookie)).json().total, 0)
      await request('GET', `/api/announcements/${draft.id}`, actor.cookie, undefined, 404)
      await request('POST', `/api/announcements/${draft.id}/read`, actor.cookie, undefined, 404)
      assert.equal((await summary(actor.cookie)).announcements_unread, 0)
    }
    assert.equal((await request('GET', '/api/admin/announcements', administrator.cookie)).json().items[0].id, draft.id)
    await request('GET', '/api/admin/announcements', readerA.cookie, undefined, 403)
  })
  await check('user cannot edit, publish or withdraw; manager author and timestamps cannot be mass assigned', async () => {
    await request('PATCH', `/api/admin/announcements/${draft.id}`, readerA.cookie, { title: 'stolen' }, 403, { origin })
    for (const action of ['publish', 'unpublish']) await adminPost(`/api/admin/announcements/${draft.id}/${action}`, undefined, 403, readerA.cookie)
    await adminPatch(draft.id, { created_by: readerA.id }, 400)
    await adminPatch(draft.id, { updated_at: 'forged' }, 400)
    await adminPatch(draft.id, { status: 'published' }, 400)
  })
  await check('publication is idempotent and gives each user independent unread state', async () => {
    const published = (await adminPost(`/api/admin/announcements/${draft.id}/publish`)).json()
    const repeat = (await adminPost(`/api/admin/announcements/${draft.id}/publish`)).json()
    assert.equal(repeat.published_at, published.published_at)
    assert.equal(repeat.updated_at, published.updated_at)
    assert.equal((await summary(readerA.cookie)).announcements_unread, 1)
    assert.equal((await summary(readerB.cookie)).announcements_unread, 1)
    for (let i = 0; i < 2; i++) await request('POST', `/api/announcements/${draft.id}/read`, readerA.cookie)
    assert.equal((await summary(readerA.cookie)).announcements_unread, 0)
    assert.equal((await summary(readerB.cookie)).announcements_unread, 1)
    assert.equal((db.prepare('SELECT count(*) n FROM announcement_reads WHERE announcement_id=? AND user_id=?').get(draft.id, readerA.id) as { n: number }).n, 1)
  })
  await check('editing and withdraw/re-publish preserve reads; draft read-all cannot read hidden content', async () => {
    await adminPatch(draft.id, { content: 'edited pure text' })
    assert.equal((await summary(readerA.cookie)).announcements_unread, 0)
    for (let i = 0; i < 2; i++) await adminPost(`/api/admin/announcements/${draft.id}/unpublish`)
    await request('GET', `/api/announcements/${draft.id}`, readerB.cookie, undefined, 404)
    await request('POST', `/api/announcements/${draft.id}/read`, readerB.cookie, undefined, 404)
    await request('POST', '/api/announcements/read-all', readerB.cookie)
    assert.equal((await summary(readerB.cookie)).announcements_unread, 0)
    assert.equal((db.prepare('SELECT count(*) n FROM announcement_reads WHERE announcement_id=? AND user_id=?').get(draft.id, readerB.id) as { n: number }).n, 0)
    await adminPost(`/api/admin/announcements/${draft.id}/publish`)
    assert.equal((await summary(readerA.cookie)).announcements_unread, 0)
    assert.equal((await summary(readerB.cookie)).announcements_unread, 1)
    const fresh = await register('newNoticeReader')
    assert.equal((await summary(fresh.cookie)).announcements_unread, 1)
  })
  const second = (await adminPost('/api/admin/announcements', { title: 'second', content: '<script>window.fixtureXss=true</script>\nplain text' })).json()
  await adminPost(`/api/admin/announcements/${second.id}/publish`)
  await check('announcement count covers all pages; list is stable and does not mark titles read', async () => {
    const first = (await request('GET', '/api/announcements?pageSize=1', readerB.cookie)).json()
    const next = (await request('GET', '/api/announcements?page=2&pageSize=1', readerB.cookie)).json()
    assert.equal(first.items.length, 1)
    assert.equal(first.total, 2)
    assert.equal(first.items[0].id, second.id)
    assert.equal(next.items[0].id, draft.id)
    assert.equal(first.items[0].is_read, false)
    assert.equal((await summary(readerB.cookie)).announcements_unread, 2)
    assert.equal(first.items[0].content, '<script>window.fixtureXss=true</script>\nplain text')
    assert.equal((await summary(readerB.cookie)).total_unread, 3)
  })
  await check('read-all affects only its Tab and user and is idempotent', async () => {
    await request('POST', '/api/notifications/read-all', readerB.cookie)
    assert.deepEqual(await summary(readerB.cookie), { notifications_unread: 0, announcements_unread: 2, total_unread: 2 })
    for (let i = 0; i < 2; i++) await request('POST', '/api/announcements/read-all', readerB.cookie)
    assert.deepEqual(await summary(readerB.cookie), { notifications_unread: 0, announcements_unread: 0, total_unread: 0 })
    assert.equal((await summary(readerA.cookie)).announcements_unread, 1)
    await request('POST', `/api/announcements/${second.id}/read`, readerA.cookie, { user_id: readerB.id }, 400)
    await request('POST', '/api/announcements/read-all', readerA.cookie, { user_id: readerB.id }, 400)
    addNotification(readerB.id)
    await request('POST', '/api/announcements/read-all', readerB.cookie)
    assert.equal((await summary(readerB.cookie)).notifications_unread, 1)
  })
  await check('safe actions accept HTTPS or root paths; reject scripts, credentials, slashes and incomplete pair', async () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,test', 'file:///test', '//evil.test', '/\\evil.test', '/%2f%2fevil.test', 'https://user:password@example.test/', 'https://example.test/%0a', 'http://example.test', 'https://example.test/\\bad']) {
      assert.equal(safeActionUrl(url), null)
      await adminPatch(draft.id, { action_label: 'unsafe', action_url: url }, 400)
    }
    await adminPatch(draft.id, { action_label: 'only text', action_url: null }, 400)
    await adminPatch(draft.id, { action_label: null, action_url: '/settings' }, 400)
    assert.equal((await adminPatch(draft.id, { action_label: '设置', action_url: '/settings' })).json().action_url, '/settings')
    assert.equal((await adminPatch(draft.id, { action_label: '外链', action_url: 'https://example.test/docs' })).json().action_url, 'https://example.test/docs')
    await adminPatch(draft.id, { action_label: '', action_url: '' })
  })
  await check('GitHub framework accepts exact repository URL and safely disables missing or hostile values', () => {
    for (const url of [undefined, '', 'https://github.com.attacker.test/owner/repo', 'https://github.com@evil.test/owner/repo', 'http://github.com/owner/repo', '//github.com/owner/repo', 'https://github.com/owner', 'https://github.com/owner/repo/issues', 'https://github.com/owner/repo?token=example', 'https://github.com:8080/owner/repo']) assert.equal(githubRepositoryUrl(url), null)
    assert.equal(githubRepositoryUrl('https://github.com/fixture-owner/fixture-repo'), 'https://github.com/fixture-owner/fixture-repo')
  })
  await check('notification target mapping only uses supported type and validated ID', () => {
    for (const type of ['like', 'comment', 'mention']) assert.equal(notificationTarget({ type, ref_id: 2 }), '/plaza/2')
    assert.equal(notificationTarget({ type: 'followup', ref_id: 2 }), '/consult')
    for (const ref_id of [null, 0, -1, 2.1, Number.MAX_SAFE_INTEGER + 1]) assert.equal(notificationTarget({ type: 'like', ref_id }), null)
    assert.equal(notificationTarget({ type: 'unknown-legacy', ref_id: 2 }), null)
  })
  await check('malformed IDs, pagination and manager publication payloads fail without changing state', async () => {
    for (const base of ['/api/notifications', '/api/announcements', '/api/admin/announcements']) {
      for (const query of ['page=0', 'page=1.5', 'pageSize=101', 'page=1&page=2']) await request('GET', `${base}?${query}`, administrator.cookie, undefined, 400)
    }
    await request('GET', '/api/announcements/0', readerA.cookie, undefined, 400)
    await request('GET', '/api/announcements/999999', readerA.cookie, undefined, 404)
    await adminPost(`/api/admin/announcements/${draft.id}/publish`, { status: 'published' }, 400)
    await adminPatch(999999, { title: 'missing' }, 404)
    assert.equal((db.prepare('SELECT read FROM notifications WHERE id=?').get(noticeB) as { read: number }).read, 1)
  })
  await check('old admin cookie loses all announcement management rights immediately after demotion', async () => {
    await patchRole(owner.cookie, administrator.id, 'user')
    await request('GET', '/api/admin/announcements', administrator.cookie, undefined, 403)
    await adminPost('/api/admin/announcements', { title: 'x', content: 'x' }, 403)
    await adminPatch(draft.id, { title: 'x' }, 403)
    for (const action of ['publish', 'unpublish']) await adminPost(`/api/admin/announcements/${draft.id}/${action}`, undefined, 403)
  })
  await runDataSmoke(app, db, root, temp, owner, check, mailbox)
  await runAdminSmoke(app, db, root, owner, check, mailbox)
  console.log(`SMOKE PASSED: ${checks} scenarios; isolated fixtures only`)
} finally {
  await app.close()
  db.close()
  process.chdir(previousCwd)
  assert.ok(path.resolve(temp).startsWith(path.join(os.tmpdir(), 'sparkwright-role-smoke-')))
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
}
