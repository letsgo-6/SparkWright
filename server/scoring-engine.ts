// SPDX-License-Identifier: MPL-2.0
import { LOCAL_WEIGHTS,VALUE_POINTS,DIMENSION_NAMES,DIMENSION_KEYS,SCORE_OUTPUT_SCHEMA,normalizeText,type TextInput,type Assessment,type ComputedAssessment,type MetricId,type AppliedRule } from '../shared/scoring-standard'
export interface ValidationIssue {path:string;code:'score_format_invalid'|'score_evidence_invalid';message:string}
export function parseJsonStrict(raw:string):unknown {
  const text=raw.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i,'$1')
  const value=JSON.parse(text)
  const tokens=text.match(/"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]/g)||[],stack:(Set<string>|null)[]=[]
  tokens.forEach((token,index)=>{
    if(token==='{')stack.push(new Set())
    else if(token==='[')stack.push(null)
    else if(token==='}'||token===']')stack.pop()
    else if(token.startsWith('"')&&tokens[index+1]===':'&&stack.at(-1)){
      const key=JSON.parse(token),keys=stack.at(-1)!
      if(keys.has(key))throw new Error('duplicate JSON key: '+key)
      keys.add(key)
    }
  })
  return value
}
export function schemaIssues(value:unknown,schema:Record<string,any>,path='$',root=SCORE_OUTPUT_SCHEMA):ValidationIssue[] {
  if(schema.anyOf){const choices=schema.anyOf.map((choice:Record<string,any>)=>schemaIssues(value,choice,path,root));return choices.some((x:ValidationIssue[])=>!x.length)?[]:[{path,code:'score_format_invalid',message:'invalid union value'}]}
  if(schema.type==='null')return value===null?[]:[{path,code:'score_format_invalid',message:'must be null'}]
  const issues:ValidationIssue[]=[],fail=(message:string)=>issues.push({path,code:'score_format_invalid',message})
  if(schema.type==='object'){
    if(!value||typeof value!=='object'||Array.isArray(value)){fail('must be object');return issues}
    const obj=value as Record<string,unknown>
    for(const key of schema.required||[])if(!Object.hasOwn(obj,key))issues.push({path:path+'.'+key,code:'score_format_invalid',message:'required'})
    for(const [key,v] of Object.entries(obj))if(!schema.properties?.[key])issues.push({path:path+'.'+key,code:'score_format_invalid',message:'extra property'});else issues.push(...schemaIssues(v,schema.properties[key],path+'.'+key,root))
  }else if(schema.type==='array'){
    if(!Array.isArray(value)){fail('must be array');return issues}
    if(value.length>(schema.maxItems??Infinity)||value.length<(schema.minItems??0))fail('array length')
    if(schema.uniqueItems&&new Set(value.map(x=>JSON.stringify(x))).size!==value.length)fail('duplicate item')
    value.forEach((v,i)=>issues.push(...schemaIssues(v,schema.items,path+'['+i+']',root)))
  }else if(schema.type==='integer'){
    if(!Number.isSafeInteger(value)||(value as number)<(schema.minimum??-Infinity)||(value as number)>(schema.maximum??Infinity))fail('invalid integer')
  }else if(schema.type==='string'){
    if(typeof value!=='string')fail('must be string')
    else if([...value].length<(schema.minLength??0)||[...value].length>(schema.maxLength??Infinity))fail('Unicode length')
  }else if(schema.type==='boolean'&&typeof value!=='boolean')fail('must be boolean')
  if(schema.enum&&!schema.enum.includes(value))fail('invalid enum')
  return issues
}
export function validateAssessment(value:unknown,input:TextInput):{assessment:Assessment|null;issues:ValidationIssue[]} {
 const issues=schemaIssues(value,SCORE_OUTPUT_SCHEMA)
 if(issues.length)return {assessment:null,issues}
 const a=value as Assessment,text=normalizeText(input.title,input.content),all=text.title+"\n"+text.content
 a.quotes.forEach((quote,i)=>{if(!all.includes(quote))issues.push({path:"$.quotes["+i+"]",code:"score_evidence_invalid",message:"quote is not in original text"})})
 return {assessment:issues.length?null:a,issues}
}
export const level=(value:unknown)=>Number.isInteger(value)?Number(value):NaN
export function evaluateAssessment(a:Assessment):ComputedAssessment {
 const numerators=Array.from({length:4},(_,d)=>LOCAL_WEIGHTS.reduce((n,w,j)=>n+w*VALUE_POINTS[a.levels[d*3+j]],0))
 const total=numerators.reduce((a,b)=>a+b,0),raw=numerators.map(n=>n*10)
 const gate80=[0,3,9].every(i=>a.levels[i]>=3),gate90=gate80&&numerators.every(n=>n>=8000)&&a.levels[7]===4
 let tenth=Math.floor((total+20)/40)
 const applied:AppliedRule[]=[]
 const cap=(hit:boolean,max:number,id:string,ids:MetricId[])=>{if(hit){if(tenth>max)applied.push({id,cap_milli:max*100,metric_ids:ids});tenth=Math.min(tenth,max)}}
 cap(!gate80,799,"E_GATE_80",["P1","S1","F1"])
 cap(!gate90,899,"E_GATE_90",["D2"])
 cap(a.levels[3]===0||a.levels[9]===0,499,"E_CORE_IMPOSSIBLE",(["S1","F1"] as MetricId[]).filter((_,i)=>a.levels[i===0?3:9]===0))
 return {assessment:a,raw_dimensions_milli:raw,base_milli:Math.floor((total+20)/40)*100,score_milli:tenth*100,
 dimensions:numerators.map((n,i)=>({key:DIMENSION_KEYS[i],name:DIMENSION_NAMES[i],score:n/100,comment:"V5固定等级计算"})),applied_rules:applied,gates:{gate80,gate90}}
}
export const ENGINE_IMPLEMENTATION=[parseJsonStrict,schemaIssues,validateAssessment,evaluateAssessment,normalizeText].map(fn=>fn.toString()).join("\n")
