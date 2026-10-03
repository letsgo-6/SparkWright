// SPDX-License-Identifier: MPL-2.0
import { test,after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { randomUUID,randomBytes } from 'node:crypto'
import { fixtureAssessment } from './fixtures/scoring-v5'
const previous=process.cwd(),temp=mkdtempSync(path.join(os.tmpdir(),'sparkwright-flex-'))
process.chdir(temp);process.env.AUTH_SECRET=randomBytes(48).toString('hex');delete process.env.AI_API_KEY;delete process.env.ZAI_API_KEY
const {db}=await import('../server/db'),{buildApp}=await import('../server/app'),{signToken}=await import('../server/auth')
const {userOperation}=await import('../server/scoring-operations')
const {validateGeneration}=await import('../server/idea-synthesis')
const app=await buildApp({}, false);await app.ready()
const cfg={baseUrl:'https://fixture.test.invalid/v1',apiKey:'dummy-flexible-key',model:'fixture-v5',source:'user' as const}
function user(){const id=Number(db.prepare("INSERT INTO users(name,role) VALUES(?,'user')").run(randomUUID()).lastInsertRowid);db.prepare('INSERT INTO user_settings(user_id,base_url,api_key,model) VALUES(?,?,?,?)').run(id,cfg.baseUrl,cfg.apiKey,cfg.model);return {id,cookie:'ideabox_session='+signToken(id,'fixture')}}
function idea(who:ReturnType<typeof user>,title:string,content:string){const id=Number(db.prepare('INSERT INTO ideas(user_id,title,content) VALUES(?,?,?)').run(who.id,title,content).lastInsertRowid);return db.prepare('SELECT * FROM ideas WHERE id=?').get(id) as any}
async function call(who:ReturnType<typeof user>,method:string,url:string,payload?:unknown,status=200){const res=await app.inject({method:method as any,url,headers:{cookie:who.cookie,origin:'http://localhost:5318'},payload:payload as any});assert.equal(res.statusCode,status,res.body);return res.json()}
const generation=()=>({parents:{A:{mechanism:'借鉴资料整理过程',weakness:'主动查找费力'},B:{mechanism:'借鉴登山活动的节奏',weakness:'难以在家体验'}},child:{title:'新组合',content:'把资料整理变成分段登山式的探索体验，每个阶段提供随机任务。'},contributions:{A:'用资料归档流程组织任务',B:'用登山节奏组织体验'},improvement:{from:'A',description:'重组优势和缺点，探索新的使用情境'}})
const response=(value:unknown)=>Response.json({model:'returned-v5',choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]})
async function transport(work:(calls:any[])=>Promise<void>,childLevel=1){
 const original=globalThis.fetch,calls:any[]=[]
 globalThis.fetch=(async(_url,init)=>{const body=JSON.parse(String(init?.body));calls.push(body)
  if(body.messages[0].content.startsWith('读取A/B'))return response(generation())
  const payload=JSON.parse(body.messages[1].content.slice(body.messages[1].content.lastIndexOf('\n')+1))
  return response({items:payload.map((x:any)=>({id:x.id,assessment:fixtureAssessment(x.title==='新组合'?childLevel:3)}))})
 }) as typeof fetch
 try{await work(calls)}finally{globalThis.fetch=original}
}
after(async()=>{await app.close();db.close();process.chdir(previous);await rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100})})
test('synthesis permits at least six consecutive completed tasks without the old two-per-ten-minute quota',()=>{
 const who=user()
 for(let n=0;n<6;n++){const release=userOperation(who.id,'synthesis',true);release()}
})
test('synthesis allows paraphrased inspiration instead of requiring verbatim contribution quotes',()=>{
 assert.deepEqual(validateGeneration(generation(),{title:'资料',content:'整理和归档资料'},{title:'登山',content:'周末登山社群'}),[])
})
test('unrelated inputs, negative gain and repeated pairs generate fresh variants and remain privately importable',async()=>{
 const who=user(),a=idea(who,'资料工具','用网页表单整理资料并归档。'),b=idea(who,'登山社群','每周组织不同的登山路线，与同好分享风景。')
 await transport(async calls=>{
  const ids=new Set<number>(),variants=new Set<string>()
  for(let n=0;n<4;n++){
   const run=await call(who,'POST','/api/ideas/synthesize',{idea_a_id:a.id,idea_b_id:b.id})
   assert.equal(run.contract_ok,true);assert.equal(run.outcome,'synthesized');assert.equal(run.contract.gain_milli,-50000)
   assert.deepEqual(run.contract.failures,[]);assert.equal(run.synthesis_version,'synthesis-v5.1.0')
   ids.add(run.id);variants.add(JSON.parse(calls[n*2].messages[1].content).variant)
   const imported=await call(who,'POST','/api/synthesis/'+run.id+'/import');assert.equal(imported.idea.is_public,0);assert.equal(imported.idea.leaderboard_opt_in,0)
   const detail=await call(who,'GET','/api/ideas/'+imported.idea.id);assert.equal(detail.score.score,30)
  }
  assert.equal(ids.size,4);assert.equal(variants.size,4);assert.equal(calls.length,8)
 })
})
test('synthesis still blocks overlapping tasks while ordinary scoring throttles stay unchanged',()=>{
 const who=user(),release=userOperation(who.id,'synthesis',true)
 try{assert.throws(()=>userOperation(who.id,'synthesis',true),(e:any)=>e.code==='synthesis_in_progress')}finally{release()}
 for(let n=0;n<3;n++){const done=userOperation(who.id,'score',true);done()}
 assert.throws(()=>userOperation(who.id,'score',true),(e:any)=>e.code==='score_rate_limited')
 const next=userOperation(who.id,'synthesis',true);next()
})

test('distinct ideas and parent visibility remain required before any model calls',async()=>{
 const who=user(),other=user(),a=idea(who,'资料工具','整理资料'),privateIdea=idea(other,'私密材料','不可访问')
 await transport(async calls=>{
  await call(who,'POST','/api/ideas/synthesize',{idea_a_id:a.id,idea_b_id:a.id},400)
  await call(who,'POST','/api/ideas/synthesize',{idea_a_id:a.id,idea_b_id:privateIdea.id},404)
  assert.equal(calls.length,0)
 })
})

test('previous V5 synthesis records remain readable and importable under their recorded version',async()=>{
 const who=user(),a=idea(who,'资料工具','整理资料'),b=idea(who,'登山社群','组织登山活动')
 await transport(async()=>{
  const run=await call(who,'POST','/api/ideas/synthesize',{idea_a_id:a.id,idea_b_id:b.id})
  // Model a stored record from the previous release without migrating its score.
  const archived={...run,synthesis_version:'synthesis-v5.0.0',contract_ok:false,outcome:'candidate_insufficient',contract:{...run.contract,ok:false,failures:['gain_below_3']}}
  db.prepare('UPDATE synthesis_runs SET synthesis_version=?,result_json=?,contract_ok=0 WHERE id=?').run('synthesis-v5.0.0',JSON.stringify(archived),run.id)
  const saved=await call(who,'GET','/api/synthesis/'+run.id)
  assert.equal(saved.synthesis_version,'synthesis-v5.0.0');assert.equal(saved.legacy_read_only,false);assert.equal(saved.contract_ok,false)
  const imported=await call(who,'POST','/api/synthesis/'+run.id+'/import')
  assert.equal(imported.idea.synthesis_contract_ok,0);assert.equal(imported.idea.is_public,0);assert.equal(imported.idea.leaderboard_opt_in,0)
 })
})

test('empty candidate output is still a format error rather than incompatible inspirations',()=>{
 const output=generation();output.child.content='   '
 assert.ok(validateGeneration(output).some(x=>x.includes('must not be blank')))
})
