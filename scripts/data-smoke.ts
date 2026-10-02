// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict'
import type { FastifyInstance } from 'fastify'
import Database from 'better-sqlite3'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import type { testMailbox } from './test-mailbox'

type Actor = { id: number; cookie: string }
type Check = (label: string, work: () => unknown | Promise<unknown>) => Promise<void>
type Export = { export_version: number; user: { id: number }; data: Record<string, Record<string, any>[]>; excluded: Record<string, unknown> }

export async function runDataSmoke(app: FastifyInstance, db: Database.Database, root: string, temp: string, currentOwner: Actor, check: Check, mailbox: ReturnType<typeof testMailbox>): Promise<void> {
  assert.equal(process.cwd(), temp)
  const origin = 'http://127.0.0.1:5318'
  const backups = path.join(temp, 'data/backups')
  const request = async (method: 'GET' | 'POST' | 'PATCH', url: string, actor?: Actor, body?: unknown, status = 200, extra: Record<string, string> = {}) => {
    const result = await app.inject({ method, url, headers: { ...(actor ? { cookie: actor.cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra }, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) })
    assert.equal(result.statusCode, status, `${method} ${url} status`)
    return result
  }
  const register = async (name: string): Promise<Actor> => {
    const result = await request('POST', '/api/auth/register', undefined, { name, email: `${name}@test.invalid`, password: 'fixture-password-123', ...await mailbox.proof(app, `${name}@test.invalid`) })
    return { id: result.json().id, cookie: String(result.headers['set-cookie']).split(';')[0] }
  }
  const a = await register('data-user-A'), b = await register('data-user-B'), owner = await register('data-owner'), admin = await register('data-admin')
  for (const [actor, role] of [[owner, 'owner'], [admin, 'admin']] as const) await request('PATCH', `/api/admin/users/${actor.id}/role`, currentOwner, { role }, 200, { origin })
  const create = (actor = owner, status = 200, body?: unknown, headers: Record<string, string> = { origin }) => request('POST', '/api/admin/backups', actor, body, status, headers)
  const insert = (table: string, values: Record<string, unknown>) => Number(db.prepare(`INSERT INTO ${table} (${Object.keys(values).join(',')}) VALUES (${Object.keys(values).map(() => '?').join(',')})`).run(...Object.values(values)).lastInsertRowid)
  const ownKey = 'fixture-personal-A-secret-value', platformKey = 'fixture-platform-secret-value'
  process.env.AI_API_KEY = platformKey
  const hash = (db.prepare('SELECT password_hash FROM users WHERE id = ?').get(a.id) as { password_hash: string }).password_hash
  insert('user_settings', { user_id: a.id, api_key: ownKey, base_url: 'https://login:fixture-url-password@test.invalid/v1?api_key=fixture-url-token', model: 'safe-model-A', updated_at: '2026-09-29' })
  insert('user_settings', { user_id: b.id, api_key: 'private-B-key-do-not-export', model: 'private-B-model-do-not-export' })
  const ai = insert('ideas', { user_id: a.id, title: 'own-A-idea', content: `${ownKey} ${platformKey} ${process.env.AUTH_SECRET} ${hash} ${a.cookie} Authorization: Bearer unknown-header-token https://login:fixture-url-password@test.invalid/v1?api_key=fixture-url-token` })
  const bi = insert('ideas', { user_id: b.id, title: 'PRIVATE-B-TITLE', content: 'PRIVATE-B-CONTENT' })
  const pub = insert('ideas', { user_id: b.id, title: 'SHARED-B-TITLE-NOT-COPIED', content: 'SHARED-B-BODY-NOT-COPIED', is_public: 1 })
  const astep = insert('plan_steps', { idea_id: ai, title: 'own-A-step' })
  const bstep = insert('plan_steps', { idea_id: bi, title: 'PRIVATE-B-STEP' })
  insert('ai_messages', { idea_id: ai, user_id: a.id, role: 'assistant', content: 'own-A-AI-message' })
  insert('ai_messages', { idea_id: bi, user_id: a.id, role: 'assistant', content: 'PRIVATE-B-MISOWNED-AI' })
  insert('ai_messages', { idea_id: ai, user_id: b.id, role: 'assistant', content: 'PRIVATE-B-USER-AI' })
  insert('idea_scores', { idea_id: ai, user_id: a.id, score: 80, summary: 'own-score', dimensions: JSON.stringify([{ name: 'safe dimension', api_key: 'unknown-nested-key', nested: { Authorization: 'Bearer nested-unknown-token' }, note: ownKey }]) })
  insert('idea_scores', { idea_id: bi, user_id: a.id, score: 80, summary: 'PRIVATE-B-MISOWNED-SCORE' })
  const ap = insert('dev_projects', { user_id: a.id, name: 'own-A-project', description: 'own-A-description', source_idea_id: bi })
  const bp = insert('dev_projects', { user_id: b.id, name: 'PRIVATE-B-PROJECT' })
  for (const [project, label] of [[ap, 'own-A'], [bp, 'PRIVATE-B']] as const) {
    insert('dev_tasks', { project_id: project, title: `${label}-TASK` })
    insert('dev_milestones', { project_id: project, title: `${label}-MILESTONE` })
    insert('dev_logs', { project_id: project, content: `${label}-LOG` })
  }
  const ao = insert('order_leads', { user_id: a.id, title: 'own-A-order', url: 'https://test.invalid/order', matched_project_id: bp, match_raw: 'RAW-ORDER-EXCLUDED' })
  const bo = insert('order_leads', { user_id: b.id, title: 'PRIVATE-B-ORDER', url: 'https://test.invalid/private' })
  db.prepare('UPDATE dev_projects SET source_lead_id = ? WHERE id = ?').run(bo, ap)
  for (const [lead, project, reason] of [[ao, ap, 'own-A-match'], [ao, bp, 'PRIVATE-B-CROSS-MATCH'], [bo, ap, 'PRIVATE-B-CROSS-LEAD']] as const) insert('order_matches', { lead_id: lead, project_id: project, score: 80, reasons: reason })
  insert('idea_order_scores', { idea_id: ai, user_id: a.id, order_id: ao, score: 80, reasons: 'own-A-idea-order' })
  insert('idea_order_scores', { idea_id: ai, user_id: a.id, order_id: bo, score: 80, reasons: 'PRIVATE-B-CROSS-IDEA-ORDER' })
  const astudio = insert('studio_projects', { user_id: a.id, source_idea_id: bi, title: 'own-A-studio', brief: 'own-A-brief', characters: JSON.stringify([{ name: 'safe person', nested: { apiKey: 'unknown-character-secret' }, note: ownKey }]).replace(ownKey, '\\u0066' + ownKey.slice(1)), tools_raw: 'RAW-TOOLS-EXCLUDED' })
  const bstudio = insert('studio_projects', { user_id: b.id, title: 'PRIVATE-B-STUDIO', brief: 'PRIVATE-B-BRIEF' })
  const aw = insert('video_wishes', { user_id: a.id, source_idea_id: bi, adopted_studio_id: bstudio, title: 'own-A-wish', analysis_raw: 'RAW-ANALYSIS-EXCLUDED' })
  const bw = insert('video_wishes', { user_id: b.id, title: 'PRIVATE-B-WISH' })
  for (const [wish, studio, reasons] of [[aw, astudio, 'own-A-wish-match'], [aw, bstudio, 'PRIVATE-B-CROSS-WISH'], [bw, astudio, 'PRIVATE-B-CROSS-STUDIO']] as const) insert('wish_matches', { wish_id: wish, studio_id: studio, score: 80, reasons })
  insert('media_items', { user_id: a.id, title: 'own-A-media', source_idea_id: bi, studio_id: bstudio })
  insert('media_items', { user_id: b.id, title: 'PRIVATE-B-MEDIA' })
  const consult = insert('consult_items', { user_id: a.id, client: 'own-A-consult' })
  insert('consult_items', { user_id: b.id, client: 'PRIVATE-B-CONSULT' })
  insert('daily_plans', { user_id: a.id, plan_date: '2026-09-29', title: 'own-A-plan', source_step_id: bstep })
  insert('daily_plans', { user_id: b.id, plan_date: '2026-09-29', title: 'PRIVATE-B-PLAN', source_step_id: bstep })
  insert('daily_reviews', { user_id: a.id, review_date: '2026-09-29', content: 'own-A-review' })
  insert('daily_reviews', { user_id: b.id, review_date: '2026-09-29', content: 'PRIVATE-B-REVIEW' })
  insert('notifications', { user_id: a.id, type: 'like', ref_id: bi, actor_id: b.id, content: 'own-A-notification' })
  insert('notifications', { user_id: a.id, type: 'followup', ref_id: consult, actor_id: a.id, content: 'own-A-followup' })
  insert('notifications', { user_id: b.id, type: 'like', ref_id: bi, content: 'PRIVATE-B-NOTIFICATION' })
  const published = insert('announcements', { title: 'SHARED-ANNOUNCEMENT-NOT-COPIED', content: 'SHARED-ANNOUNCEMENT-BODY-NOT-COPIED', status: 'published', created_by: owner.id, created_at: '2026-09-29', updated_at: '2026-09-29', published_at: '2026-09-29' })
  const draft = insert('announcements', { title: 'PRIVATE-DRAFT-NOT-COPIED', content: 'PRIVATE-DRAFT-BODY-NOT-COPIED', created_by: owner.id, created_at: '2026-09-29', updated_at: '2026-09-29' })
  for (const announcement of [published, draft]) insert('announcement_reads', { announcement_id: announcement, user_id: a.id, read_at: '2026-09-29' })
  for (const idea of [pub, bi]) insert('plaza_likes', { user_id: a.id, idea_id: idea })
  const parent = insert('plaza_comments', { user_id: b.id, idea_id: pub, content: 'PRIVATE-B-COMMENT-BODY' })
  insert('plaza_comments', { user_id: a.id, idea_id: pub, parent_id: parent, content: 'own-A-comment' })
  insert('plaza_comments', { user_id: a.id, idea_id: bi, content: 'own-A-history-comment' })
  const publicChannel = (db.prepare("SELECT id FROM channels WHERE type = 'public' LIMIT 1").get() as { id: number }).id
  const privateChannel = insert('channels', { type: 'idea', idea_id: bi, name: 'PRIVATE-B-CHANNEL-NAME' })
  insert('messages', { user_id: b.id, channel_id: publicChannel, content: 'PRIVATE-B-MESSAGE' })
  insert('messages', { user_id: a.id, channel_id: publicChannel, content: 'own-A-public-message' })
  insert('messages', { user_id: a.id, channel_id: privateChannel, content: 'own-A-history-message' })
  insert('ai_raw_logs', { idea_id: ai, kind: 'fixture', request_prompt: 'RAW-AI-PROMPT-EXCLUDED', raw_response: 'RAW-AI-RESPONSE-EXCLUDED' })
  for (const actor of [owner, admin]) insert('ideas', { user_id: actor.id, title: `own-${actor.id}-idea`, content: 'role-own-record' })
  const tableNames = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((row) => row.name)
  const counts = () => tableNames.map((name) => (db.prepare(`SELECT count(*) n FROM ${name}`).get() as { n: number }).n)
  let exported: Export
  const ownFeedback = insert('user_feedback', { user_id:a.id,category:'bug',title:'own-A-feedback',content:'own-A-feedback-content',request_id:'export-fixture-A',content_hash:'export-fixture-A',created_at:'2026-09-29',updated_at:'2026-09-29' })
  const otherFeedback = insert('user_feedback', { user_id:b.id,category:'bug',title:'PRIVATE-B-feedback',content:'PRIVATE-B-feedback-content',request_id:'export-fixture-B',content_hash:'export-fixture-B',created_at:'2026-09-29',updated_at:'2026-09-29' })
  insert('feedback_events',{feedback_id:ownFeedback,actor_id:owner.id,kind:'public_reply',content:'own-A-public-reply',request_id:'export-reply',created_at:'2026-09-29'})
  insert('feedback_events',{feedback_id:ownFeedback,actor_id:owner.id,kind:'internal_note',content:'PRIVATE-B-internal-note',request_id:'export-note',created_at:'2026-09-29'})
  insert('feedback_events',{feedback_id:otherFeedback,actor_id:owner.id,kind:'public_reply',content:'PRIVATE-B-public-reply',request_id:'export-other',created_at:'2026-09-29'})
  insert('scoring_operations',{id:'own-A-operation',user_id:a.id,kind:'score',standard_version:'sparkwright-idea-v4.0.0',engine_hash:'fixture',prompt_hash:'fixture',status:'success',attempt_count:0,cache_status:'hit',telemetry_json:'{}',created_at:'2026-10-01'})
  insert('scoring_operations',{id:'PRIVATE-B-operation',user_id:b.id,kind:'score',standard_version:'sparkwright-idea-v4.0.0',engine_hash:'fixture',prompt_hash:'fixture',status:'success',attempt_count:0,cache_status:'hit',telemetry_json:'{}',created_at:'2026-10-01'})
  await check('stage3 export is an attachment with 28 scoped tables and no database mutation', async () => {
    const before = counts()
    const result = await request('GET', '/api/export/me', a)
    assert.match(String(result.headers['content-type']), /application\/json/)
    assert.match(String(result.headers['content-disposition']), /^attachment; filename="sparkwright-my-data-\d{4}-\d{2}-\d{2}\.json"$/)
    assert.equal(result.headers['cache-control'], 'no-store')
    exported = result.json()
    assert.equal(exported.export_version, 1); assert.equal(exported.user.id, a.id)
    assert.equal(Object.keys(exported.data).length, 28)
    assert.deepEqual(counts(), before)
    assert.ok(exported.data.plan_steps.some((row) => row.id === astep))
    for (const table of Object.keys(exported.data)) if (table !== 'synthesis_runs') assert.ok(exported.data[table].length > 0, `Expected own fixture in ${table}`)
    assert.deepEqual(exported.data.synthesis_runs, [])
  })
  await check('stage3 export omits other users, credentials, shared context and raw AI fields', async () => {
    const text = JSON.stringify(exported)
    for (const forbidden of ['PRIVATE-B-', 'SHARED-B-', 'private-B-key', 'private-B-model', 'data-user-B@test.invalid', 'SHARED-ANNOUNCEMENT-', 'PRIVATE-DRAFT-', 'RAW-', ownKey, platformKey, process.env.AUTH_SECRET!, hash, a.cookie, 'unknown-nested-key', 'nested-unknown-token', 'unknown-character-secret', 'unknown-header-token', 'fixture-url-password', 'fixture-url-token']) assert.ok(!text.includes(forbidden), 'Export contained excluded content or a credential marker')
    assert.ok(text.includes('[REDACTED]'))
    for (const table of ['users', 'channels', 'announcements', 'ai_raw_logs']) assert.ok(!(table in exported.data))
    assert.deepEqual(exported.data.user_settings[0], { model: 'safe-model-A', language: 'zh-CN', updated_at: '2026-09-29' })
  })
  await check('stage3 parent joins, two-ended matches and inaccessible references fail closed', async () => {
    assert.equal(exported.data.ai_messages.length, 1); assert.equal(exported.data.idea_scores.length, 1)
    for (const table of ['order_matches', 'idea_order_scores', 'wish_matches']) assert.equal(exported.data[table].length, 1)
    const referenceFields = { dev_projects: ['source_idea_id', 'source_lead_id'], order_leads: ['matched_project_id'], studio_projects: ['source_idea_id'], video_wishes: ['source_idea_id', 'adopted_studio_id'], media_items: ['source_idea_id', 'studio_id'], daily_plans: ['source_step_id'] }
    for (const [table, fields] of Object.entries(referenceFields)) for (const field of fields) assert.equal(exported.data[table][0][field], null)
    assert.equal(exported.data.notifications[0].ref_id, null); assert.equal(exported.data.notifications[0].actor_id, null)
    assert.equal(exported.data.notifications[1].ref_id, consult)
    assert.equal(exported.data.plaza_comments[0].parent_id, null)
    assert.equal(exported.data.plaza_likes.find((row) => row.idea_id === null)?.user_id, a.id)
    assert.equal(exported.data.messages[1].channel_id, null)
    assert.equal(exported.data.announcement_reads[1].announcement_id, null)
  })
  await check('stage3 every role exports only itself; query overrides and anonymous export are denied', async () => {
    await request('GET', '/api/export/me', undefined, undefined, 401)
    for (const actor of [a, admin, owner]) {
      const result = (await request('GET', '/api/export/me', actor)).json() as Export
      assert.equal(result.user.id, actor.id)
      assert.ok(result.data.ideas.every((row) => row.user_id === actor.id))
      await request('GET', `/api/export/me?userId=${b.id}`, actor, undefined, 400)
      await request('GET', '/api/export/me?all=true', actor, undefined, 400)
    }
  })
  await check('stage3 full backup is owner-only with exact origin and no client paths', async () => {
    for (const actor of [undefined, a, admin]) {
      const status = actor ? 403 : 401
      await request('POST', '/api/admin/backups', actor, undefined, status, { origin })
      await request('GET', '/api/admin/backups', actor, undefined, status)
      await request('GET', '/api/admin/backups/20260101T000000000Z-00000000000000000000000000000000/download', actor, undefined, status)
    }
    await create(owner, 403, undefined, {})
    await create(owner, 403, undefined, { origin: 'https://evil.test' })
    for (const body of [{ path: '../ideabox.db' }, { filename: 'x.db' }, { user_id: a.id }, []]) await create(owner, 400, body)
    await request('POST', '/api/admin/backups?path=x', owner, undefined, 400, { origin })
    await request('GET', '/api/admin/backups?pageSize=101', owner, undefined, 400)
  })
  db.pragma('wal_checkpoint(TRUNCATE)')
  db.pragma('wal_autocheckpoint = 0')
  const marker = insert('ideas', { user_id: a.id, title: 'WAL-COMMITTED-BEFORE-BACKUP', content: 'committed-before-backup' })
  db.transaction(() => { for (let i = 0; i < 180; i++) insert('ideas', { user_id: a.id, title: `scale-${i}`, content: 'scale-fixture-'.repeat(2000) }) })()
  assert.ok(statSync(path.join(temp, 'data/ideabox.db-wal')).size > 32)
  let backup!: { id: string; file_name: string; size_bytes: number }
  await check('stage3 backup lock rejects overlap while ordinary writes remain usable', async () => {
    const [first, second, business] = await Promise.all([create(), create(owner, 409), request('POST', '/api/ideas', a, { title: 'written-during-backup', content: 'concurrent-business-write' })])
    backup = first.json()
    assert.equal(second.json().error.code, 'backup_in_progress')
    assert.ok(business.json().id > 0)
    assert.deepEqual(Object.keys(backup).sort(), ['created_at', 'file_name', 'id', 'size_bytes'])
    assert.ok(backup.size_bytes > 0)
  })
  await check('stage3 WAL backup opens as a single downloaded DB without source sidecars', async () => {
    const result = await request('GET', `/api/admin/backups/${backup.id}/download`, owner)
    assert.equal(result.headers['content-type'], 'application/vnd.sqlite3')
    assert.equal(result.headers['cache-control'], 'no-store')
    assert.equal(result.headers['content-disposition'], `attachment; filename="${backup.file_name}"`)
    assert.equal(result.rawPayload.subarray(0, 16).toString(), 'SQLite format 3\u0000')
    const independent = path.join(temp, 'independent-backup-check')
    mkdirSync(independent)
    writeFileSync(path.join(independent, 'only.db'), result.rawPayload)
    assert.deepEqual(readdirSync(independent), ['only.db'])
    const copy = new Database(path.join(independent, 'only.db'), { readonly: true, fileMustExist: true })
    try {
      assert.equal(copy.pragma('integrity_check', { simple: true }), 'ok')
      assert.deepEqual(copy.pragma('foreign_key_check'), [])
      assert.ok(copy.prepare('SELECT 1 FROM ideas WHERE id = ? AND title = ?').get(marker, 'WAL-COMMITTED-BEFORE-BACKUP'))
      assert.ok(copy.prepare('SELECT 1 FROM user_settings WHERE user_id = ? AND api_key = ?').get(a.id, ownKey), 'Full backup keeps credentials and differs from personal export')
    } finally { copy.close() }
    const listed = (await request('GET', '/api/admin/backups?page=1&pageSize=1', owner)).json()
    assert.equal(listed.items[0].id, backup.id); assert.equal(listed.total, 1)
  })
  await check('stage3 owner demotion immediately rejects old-cookie creation, list and download', async () => {
    await request('PATCH', `/api/admin/users/${owner.id}/role`, currentOwner, { role: 'admin' }, 200, { origin })
    await create(owner, 403)
    await request('GET', '/api/admin/backups', owner, undefined, 403)
    await request('GET', `/api/admin/backups/${backup.id}/download`, owner, undefined, 403)
    await request('PATCH', `/api/admin/users/${owner.id}/role`, currentOwner, { role: 'owner' }, 200, { origin })
  })
  await check('stage3 unknown IDs, traversal and partial files never become downloads', async () => {
    await request('GET', '/api/admin/backups/../download', owner, undefined, 404) // URL normalization removes the ID segment before routing.
    for (const id of ['..%5Cideabox.db', '%2e%2e%2fideabox.db', 'C%3A%5Csecret.db', 'https%3A%2F%2Fevil.test', backup.id + '.part']) await request('GET', `/api/admin/backups/${id}/download`, owner, undefined, 400)
    await request('GET', '/api/admin/backups/20260101T000000000Z-00000000000000000000000000000000/download', owner, undefined, 404)
    await request('GET', `/api/admin/backups/${backup.id}/download?token=anything`, owner, undefined, 400)
    writeFileSync(path.join(backups, '20260101T000000000Z-00000000000000000000000000000000.part'), 'interrupted fixture')
    writeFileSync(path.join(backups, 'old-unmanaged.db'), 'unmanaged fixture')
    assert.equal((await request('GET', '/api/admin/backups', owner)).json().total, 1)
  })
  await check('stage3 linked files and junction directories are excluded and cannot escape backup root', async () => {
    const external = path.join(temp, 'external-link-target')
    mkdirSync(external)
    const linkedId = '20260101T000000000Z-11111111111111111111111111111111'
    const linked = path.join(backups, linkedId + '.db')
    symlinkSync(external, linked, 'junction')
    try {
      assert.equal((await request('GET', '/api/admin/backups', owner)).json().total, 1)
      await request('GET', `/api/admin/backups/${linkedId}/download`, owner, undefined, 404)
    } finally { rmSync(linked) }
    const fileLinkId = '20260101T000000000Z-22222222222222222222222222222222'
    const fileLink = path.join(backups, fileLinkId + '.db')
    let fileLinkCreated = false
    try { symlinkSync(path.join(backups, backup.file_name), fileLink, 'file'); fileLinkCreated = true }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error; console.log('INFO file symlink creation unavailable (EPERM); junction rejection is verified') }
    if (fileLinkCreated) {
      try {
        assert.equal((await request('GET', '/api/admin/backups', owner)).json().total, 1)
        await request('GET', `/api/admin/backups/${fileLinkId}/download`, owner, undefined, 404)
      } finally { rmSync(fileLink) }
    }
    const saved = path.join(temp, 'data/backups-saved')
    renameSync(backups, saved)
    symlinkSync(external, backups, 'junction')
    try {
      await create(owner, 500)
      await request('GET', '/api/admin/backups', owner, undefined, 500)
      assert.deepEqual(readdirSync(external), [])
    } finally { rmSync(backups); renameSync(saved, backups) }
  })
  await check('stage3 unavailable directory returns safe errors, releases lock and permits retry', async () => {
    const saved = path.join(temp, 'data/backups-saved')
    renameSync(backups, saved)
    writeFileSync(backups, 'not-a-directory')
    try {
      const failed = await create(owner, 500)
      assert.equal(failed.json().error.code, 'backup_failed')
      assert.ok(!failed.body.includes(temp) && !failed.body.includes('SQLITE_'))
    } finally { rmSync(backups); renameSync(saved, backups) }
    await create()
  })
  await check('stage3 transfer and integrity failures clean own partial files and release the lock', async () => {
    const before = (await request('GET', '/api/admin/backups', owner)).json().total
    const original = db.backup.bind(db)
    for (const corrupt of [false, true]) {
      db.backup = async (destination) => {
        writeFileSync(destination, 'INVALID-FIXTURE-DATABASE-HEADER')
        writeFileSync(destination + '-journal', 'fixture-sidecar')
        if (!corrupt) throw new Error('fixture_transfer_failure')
        return { totalPages: 0, remainingPages: 0 }
      }
      try { await create(owner, 500) } finally { db.backup = original }
      assert.equal((await request('GET', '/api/admin/backups', owner)).json().total, before)
      assert.ok(readdirSync(backups).filter((name) => name.endsWith('.part')).every((name) => name.startsWith('20260101T')))
      assert.ok(!readdirSync(backups).some((name) => /\.part-(?:wal|shm|journal)$/.test(name)))
    }
    await create()
  })
  await check('stage3 source and backup database bytes cannot be obtained through static fallback', async () => {
    for (const url of ['/data/ideabox.db', `/data/backups/${backup.file_name}`, `/backups/${backup.file_name}`, `/public/../data/backups/${backup.file_name}`]) {
      const result = await app.inject({ method: 'GET', url })
      assert.ok([200, 400, 404].includes(result.statusCode))
      assert.notEqual(result.rawPayload.subarray(0, 16).toString(), 'SQLite format 3\u0000')
      assert.ok(!result.rawPayload.equals(readFileSync(path.join(backups, backup.file_name))))
    }
    for (const url of ['/api/admin/backups/restore', '/api/export/import']) {
      const result = await app.inject({ method: 'POST', url, headers: { cookie: owner.cookie, origin } })
      assert.equal(result.statusCode, 404)
    }
  })
  await check('stage3 personal export does not silently truncate a multi-megabyte dataset', async () => {
    const start = performance.now()
    const result = await request('GET', '/api/export/me', a)
    const count = (db.prepare('SELECT count(*) n FROM ideas WHERE user_id = ?').get(a.id) as { n: number }).n
    assert.equal(result.json().data.ideas.length, count)
    assert.ok(Buffer.byteLength(result.body) > 4_000_000)
    console.log(`INFO stage3 isolated export: ${count} ideas, ${Buffer.byteLength(result.body)} bytes, ${Math.round(performance.now() - start)} ms`)
  })
  await check('stage3 upgraded legacy database supports backup and personal export across two startups', async () => {
    const loader = pathToFileURL(path.join(root, 'node_modules/tsx/dist/loader.mjs')).href
    for (let pass = 0; pass < 2; pass++) {
      const result = spawnSync(process.execPath, ['--import', loader, path.join(root, 'scripts/legacy-data-check.ts')], { cwd: path.join(temp, 'legacy'), env: process.env, encoding: 'utf8', windowsHide: true, timeout: 15000 })
      assert.equal(result.status, 0, `Legacy backup/export pass ${pass + 1}: ${result.stderr.slice(0, 350)}`)
    }
  })
  delete process.env.AI_API_KEY
  assert.ok(existsSync(path.join(backups, backup.file_name)))
}
