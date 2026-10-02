// SPDX-License-Identifier: MPL-2.0
import { test,after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID,randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { fixtureInput,fixtureAssessment } from './fixtures/scoring-v5'
import { STANDARD_VERSION,INPUT_SCOPE } from '../shared/scoring-standard'
const previous=process.cwd(),temp=mkdtempSync(path.join(os.tmpdir(),'sparkwright-v5-'))
process.chdir(temp);process.env.AUTH_SECRET=randomBytes(48).toString('hex')
delete process.env.AI_API_KEY;delete process.env.ZAI_API_KEY
process.env.SPARKWRIGHT_APPROVED_SCORE_MODELS='[]';process.env.SPARKWRIGHT_SCORING_ENGINE='v2'
const {db}=await import('../server/db')
const {buildApp}=await import('../server/app')
const {signToken}=await import('../server/auth')
const {requestScore}=await import('../server/ai-scoring')
const {representativeFor}=await import('../server/score-selection')
const {migrateScoringV5}=await import('../server/scoring-v5-migration')
const {SCORE_SYSTEM,ENGINE_HASH,PROMPT_HASH}=await import('../server/scoring-config')
const {createOperation}=await import('../server/scoring-operations')
const {SYNTHESIS_VERSION}=await import('../server/idea-synthesis')
const app=await buildApp();await app.ready()
const cfg={baseUrl:'https://fixture.test.invalid/v1',apiKey:'dummy-private-key',model:'fixture-v5',source:'user' as const}
function user(role='user'){
 const id=Number(db.prepare('INSERT INTO users(name,role) VALUES(?,?)').run(randomUUID(),role).lastInsertRowid)
 db.prepare('INSERT INTO user_settings(user_id,base_url,api_key,model) VALUES(?,?,?,?)').run(id,cfg.baseUrl,cfg.apiKey,cfg.model)
 return {id,cookie:'ideabox_session='+signToken(id,'fixture')}
}
type Who=ReturnType<typeof user>
async function call(who:Who,method:string,url:string,payload?:unknown,status=200,origin='http://localhost:5318'){
 const res=await app.inject({method:method as any,url,headers:{cookie:who.cookie,origin},payload:payload as any})
 assert.equal(res.statusCode,status,res.body);return res.json()
}
function idea(who:Who,pub=false,content=fixtureInput.content){
 const id=Number(db.prepare('INSERT INTO ideas(user_id,title,content,is_public,score_public,public_summary) VALUES(?,?,?,?,1,?)').run(who.id,fixtureInput.title,content,pub?1:0,'public summary').lastInsertRowid)
 return db.prepare('SELECT * FROM ideas WHERE id=?').get(id) as any
}
const response=(value:unknown)=>Response.json({model:'returned-fixture-v5',choices:[{finish_reason:'stop',message:{content:typeof value==='string'?value:JSON.stringify(value)}}],usage:{prompt_tokens:700,completion_tokens:200}})
async function transport(run:(body:any,n:number)=>Response|Promise<Response>,work:(calls:any[])=>Promise<void>){
 const old=globalThis.fetch,calls:any[]=[]
 globalThis.fetch=(async(_url,init)=>{const body=JSON.parse(String(init?.body));calls.push(body);return run(body,calls.length)}) as typeof fetch
 try{await work(calls)}finally{globalThis.fetch=old}
}
const score=(who:Who,id:number,force=false)=>call(who,'POST','/api/ideas/'+id+'/ai/score',{request_id:randomUUID(),response_mode:'compact',force})
const join=(who:Who,id:number,enabled=true,status=200)=>call(who,'PUT','/api/ideas/'+id+'/leaderboard',{enabled},status)
const row=(id:number)=>db.prepare('SELECT * FROM ideas WHERE id=?').get(id) as any
after(async()=>{await app.close();db.close();process.chdir(previous);await rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100})})

test('V5 is the sole path; any compatible model is current without approval, score uses one call and cache uses none',async()=>{
 const who=user(),i=idea(who)
 await transport(()=>response(fixtureAssessment(3)),async calls=>{
  const r=await score(who,i.id);assert.equal(r.score.score_milli,80000);assert.equal(r.representative_score.id,r.score.id)
  assert.equal(r.scoring_meta.engine,'v5');assert.equal(r.score.comparison_status,'current');assert.equal(calls.length,1)
  assert.equal(row(i.id).leaderboard_opt_in,0);assert.equal(row(i.id).is_public,0)
  assert.equal((await score(who,i.id)).cached,true);assert.equal(calls.length,1)
  assert.equal(calls[0].messages[0].content,SCORE_SYSTEM)
  assert.equal((db.prepare('SELECT attempt_count FROM scoring_operations WHERE user_id=? ORDER BY rowid').all(who.id) as any[]).at(-1).attempt_count,0)
 })
})
test('V5 structural repair happens once; twice-invalid output and provider errors write no scores',async()=>{
 const who=user(),i=idea(who)
 await transport((_body,n)=>response(n===1?{score:100}:fixtureAssessment(2)),async calls=>{
  assert.equal((await score(who,i.id)).score.score_milli,55000);assert.equal(calls.length,2)
  assert.match(calls[1].messages.at(-1).content,/levels/)
 })
 for(const upstream of [()=>response({score:100}),()=>new Response('private-upstream-error',{status:503})]){
  const who=user(),i=idea(who)
  await transport(upstream,async calls=>{await call(who,'POST','/api/ideas/'+i.id+'/ai/score',{},502);assert.ok(calls.length<=2);assert.equal(representativeFor(i.id),null)})
 }
})
test('V5 exact cache excludes other users/models, text/config changes; status/plans/language are outside inputs',async()=>{
 const who=user(),i=idea(who)
 await transport(()=>response(fixtureAssessment(2)),async calls=>{
  await score(who,i.id)
  db.prepare("UPDATE ideas SET status='done',deadline='2030-01-01' WHERE id=?").run(i.id)
  db.prepare("INSERT INTO plan_steps(idea_id,title) VALUES(?,'private plan never scored')").run(i.id)
  await call(who,'PUT','/api/settings',{language:'en'})
  await score(who,i.id);assert.equal(calls.length,1)
  db.prepare('UPDATE ideas SET title=? WHERE id=?').run('changed title',i.id);await score(who,i.id);assert.equal(calls.length,2)
  await call(who,'PUT','/api/settings',{model:'different-compatible-model'});await score(who,i.id);assert.equal(calls.length,3)
  const other=user();await score(other,idea(other).id);assert.equal(calls.length,4)
  assert.equal(calls.some(c=>c.messages.at(-1).content.includes('private plan never scored')),false)
 })
})
test('V5 commit rejects in-flight text/config changes and oversized input before calls',async()=>{
 for(const change of ['text','config']){
  const who=user(),i=idea(who)
  await transport(()=>{if(change==='text')db.prepare('UPDATE ideas SET content=content||? WHERE id=?').run('changed',i.id);else db.prepare('UPDATE user_settings SET model=? WHERE user_id=?').run('changed',who.id);return response(fixtureAssessment())},async()=>{
   await call(who,'POST','/api/ideas/'+i.id+'/ai/score',{},409);assert.equal(representativeFor(i.id),null)
  })
 }
 const who=user(),i=idea(who,false,'大'.repeat(2501))
 await transport(()=>{throw new Error('should never call')},async calls=>{await call(who,'POST','/api/ideas/'+i.id+'/ai/score',{},413);assert.equal(calls.length,0)})
})
test('V5 private joining never silently publishes and only the author can change participation',async()=>{
 const who=user(),i=idea(who),other=user(),admin=user('admin'),owner=user('owner')
 await join(who,i.id,true,409)
 await transport(()=>response(fixtureAssessment(3)),async calls=>{
  await score(who,i.id);await join(who,i.id,true,409);assert.equal(row(i.id).is_public,0)
  for(const stranger of [other,admin,owner])await join(stranger,i.id,true,404)
  await call(who,'PUT','/api/ideas/'+i.id+'/leaderboard',{enabled:1},400)
  await call(who,'PUT','/api/ideas/'+i.id+'/leaderboard',{enabled:true,extra:1},400)
  await call(who,'POST','/api/plaza/'+i.id+'/publish',{summary:'explicitly published',scorePublic:true})
  assert.equal(row(i.id).leaderboard_opt_in,0)
  await join(who,i.id);assert.equal(row(i.id).leaderboard_opt_in,1)
  await join(who,i.id,false);assert.equal(row(i.id).is_public,1);assert.equal(calls.length,1)
  await call(who,'PUT','/api/ideas/'+i.id+'/leaderboard',{enabled:true},403,'https://evil.test')
 })
})
test('V5 all representative views use latest valid score, lower rescoring lowers rank, ties and pagination are stable',async()=>{
 db.prepare('UPDATE ideas SET leaderboard_opt_in=0').run()
 const who=user(),a=idea(who,true),b=idea(who,true),c=idea(who,true)
 await transport((_body,n)=>{const assessment=fixtureAssessment(3);if(n===1)assessment.levels[0]=4;return response(assessment)},async()=>{
  for(const i of [a,b,c]){await score(who,i.id);await join(who,i.id)}
  let board=await call(who,'GET','/api/plaza/leaderboard?pageSize=2');assert.deepEqual(board.items.map((x:any)=>x.rank),[1,2])
  const second=await call(who,'GET','/api/plaza/leaderboard?page=2&pageSize=2');assert.equal(second.items[0].rank,2);assert.equal(board.total,3)
 })
 await transport(()=>response(fixtureAssessment(2)),async()=>{await score(who,a.id,true)})
 const current=representativeFor(a.id)!
 assert.equal(current.score_milli,55000)
 const own=await call(who,'GET','/api/ideas/'+a.id),list=await call(who,'GET','/api/ideas'),pub=await call(who,'GET','/api/plaza/'+a.id),plaza=await call(who,'GET','/api/plaza'),board=await call(who,'GET','/api/plaza/leaderboard')
 assert.equal(own.score.id,current.id);assert.equal(own.personal_score.id,current.id)
 assert.equal(list.find((x:any)=>x.id===a.id).representative_score_milli,55000);assert.equal(pub.score,55)
 assert.equal(plaza.items.find((x:any)=>x.id===a.id).score,55);assert.equal(board.items.find((x:any)=>x.idea_id===a.id).rank,3)
})
test('V5 editing temporarily leaves opt-in; rescoring restores, privacy/removal cancels and restoration never autojoins',async()=>{
 const who=user(),i=idea(who,true)
 await transport(()=>response(fixtureAssessment(3)),async calls=>{
  await score(who,i.id);await join(who,i.id)
  await call(who,'PATCH','/api/ideas/'+i.id,{content:fixtureInput.content+' 新内容'})
  assert.equal(row(i.id).leaderboard_opt_in,1);assert.equal(representativeFor(i.id),null)
  assert.equal((await call(who,'GET','/api/ideas/'+i.id)).score,null)
  assert.equal((await call(who,'GET','/api/plaza/leaderboard')).items.some((x:any)=>x.idea_id===i.id),false)
  await score(who,i.id);assert.equal((await call(who,'GET','/api/plaza/leaderboard')).items.some((x:any)=>x.idea_id===i.id),true)
  await call(who,'POST','/api/plaza/'+i.id+'/unpublish');assert.equal(row(i.id).leaderboard_opt_in,0)
  await call(who,'POST','/api/plaza/'+i.id+'/publish',{scorePublic:true});assert.equal(row(i.id).leaderboard_opt_in,0)
  await join(who,i.id);await call(who,'POST','/api/plaza/'+i.id+'/publish',{scorePublic:false});assert.equal(row(i.id).leaderboard_opt_in,0)
  await join(who,i.id,true,409)
  await call(who,'POST','/api/plaza/'+i.id+'/publish',{scorePublic:true});await join(who,i.id)
  db.prepare('UPDATE ideas SET plaza_removed_at=? WHERE id=?').run(new Date().toISOString(),i.id);assert.equal(row(i.id).leaderboard_opt_in,0)
  db.prepare('UPDATE ideas SET plaza_removed_at=NULL WHERE id=?').run(i.id);assert.equal(row(i.id).leaderboard_opt_in,0)
  assert.equal(calls.length,2)
 })
})
test('V5 migration is idempotent, preserves archive bytes, validates new version writes in SQLite',async()=>{
 const who=user(),i=idea(who)
 db.prepare("INSERT INTO idea_scores(idea_id,user_id,score,score_milli,summary,dimensions,standard_version,precision_version) VALUES(?,?,67,67000,'archive','[]','archive-v1','legacy-int-v1')").run(i.id,who.id)
 const archive=JSON.stringify(db.prepare("SELECT * FROM idea_scores WHERE idea_id=?").all(i.id))
 migrateScoringV5(db);migrateScoringV5(db);assert.equal(JSON.stringify(db.prepare('SELECT * FROM idea_scores WHERE idea_id=?').all(i.id)),archive)
 assert.equal(row(i.id).leaderboard_opt_in,0);assert.equal(representativeFor(i.id),null)
 assert.throws(()=>db.prepare('UPDATE idea_scores SET standard_version=? WHERE idea_id=?').run(STANDARD_VERSION,i.id),/incomplete v5/)
 await transport(()=>response(fixtureAssessment(3)),async()=>{await score(who,i.id)})
 const id=representativeFor(i.id)!.id
 for(const milli of [80001,80000.5,-100,100100])assert.throws(()=>db.prepare('UPDATE idea_scores SET score_milli=? WHERE id=?').run(milli,id))
 assert.throws(()=>db.prepare("UPDATE idea_scores SET input_scope='idea-text-v4' WHERE id=?").run(id),/incomplete v5/)
 const history=await call(who,'GET','/api/ideas/'+i.id+'/scores');assert.equal(history.items.at(-1).comparison_status,'archived');assert.equal(history.items.at(-1).standard_version,'archive-v1')
 assert.equal(db.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(db.pragma('foreign_key_check'),[])
})
function generation(a:any,b:any){
 return {parents:{A:{mechanism:a.content.slice(0,12),weakness:'整理后难以及时使用'},B:{mechanism:b.content.slice(0,12),weakness:'提醒缺少清晰资料'}},child:{title:'融合工程工具',content:'规则去重归档，再根据定时提醒交付可执行的资料卡片。'},contributions:{A:'规则去重归档',B:'定时提醒'},improvement:{from:'A',description:'归档结果由提醒交付，缩短查找路径'}}
}
function batch(body:any,cLevel=3){
 const payload=JSON.parse(body.messages[1].content.slice(body.messages[1].content.lastIndexOf('\n')+1))
 return {items:payload.map((item:any)=>({id:item.id,assessment:fixtureAssessment(item.title==='融合工程工具'?cLevel:2)}))}
}
test('V5 synthesis is exactly generation plus neutral batch, uses same score prompt, no historic parent overwrite or autojoin',async()=>{
 const who=user(),a=idea(who),b=idea(who,false,'定时提醒用户使用资料。通过提醒按钮显示需要处理的卡片。')
 await transport(()=>response(fixtureAssessment(4)),async()=>{await score(who,a.id);await score(who,b.id)})
 const parentScores=JSON.stringify(db.prepare('SELECT * FROM idea_scores WHERE idea_id IN (?,?) ORDER BY id').all(a.id,b.id))
 await transport((body,n)=>response(n===1?generation(a,b):batch(body)),async calls=>{
  const run=await call(who,'POST','/api/ideas/synthesize',{idea_a_id:a.id,idea_b_id:b.id})
  assert.equal(calls.length,2);assert.equal(run.contract_ok,true);assert.equal(run.contract.gain_milli,25000);assert.equal(run.parents.A.total,55)
  assert.equal(run.child_score.score,80);assert.equal(run.synthesis_version,SYNTHESIS_VERSION);assert.equal(run.child_score.input_scope,INPUT_SCOPE)
  assert.equal(calls[1].messages[0].content,SCORE_SYSTEM)
  const payload=JSON.parse(calls[1].messages[1].content.slice(calls[1].messages[1].content.lastIndexOf('\n')+1))
  assert.deepEqual(payload.map((x:any)=>x.id),['I','II','III'])
  for(const item of payload)assert.deepEqual(Object.keys(item).sort(),['content','id','title'])
  assert.equal(calls[1].messages[1].content.includes('child'),false);assert.equal(calls[1].messages[1].content.includes('100.0'),false)
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM idea_scores WHERE idea_id IN (?,?) ORDER BY id').all(a.id,b.id)),parentScores)
  const imported=await call(who,'POST','/api/synthesis/'+run.id+'/import')
  assert.equal(imported.idea.is_public,0);assert.equal(imported.idea.leaderboard_opt_in,0);assert.equal(imported.created,true)
  assert.equal(representativeFor(imported.idea.id)!.score,80)
  assert.equal((await score(who,imported.idea.id)).cached,true);assert.equal(calls.length,2)
  assert.equal((await call(who,'POST','/api/synthesis/'+run.id+'/import')).idea.id,imported.idea.id)
  db.prepare('UPDATE ideas SET content=content||? WHERE id=?').run('changed',imported.idea.id);assert.equal(representativeFor(imported.idea.id),null)
 })
})
test('synthesis accepts lower, equal and higher scores without automatic quality loops and allows private import',async()=>{
 for(const childLevel of [0,2,3]){
  const who=user(),a=idea(who),b=idea(who,false,'定时提醒用户使用资料。')
  await transport((body,n)=>response(n===1?generation(a,b):batch(body,childLevel)),async calls=>{
   const run=await call(who,'POST','/api/ideas/synthesize',{idea_a_id:a.id,idea_b_id:b.id})
   assert.equal(run.contract_ok,true);assert.equal(run.outcome,'synthesized');assert.ok(run.child.content);assert.equal(calls.length,2)
   assert.deepEqual(run.contract.failures,[])
   const imported=await call(who,'POST','/api/synthesis/'+run.id+'/import');assert.equal(imported.idea.synthesis_contract_ok,1);assert.equal(imported.idea.leaderboard_opt_in,0)
   assert.equal(representativeFor(imported.idea.id)!.score_milli,run.child_score.score_milli)
  })
 }
})
test('V5 two structural repairs have a four-call limit and no quality rewrite',async()=>{
 const who=user(),a=idea(who),b=idea(who,false,'定时提醒用户使用资料。')
 await transport((body,n)=>response(n===1||n===3?{}:n===2?generation(a,b):batch(body)),async calls=>{
  const run=await call(who,'POST','/api/ideas/synthesize',{idea_a_id:a.id,idea_b_id:b.id})
  assert.equal(calls.length,4);assert.equal(run.budget.repairs,2);assert.equal(run.budget.max_attempts,4)
 })
 const other=user(),aa=idea(other),bb=idea(other)
 await transport(()=>response({}),async calls=>{await call(other,'POST','/api/ideas/synthesize',{idea_a_id:aa.id,idea_b_id:bb.id},502);assert.equal(calls.length,2);assert.equal((db.prepare('SELECT COUNT(*) n FROM synthesis_runs WHERE user_id=?').get(other.id) as any).n,0)})
})
test('synthesis gain is descriptive: both 3.0 and 2.9 are accepted using unchanged engine scores',async()=>{
 const {evaluateAssessment}=await import('../server/scoring-engine')
 const parent=fixtureAssessment(2);parent.levels[0]=0
 assert.equal(evaluateAssessment(parent).score_milli,49500)
 const exact=fixtureAssessment(2);exact.levels[0]=1
 let below:any
 for(let k=0;k<15625&&!below;k++){const candidate=fixtureAssessment(2);candidate.levels[0]=0;let n=k
  for(const index of [1,2,4,5,6,8]){candidate.levels[index]=n%5 as any;n=Math.floor(n/5)}
  if(evaluateAssessment(candidate).score_milli===52400)below=candidate
 }
 assert.ok(below)
 for(const [child,gain] of [[exact,3000],[below,2900]] as const){
  const who=user(),a=idea(who),b=idea(who,false,'定时提醒用户使用资料。')
  await transport((body,n)=>{
   if(n===1)return response(generation(a,b))
   const data=batch(body)
   const inputs=JSON.parse(body.messages[1].content.slice(body.messages[1].content.lastIndexOf('\n')+1))
   for(const item of data.items)item.assessment=inputs.find((x:any)=>x.id===item.id).title==='融合工程工具'?child:parent
   return response(data)
  },async calls=>{
   const result=await call(who,'POST','/api/ideas/synthesize',{idea_a_id:a.id,idea_b_id:b.id})
   assert.equal(result.contract_ok,true);assert.equal(result.contract.gain_milli,gain);assert.equal(calls.length,2)
  })
 }
})
test('V5 withdrawn foreign parents hide provenance/logs and block import',async()=>{
 const who=user(),other=user(),a=idea(who),b=idea(other,true,'定时提醒用户使用资料。')
 await transport((body,n)=>response(n===1?generation(a,b):batch(body)),async()=>{
  const run=await call(who,'POST','/api/ideas/synthesize',{idea_a_id:a.id,idea_b_id:b.id})
  await call(other,'POST','/api/plaza/'+b.id+'/unpublish')
  const withdrawn=await call(who,'GET','/api/synthesis/'+run.id)
  assert.equal(withdrawn.parents.B,null);assert.equal(withdrawn.contributions,null);assert.equal(withdrawn.improvement,null);assert.equal(withdrawn.context_withdrawn,true)
  assert.ok(Array.isArray(withdrawn.contract.failures));assert.equal(withdrawn.idea_b_id,null)
  await call(who,'POST','/api/synthesis/'+run.id+'/import',undefined,409)
  const logs=await call(who,'GET','/api/ideas/'+a.id+'/raw-logs');assert.equal(JSON.stringify(logs).includes('定时提醒用户使用资料'),false)
 })
})
test('V5 cancelled waiter does not cancel another waiter; no score/synthesis short deadline',async()=>{
 const who=user(),i=idea(who),controller=new AbortController();let release!:(r:Response)=>void
 const old=globalThis.fetch;globalThis.fetch=(()=>new Promise<Response>(resolve=>release=resolve)) as typeof fetch
 try{
  const args={idea:i,config:cfg,userId:who.id,force:false,responseMode:'compact'}
  const first=requestScore({...args,requestId:randomUUID(),signal:controller.signal}),second=requestScore({...args,requestId:randomUUID()})
  controller.abort();await assert.rejects(first,(e:any)=>e.code==='score_cancelled')
  release(response(fixtureAssessment()));assert.equal((await second).score.score_milli,55000)
  assert.equal((db.prepare('SELECT COUNT(*) n FROM idea_scores WHERE idea_id=?').get(i.id) as any).n,1)
 }finally{globalThis.fetch=old}
 for(const kind of ['score','synthesis'] as const){const op=createOperation(randomUUID(),kind,undefined,0);assert.doesNotThrow(()=>op.check());assert.equal(op.maxAttempts,kind==='score'?2:4);op.close()}
})
test('V5 persisted raw logs redact credentials, while model identity and engine hashes remain traceable',async()=>{
 const who=user(),i=idea(who,false,fixtureInput.content+'\n'+cfg.apiKey)
 await transport(()=>response(fixtureAssessment()),async()=>{await score(who,i.id)})
 const logs=JSON.stringify(db.prepare('SELECT * FROM ai_raw_logs WHERE idea_id=?').all(i.id))
 assert.equal(logs.includes(cfg.apiKey),false);assert.match(logs,/REDACTED/)
 const current=representativeFor(i.id)!;assert.equal(current.engine_hash,ENGINE_HASH);assert.equal(current.prompt_hash,PROMPT_HASH)
 assert.equal(current.assessment.manifest.returned_model,'returned-fixture-v5')
})

function rankingDuration(scoreId:number,ms:number){
 const row=db.prepare('SELECT operation_id FROM idea_scores WHERE id=?').get(scoreId) as any
 db.prepare("UPDATE scoring_operations SET telemetry_json=json_set(telemetry_json,'$.operation_total_ms',?) WHERE id=?").run(ms,row.operation_id)
}
const isRanked=async(who:Who,id:number)=>(await call(who,'GET','/api/plaza/leaderboard?pageSize=50')).items.some((x:any)=>x.idea_id===id)

test('100-point scores stay visible while enrollment and existing leaderboard rows exclude them',async()=>{
 const who=user(),i=idea(who,true)
 await transport(()=>response(fixtureAssessment(4)),async()=>{
  const result=await score(who,i.id);assert.equal(result.score.score_milli,100000)
  assert.equal((await join(who,i.id,true,409)).error.code,'leaderboard_full_score_excluded')
  db.prepare('UPDATE ideas SET leaderboard_opt_in=1 WHERE id=?').run(i.id)
  assert.equal(await isRanked(who,i.id),false)
  const detail=await call(who,'GET','/api/ideas/'+i.id)
  assert.equal(detail.score.score_milli,100000);assert.equal(detail.idea.is_public,1)
 })
})

test('exactly 60 seconds is allowed; above 60 seconds cannot join or rank',async()=>{
 await transport(()=>response(fixtureAssessment(3)),async()=>{
  for(const [ms,eligible] of [[59999,true],[60000,true],[60000.1,false]] as const){
   const who=user(),i=idea(who,true),result=await score(who,i.id)
   rankingDuration(result.score.id,ms)
   const joined=await join(who,i.id,true,eligible?200:409)
   if(!eligible)assert.equal(joined.error.code,'leaderboard_scoring_too_slow')
   db.prepare('UPDATE ideas SET leaderboard_opt_in=1 WHERE id=?').run(i.id)
   assert.equal(await isRanked(who,i.id),eligible)
  }
 })
})

test('slow original scores stay excluded after fast cache hits and request receipts',async()=>{
 const who=user(),i=idea(who,true),requestId=randomUUID()
 await transport(()=>response(fixtureAssessment(3)),async calls=>{
  const result=await requestScore({idea:i,config:cfg,userId:who.id,force:false,responseMode:'compact',receivedAt:performance.now()-61000})
  assert.ok(JSON.parse((db.prepare('SELECT telemetry_json FROM scoring_operations WHERE id=?').get(result.operation_id) as any).telemetry_json).operation_total_ms>60000)
  for(let n=0;n<2;n++){
   const cached=await call(who,'POST','/api/ideas/'+i.id+'/ai/score',{request_id:requestId,response_mode:'compact'})
   assert.equal(cached.cached,true);assert.equal(cached.score.id,result.score.id)
   assert.equal((await join(who,i.id,true,409)).error.code,'leaderboard_scoring_too_slow')
  }
  assert.equal(calls.length,1)
 })
})

test('latest ineligible scores never fall back to older scores; fast rescoring restores ranking',async()=>{
 const who=user(),i=idea(who,true)
 await transport((_body,n)=>response(fixtureAssessment(n===2?4:3)),async()=>{
  await score(who,i.id);await join(who,i.id);assert.equal(await isRanked(who,i.id),true)
  await score(who,i.id,true);assert.equal(await isRanked(who,i.id),false)
  const slow=await score(who,i.id,true);rankingDuration(slow.score.id,61000);assert.equal(await isRanked(who,i.id),false)
  await score(who,i.id,true);assert.equal(await isRanked(who,i.id),true)
  assert.equal(row(i.id).leaderboard_opt_in,1)
 })
})

test('withdrawal remains available when a current score cannot rank',async()=>{
 const who=user(),i=idea(who,true)
 await transport(()=>response(fixtureAssessment(4)),async()=>{await score(who,i.id)})
 db.prepare('UPDATE ideas SET leaderboard_opt_in=1 WHERE id=?').run(i.id)
 await join(who,i.id,false);assert.equal(row(i.id).leaderboard_opt_in,0);assert.equal(row(i.id).is_public,1)
})

test('imported synthesis scores use the original synthesis duration for ranking',async()=>{
 const who=user(),a=idea(who),b=idea(who,false,'定时提醒用户使用资料。')
 await transport((body,n)=>response(n===1?generation(a,b):batch(body)),async()=>{
  const run=await call(who,'POST','/api/ideas/synthesize',{idea_a_id:a.id,idea_b_id:b.id})
  const imported=await call(who,'POST','/api/synthesis/'+run.id+'/import')
  await call(who,'POST','/api/plaza/'+imported.idea.id+'/publish',{scorePublic:true})
  await join(who,imported.idea.id)
  assert.equal(await isRanked(who,imported.idea.id),true)
  const scoreId=representativeFor(imported.idea.id)!.id
  rankingDuration(scoreId,61000)
  assert.equal(await isRanked(who,imported.idea.id),false)
  assert.equal((await join(who,imported.idea.id,true,409)).error.code,'leaderboard_scoring_too_slow')
 })
})
