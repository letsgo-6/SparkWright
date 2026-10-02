// SPDX-License-Identifier: MPL-2.0
// Synthetic, isolated data only. No real account, AI key or live database is read.
import {mkdtempSync,writeFileSync} from 'node:fs'
import {rm} from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {performance} from 'node:perf_hooks'
import {randomBytes} from 'node:crypto'
import type {Assessment} from '../shared/scoring-standard'
const output=process.argv[2]?path.resolve(process.argv[2]):null
const original=process.cwd(),temp=mkdtempSync(path.join(os.tmpdir(),'sparkwright-benchmark-'));process.chdir(temp)
process.env.AUTH_SECRET=randomBytes(48).toString('hex')
const {db}=await import('../server/db')
const {ActivityTracker}=await import('../server/activity')
const {leaderboard}=await import('../server/leaderboard')
const {STANDARD_VERSION,PRECISION_VERSION,INPUT_SCOPE}=await import('../shared/scoring-standard')
const {ENGINE_HASH,PROMPT_HASH,modelFingerprint,comparisonGroup,inputHash}=await import('../server/scoring-config')
const {evaluateAssessment}=await import('../server/scoring-engine')
const {writeScore}=await import('../server/ai-scoring')
const {representativeIdSql}=await import('../server/score-selection')
const config={baseUrl:'https://benchmark.test.invalid/v1',model:'synthetic-v5',apiKey:'unused-fixture',source:'user' as const}
const fingerprint=modelFingerprint(config)
const content='Synthetic workflow with form input and database rules.'
const assessment:Assessment={levels:Array(12).fill(3),quotes:['Synthetic workflow'],summary:'Synthetic engineering fixture'}
const computed=evaluateAssessment(assessment)
let app: Awaited<ReturnType<typeof import('../server/app').buildApp>> | undefined
const now=Math.floor(Date.now()/1000),hour=Math.floor(now/3600)*3600
try{
  db.transaction(()=>{
    const user=db.prepare("INSERT INTO users(id,name,role) VALUES (?,?,'user')"),idea=db.prepare("INSERT INTO ideas(id,user_id,title,content,is_public,score_public,leaderboard_opt_in,public_summary) VALUES (?,?,?,?,1,1,1,'Synthetic summary')")
    const activity=db.prepare('INSERT INTO user_activity_hours VALUES (?,?,?,?)'),state=db.prepare('INSERT INTO user_activity_state VALUES (?,?)')
    const archive=db.prepare("INSERT INTO idea_scores(idea_id,user_id,score,summary,dimensions,model,standard_version,created_at) VALUES (?,?,80,'read-only archive fixture','[]','archive-fixture','archive-capacity-fixture',?)")
    for(let i=1;i<=10000;i++){
      const title=`Synthetic idea ${i}`;user.run(i,`benchmark-${i}`);idea.run(i,i,title,content);state.run(i,now-(i%720)*3600)
      for(let j=0;j<50;j++){const h=hour-((i+j*13)%720)*3600;activity.run(i,h,h+1,h+1)}
      for(let j=0;j<19;j++)archive.run(i,i,new Date((now-(20-j)*3600)*1000).toISOString())
      writeScore(i,i,0,{score:computed.score_milli/1000,score_milli:computed.score_milli,summary:'synthetic engineering fixture',dimensions:computed.dimensions,analysis:{},assessment:{...computed,manifest:{returned_model:config.model,operation_id:'benchmark-'+i}},standard_version:STANDARD_VERSION,precision_version:PRECISION_VERSION,engine_hash:ENGINE_HASH,prompt_hash:PROMPT_HASH,model_fingerprint:fingerprint,input_scope:INPUT_SCOPE,input_hash:inputHash({title,content}),comparison_group:comparisonGroup(),model:config.model,cache_key:null,cached:false})
    }
    db.prepare('INSERT INTO activity_collection_meta(id,collection_started_at,last_cleanup_at) VALUES (1,?,?)').run(now-90*86400,now)
  }).immediate()
  db.exec('ANALYZE')
  const tracker=new ActivityTracker(()=>now)
  function measure(work:()=>unknown,n:number){const samples:number[]=[];for(let i=0;i<n;i++){const start=performance.now();work();samples.push(performance.now()-start)}samples.sort((a,b)=>a-b);return{count:n,p50_ms:samples[Math.floor(n*.5)],p95_ms:samples[Math.ceil(n*.95)-1],max_ms:samples.at(-1)}}
  const result={machine:{platform:os.platform(),release:os.release(),cpu:os.cpus()[0].model,memory_gib:Math.round(os.totalmem()/2**30),node:process.version},data:{users:10000,activity_hours:500000,ideas:10000,scores:200000,v5_scores:10000,read_only_archives:190000},mode:'single process; no business result cache; assessment-validation cache limited to 10000 entries/64 MiB key payload; synthetic V5 assessments only, no model calls; SQLite serializes work',
    activity_first:measure(()=>{db.pragma('shrink_memory');tracker.report('30d')},1),activity_24h:measure(()=>tracker.report('24h'),30),activity_7d:measure(()=>tracker.report('7d'),30),activity_30d:measure(()=>tracker.report('30d'),30),
    leaderboard_first:measure(()=>{db.pragma('shrink_memory');leaderboard(1,20)},1),leaderboard_page1:measure(()=>leaderboard(1,20),30),leaderboard_page100:measure(()=>leaderboard(100,20),30),leaderboard_page500:measure(()=>leaderboard(500,20),30),
    concurrent_burst_8:await(async()=>{const timings:number[]=[];for(let r=0;r<10;r++){const start=performance.now();await Promise.all(Array.from({length:8},(_,i)=>Promise.resolve().then(()=>{tracker.report('30d');leaderboard(i+1,20);timings.push(performance.now()-start)})))}timings.sort((a,b)=>a-b);return{requests:80,p95_end_to_end_ms:timings[Math.ceil(timings.length*.95)-1]}})(),
    plans:{activity:db.prepare("EXPLAIN QUERY PLAN SELECT COUNT(DISTINCT a.user_id) FROM user_activity_hours a INDEXED BY idx_activity_hours_chart JOIN users u ON u.id=a.user_id WHERE a.hour_start>=? AND a.hour_start<? AND a.first_seen_at<=? AND u.role='user'").all(hour-86400,hour,now),representative:db.prepare('EXPLAIN QUERY PLAN SELECT s.id FROM ideas i JOIN idea_scores s ON s.id='+representativeIdSql()+' WHERE i.id=?').all(1)}}
  // Measure the real HTTP handlers as well as the storage functions.
  db.prepare("UPDATE users SET role='admin' WHERE id=10000").run()
  process.env.SPARKWRIGHT_LEADERBOARD_ENABLED='true'
  const {buildApp}=await import('../server/app'),{signToken}=await import('../server/auth')
  app=await buildApp();const address=await app.listen({host:'127.0.0.1',port:0})
  const headers={cookie:`ideabox_session=${signToken(10000,'benchmark')}`}
  async function get(route:string){const response=await fetch(address+route,{headers});if(!response.ok)throw new Error(`Benchmark HTTP ${response.status}`);await response.json()}
  async function http(work:()=>Promise<void>,n:number){const samples:number[]=[];for(let i=0;i<n;i++){const start=performance.now();await work();samples.push(performance.now()-start)}samples.sort((a,b)=>a-b);return{count:n,p95_ms:samples[Math.ceil(n*.95)-1]}}
  const endpoint={activity_30d:await http(()=>get('/api/admin/analytics/activity?view=30d'),20),leaderboard:await http(()=>get('/api/plaza/leaderboard'),20),
    burst8:await(async()=>{const samples:number[]=[];for(let batch=0;batch<10;batch++){const start=performance.now();await Promise.all(Array.from({length:8},(_,i)=>(async()=>{await get(i%2?'/api/plaza/leaderboard':'/api/admin/analytics/activity?view=30d');samples.push(performance.now()-start)})()))}samples.sort((a,b)=>a-b);return{requests:80,p95_end_to_end_ms:samples[Math.ceil(samples.length*.95)-1]}})()}
  const final={...result,http:endpoint,http_role_scope:'user 10000 temporarily promoted to admin for authenticated API benchmarking'}
  if(output)writeFileSync(output,JSON.stringify(final,null,2)+'\n','utf8');console.log(JSON.stringify(final,null,2))
}finally{if(app)await app.close();db.close();process.chdir(original);await rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100})}
