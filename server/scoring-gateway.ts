// SPDX-License-Identifier: MPL-2.0
import { performance } from 'node:perf_hooks'
import type { AiConfig } from './ai'
import { OUTPUT_BUDGETS,type Capability } from './scoring-config'
import type { Operation } from './scoring-operations'
import { upstreamSlot } from './scoring-operations'
import { permissionError } from './permissions'
import { scoringFetch } from './scoring-http'
async function readError(res:Response,signal:AbortSignal):Promise<any>{
  const reader=res.body?.getReader();if(!reader)return null
  const decoder=new TextDecoder();let text='',bytes=0
  try{while(true){if(signal.aborted)throw signal.reason;const {done,value}=await reader.read();if(done)break
    bytes+=value.byteLength;if(bytes>65536)throw permissionError(502,'ai_invalid_response','模型错误响应超出限制');text+=decoder.decode(value,{stream:true})}
    text+=decoder.decode();try{return JSON.parse(text)}catch{return null}
  }finally{await reader.cancel().catch(()=>{});reader.releaseLock()}
}
export interface GatewayResult {text:string;telemetry:Record<string,any>}
export async function scoringCompletion(cfg:AiConfig,messages:{role:string;content:string}[],options:{operation:Operation;capability:Capability;schema?:Record<string,any>;stage:string;attempt:number;reserve?:number}):Promise<GatewayResult> {
  const {operation:op,capability:cap}=options,budget=options.stage==='generation'?OUTPUT_BUDGETS.generation:options.stage==='batch'?OUTPUT_BUDGETS.batch:OUTPUT_BUDGETS.score
  op.check();const release=upstreamSlot(),start=performance.now(),signal=op.signal
  const telemetry:Record<string,any>={operation_id:op.id,stage:options.stage,attempt:options.attempt,mode:cap.mode,capability_version:cap.version,
    effective_parameters:{temperature:cap.temperature,output_parameter:cap.token_parameter,output_budget:cap.token_parameter?budget:null,stream:cap.stream,reasoning_effort:cap.reasoning_effort??null},headers_ms:null,first_content_delta_ms:null,body_ms:null,input_tokens:null,output_tokens:null,reasoning_tokens:null,cached_input_tokens:null,usage_source:null,usage_missing:true,ttft_unavailable_reason:cap.stream?null:'non_streaming',queue_wait_ms:0,finish_reason:null,returned_model:null,total_ms:null}
  let raw=''
  try {
    op.take(options.reserve)
    const body:Record<string,any>={model:cfg.model,messages}
    if(cap.temperature!==null)body.temperature=cap.temperature
    if(cap.token_parameter)body[cap.token_parameter]=budget
    if(cap.mode==='strict')body.response_format={type:'json_schema',json_schema:{name:options.stage==='generation'?'synthesis_v5':'assessment_v5',schema:options.schema,strict:true}}
    else if(cap.mode==='json')body.response_format={type:'json_object'}
    if(cap.stream){body.stream=true;if(cap.stream_usage)body.stream_options={include_usage:true}}
    if(cap.reasoning_effort)body.reasoning_effort=cap.reasoning_effort
    const res=await scoringFetch(`${cfg.baseUrl}/chat/completions`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${cfg.apiKey}`},body:JSON.stringify(body),signal,redirect:'error'})
    telemetry.headers_ms=performance.now()-start
    if(!res.ok){
      const error=await readError(res,signal)
      const param=error?.error?.param,message=String(error?.error?.message||'')
      const unsupported=[400,422].includes(res.status)&&/unsupported|not supported|does not support|不支持/i.test(message)&&['response_format','temperature',cap.token_parameter].filter(Boolean).includes(param)
      throw Object.assign(permissionError(res.status===429?429:502,unsupported?'score_model_capability_error':res.status===429?'score_rate_limited':'ai_service_error','模型服务请求失败'),{unsupported_param:unsupported?param:null,retryAfter:res.status===429?Number(res.headers.get('Retry-After'))||5:undefined})
    }
    const readStart=performance.now(),reader=res.body?.getReader()
    if(!reader)throw permissionError(502,'ai_empty_response','模型没有返回内容')
    const decoder=new TextDecoder(),sse=(res.headers.get('content-type')||'').includes('text/event-stream')
    if(sse&&!cap.stream)throw permissionError(502,'score_model_capability_error','未经验证的流式响应')
    let buffer='',completed=false,received=0
    const packet=(line:string)=>{
      if(!line.startsWith('data:'))return
      const payload=line.slice(5).trim();if(payload==='[DONE]'){completed=true;return}
      let data:any;try{data=JSON.parse(payload)}catch{throw permissionError(502,'ai_incomplete','模型返回不完整')}
      if(data.error)throw permissionError(502,'ai_service_error','模型返回错误')
      const choice=data.choices?.[0]
      if(typeof data.model==='string')telemetry.returned_model=data.model
      if(data.usage){telemetry.input_tokens=Number.isSafeInteger(data.usage.prompt_tokens)?data.usage.prompt_tokens:null;telemetry.output_tokens=Number.isSafeInteger(data.usage.completion_tokens)?data.usage.completion_tokens:null;telemetry.usage_source='upstream';telemetry.usage_missing=false;telemetry.reasoning_tokens=data.usage.completion_tokens_details?.reasoning_tokens??null;telemetry.cached_input_tokens=data.usage.prompt_tokens_details?.cached_tokens??null}
      if(choice?.delta?.refusal)throw permissionError(502,'score_model_refusal','模型拒绝评分')
      const delta=choice?.delta?.content
      if(typeof delta==='string'&&delta){if(telemetry.first_content_delta_ms===null&&delta.trim())telemetry.first_content_delta_ms=performance.now()-start;raw+=delta}
      if(choice?.finish_reason){telemetry.finish_reason=choice.finish_reason;completed=true}
    }
    try {
      while(true){
        if(signal.aborted)throw signal.reason
        const {done,value}=await reader.read();if(done)break
        received+=value.byteLength;if(received>65536)throw permissionError(502,'ai_invalid_response','模型输出超出限制')
        buffer+=decoder.decode(value,{stream:true})
        if(sse){const lines=buffer.split('\n');buffer=lines.pop()||'';lines.forEach(line=>packet(line.trim()))}
      }
      buffer+=decoder.decode();if(sse){if(buffer.trim())packet(buffer.trim());if(!completed)throw permissionError(502,'ai_incomplete','模型流式响应未完成')}
      else {
        let data:any;try{data=JSON.parse(buffer)}catch{throw permissionError(502,'ai_invalid_response','模型响应不是JSON')}
        const choice=data.choices?.[0];if(choice?.message?.refusal)throw permissionError(502,'score_model_refusal','模型拒绝评分')
        raw=choice?.message?.content;telemetry.finish_reason=choice?.finish_reason??null;telemetry.returned_model=typeof data.model==='string'?data.model:null
        telemetry.input_tokens=Number.isSafeInteger(data.usage?.prompt_tokens)?data.usage.prompt_tokens:null;telemetry.output_tokens=Number.isSafeInteger(data.usage?.completion_tokens)?data.usage.completion_tokens:null;telemetry.usage_source=data.usage?'upstream':null;telemetry.usage_missing=!data.usage;telemetry.reasoning_tokens=data.usage?.completion_tokens_details?.reasoning_tokens??null;telemetry.cached_input_tokens=data.usage?.prompt_tokens_details?.cached_tokens??null
      }
    } finally {await reader.cancel().catch(()=>{});reader.releaseLock()}
    telemetry.body_ms=performance.now()-readStart
    if(telemetry.finish_reason==='length')throw permissionError(502,'score_output_truncated','模型输出达到上限，请调整配置')
    if(telemetry.finish_reason==='content_filter')throw permissionError(502,'score_model_refusal','模型拒绝评分')
    if(typeof raw!=='string'||!raw.trim())throw permissionError(502,'ai_empty_response','模型没有返回内容')
    if(signal.aborted)throw signal.reason
    return {text:raw.trim(),telemetry}
  } catch(error:any){
    const failure=signal.aborted?permissionError(499,'score_cancelled','评分已取消'):
      error?.code?error:permissionError(502,'ai_service_error','模型服务连接失败')
    telemetry.end_reason=failure.code;throw Object.assign(failure,{telemetry,raw_response:typeof raw==='string'?raw:''})
  } finally {telemetry.total_ms=performance.now()-start;telemetry.upstream_ms=telemetry.total_ms;telemetry.ttft_ms=telemetry.first_content_delta_ms;telemetry.usage_status=telemetry.usage_missing?'missing':'upstream';release()}
}
