// SPDX-License-Identifier: MPL-2.0
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { chatCompletion } from '../server/ai'
import { ERROR_MESSAGES } from '../shared/error-messages'

const previous = process.cwd(), temp = mkdtempSync(path.join(os.tmpdir(), 'sparkwright-phase2-'))
process.chdir(temp)
process.env.AUTH_SECRET = randomBytes(48).toString('hex')
delete process.env.AI_API_KEY; delete process.env.ZAI_API_KEY
const { db } = await import('../server/db')
const { buildApp } = await import('../server/app')
const { signToken } = await import('../server/auth')
const { ChannelPresence } = await import('../server/presence')
const app = await buildApp({}, false)
await app.ready()
const origin = 'http://127.0.0.1:5318'

function user(name: string, role = 'user') {
  const id = Number(db.prepare('INSERT INTO users (name, role) VALUES (?, ?)').run(name, role).lastInsertRowid)
  return { id, cookie: `ideabox_session=${signToken(id, name)}` }
}
const owner = user('phase2Owner', 'owner'), admin = user('phase2Admin', 'admin'), alice = user('phase2Alice'), bob = user('phase2Bob')
async function call(method: string, url: string, who = alice, body?: unknown, status = 200, withOrigin = true) {
  const response = await app.inject({ method: method as any, url, headers: { cookie: who.cookie, ...(withOrigin ? { origin } : {}) }, payload: body as any })
  assert.equal(response.statusCode, status, `${method} ${url}: ${response.body}`)
  return response.json()
}
function newIdea(who = alice, title = '测试灵感', content = '可运行的想法') {
  return call('POST', '/api/ideas', who, { title, content })
}
after(async () => {
  await app.close(); db.close(); process.chdir(previous)
  assert.ok(path.resolve(temp).startsWith(path.join(os.tmpdir(), 'sparkwright-phase2-')))
  await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
})

test('batch3 account languages default independently, persist and never overwrite AI settings', async () => {
  const first = user('languageFirst'), second = user('languageSecond')
  assert.equal((await call('GET', '/api/settings', first)).language, 'zh-CN')
  await call('PUT', '/api/settings', first, { apiKey: 'language-fixture-key', model: 'language-fixture-model', baseUrl: 'https://controlled.test.invalid' })
  await call('PUT', '/api/settings', first, { language: 'en' })
  const row = db.prepare('SELECT * FROM user_settings WHERE user_id=?').get(first.id) as any
  assert.equal(row.language, 'en'); assert.equal(row.api_key, 'language-fixture-key'); assert.equal(row.model, 'language-fixture-model')
  assert.equal((await call('GET', '/api/settings', second)).language, 'zh-CN')
  assert.equal((await call('PUT', '/api/settings', first, { language: 'fr' }, 400)).error.code, 'invalid_language')
  const fresh = await buildApp({}, false)
  try {
    const response = await fresh.inject({ method: 'GET', url: '/api/settings', headers: { cookie: first.cookie } })
    assert.equal(response.statusCode, 200); assert.equal(response.json().language, 'en')
  } finally { await fresh.close() }
})

test('batch3 core errors have stable codes and provider bodies never reach HTTP or SSE errors', async () => {
  const guest = await app.inject({ method: 'GET', url: '/api/settings' })
  assert.equal(guest.statusCode, 401); assert.equal(guest.json().error.code, 'unauthorized')
  const invalidLogin = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'not-a-user@test.invalid', password: 'fixture-pass' } })
  assert.equal(invalidLogin.statusCode, 401); assert.equal(invalidLogin.json().error.code, 'invalid_credentials')
  assert.equal((await call('GET', '/api/ideas/999999', alice, undefined, 404)).error.code, 'idea_not_found')
  const config = { baseUrl: 'https://controlled.test.invalid', apiKey: 'private-fixture-key', model: 'fixture', source: 'user' as const }
  const original = globalThis.fetch, leak = 'SMTP-password-fixture Authorization: Bearer secret-fixture C:\\private\\database.db'
  const idea = await newIdea()
  await call('PUT', '/api/settings', alice, { apiKey: config.apiKey, model: config.model, baseUrl: config.baseUrl })
  try {
    globalThis.fetch = (async () => new Response(leak, { status: 503 })) as typeof fetch
    await assert.rejects(chatCompletion(config, []), (error: any) => error.code === 'ai_service_error' && !error.message.includes('secret-fixture'))
    const failure = await call('POST', `/api/ideas/${idea.id}/ai/score`, alice, undefined, 502)
    assert.equal(failure.error.code, 'ai_service_error'); assert.equal(failure.error.message, ERROR_MESSAGES.ai_service_error[0])
    globalThis.fetch = (async () => new Response(`data: ${JSON.stringify({ error: { message: leak } })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })) as typeof fetch
    const streamed = await app.inject({ method: 'POST', url: `/api/ideas/${idea.id}/ai/chat`, headers: { cookie: alice.cookie }, payload: { message: 'original Chinese message' } })
    assert.equal(streamed.statusCode, 200); assert.match(streamed.body, /"code":"ai_service_error"/); assert.ok(!streamed.body.includes('secret-fixture'))
    assert.equal(db.prepare("SELECT id FROM ai_messages WHERE idea_id=? AND role='assistant'").get(idea.id), undefined)
  } finally { globalThis.fetch = original }
})

test('batch3 raw logs redact known credentials and preserve original database content and owner isolation', async () => {
  const idea = await newIdea(alice, '原始日志脱敏')
  const key = 'fixture-secret-raw-log', smtp = process.env.EMAIL_SMTP_PASS
  process.env.EMAIL_SMTP_PASS = 'fixture-smtp-secret'
  await call('PUT', '/api/settings', alice, { apiKey: key })
  const raw = `用户原文：保存。${key} fixture-smtp-secret ${alice.cookie} Authorization: Bearer unknown-fixture`
  db.prepare("INSERT INTO ai_raw_logs (idea_id,kind,request_prompt,raw_response,parsed_ok) VALUES (?,'chat',?,?,1)").run(idea.id, raw, raw)
  try {
    const logs = JSON.stringify(await call('GET', `/api/ideas/${idea.id}/raw-logs`))
    for (const secret of [key, 'fixture-smtp-secret', alice.cookie, 'unknown-fixture']) assert.ok(!logs.includes(secret))
    assert.ok(logs.includes('用户原文：保存')); assert.equal((db.prepare('SELECT raw_response FROM ai_raw_logs WHERE idea_id=?').get(idea.id) as any).raw_response, raw)
    await call('GET', `/api/ideas/${idea.id}/raw-logs`, bob, undefined, 404)
  } finally { if (smtp === undefined) delete process.env.EMAIL_SMTP_PASS; else process.env.EMAIL_SMTP_PASS = smtp }
})

test('phase2 migration defaults and legacy score remain intact', () => {
  assert.equal((db.pragma('integrity_check') as { integrity_check: string }[])[0].integrity_check, 'ok')
  const columns = (table: string) => new Set((db.pragma(`table_info(${table})`) as { name: string }[]).map((x) => x.name))
  for (const column of ['plaza_removed_at', 'source_parent_ids']) assert.ok(columns('ideas').has(column))
  for (const column of ['analysis', 'standard_version', 'validity']) assert.ok(columns('idea_scores').has(column))
  assert.ok(columns('user_settings').has('language'))
  assert.ok(columns('synthesis_runs').has('result_json'))
})

test('supplement Owner manages visible idea channels without access to another private idea', async () => {
  const shared = await newIdea(alice, '可管理的公开灵感', '公开测试文本')
  const channel = await call('POST', '/api/channels', alice, { name: '专属讨论区', ideaId: shared.id })
  const privateIdea = await newIdea(bob, '不能泄露的私人标题', '不能泄露的私人内容')
  const privateChannel = await call('POST', '/api/channels', bob, { name: '不能泄露的私人频道', ideaId: privateIdea.id })
  await call('POST', `/api/plaza/${shared.id}/publish`, alice, { scorePublic: false })
  await call('POST', `/api/channels/${channel.id}/messages`, alice, { content: '归档后保留这条历史消息' })
  await call('GET', '/api/admin/channels?type=idea', admin, undefined, 403)
  await call('GET', '/api/admin/channels?type=idea', alice, undefined, 403)
  const list = await call('GET', '/api/admin/channels?type=idea', owner)
  assert.ok(list.items.some((row: any) => row.id === channel.id && row.idea_title === shared.title))
  assert.ok(!JSON.stringify(list).includes('不能泄露'))
  assert.ok((await call('GET', '/api/admin/channels', owner)).items.every((row: any) => row.type === 'public'))
  assert.equal((await call('GET', '/api/admin/channels?type=bad', owner, undefined, 400)).error.code, 'invalid_channel_type')
  for (const who of [alice, admin]) {
    await call('PATCH', `/api/admin/channels/${channel.id}`, who, { name: '越权修改' }, 403)
    await call('DELETE', `/api/admin/channels/${channel.id}`, who, undefined, 403)
    await call('POST', `/api/admin/channels/${channel.id}/restore`, who, undefined, 403)
  }
  await call('PATCH', `/api/admin/channels/${channel.id}`, owner, { name: '无来源修改' }, 403, false)
  await call('DELETE', `/api/admin/channels/${channel.id}`, owner, undefined, 403, false)
  await call('POST', `/api/admin/channels/${channel.id}/restore`, owner, undefined, 403, false)
  await call('PATCH', `/api/admin/channels/${channel.id}`, owner, { name: 'Owner 改名' })
  assert.equal((await call('GET', `/api/channels/${channel.id}`, bob)).name, 'Owner 改名')
  await call('POST', `/api/channels/${channel.id}/presence`, bob)
  await call('DELETE', `/api/admin/channels/${channel.id}`, owner)
  for (const who of [alice, bob, owner]) {
    await call('GET', `/api/channels/${channel.id}`, who, undefined, 404)
    await call('GET', `/api/channels/${channel.id}/messages`, who, undefined, 404)
    await call('POST', `/api/channels/${channel.id}/messages`, who, { content: '绕过归档' }, 404)
    await call('POST', `/api/channels/${channel.id}/presence`, who, undefined, 404)
    assert.ok(!(await call('GET', '/api/channels', who)).some((row: any) => row.id === channel.id))
  }
  await call('POST', '/api/channels', alice, { name: '重建绕过归档', ideaId: shared.id }, 409)
  assert.equal((await call('GET', `/api/plaza/${shared.id}`, bob)).channel, null)
  assert.ok((await call('GET', '/api/admin/channels?type=idea', owner)).items.find((row: any) => row.id === channel.id).archived_at)
  await call('POST', `/api/admin/channels/${channel.id}/restore`, owner)
  const history = await call('GET', `/api/channels/${channel.id}/messages`, bob)
  assert.equal(history.length, 1); assert.equal(history[0].content, '归档后保留这条历史消息')
  assert.equal((await call('GET', `/api/channels/${channel.id}`, bob)).online_count, 0)
  for (const method of ['PATCH', 'DELETE', 'POST']) {
    const suffix = method === 'POST' ? '/restore' : ''
    await call(method, `/api/admin/channels/${privateChannel.id}${suffix}`, owner, method === 'PATCH' ? { name: '不能修改' } : undefined, 404)
  }
  await call('POST', `/api/plaza/${shared.id}/unpublish`, alice)
  assert.ok(!(await call('GET', '/api/admin/channels?type=idea', owner)).items.some((row: any) => row.id === channel.id))
  await call('PATCH', `/api/admin/channels/${channel.id}`, owner, { name: '取消公开后不能修改' }, 404)
})

test('owner moderation blocks ordinary/admin, removal, mute and archive bypasses', async () => {
  const idea = await newIdea(alice)
  const channel = await call('POST', '/api/channels', alice, { name: '灵感频道', ideaId: idea.id })
  await call('POST', `/api/plaza/${idea.id}/publish`, alice, {})
  await call('GET', '/api/admin/plaza/ideas?status=active', admin, undefined, 403)
  await call('POST', `/api/admin/plaza/ideas/${idea.id}/remove`, alice, { reason: '不合适' }, 403)
  await call('POST', `/api/admin/plaza/ideas/${idea.id}/remove`, owner, { reason: '不合适' }, 403, false)
  await call('POST', `/api/admin/plaza/ideas/${idea.id}/remove`, owner, { reason: '不合适' })
  await call('GET', `/api/plaza/${idea.id}`, bob, undefined, 404)
  await call('GET', `/api/channels/${channel.id}`, bob, undefined, 404)
  await call('POST', `/api/plaza/${idea.id}/publish`, alice, {}, 409)
  assert.equal((await call('GET', `/api/ideas/${idea.id}`, alice)).idea.content, '可运行的想法')
  await call('POST', `/api/admin/plaza/ideas/${idea.id}/restore`, owner)
  assert.equal((await call('GET', `/api/plaza/${idea.id}`, bob)).idea.id, idea.id)
  await call('PATCH', `/api/admin/users/${owner.id}/mute`, owner, { muted: true }, 409)
  await call('PATCH', `/api/admin/users/${alice.id}/mute`, owner, { muted: true, reason: '测试' })
  await call('POST', `/api/plaza/${idea.id}/comments`, alice, { content: '评论' }, 403)
  await call('POST', '/api/plaza/compose', alice, { content: '发布' }, 403)
  await call('POST', `/api/channels/${channel.id}/messages`, alice, { content: '消息' }, 403)
  await call('PATCH', `/api/ideas/${idea.id}`, alice, { title: '公开编辑' }, 403)
  const privateIdea = await newIdea(alice)
  await call('PATCH', `/api/ideas/${privateIdea.id}`, alice, { title: '私人编辑可用' })
  await call('PATCH', `/api/admin/users/${alice.id}/mute`, owner, { muted: false })
  await call('POST', '/api/channels', bob, { name: '越权公共频道' }, 403)
  const publicChannel = await call('POST', '/api/channels', owner, { name: 'Owner 频道' })
  await call('POST', `/api/channels/${publicChannel.id}/messages`, bob, { content: '保留消息' })
  await call('DELETE', `/api/admin/channels/${publicChannel.id}`, owner)
  await call('GET', `/api/channels/${publicChannel.id}/messages`, bob, undefined, 404)
  await call('POST', `/api/admin/channels/${publicChannel.id}/restore`, owner)
  assert.equal((await call('GET', `/api/channels/${publicChannel.id}/messages`, bob)).length, 1)
  await call('PATCH', `/api/admin/channels/${channel.id}`, owner, { name: 'Owner 管理专属频道' })
})

test('presence de-duplicates, expires and clears by account; settings preserve model/key', async () => {
  let now = 1000
  const p = new ChannelPresence(75_000, () => now)
  assert.equal(p.heartbeat(1, alice.id), 1)
  assert.equal(p.heartbeat(1, alice.id), 1)
  assert.equal(p.heartbeat(1, bob.id), 2)
  p.heartbeat(2, alice.id)
  now += 75_001
  assert.equal(p.count(1), 0)
  assert.equal(p.count(2), 0)
  p.heartbeat(1, alice.id); p.leaveAll(alice.id)
  assert.equal(p.count(1), 0)
  const channel = await call('POST', '/api/channels', owner, { name: '在线测试' })
  await call('POST', `/api/channels/${channel.id}/presence`, alice)
  await call('POST', `/api/channels/${channel.id}/presence`, alice)
  assert.equal((await call('POST', `/api/channels/${channel.id}/presence`, bob)).online_count, 2)
  assert.equal((await call('GET', `/api/channels/${channel.id}`, alice)).online_count, 2)
  await call('DELETE', `/api/channels/${channel.id}/presence`, alice)
  assert.equal((await call('GET', `/api/channels/${channel.id}`, bob)).online_count, 1)
  await call('PUT', '/api/settings', alice, { apiKey: 'fixture-key', model: 'fixture-model' })
  assert.equal((await call('PUT', '/api/settings', alice, { language: 'en' })).language, 'en')
  assert.equal((await call('GET', '/api/settings', alice)).model, 'fixture-model')
  assert.equal((db.prepare('SELECT api_key FROM user_settings WHERE user_id = ?').get(alice.id) as any).api_key, 'fixture-key')
  await call('PUT', '/api/settings', alice, { language: 'fr' }, 400)
})

test('batch2 current-account moderation status is authenticated and never exposes another account', async () => {
  const unauthenticated = await app.inject({ method: 'GET', url: '/api/moderation/me' })
  assert.equal(unauthenticated.statusCode, 401)
  await call('PATCH', `/api/admin/users/${alice.id}/mute`, owner, { muted: true, reason: '本人禁言状态测试' })
  const state = await call('GET', `/api/moderation/me?userId=${alice.id}`, bob)
  assert.deepEqual(state, { plaza_muted_at: null, plaza_mute_reason: null })
  const own = await call('GET', '/api/moderation/me', alice)
  assert.ok(own.plaza_muted_at); assert.equal(own.plaza_mute_reason, '本人禁言状态测试')
  assert.deepEqual(Object.keys(own).sort(), ['plaza_mute_reason', 'plaza_muted_at'])
  await call('PATCH', `/api/admin/users/${alice.id}/mute`, owner, { muted: false })
})

