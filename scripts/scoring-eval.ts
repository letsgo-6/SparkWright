// SPDX-License-Identifier: MPL-2.0
import { readFileSync,writeFileSync,existsSync,mkdirSync,appendFileSync,openSync,closeSync,unlinkSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:net'
import { randomUUID,randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { ENGINE_HASH,PROMPT_HASH,hash,modelFingerprint,capabilityFor,rememberCapability,type Capability } from '../server/scoring-config'
import { STANDARD_VERSION,METRICS } from '../shared/scoring-standard'
import { level } from '../server/scoring-engine'
import type { AiConfig } from '../server/ai'
import { DURATION_POLICY,scoringFetch } from '../server/scoring-http'
export const percentile=(values:number[],p:number)=>{if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.max(0,Math.ceil(p*sorted.length)-1)]}
const median=(values:number[])=>{const s=[...values].sort((a,b)=>a-b);return s.length%2?s[(s.length-1)/2]:(s[s.length/2-1]+s[s.length/2])/2}
const mean=(values:number[])=>values.length?values.reduce((a,b)=>a+b,0)/values.length:null
export const intervalDistance=(score:number,interval:[number,number])=>score<interval[0]?interval[0]-score:score>interval[1]?score-interval[1]:0
export function averageRanks(values:number[]):number[]{const sorted=values.map((value,index)=>({value,index})).sort((a,b)=>a.value-b.value),ranks:number[]=[];for(let i=0;i<sorted.length;){let end=i+1;while(end<sorted.length&&sorted[end].value===sorted[i].value)end++;for(let j=i;j<end;j++)ranks[sorted[j].index]=(i+1+end)/2;i=end}return ranks}
export function spearman(a:number[],b:number[]):number|null{if(a.length!==b.length||a.length<3)return null;const ra=averageRanks(a),rb=averageRanks(b),m=(a.length+1)/2;let sum=0,aa=0,bb=0;ra.forEach((x,i)=>{sum+=(x-m)*(rb[i]-m);aa+=(x-m)**2;bb+=(rb[i]-m)**2});return aa&&bb?sum/Math.sqrt(aa*bb):null}
export function evaluationReport(records:any[],labels:any={},expectedIds?:string[]){
 const all=records.filter(x=>x.kind==='score'),groups=[...new Set(all.map(x=>x.configuration))],ids=expectedIds??[...new Set(all.map(x=>x.input_id))]
 const reviewed=labels.source==='human-reviewed'&&labels.reviewers?.length>=2&&!!labels.adjudicator
 const configurations=groups.map(group=>{
  const rows=all.filter(x=>x.configuration===group),ok=rows.filter(x=>x.ok&&x.score),first=ok.filter(x=>x.attempts===1),uncached=ok.filter(x=>!x.cached),latency=uncached.map(x=>x.total_ms)
  const triples=ids.map(id=>ok.filter(x=>x.input_id===id)).filter(x=>x.length===3),ranges=triples.map(x=>Math.max(...x.map(y=>y.score.score))-Math.min(...x.map(y=>y.score.score)))
  const human=reviewed?ok.filter(x=>labels.references?.[x.input_id]?.total_interval):[]
  const interval=human.map(x=>intervalDistance(x.score.score,labels.references[x.input_id].total_interval))
  const centerErrors=human.map(x=>Math.abs(x.score.score-(labels.references[x.input_id].total_interval[0]+labels.references[x.input_id].total_interval[1])/2))
  let gradeCount=0,gradeMisclass=0,coreExpected=0,coreHit=0
  for(const row of human){const ref=labels.references[row.input_id];for(const [i] of METRICS.entries()){const expected=ref.levels?.[i],actual=row.score.assessment?.assessment?.levels?.[i]
   if(!Number.isInteger(expected)||!Number.isInteger(actual))continue;gradeCount++;if(Math.abs(level(actual)-level(expected))>=2)gradeMisclass++
  }for(const rule of ref.core_rules||[]){coreExpected++;if(row.score.assessment?.applied_rules.some((r:any)=>r.id===rule))coreHit++}}
  const unique=ids.map(id=>{const r=ok.filter(x=>x.input_id===id);return r.length?{id,score:median(r.map(x=>x.score.score))}:null}).filter(Boolean) as {id:string;score:number}[]
  const pairs=(labels.near_pairs||[]).map((p:any)=>({a:unique.find(x=>x.id===p.higher),b:unique.find(x=>x.id===p.lower)})).filter((p:any)=>p.a&&p.b)
  const equivalence=(labels.equivalent_pairs||[]).map((p:any)=>{const a=unique.find(x=>x.id===p.A),b=unique.find(x=>x.id===p.B);return a&&b?Math.abs(a.score-b.score):null}).filter(Number.isFinite) as number[]
  const monotonic=(labels.evidence_removal_pairs||[]).map((p:any)=>({original:unique.find(x=>x.id===p.original),removed:unique.find(x=>x.id===p.removed)})).filter((p:any)=>p.original&&p.removed)
  const natural=rows.filter(x=>x.set==='natural'&&x.ok&&x.score),counts=new Map<number,number>();for(const x of natural)counts.set(x.score.score_milli,(counts.get(x.score.score_milli)||0)+1)
  const naturalIds=[...new Set(natural.map(x=>x.input_id))],naturalMedians=naturalIds.map(id=>median(natural.filter(x=>x.input_id===id).map(x=>x.score.score)))
  const natural80=naturalMedians.length?naturalMedians.filter(x=>x>=80).length/naturalMedians.length:null,natural90=naturalMedians.length?naturalMedians.filter(x=>x>=90).length/naturalMedians.length:null
  const performanceRows=rows.filter(x=>x.set==='performance')
  const denominator=expectedIds&&rows.some(x=>x.set==='hidden')?Math.max(rows.length,ids.length*3):rows.length
  const rates={first_pass_rate:denominator?first.length/denominator:null,final_pass_rate:denominator?ok.length/denominator:null}
  const perfStats=(rs:any[])=>{const valid=rs.filter(x=>x.ok&&!x.cached);return {n:rs.length,successes:valid.length,cached:rs.filter(x=>x.cached).length,first_pass_rate:rs.length?valid.filter(x=>x.attempts===1).length/rs.length:null,repair_rate:rs.length?rs.filter(x=>x.attempts>1).length/rs.length:null,timeout_rate:rs.length?rs.filter(x=>x.error_code==='score_deadline_exceeded').length/rs.length:null,p50_ms:percentile(valid.map(x=>x.total_ms),.5),p95_ms:percentile(valid.map(x=>x.total_ms),.95),client_p50_ms:percentile(valid.map(x=>x.client_total_ms).filter(Number.isFinite),.5),client_p95_ms:percentile(valid.map(x=>x.client_total_ms).filter(Number.isFinite),.95)}}
  const attempts=rows.flatMap(x=>x.attempt_telemetry||[])
  return {configuration:group,requests:rows.length,expected_requests:denominator,missing_requests:denominator-rows.length,successes:ok.length,failures:rows.length-ok.length,attempts:rows.reduce((n,x)=>n+x.attempts,0),...rates,
   p50_ms:percentile(latency,.5),p95_ms:percentile(latency,.95),client_p50_ms:percentile(uncached.map(x=>x.client_total_ms).filter(Number.isFinite),.5),client_p95_ms:percentile(uncached.map(x=>x.client_total_ms).filter(Number.isFinite),.95),
   repeats_with_three:triples.length,repeat_range_p90:percentile(ranges,.9),
   human_reference_count:human.length,interval_hit_rate:interval.length?interval.filter(x=>x===0).length/interval.length:null,mae_to_interval_center:mean(centerErrors),p90_error_to_center:percentile(centerErrors,.9),
   grade_count:gradeCount,two_grade_misclass_rate:gradeCount?gradeMisclass/gradeCount:null,core_rule_recall:coreExpected?coreHit/coreExpected:null,
   near_pair_n:pairs.length,near_pair_direction_rate:pairs.length?pairs.filter((p:any)=>p.a.score>p.b.score).length/pairs.length:null,equivalence_p90:percentile(equivalence,.9),
   evidence_removal_n:monotonic.length,evidence_removal_never_increases:monotonic.length?monotonic.every((p:any)=>p.removed.score<=p.original.score):null,
   natural_distribution:{n:natural.length,independent_n:naturalMedians.length,independent_above80_fraction:natural80,independent_above90_fraction:natural90,zero_fraction:natural.length?natural.filter(x=>x.score.score===0).length/natural.length:null,above80_fraction:natural.length?natural.filter(x=>x.score.score>=80).length/natural.length:null,above90_fraction:natural.length?natural.filter(x=>x.score.score>=90).length/natural.length:null,most_common_fraction:natural.length?Math.max(...counts.values())/natural.length:null,status:naturalMedians.length?'measured_diagnostic_only':'not_verified'},
   performance:{...perfStats(performanceRows),long_n:performanceRows.filter(x=>x.long_input).length,profiles:[...new Set(performanceRows.map(x=>x.cache_profile))],by_profile:Object.fromEntries(['cold','warm'].map(p=>[p,perfStats(performanceRows.filter(x=>x.cache_profile===p))])),by_length:Object.fromEntries(['short','long'].map(p=>[p,perfStats(performanceRows.filter(x=>Boolean(x.long_input)===(p==='long')))])),by_concurrency:Object.fromEntries([...new Set(performanceRows.map(x=>x.concurrency))].map(n=>[String(n),perfStats(performanceRows.filter(x=>x.concurrency===n))])),status:performanceRows.length>=100&&performanceRows.filter(x=>x.long_input).length>=20&&['cold','warm'].every(p=>performanceRows.some(x=>x.cache_profile===p))?'measured_requires_deployment_review':'not_verified'},
   usage_missing_fraction:rows.length?rows.filter(x=>!x.usage).length/rows.length:null,ttft_missing_fraction:attempts.length?attempts.filter(x=>x.ttft_ms==null).length/attempts.length:null,
   tokens:rows.every(x=>x.usage?.input_tokens!=null&&x.usage?.output_tokens!=null)?{input:rows.reduce((n,x)=>n+x.usage.input_tokens,0),output:rows.reduce((n,x)=>n+x.usage.output_tokens,0)}:null}
 })
 const complete=ids.filter(id=>groups.length>=2&&groups.every(g=>all.filter(x=>x.configuration===g&&x.input_id===id&&x.ok).length>0))
 const modelSpreads=complete.map(id=>{const medians=groups.map(g=>median(all.filter(x=>x.configuration===g&&x.input_id===id&&x.ok).map(x=>x.score.score)));return Math.max(...medians)-Math.min(...medians)})
 const rawSpreads=complete.map(id=>{const values=all.filter(x=>x.input_id===id&&x.ok).map(x=>x.score.score);return Math.max(...values)-Math.min(...values)})
 const cross={expected_n:ids.length,complete_n:complete.length,missing_ids:ids.filter(id=>!complete.includes(id)),model_spread_p50:percentile(modelSpreads,.5),model_spread_p90:percentile(modelSpreads,.9),model_spread_p95:percentile(modelSpreads,.95),raw_spread_p90:percentile(rawSpreads,.9),raw_spread_p95:percentile(rawSpreads,.95)}
 const synth=records.filter(x=>x.kind==='synthesis'),synthLabels=reviewed?labels.synthesis_reviews||{}:{},integrated=synth.filter(x=>synthLabels[x.input_id]?.substantive_integration===true),positive=synth.filter(x=>x.ok&&x.result?.contract_ok),reviewedPositive=positive.filter(x=>synthLabels[x.input_id]?.confirmed_improvement===true)
 return {standard_version:STANDARD_VERSION,engine_hash:ENGINE_HASH,prompt_hash:PROMPT_HASH,requests:records.length,configurations,cross_model:cross,
  synthesis:{n:synth.length,integration_rate:synth.length?integrated.length/synth.length:null,positive_n:positive.length,confirmed_positive_rate:positive.length?reviewedPositive.length/positive.length:null,fabricated_facts:Object.values(synthLabels).filter((x:any)=>x.fabricated===true).length,status:reviewed&&synth.length>=20?'requires_human_review':'not_verified'},
  human_labels_status:reviewed?'provided_requires_provenance_review':'not_verified',cross_model_status:groups.length>=2?'measured_diagnostic_only':'not_verified',evaluation_role:'optional_diagnostics_no_runtime_gate',failures_are_not_zero_scores:true}
}
const datasets=['development','calibration','hidden','natural','performance','synthesis']
async function main(){
 const argv=process.argv.slice(2),arg=(name:string)=>{const i=argv.indexOf(name);return i<0?undefined:argv[i+1]}
 if(argv.includes('--help')){console.log('V5 optional diagnostics. --eval-dir PRIVATE_DIR --freeze | --report | --dry-run\nPaid run requires --allow-real --configs PRIVATE_JSON --set development|calibration|hidden|natural|performance|synthesis --budget INTEGER --max-cost USD --stop-failure-rate 0..1 [--repeat 1..3] [--concurrency 1..4] [--cache-profile cold|warm]\nNo V2/V3 baseline, automatic approval, HTTP evaluation bypass or hidden quality rewrite.');return}
 const root=path.resolve(arg('--eval-dir')||'work/evals/scoring-v5');if(!existsSync(root))throw new Error('Prepare private evaluation inputs first.')
 const manifestPath=path.join(root,'freeze-manifest.json'),ledgerPath=path.join(root,'attempt-budget.json'),resultsPath=path.join(root,'results.jsonl'),synthHash=hash(readFileSync(new URL('../server/idea-synthesis.ts',import.meta.url),'utf8'))
 const read=(name:string)=>JSON.parse(readFileSync(path.join(root,name),'utf8'))
 const previous=()=>existsSync(resultsPath)?readFileSync(resultsPath,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[]
 if(argv.includes('--report')){const set=arg('--set')||'hidden',labels=existsSync(path.join(root,set+'-labels.json'))?read(set+'-labels.json'):{};writeFileSync(path.join(root,set+'-report.json'),JSON.stringify(evaluationReport(previous().filter(x=>x.set===set),labels,existsSync(path.join(root,set+'-inputs.json'))?read(set+'-inputs.json').map((x:any)=>x.id):undefined),null,2));console.log('Report generated; no automatic model approval.');return}
 if(argv.includes('--freeze')||argv.includes('--dry-run')){
  if(existsSync(ledgerPath))throw new Error('Attempts already exist. Freeze a new batch instead of rewriting this batch.')
  const hashes:Record<string,string>={},counts:Record<string,number>={},seen=new Set<string>()
  for(const set of datasets){const name=set+'-inputs.json';if(!existsSync(path.join(root,name)))continue;const rows=read(name);if(!Array.isArray(rows))throw new Error('Inputs must be arrays')
   counts[set]=rows.length;hashes[name]=hash(rows);const ids=new Set<string>();for(const row of rows){if(typeof row.id!=='string'||ids.has(row.id))throw new Error('Unique string IDs required');ids.add(row.id);const texts=set==='synthesis'?[row.A,row.B]:[row];for(const t of texts)if(typeof t?.title!=='string'||typeof t?.content!=='string')throw new Error('Title/content required')
    if(!['synthesis','performance'].includes(set)){const identity=hash({title:row.title.normalize('NFC').trim(),content:row.content.normalize('NFC').trim()});if(seen.has(identity))throw new Error('Duplicate input across evaluation sets');seen.add(identity)}}
   const label=set+'-labels.json';if(existsSync(path.join(root,label)))hashes[label]=hash(read(label))
  }
  const manifest={standard_version:STANDARD_VERSION,engine_hash:ENGINE_HASH,prompt_hash:PROMPT_HASH,synthesis_source_hash:synthHash,duration_policy:DURATION_POLICY,frozen_at:new Date().toISOString(),hashes,counts,ready:Object.values(counts).some(n=>n>0),evaluation_role:'optional_diagnostics_no_runtime_gate'}
  if(argv.includes('--freeze'))writeFileSync(manifestPath,JSON.stringify(manifest,null,2));else writeFileSync(path.join(root,'engineering-dry-run.json'),JSON.stringify(manifest,null,2))
  console.log(JSON.stringify({no_model_calls:true,ready:manifest.ready,counts}));return
 }
 if(!argv.includes('--allow-real'))throw new Error('Real calls require explicit --allow-real.')
 const budget=Number(arg('--budget')),maxCost=Number(arg('--max-cost')),stopFailure=Number(arg('--stop-failure-rate'))
 if(!Number.isSafeInteger(budget)||budget<1||!Number.isFinite(maxCost)||maxCost<=0||!arg('--stop-failure-rate')||stopFailure<0||stopFailure>1)throw new Error('Explicit call budget, cost ceiling and failure stop threshold are required.')
 const set=arg('--set')||'calibration';if(!datasets.includes(set))throw new Error('Unknown set')
 const manifest=read('freeze-manifest.json')
 if(manifest.engine_hash!==ENGINE_HASH||manifest.prompt_hash!==PROMPT_HASH||manifest.synthesis_source_hash!==synthHash||manifest.duration_policy!==DURATION_POLICY)throw new Error('Frozen implementation changed. Create a new evaluation batch.')
 for(const [name,h] of Object.entries(manifest.hashes))if(hash(read(name))!==h)throw new Error('Frozen data changed: '+name)
 const inputs=read(set+'-inputs.json');if(!Array.isArray(inputs)||!inputs.length)throw new Error('Supply at least one input for this optional batch.')
 const configPath=arg('--configs');if(!configPath)throw new Error('Private configurations are required')
 const configurations=JSON.parse(readFileSync(path.resolve(configPath),'utf8')) as (AiConfig&{family:string;provider:string;input_per_million:number;output_per_million:number;capability?:Capability;capability_verification?:string})[]
 if(!Array.isArray(configurations)||!configurations.length||configurations.some(c=>!c.apiKey||!c.model||!c.baseUrl||!c.family||!c.provider||!Number.isFinite(c.input_per_million)||!Number.isFinite(c.output_per_million)))throw new Error('Supply local configurations, family/provider identities and reviewed rates.')
 for(const c of configurations)if(c.capability){if(!c.capability_verification)throw new Error('Explicit capability verification evidence required');rememberCapability(c,c.capability)}
 if(new Set(configurations.map(c=>modelFingerprint(c))).size!==configurations.length)throw new Error('Duplicate effective model configurations are not independent models.')
 const configurationManifest=configurations.map(c=>({fingerprint:modelFingerprint(c),requested_model:c.model,family:c.family,provider:c.provider,capability:capabilityFor(c),capability_verification:c.capability_verification??null,input_per_million:c.input_per_million,output_per_million:c.output_per_million}))
 const configurationManifestPath=path.join(root,'configuration-manifest.json')
 if(existsSync(configurationManifestPath)&&hash(JSON.parse(readFileSync(configurationManifestPath,'utf8')))!==hash(configurationManifest))throw new Error('Frozen configurations or reviewed prices changed. Start a new batch.')
 const repeat=Number(arg('--repeat')|| (set==='hidden'?'3':'1')),concurrency=Number(arg('--concurrency')||'1')
 const cacheProfile=arg('--cache-profile')||'cold'
 if(!['cold','warm'].includes(cacheProfile))throw new Error('Cache profile must be cold or warm; scoring cache is disabled by fresh input identities in both.')
 if(!Number.isSafeInteger(repeat)||repeat<1||repeat>3||!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>4)throw new Error('Invalid repeat/concurrency')
 if(set==='hidden'&&(repeat!==3||configurations.length<5||new Set(configurations.map(c=>c.family)).size<3||new Set(configurations.map(c=>c.provider)).size<3))throw new Error('Hidden H1 requires five configurations from three families/providers and three repeats.')
 const lock=path.join(root,'.eval.lock')
 const ledger=existsSync(ledgerPath)?read('attempt-budget.json'):{attempts:0,max:budget,max_cost:maxCost,cost:0,tasks:{},unknown_usage:false,stop:false}
 if(ledger.max!==budget||ledger.max_cost!==maxCost)throw new Error('Resuming a batch must preserve its approved budget.')
 const fd=openSync(lock,'wx');closeSync(fd)
 if(!existsSync(configurationManifestPath))writeFileSync(configurationManifestPath,JSON.stringify(configurationManifest,null,2))
 const saveLedger=()=>writeFileSync(ledgerPath,JSON.stringify(ledger,null,2))
 const oldCwd=process.cwd(),runtime=path.join(root,'runtime');mkdirSync(runtime,{recursive:true});process.chdir(runtime)
 process.env.AUTH_SECRET=randomBytes(48).toString('hex');delete process.env.AI_API_KEY;delete process.env.ZAI_API_KEY;process.env.SPARKWRIGHT_AI_WRITES_ENABLED='true'
 let app:any,database:any;const originalFetch=globalThis.fetch
 try{
  const reservation=createServer();await new Promise<void>(resolve=>reservation.listen(0,'127.0.0.1',resolve))
  const port=(reservation.address() as {port:number}).port;await new Promise<void>((resolve,reject)=>reservation.close(error=>error?reject(error):resolve()))
  const url='http://127.0.0.1:'+port;process.env.APP_ORIGIN=url
  const {db}=await import('../server/db');database=db;const {buildApp}=await import('../server/app');const {signToken}=await import('../server/auth')
  app=await buildApp();await app.listen({host:'127.0.0.1',port})
  globalThis.fetch=(async(...args:Parameters<typeof fetch>)=>{if(String(args[0]).startsWith(url+'/'))return originalFetch(...args);if(ledger.stop||ledger.attempts>=ledger.max)throw Object.assign(new Error('Evaluation call budget exhausted'),{code:'synthesis_budget_exceeded',statusCode:429});ledger.attempts++;saveLedger();const headers=new Headers(args[1]?.headers);if(cacheProfile==='cold')headers.set('Connection','close');return originalFetch(args[0],{...args[1],headers})}) as typeof fetch
  const tasks=configurations.flatMap(config=>inputs.flatMap((input:any)=>Array.from({length:repeat},(_,repetition)=>({config,input,repetition,id:hash({set,input_id:input.id,configuration:modelFingerprint(config),repetition,cache_profile:arg('--cache-profile')||'cold',concurrency})}))))
  let cursor=0,executed=0,failures=0
  const worker=async()=>{while(cursor<tasks.length&&!ledger.stop&&ledger.attempts<ledger.max){const task=tasks[cursor++];if(ledger.tasks[task.id])continue
   ledger.tasks[task.id]='started';saveLedger();const {config,input,repetition}=task,userId=Number(db.prepare('INSERT INTO users(name,role) VALUES(?,?)').run('eval-'+randomUUID(),'user').lastInsertRowid)
   db.prepare('INSERT INTO user_settings(user_id,base_url,api_key,model) VALUES(?,?,?,?)').run(userId,config.baseUrl,config.apiKey,config.model)
   const cookie='ideabox_session='+signToken(userId,'eval'),make=(x:any)=>Number(db.prepare('INSERT INTO ideas(user_id,title,content) VALUES(?,?,?)').run(userId,x.title,x.content).lastInsertRowid)
   const payload=set==='synthesis'?{idea_a_id:make(input.A),idea_b_id:make(input.B)}:{request_id:randomUUID(),response_mode:'compact'},ideaId=set==='synthesis'?payload.idea_a_id:make(input)
   const route=set==='synthesis'?'/api/ideas/synthesize':'/api/ideas/'+ideaId+'/ai/score',start=performance.now()
   const record:any={task_id:task.id,kind:set==='synthesis'?'synthesis':'score',set,input_id:input.id,repetition,configuration:modelFingerprint(config),model:config.model,family:config.family,provider:config.provider,cache_profile:cacheProfile,transport_profile:cacheProfile==='cold'?'connection-close-each-request':'pooled-connections-including-initial-request',concurrency,long_input:input.long_input===true,occurred_at:new Date().toISOString(),ok:false,attempts:0}
   try{const res=await scoringFetch(url+route,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie,Origin:url,...(cacheProfile==='cold'?{Connection:'close'}:{})},body:JSON.stringify(payload)}),data=await res.json() as any;record.client_total_ms=performance.now()-start;record.ok=res.ok;record.error_code=data.error?.code??null;record.score=data.score;record.result=set==='synthesis'?data:undefined;record.cached=data.cached??false
    const opId=data.operation_id??data.score?.assessment?.manifest?.operation_id
    const op=opId?db.prepare('SELECT * FROM scoring_operations WHERE id=?').get(opId) as any:db.prepare('SELECT * FROM scoring_operations WHERE user_id=? ORDER BY rowid DESC LIMIT 1').get(userId) as any
    const meta=op?JSON.parse(op.telemetry_json):null;record.total_ms=meta?.http_total_ms??meta?.operation_total_ms??record.client_total_ms;record.operation_telemetry=meta
    const logs=op?db.prepare("SELECT telemetry_json FROM ai_raw_logs WHERE json_extract(telemetry_json,'$.operation_id')=? ORDER BY id").all(op.id) as any[]:[]
    record.attempt_telemetry=logs.map(x=>JSON.parse(x.telemetry_json));record.attempts=op?.attempt_count??record.attempt_telemetry.length
    const known=record.attempt_telemetry.length>0&&record.attempt_telemetry.every((x:any)=>x.input_tokens!=null&&x.output_tokens!=null)
    record.usage=known?{input_tokens:record.attempt_telemetry.reduce((n:number,x:any)=>n+x.input_tokens,0),output_tokens:record.attempt_telemetry.reduce((n:number,x:any)=>n+x.output_tokens,0)}:null
    record.cost=record.attempts===0?0:known?(record.usage.input_tokens*config.input_per_million+record.usage.output_tokens*config.output_per_million)/1000000:null
    if(record.cost!==null)ledger.cost+=record.cost;else{ledger.unknown_usage=true;ledger.stop=true}
    if(ledger.cost>=ledger.max_cost)ledger.stop=true
   }catch(e:any){record.error_code=e.code||'transport_error';record.total_ms=performance.now()-start}
   if(!record.ok)failures++;executed++;if(executed>=5&&failures/executed>stopFailure)ledger.stop=true
   appendFileSync(resultsPath,JSON.stringify(record)+'\n');ledger.tasks[task.id]='finished';saveLedger();console.log(JSON.stringify({input_id:input.id,ok:record.ok,attempts:record.attempts}))
  }}
  await Promise.all(Array.from({length:concurrency},worker))
  const labels=existsSync(path.join(root,set+'-labels.json'))?read(set+'-labels.json'):{},report=evaluationReport(previous().filter(x=>x.set===set),labels,inputs.map((x:any)=>x.id))
  writeFileSync(path.join(root,set+'-report.json'),JSON.stringify({...report,executed_tasks:executed,budget:{attempts:ledger.attempts,max:ledger.max,cost:ledger.cost,max_cost:ledger.max_cost,unknown_usage:ledger.unknown_usage},unfinished_tasks:Object.entries(ledger.tasks).filter(([,state])=>state==='started').map(([id])=>id),skipped_due_budget:tasks.filter(t=>!ledger.tasks[t.id]).length},null,2))
 }finally{globalThis.fetch=originalFetch;if(app)await app.close();if(database)database.close();process.chdir(oldCwd);unlinkSync(lock)}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href)main().catch(error=>{console.error(error instanceof Error?error.message:'Evaluation failed');process.exitCode=1})
