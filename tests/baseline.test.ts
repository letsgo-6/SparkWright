// SPDX-License-Identifier: MPL-2.0
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { kwScore, parseAiArray } from '../server/lib/hybrid-match'
import { deadlineInfo } from '../src/utils'
import { chatCompletion } from '../server/ai'
import { testMailbox } from '../scripts/test-mailbox'

const originalCwd = process.cwd()
const temp = mkdtempSync(path.join(os.tmpdir(), 'sparkwright-baseline-'))
process.chdir(temp)
process.env.AUTH_SECRET = randomBytes(48).toString('hex')
delete process.env.AI_API_KEY
delete process.env.ZAI_API_KEY
const { db } = await import('../server/db')
const { buildApp } = await import('../server/app')
const mailbox = testMailbox()
const app = await buildApp(mailbox.options)
let a: { id: number; cookie: string }
let b: { id: number; cookie: string }

async function request(method: string, url: string, cookie?: string, body?: unknown, status = 200) {
  const response = await app.inject({ method: method as any, url,
    headers: cookie ? { cookie, origin: 'http://127.0.0.1:5318' } : {}, payload: body as any })
  assert.equal(response.statusCode, status, `${method} ${url}: ${response.body}`)
  return response
}
const json = async (...args: Parameters<typeof request>) => (await request(...args)).json()
async function register(name: string) {
  const email = `${name}@test.invalid`
  const r = await request('POST', '/api/auth/register', undefined, { name, email, password: 'test-password-123', ...await mailbox.proof(app, email) })
  return { id: r.json().id, cookie: String(r.headers['set-cookie']).split(';')[0] }
}
async function idea(cookie = a.cookie) {
  return json('POST', '/api/ideas', cookie, { title: '私有测试灵感', content: 'React SQLite 简历生成工具' })
}
async function mockedAi<T>(reply: () => Response | Promise<Response>, work: () => Promise<T>) {
  const original = globalThis.fetch
  globalThis.fetch = (async () => reply()) as typeof fetch
  try { return await work() } finally { globalThis.fetch = original }
}
function enableAi(userId: number) {
  db.prepare('INSERT OR REPLACE INTO user_settings (user_id, base_url, api_key, model) VALUES (?, ?, ?, ?)')
    .run(userId, 'https://controlled.test.invalid', 'controlled-fixture', 'fixture')
}
function disableAi(userId: number) { db.prepare('DELETE FROM user_settings WHERE user_id = ?').run(userId) }

before(async () => { await app.ready(); a = await register('baselineA'); b = await register('baselineB'); db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(a.id) })
after(async () => {
  await app.close()
  db.close()
  process.chdir(originalCwd)
  assert.ok(path.resolve(temp).startsWith(path.join(os.tmpdir(), 'sparkwright-baseline-')))
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

test('B02: different members of a synonym group contribute to matching', () => {
  assert.equal(kwScore('resume', '简历').kwScore, 18)
  assert.equal(kwScore('简历', 'resume').kwScore, 18)
})
test('B03: AI arrays reject nonobjects, missing IDs and invalid scores', () => {
  for (const bad of ['[null]', '[1]', '[{}]', '[{"project_id":1,"score":"bad"}]']) {
    assert.equal(parseAiArray(bad, 'project_id').ok, false, bad)
  }
  assert.equal(parseAiArray('[{"project_id":1,"score":80,"reasons":"符合"}]', 'project_id').ok, true)
})
test('B04: a date-only deadline today is due today', () => {
  const now = new Date()
  const today = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`
  assert.equal(deadlineInfo(today)?.label, '今天到期')
  const fixed = new Date(2026, 8, 29, 12)
  assert.equal(deadlineInfo('2026-09-30', fixed)?.label, '还有 1 天')
  assert.equal(deadlineInfo('2026-09-28', fixed)?.label, '已逾期 1 天')
})
test('R03: matching a legacy nickname cannot claim its existing data', async () => {
  db.prepare('INSERT INTO users (name) VALUES (?)').run('legacyFixture')
  await request('POST', '/api/auth/register', undefined,
    { name: 'legacyFixture', email: 'claim@test.invalid', password: 'test-password-123' }, 400)
  await request('POST', '/api/auth/register', undefined, { name: 'legacyFixture', email: 'claim@test.invalid', password: 'test-password-123', ...await mailbox.proof(app, 'claim@test.invalid') }, 409)
  assert.equal((db.prepare('SELECT email FROM users WHERE name = ?').get('legacyFixture') as any).email, null)
})
test('R04/B01: tags persist and private resources reject another user', async () => {
  const i = await idea()
  await json('PATCH', `/api/ideas/${i.id}`, a.cookie, { tags: 'AI,React' })
  assert.equal((await json('GET', `/api/ideas/${i.id}`, a.cookie)).idea.tags, 'AI,React')
  await request('GET', `/api/ideas/${i.id}`, b.cookie, undefined, 404)
  await request('GET', '/api/ideas', undefined, undefined, 401)
})
test('R04: hidden scores and withdrawn comments are not returned to other users', async () => {
  const i = await idea()
  db.prepare('INSERT INTO idea_scores (idea_id,user_id,score,summary,dimensions,created_at) VALUES (?,?,99,?,?,?)')
    .run(i.id, a.id, '私有评分', '[]', new Date().toISOString())
  await json('POST', `/api/plaza/${i.id}/publish`, a.cookie, { scorePublic: false })
  const feed = await json('GET', '/api/plaza', b.cookie)
  assert.equal(feed.items.find((x: any) => x.id === i.id).score, null)
  await json('POST', `/api/plaza/${i.id}/comments`, b.cookie, { content: '公开评论' })
  await json('POST', `/api/plaza/${i.id}/unpublish`, a.cookie)
  await request('GET', `/api/plaza/${i.id}/comments`, b.cookie, undefined, 404)
})
test('R05: private idea channels enforce visibility on list, detail and messages', async () => {
  const i = await idea()
  const c = await json('POST', '/api/channels', a.cookie, { name: '私有灵感频道', ideaId: i.id })
  assert.equal((await json('GET', '/api/channels', b.cookie)).some((x: any) => x.id === c.id), false)
  await request('GET', `/api/channels/${c.id}`, b.cookie, undefined, 404)
  await request('GET', `/api/channels/${c.id}/messages`, b.cookie, undefined, 404)
  await request('POST', `/api/channels/${c.id}/messages`, b.cookie, { content: '越权消息' }, 404)
  await request('POST', '/api/channels', b.cookie, { name: '跨用户关联', ideaId: i.id }, 404)
  await json('POST', `/api/plaza/${i.id}/publish`, a.cookie, {})
  await request('GET', `/api/channels/${c.id}`, b.cookie)
  await json('POST', `/api/plaza/${i.id}/unpublish`, a.cookie)
  await request('GET', `/api/channels/${c.id}`, b.cookie, undefined, 404)
})
test('B11: channel history and increment cursor remain ascending and unique', async () => {
  const c = await json('POST', '/api/channels', a.cookie, { name: '公开基线频道' })
  const first = await json('POST', `/api/channels/${c.id}/messages`, a.cookie, { content: '第一条' })
  const second = await json('POST', `/api/channels/${c.id}/messages`, b.cookie, { content: '第二条' })
  assert.deepEqual((await json('GET', `/api/channels/${c.id}/messages`, a.cookie)).map((x: any) => x.id), [first.id,second.id])
  assert.deepEqual((await json('GET', `/api/channels/${c.id}/messages?after=${first.id}`, a.cookie)).map((x: any) => x.id), [second.id])
})
test('core: idea import is idempotent; imported tasks and task done state stay consistent', async () => {
  const i = await idea()
  const step = await json('POST', `/api/ideas/${i.id}/steps`, a.cookie, { title: '执行测试步骤' })
  await json('PATCH', `/api/steps/${step.id}`, a.cookie, { done: true })
  const imported = await json('POST', `/api/ideas/${i.id}/import-to-dev`, a.cookie)
  const repeated = await json('POST', `/api/ideas/${i.id}/import-to-dev`, a.cookie)
  assert.equal(repeated.created, false)
  assert.equal(imported.project.id, repeated.project.id)
  const p = (await json('GET', '/api/dev', a.cookie)).find((x: any) => x.id === imported.project.id)
  assert.equal(p.tasks[0].status, 'todo')
  assert.equal(p.tasks[0].done, 0)
  await request('PATCH', `/api/dev/tasks/${p.tasks[0].id}`, b.cookie, { status: 'done' }, 404)
  const t = await json('PATCH', `/api/dev/tasks/${p.tasks[0].id}`, a.cookie, { status: 'done' })
  assert.equal(t.done, 1)
})
test('core: notification unread changes are isolated and repeated polling does not duplicate', async () => {
  const i = await idea()
  await json('POST', `/api/plaza/${i.id}/publish`, a.cookie, {})
  await json('POST', `/api/plaza/${i.id}/like`, b.cookie)
  const initial = await json('GET', '/api/notifications', a.cookie)
  assert.ok(initial.items.some((x: any) => x.ref_id === i.id))
  assert.equal((await json('GET', '/api/notifications', a.cookie)).items.length, initial.items.length)
  await json('POST', '/api/notifications/read-all', b.cookie)
  assert.equal((await json('GET', '/api/notifications', a.cookie)).unread, initial.unread)
  await json('POST', '/api/notifications/read-all', a.cookie)
  assert.equal((await json('GET', '/api/notifications', a.cookie)).unread, 0)
})
test('B09: failed AI regeneration preserves an edited studio plan', async () => {
  const s = await json('POST', '/api/studio', a.cookie, { title: '保留方案', brief: '测试剧情' })
  await json('PATCH', `/api/studio/${s.id}`, a.cookie,
    { characters: '[{"name":"保留人物"}]', scenes: '[{"name":"保留场景"}]', tools: '[{"name":"保留工具"}]' })
  enableAi(a.id)
  try {
    const result = await mockedAi(() => Response.json({ choices:[{message:{content:'invalid JSON'}}] }),
      () => json('POST', `/api/studio/${s.id}/regenerate`, a.cookie))
    assert.equal(result.parseFailed, true)
    assert.equal(JSON.parse(result.project.characters)[0].name, '保留人物')
    assert.equal(JSON.parse(result.project.scenes)[0].name, '保留场景')
    assert.equal(JSON.parse(result.project.tools)[0].name, '保留工具')
  } finally { disableAi(a.id) }
})
test('B05: an incomplete AI stream is not persisted as a completed reply', async () => {
  const i = await idea()
  enableAi(a.id)
  try {
    await mockedAi(() => new Response('data: {"choices":[{"delta":{"content":"半截回复"}}]}\n\n',
      { headers: { 'content-type':'text/event-stream' } }),
      () => request('POST', `/api/ideas/${i.id}/ai/chat`, a.cookie, { message:'测试中断' }))
    const messages = await json('GET', `/api/ideas/${i.id}/ai/messages`, a.cookie)
    assert.equal(messages.some((m: any) => m.role === 'assistant'), false)
  } finally { disableAi(a.id) }
})
test('B06: ordinary AI calls provide a bounded timeout signal', async () => {
  const oldFetch = globalThis.fetch
  globalThis.fetch = (async (_url, options) => {
    assert.ok(options?.signal)
    return Response.json({ choices:[{message:{content:'ok'}}] })
  }) as typeof fetch
  try { assert.equal(await chatCompletion({ baseUrl:'https://controlled.test.invalid', apiKey:'fixture', model:'fixture', source:'user' },[]),'ok') }
  finally { globalThis.fetch = oldFetch }
})
test('B06: a controlled delayed AI request is cancelled and reports an error', async () => {
  const oldTimeout = AbortSignal.timeout
  const oldFetch = globalThis.fetch
  AbortSignal.timeout = (milliseconds) => { assert.equal(milliseconds,90000); return oldTimeout(15) }
  globalThis.fetch = (async (_url, options) => new Promise<Response>((resolve,reject) => {
    const timer = setTimeout(() => resolve(Response.json({choices:[{message:{content:'too late'}}]})),200)
    options!.signal!.addEventListener('abort',()=>{clearTimeout(timer);reject(options!.signal!.reason)},{once:true})
  })) as typeof fetch
  try {
    await assert.rejects(chatCompletion({baseUrl:'https://controlled.test.invalid',apiKey:'fixture',model:'fixture',source:'user'},[]),{name:'TimeoutError'})
  } finally { AbortSignal.timeout=oldTimeout;globalThis.fetch=oldFetch }
})
test('B07: AI network failure retains keyword-only order matching', async () => {
  const p = await json('POST', '/api/dev', a.cookie, { name: 'React SQLite 简历', description:'React SQLite 简历', techStack:'React SQLite' })
  const o = await json('POST', '/api/orders', a.cookie, { title:'React SQLite 简历', requirement:'React SQLite 简历', url:'https://example.com/fixture' })
  enableAi(a.id)
  try {
    const result = await mockedAi(() => Promise.reject(new Error('controlled network failure')),
      () => json('POST', `/api/orders/${o.id}/match`, a.cookie))
    assert.ok(result.matches.some((m: any) => m.project_id === p.id && m.ai_score === -1))
  } finally { disableAi(a.id) }
})
test('R06: test database backup restores intact without altering live data', async () => {
  assert.equal((db.pragma('integrity_check') as any)[0].integrity_check,'ok')
  assert.equal(db.pragma('foreign_keys', { simple:true }),1)
  const backup = path.join(temp,'backup.db')
  await db.backup(backup)
  const restored = new Database(backup,{ readonly:true })
  try {
    assert.equal((restored.pragma('integrity_check') as any)[0].integrity_check,'ok')
    assert.equal((restored.prepare('SELECT count(*) n FROM ideas').get() as any).n,(db.prepare('SELECT count(*) n FROM ideas').get() as any).n)
  } finally { restored.close() }
})

test('R04: cross-user source links, subresources and settings are isolated', async () => {
  const i = await idea()
  const step = await json('POST', `/api/ideas/${i.id}/steps`, a.cookie, { title: '私有步骤' })
  await request('PATCH', `/api/steps/${step.id}`, b.cookie, { done: true }, 404)
  await request('POST', '/api/media', b.cookie, { title: '越权作品', sourceIdeaId: i.id }, 404)
  await request('POST', '/api/wishes', b.cookie, { title: '越权心仪', sourceIdeaId: i.id }, 404)
  const s = await json('POST', '/api/studio', a.cookie, { title: '隔离工坊', brief: '测试' })
  await request('GET', `/api/studio/${s.id}`, b.cookie, undefined, 404)
  await request('POST', `/api/studio/${s.id}/archive`, b.cookie, {}, 404)
  enableAi(a.id)
  try {
    assert.equal((await json('GET', '/api/settings', b.cookie)).keySource, 'none')
    assert.equal((await json('GET', '/api/settings/reveal', b.cookie)).apiKey || '', '')
  } finally { disableAi(a.id) }
})

test('B08: reverse matching removes old pairs excluded by top-12 recall', async () => {
  const p = await json('POST', '/api/dev', a.cookie, { name: 'rain cat video', description: 'rain cat video' })
  const oldLead = Number(db.prepare("INSERT INTO order_leads (user_id,title,requirement,url) VALUES (?,'unrelated zebra','unrelated zebra','https://example.com/fixture')").run(a.id).lastInsertRowid)
  db.prepare('INSERT INTO order_matches (lead_id,project_id,score) VALUES (?,?,90)').run(oldLead,p.id)
  for (let x=0;x<12;x++) db.prepare("INSERT INTO order_leads (user_id,title,requirement,url) VALUES (?,'rain cat video','rain cat video','https://example.com/fixture')").run(a.id)
  await json('PATCH', `/api/dev/${p.id}`, a.cookie, { description: 'rain cat video' })
  assert.equal(db.prepare('SELECT id FROM order_matches WHERE lead_id=? AND project_id=?').get(oldLead,p.id),undefined)
  const s = await json('POST', '/api/studio', a.cookie, { title: 'rain cat video', brief: 'rain cat video' })
  const oldWish = Number(db.prepare("INSERT INTO video_wishes (user_id,title,features) VALUES (?,'unrelated zebra','unrelated zebra')").run(a.id).lastInsertRowid)
  db.prepare('INSERT INTO wish_matches (wish_id,studio_id,score) VALUES (?,?,90)').run(oldWish,s.id)
  for(let x=0;x<12;x++) db.prepare("INSERT INTO video_wishes (user_id,title,features) VALUES (?,'rain cat video','rain cat video')").run(a.id)
  await json('PATCH', `/api/studio/${s.id}`, a.cookie, { synopsis: 'rain cat video' })
  assert.equal(db.prepare('SELECT id FROM wish_matches WHERE wish_id=? AND studio_id=?').get(oldWish,s.id),undefined)
})

test('R06: idea import rolls back the project if a downstream task write fails', async () => {
  const i = await idea()
  await json('POST', `/api/ideas/${i.id}/steps`, a.cookie, { title:'rollback-fixture' })
  db.exec("CREATE TEMP TRIGGER fail_fixture BEFORE INSERT ON dev_tasks WHEN NEW.title='rollback-fixture' BEGIN SELECT RAISE(ABORT,'controlled task failure'); END")
  try {
    await request('POST', `/api/ideas/${i.id}/import-to-dev`, a.cookie, undefined, 500)
    assert.equal(db.prepare('SELECT id FROM dev_projects WHERE source_idea_id=?').get(i.id),undefined)
  } finally { db.exec('DROP TRIGGER fail_fixture') }
  assert.equal((await json('POST', `/api/ideas/${i.id}/import-to-dev`, a.cookie)).created,true)
})

test('B05: completed SSE and ordinary JSON replies are saved exactly once', async () => {
  enableAi(a.id)
  try {
    for (const fixture of [
      () => new Response('data: {"choices":[{"delta":{"content":"完整回复"}}]}\n\ndata: [DONE]',{headers:{'content-type':'text/event-stream'}}),
      () => Response.json({choices:[{message:{content:'完整回复'}}]}),
    ]) {
      const i = await idea()
      await mockedAi(fixture, () => request('POST', `/api/ideas/${i.id}/ai/chat`, a.cookie,{message:'测试完整回复'}))
      const replies = (await json('GET', `/api/ideas/${i.id}/ai/messages`, a.cookie)).filter((x:any)=>x.role==='assistant')
      assert.equal(replies.length,1)
      assert.equal(replies[0].content,'完整回复')
    }
  } finally { disableAi(a.id) }
})

test('B07: no-AI and malformed-AI paths retain keyword matches for orders and wishes', async () => {
  const p = await json('POST', '/api/dev', a.cookie,{name:'resume React SQLite',description:'resume React SQLite',techStack:'React SQLite'})
  const o = await json('POST','/api/orders',a.cookie,{title:'resume React SQLite',requirement:'resume React SQLite',url:'https://example.com/fixture'})
  assert.ok((await json('POST',`/api/orders/${o.id}/match`,a.cookie)).matches.some((x:any)=>x.project_id===p.id))
  const s=await json('POST','/api/studio',a.cookie,{title:'rain cat video film',brief:'rain cat video film'})
  const wid=Number(db.prepare("INSERT INTO video_wishes (user_id,title,features) VALUES (?,'rain cat video film','rain cat video film')").run(a.id).lastInsertRowid)
  enableAi(a.id)
  try {
    await mockedAi(()=>Response.json({choices:[{message:{content:'[null]'}}]}),()=>json('POST',`/api/orders/${o.id}/match`,a.cookie))
    await mockedAi(()=>Promise.reject(new Error('controlled network failure')),()=>json('POST',`/api/wishes/${wid}/rematch`,a.cookie))
    assert.ok(db.prepare('SELECT id FROM wish_matches WHERE wish_id=? AND studio_id=?').get(wid,s.id))
  } finally { disableAi(a.id) }
})
