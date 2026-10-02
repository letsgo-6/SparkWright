// SPDX-License-Identifier: MPL-2.0
import { performance } from 'node:perf_hooks'
import { permissionError } from './permissions'
export interface Operation {id:string;kind:'score'|'synthesis';started:number;attempts:number;repairs:number;maxAttempts:number;databaseMs:number;serializationMs:number;signal:AbortSignal;check:()=>void;take:(reserve?:number)=>void;repair:()=>void;close:()=>void}
export function createOperation(id:string,kind:'score'|'synthesis',signal?:AbortSignal,receivedAt=performance.now()):Operation {
  const started=receivedAt,controller=new AbortController()
  const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal
  const op:Operation={id,kind,started,attempts:0,repairs:0,maxAttempts:kind==='score'?2:4,databaseMs:0,serializationMs:0,signal:combined,
    check:()=>{if(combined.aborted)throw permissionError(499,'score_cancelled','评分已取消')},
    take:(reserve=0)=>{op.check();if(op.attempts+reserve>=op.maxAttempts)throw permissionError(429,'synthesis_budget_exceeded','调用预算不足');op.attempts++},
    repair:()=>{op.check();if(op.repairs>=(kind==='score'?1:2))throw permissionError(502,'score_format_invalid','没有剩余结构修复预算');op.repairs++},
    close:()=>{controller.abort('finished')}}
  return op
}
export function databaseWork<T>(op:Operation,work:()=>T):T {const start=performance.now();try{return work()}finally{op.databaseMs+=performance.now()-start}}
let upstream=0
export function upstreamSlot():()=>void {if(upstream>=4)throw Object.assign(permissionError(429,'score_rate_limited','评分服务繁忙'),{retryAfter:2});upstream++;return ()=>{upstream--}}
const active=new Set<number>(),limits=new Map<string,number[]>()
export function userOperation(userId:number,kind:'score'|'synthesis',limited:boolean):()=>void {
  if(active.has(userId))throw Object.assign(permissionError(429,kind==='synthesis'?'synthesis_in_progress':'score_rate_limited','已有评分或合成正在进行'),{retryAfter:2})
  if(limited&&kind==='score'){const key=userId+':'+kind,now=Date.now(),recent=(limits.get(key)||[]).filter(t=>now-t<600000),max=3
    if(recent.length>=max)throw Object.assign(permissionError(429,'score_rate_limited','操作过于频繁'),{retryAfter:(recent[0]+600000-now)/1000})
    recent.push(now);limits.set(key,recent)
    if(limits.size>10000)for(const [id,stamps] of limits)if(stamps.at(-1)!<now-600000)limits.delete(id)
  }
  active.add(userId);return ()=>active.delete(userId)
}
export function disconnectSignal(req:{raw:any},reply:{raw:any}):{signal:AbortSignal;close:()=>void} {
  const controller=new AbortController(),abort=()=>controller.abort('cancelled'),closed=()=>{if(!reply.raw.writableFinished)abort()}
  req.raw.once('aborted',abort);reply.raw.once('close',closed)
  return {signal:controller.signal,close:()=>{req.raw.removeListener('aborted',abort);reply.raw.removeListener('close',closed)}}
}
