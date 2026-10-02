// SPDX-License-Identifier: MPL-2.0
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID, randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { migrateNewRound } from '../server/new-round-migration'
import { formatIdeaScore, serializeIdeaScore, IDEA_SCORE_VERSION } from '../shared/idea-score'
const previous = process.cwd(), temp = mkdtempSync(path.join(os.tmpdir(), 'sparkwright-round-'))
process.chdir(temp); process.env.AUTH_SECRET = randomBytes(48).toString('hex')
delete process.env.AI_API_KEY; delete process.env.ZAI_API_KEY
const { db } = await import('../server/db')
const { buildApp } = await import('../server/app')
const { signToken } = await import('../server/auth')
const { ActivityTracker, isActivityRoute } = await import('../server/activity')
const { FeedbackService } = await import('../server/feedback')
const app = await buildApp(); await app.ready()
function user(role = 'user') {
  const id = Number(db.prepare('INSERT INTO users(name,role) VALUES (?,?)').run(randomUUID(),role).lastInsertRowid)
  return { id, cookie: `ideabox_session=${signToken(id,'fixture')}` }
}
const alice=user(), bob=user(), admin=user('admin'), owner=user('owner')
async function call(method: string, url: string, who=alice, body?: unknown, status=200, origin='http://localhost:5318') {
  const res = await app.inject({ method:method as any,url,headers:{cookie:who.cookie,origin},payload:body as any })
  assert.equal(res.statusCode,status,`${method} ${url}: ${res.body}`); return { data:res.json(), headers:res.headers }
}
function request(who: typeof alice, body: unknown, id?: number) { return {headers:{cookie:who.cookie},ip:'127.0.0.1',body,params:{id:String(id)}} as any }
const payload = () => ({ category:'bug',title:'Test bug',content:'A reproducible test issue.',request_id:randomUUID() })
after(async()=>{await app.close();db.close();process.chdir(previous);await rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100})})

test('migration preserves legacy values, quarantines anomalies, is repeatable and transactional',()=>{
  const old = new Database(':memory:'); old.pragma('foreign_keys=ON')
  old.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,role TEXT); CREATE TABLE ideas(id INTEGER PRIMARY KEY,title TEXT,content TEXT,status TEXT,deadline TEXT);
    CREATE TABLE plan_steps(id INTEGER PRIMARY KEY,idea_id INTEGER,title TEXT,done INTEGER,sort INTEGER);
    CREATE TABLE idea_scores(id INTEGER PRIMARY KEY,idea_id INTEGER,score INTEGER,standard_version TEXT,angle TEXT,validity TEXT);
    CREATE TABLE notifications(user_id INTEGER,type TEXT); INSERT INTO idea_scores(id,score) VALUES (1,68),(2,67.5),(3,150);`)
  migrateNewRound(old); migrateNewRound(old)
  assert.deepEqual(old.prepare('SELECT score,score_milli,precision_version,idea_revision FROM idea_scores WHERE id=1').get(),{score:68,score_milli:68000,precision_version:'legacy-int-v1',idea_revision:null})
  assert.equal((old.prepare('SELECT score_milli FROM idea_scores WHERE id=2').get() as any).score_milli,null)
  assert.throws(()=>old.prepare('UPDATE idea_scores SET score_milli=80000.5 WHERE id=1').run())
  assert.equal(old.pragma('integrity_check',{simple:true}),'ok');old.close()
})
test('scoring inputs advance revision, while privacy and touch updates do not',()=>{
  const id=Number(db.prepare('INSERT INTO ideas(user_id,title) VALUES (?,?)').run(alice.id,'initial').lastInsertRowid)
  const rev=()=> (db.prepare('SELECT score_revision FROM ideas WHERE id=?').get(id) as any).score_revision
  db.prepare('UPDATE ideas SET score_public=0,updated_at=? WHERE id=?').run(new Date().toISOString(),id);assert.equal(rev(),0)
  db.prepare('UPDATE ideas SET title=? WHERE id=?').run('changed',id);assert.equal(rev(),1)
  const step=Number(db.prepare('INSERT INTO plan_steps(idea_id,title) VALUES (?,?)').run(id,'plan').lastInsertRowid);assert.equal(rev(),2)
  db.prepare('UPDATE plan_steps SET done=1 WHERE id=?').run(step);assert.equal(rev(),3)
  db.prepare('DELETE FROM plan_steps WHERE id=?').run(step);assert.equal(rev(),4)
})
test('activity excludes polling, samples within hour and forces a cross-hour write',()=>{
  for(const route of ['/api/health','/api/auth/me','/api/notifications','/api/channels/:id/messages','/api/admin/system']) assert.equal(isActivityRoute('GET',route),false)
  assert.equal(isActivityRoute('POST','/api/channels/:id/messages'),true)
  const who=user(), base=Math.floor(Date.now()/3600000)*3600; let now=base+3599
  const tracker=new ActivityTracker(()=>now);tracker.record(who.id);now=base+3600;tracker.record(who.id);now++;tracker.record(who.id)
  assert.equal((db.prepare('SELECT COUNT(*) n FROM user_activity_hours WHERE user_id=?').get(who.id) as any).n,2)
  assert.equal((db.prepare('SELECT last_seen_at FROM user_activity_state WHERE user_id=?').get(who.id) as any).last_seen_at,base+3600)
  tracker.record(admin.id);assert.equal(db.prepare('SELECT * FROM user_activity_state WHERE user_id=?').get(admin.id),undefined)
})
test('activity cards distinct accounts, role changes filter immediately, precollection buckets null',()=>{
  const now=Math.floor(Date.now()/1000), a=user(), b=user(), tracker=new ActivityTracker(()=>now)
  db.prepare('DELETE FROM user_activity_state').run();db.prepare('DELETE FROM user_activity_hours').run()
  db.prepare('UPDATE activity_collection_meta SET collection_started_at=?').run(now-100)
  tracker.record(a.id);tracker.record(b.id)
  assert.equal((tracker.report('24h').summary['24h'] as any).value,2)
  const series=tracker.report('24h').series;assert.equal(series.length,24);assert.ok(series.some(x=>x.value===null));assert.equal(series.at(-1)!.coverage,'partial')
  db.prepare("UPDATE users SET role='admin' WHERE id=?").run(b.id)
  assert.equal((tracker.report('7d').summary['7d'] as any).value,1)
  db.prepare('UPDATE user_activity_state SET last_seen_at=? WHERE user_id=?').run(now-86400,a.id)
  assert.equal((tracker.report('24h').summary['24h'] as any).value,0)
})
test('daily activity deduplicates a user across hours and spans Shanghai midnight correctly',()=>{
  const now=Math.floor(Date.now()/1000), midnight=Math.floor((now+28800)/86400)*86400-28800
  const who=user(),tracker=new ActivityTracker(()=>now)
  db.prepare('DELETE FROM user_activity_state').run();db.prepare('DELETE FROM user_activity_hours').run();db.prepare('UPDATE activity_collection_meta SET collection_started_at=?').run(now-40*86400)
  for(const hour of [midnight-7200,midnight-3600,midnight])db.prepare('INSERT INTO user_activity_hours VALUES (?,?,?,?)').run(who.id,hour,hour+1,hour+1)
  db.prepare('INSERT INTO user_activity_state VALUES (?,?)').run(who.id,now)
  const result=tracker.report('7d');assert.equal(result.series.at(-2)!.value,1);assert.equal(result.series.at(-1)!.value,1);assert.equal((result.summary['7d'] as any).value,1)
  assert.equal(Date.parse(result.series.at(-1)!.start)/1000,midnight);assert.equal(result.series[0].value,0)
})
test('consistent backup contains new data and passes integrity/foreign-key checks',async()=>{
  const filename=path.join(temp,'compatible-round.db');await db.backup(filename)
  const backup=new Database(filename,{readonly:true})
  try{assert.equal(backup.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(backup.pragma('foreign_key_check'),[]);assert.ok(backup.prepare("SELECT name FROM sqlite_master WHERE name='user_feedback'").get())}finally{backup.close()}
})
test('analytics requires admin and rejects arbitrary query inputs',async()=>{
  await call('GET','/api/admin/analytics/activity',alice,undefined,403)
  await call('GET','/api/admin/analytics/activity?view=90d',admin,undefined,400)
  const result=await call('GET','/api/admin/analytics/activity?view=30d',owner)
  assert.equal(result.data.series.length,30);assert.equal(result.headers['cache-control'],'no-store')
})
test('activity storage failure does not fail a business response and is reported as degraded',async()=>{
  const who=user()
  db.exec("CREATE TRIGGER test_activity_failure BEFORE INSERT ON user_activity_state BEGIN SELECT RAISE(ABORT,'fixture'); END")
  try{await call('GET','/api/ideas',who);assert.equal((await call('GET','/api/admin/analytics/activity',admin)).data.collection_health,'degraded')}
  finally{db.exec('DROP TRIGGER test_activity_failure')}
})
test('feedback idempotency, duplicate IDs, own visibility, notes privacy and optimistic conflict',async()=>{
  const data=payload(), first=await call('POST','/api/feedback',alice,data,201), id=first.data.feedback.id
  assert.equal((await call('POST','/api/feedback',alice,data)).data.feedback.id,id)
  await call('POST','/api/feedback',alice,{...data,title:'changed'},409)
  const duplicate=await call('POST','/api/feedback',alice,{...data,request_id:randomUUID()},409);assert.equal(duplicate.data.error.feedback_id,id)
  await call('GET',`/api/feedback/${id}`,bob,undefined,404)
  await call('GET','/api/admin/feedback',alice,undefined,403)
  const note={content:'INTERNAL-PRIVATE',version:1,request_id:randomUUID()}
  await call('POST',`/api/admin/feedback/${id}/notes`,admin,note)
  await call('POST',`/api/admin/feedback/${id}/notes`,admin,note)
  await call('PATCH',`/api/admin/feedback/${id}/status`,owner,{status:'in_progress',version:1,request_id:randomUUID()},409)
  await call('POST',`/api/admin/feedback/${id}/replies`,owner,{content:'Public answer',version:2,request_id:randomUUID()})
  const events=(await call('GET',`/api/feedback/${id}/events`,alice)).data.items
  assert.equal(events.length,1);assert.equal(events[0].content,'Public answer');assert.equal(events[0].actor_id,undefined)
  const exported=JSON.stringify((await call('GET','/api/export/me',alice)).data)
  assert.ok(!exported.includes('INTERNAL-PRIVATE'));assert.ok(exported.includes('Public answer'))
  assert.equal((db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id=? AND type='feedback_reply'").get(alice.id) as any).n,1)
  const staff=user('admin');await call('GET',`/api/admin/feedback/${id}`,staff)
  db.prepare("UPDATE users SET role='user' WHERE id=?").run(staff.id);await call('GET',`/api/admin/feedback/${id}`,staff,undefined,403)
})
test('feedback and owner notifications roll back together, then the same request can safely retry',async()=>{
  const who=user(),body=payload()
  db.exec("CREATE TRIGGER test_feedback_notice_failure BEFORE INSERT ON notifications WHEN NEW.type='feedback_new' BEGIN SELECT RAISE(ABORT,'fixture'); END")
  try{await call('POST','/api/feedback',who,body,500);assert.equal((db.prepare('SELECT COUNT(*) n FROM user_feedback WHERE user_id=?').get(who.id) as any).n,0)}
  finally{db.exec('DROP TRIGGER test_feedback_notice_failure')}
  const id=(await call('POST','/api/feedback',who,body,201)).data.feedback.id
  assert.equal((db.prepare("SELECT COUNT(*) n FROM notifications WHERE type='feedback_new' AND user_id=? AND ref_id=?").get(owner.id,id) as any).n,1)
})
test('feedback durable throttling, bounded Unicode, CSRF, request body limits and role notice purge',async()=>{
  const who=user();let now=Date.now();const service=new FeedbackService(()=>now)
  service.create(request(who,payload()))
  assert.throws(()=>service.create(request(who,{...payload(),title:'different'})),(e:any)=>e.statusCode===429&&e.retryAfter>0)
  now+=61000;service.create(request(who,{...payload(),title:'another'}))
  for(let i=2;i<10;i++){now+=61000;service.create(request(who,{...payload(),title:String(i)}))}
  now+=61000;assert.throws(()=>new FeedbackService(()=>now).create(request(who,{...payload(),title:'eleventh'})),(e:any)=>e.statusCode===429)
  await call('POST','/api/feedback',bob,{...payload(),title:'🙂'.repeat(81)},400)
  await call('POST','/api/feedback',bob,{...payload(),page_path:'/settings?api_key=secret'},400)
  await call('POST','/api/feedback',bob,payload(),403,'https://evil.example')
  await call('POST','/api/feedback',bob,{...payload(),content:'x'.repeat(70000)},413)
  assert.ok(db.prepare("SELECT id FROM notifications WHERE user_id=? AND type='feedback_new'").get(owner.id))
  db.prepare("UPDATE users SET role='user' WHERE id=?").run(owner.id)
  assert.equal(db.prepare("SELECT id FROM notifications WHERE user_id=? AND type='feedback_new'").get(owner.id),undefined)
})
test('leaderboard gate and query validation remain authenticated',async()=>{
  process.env.SPARKWRIGHT_LEADERBOARD_ENABLED='false'
  await call('GET','/api/plaza/leaderboard',alice,undefined,503)
  assert.equal((await app.inject('/api/plaza/leaderboard')).statusCode,401)
  process.env.SPARKWRIGHT_LEADERBOARD_ENABLED='true'
  for(const q of ['page=0','page=1.5','page=1001','pageSize=51','page=1&page=2','q=secret'])await call('GET','/api/plaza/leaderboard?'+q,alice,undefined,400)
})
