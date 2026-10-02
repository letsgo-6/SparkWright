// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,writeFileSync,readFileSync,existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath,pathToFileURL } from 'node:url'
import path from 'node:path'
import os from 'node:os'
import { averageRanks,spearman,percentile,intervalDistance,evaluationReport } from '../scripts/scoring-eval'
test('V5 evaluation retains failures and missing usage, with nearest-rank statistics',()=>{
 assert.deepEqual(averageRanks([10,20,20,30]),[1,2.5,2.5,4]);assert.equal(spearman([1,2,3],[3,2,1]),-1)
 assert.equal(percentile([4,1,2,3],.5),2);assert.equal(percentile([],.95),null);assert.equal(intervalDistance(65,[40,60]),5)
 const score={score:50,score_milli:50000,dimensions:[]}
 const report=evaluationReport([{kind:'score',configuration:'A',input_id:'one',ok:true,attempts:1,total_ms:8000,repetition:0,score},{kind:'score',configuration:'A',input_id:'two',ok:false,attempts:2,total_ms:20000}])
 assert.equal(report.configurations[0].requests,2);assert.equal(report.configurations[0].failures,1);assert.equal(report.configurations[0].first_pass_rate,.5);assert.equal(report.configurations[0].tokens,null)
 assert.equal(report.human_labels_status,'not_verified');assert.equal(Object.hasOwn(report.cross_model,'threshold_pass'),false)
 const hidden=evaluationReport([{kind:'score',set:'hidden',configuration:'A',input_id:'one',ok:true,attempts:1,total_ms:8000,score}],{},['one','missing'])
 assert.equal(hidden.configurations[0].expected_requests,6);assert.equal(hidden.configurations[0].final_pass_rate,1/6);assert.equal(hidden.configurations[0].missing_requests,5)
})
test('V5 model median spread differs from raw spread, incomplete items never become zero',()=>{
 const rows:any[]=[]
 for(const config of ['A','B','C','D','E'])for(let repetition=0;repetition<3;repetition++)rows.push({kind:'score',configuration:config,input_id:'one',ok:true,attempts:1,total_ms:8000,repetition,score:{score:repetition===0?48:50,score_milli:repetition===0?48000:50000}})
 rows.push({kind:'score',configuration:'A',input_id:'missing',ok:false,attempts:1,total_ms:20000})
 const report=evaluationReport(rows,{},['one','missing']);assert.equal(report.cross_model.complete_n,1);assert.deepEqual(report.cross_model.missing_ids,['missing'])
 assert.equal(report.cross_model.model_spread_p90,0);assert.equal(report.cross_model.raw_spread_p90,2);assert.equal(Object.hasOwn(report.cross_model,'threshold_pass'),false)
 assert.equal(report.configurations[0].repeat_range_p90,2);assert.equal(Object.hasOwn(report.configurations[0],'repeat_range_p90_pass'),false)
})
test('V5 human error uses interval center and provenance; performance denominator includes repaired/failed requests',()=>{
 const make=(id:string,value:number,attempts=1)=>({kind:'score',set:'performance',configuration:'A',input_id:id,ok:true,attempts,total_ms:8000,repetition:0,score:{score:value,score_milli:value*1000,assessment:{assessment:{levels:[]},applied_rules:[],coverage:20}}})
 const labels={source:'human-reviewed',reviewers:['r1','r2'],adjudicator:'r3',references:{high:{total_interval:[70,80]}},near_pairs:[{higher:'high',lower:'low'}]}
 const report=evaluationReport([make('high',74),make('low',60,2),{kind:'score',set:'performance',configuration:'A',input_id:'fail',ok:false,attempts:1,total_ms:20000}],labels)
 assert.equal(report.configurations[0].mae_to_interval_center,1);assert.equal(report.configurations[0].interval_hit_rate,1);assert.equal(report.configurations[0].near_pair_direction_rate,1)
 assert.equal(report.configurations[0].performance.first_pass_rate,1/3)
})

test('V5 evaluation counts slow first-pass successes and retains their measured latency',()=>{
 const report=evaluationReport([{kind:'score',set:'performance',configuration:'A',input_id:'slow',ok:true,attempts:1,total_ms:360000,score:{score:50,score_milli:50000}},{kind:'score',set:'performance',configuration:'A',input_id:'failed',ok:false,attempts:1,total_ms:370000}])
 const config=report.configurations[0];assert.equal(config.first_pass_rate,.5);assert.equal(config.performance.first_pass_rate,.5);assert.equal(config.performance.p95_ms,360000)
})

test('V5 distribution is diagnostic and never imposes score quotas or sample-count gates',()=>{
 const sample=(id:string,score:number)=>({kind:'score',set:'natural',configuration:'A',input_id:id,ok:true,attempts:1,total_ms:100,score:{score,score_milli:score*1000}})
 const repeated=evaluationReport(Array.from({length:50},()=>sample('same',95))).configurations[0].natural_distribution
 assert.equal(repeated.independent_n,1);assert.equal(repeated.status,'measured_diagnostic_only')
 assert.equal(Object.hasOwn(repeated,'reference_target_pass'),false);assert.equal(Object.hasOwn(repeated,'target_above90_max'),false)
 assert.equal(repeated.independent_above90_fraction,1)
})

test('V5 mock-only CLI uses actual HTTP paths, persistent attempt limits, unique resume tasks and freeze protection',()=>{
 const source=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),directory=mkdtempSync(path.join(os.tmpdir(),'sparkwright-v4-eval-')),tsx=path.join(source,'node_modules/tsx/dist/cli.mjs'),cli=path.join(source,'scripts/scoring-eval.ts')
 writeFileSync(path.join(directory,'calibration-inputs.json'),JSON.stringify(Array.from({length:8},(_,i)=>({id:'engineering-'+i,title:'测试工具 '+i,content:'每周整理资料，使用网页表单与数据库规则计算。'}))))
 const configs=path.join(directory,'dummy-configs.json');writeFileSync(configs,JSON.stringify([{baseUrl:'https://fixture.test.invalid/v1',model:'fixture-only',apiKey:'dummy',source:'user',family:'fixture',provider:'fixture',input_per_million:1,output_per_million:1}]))
 const env={...process.env,AUTH_SECRET:'',AI_API_KEY:'',ZAI_API_KEY:''},invoke=(args:string[])=>spawnSync(process.execPath,[tsx,...args],{cwd:source,env,encoding:'utf8'})
 assert.equal(invoke([cli,'--eval-dir',directory,'--freeze']).status,0)
 const wrapper=path.join(directory,'mock-runner.mts'),args=[process.execPath,cli,'--eval-dir',directory,'--allow-real','--set','calibration','--configs',configs,'--repeat','3','--budget','2','--max-cost','1','--stop-failure-rate','0.5']
 writeFileSync(wrapper,`import {fixtureAssessment} from ${JSON.stringify(pathToFileURL(path.join(source,'tests/fixtures/scoring-v5.ts')).href)};
const original=globalThis.fetch;
globalThis.fetch=(async(...args)=>{if(!String(args[0]).startsWith('https://fixture.test.invalid'))return original(...args);if(new Headers(args[1]?.headers).get('Connection')!=='close')throw new Error('Cold transport must close each connection');return Response.json({model:'fixture-only',choices:[{finish_reason:'stop',message:{content:JSON.stringify(fixtureAssessment())}}],usage:{prompt_tokens:700,completion_tokens:550}})}) as typeof fetch;
process.argv=${JSON.stringify(args)};
await import(${JSON.stringify(pathToFileURL(cli).href)});`)
 for(const expected of [2,0]){const run=invoke([wrapper]);assert.equal(run.status,0,run.stderr);const report=JSON.parse(readFileSync(path.join(directory,'calibration-report.json'),'utf8'));assert.equal(report.budget.attempts,2);assert.equal(report.executed_tasks,expected);assert.equal(report.configurations[0].successes,2)}
 const records=readFileSync(path.join(directory,'results.jsonl'),'utf8').trim().split('\n').map(x=>JSON.parse(x));assert.equal(new Set(records.map(x=>x.task_id)).size,2);assert.ok(records.every(x=>x.client_total_ms>0))
 assert.equal(invoke([cli,'--eval-dir',directory,'--freeze']).status,1);assert.equal(existsSync(path.join(directory,'.eval.lock')),false)
})
