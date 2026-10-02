// SPDX-License-Identifier: MPL-2.0
import { test,after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { randomUUID,randomBytes } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
const previous=process.cwd(),temp=mkdtempSync(path.join(os.tmpdir(),'sparkwright-v4-http-'))
process.chdir(temp);process.env.AUTH_SECRET=randomBytes(48).toString('hex')
const {createOperation}=await import('../server/scoring-operations')
const {scoringCompletion}=await import('../server/scoring-gateway')
const {db}=await import('../server/db')
after(async()=>{db.close();process.chdir(previous);await rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100})})

const capability={version:'http-fixture',mode:'plain' as const,temperature:null,token_parameter:null,stream:false}
test('V4 real HTTP response may exceed the former 20-second score deadline',async()=>{
 const server=createServer((_req,res)=>{const timer=setTimeout(()=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({model:'fixture',choices:[{finish_reason:'stop',message:{content:'{}'}}]}))},21050);res.once('close',()=>clearTimeout(timer))})
 server.listen(0,'127.0.0.1');await once(server,'listening')
 const cfg={baseUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}`,apiKey:'dummy',model:'fixture',source:'user' as const},op=createOperation(randomUUID(),'score')
 try{const result=await scoringCompletion(cfg,[],{operation:op,capability,stage:'score',attempt:1});assert.equal(result.text,'{}');assert.ok(performance.now()-op.started>=21000);assert.ok(result.telemetry.headers_ms>=21000);assert.equal(op.attempts,1)}
 finally{op.close();server.closeAllConnections();await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
})

test('V4 real HTTP cancellation works both before headers and during a response body',async()=>{
 for(const phase of ['headers','body']){
  let announce!:()=>void,disconnected!:()=>void
  const ready=new Promise<void>(resolve=>announce=resolve),closed=new Promise<void>(resolve=>disconnected=resolve)
  const server=createServer((_req,res)=>{res.once('close',disconnected);if(phase==='body'){res.setHeader('Content-Type','application/json');res.write('{"choices":[')}announce()})
  server.listen(0,'127.0.0.1');await once(server,'listening')
  const cfg={baseUrl:`http://127.0.0.1:${(server.address() as {port:number}).port}`,apiKey:'dummy',model:'fixture',source:'user' as const},controller=new AbortController(),op=createOperation(randomUUID(),'score',controller.signal)
  const pending=scoringCompletion(cfg,[],{operation:op,capability,stage:'score',attempt:1});pending.catch(()=>{})
  try{await ready;controller.abort('cancelled');await assert.rejects(pending,(error:any)=>error.code==='score_cancelled'&&error.statusCode===499);await closed}
  finally{op.close();server.closeAllConnections();await pending.catch(()=>{});await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
 }
})
