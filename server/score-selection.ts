// SPDX-License-Identifier: MPL-2.0
import { db } from './db'
import { serializeIdeaScore } from '../shared/idea-score'
import { STANDARD_VERSION,PROMPT_VERSION,SCHEMA_VERSION,INPUT_POLICY_VERSION,INPUT_SCOPE,PRECISION_VERSION } from '../shared/scoring-standard'
import { comparisonGroup,ENGINE_HASH,PROMPT_HASH,inputHash } from './scoring-config'
type Row=Record<string,any>
export function representativeIdSql(alias='i'):string {

  return `(SELECT h.id FROM idea_scores h WHERE h.idea_id=${alias}.id AND h.user_id=${alias}.user_id AND h.idea_revision=${alias}.idea_revision
    AND h.angle='default' AND h.validity='valid' AND h.precision_version='${PRECISION_VERSION}' AND typeof(h.score_milli)='integer' AND h.score_milli BETWEEN 0 AND 100000 AND h.score_milli%100=0
    AND h.standard_version='${STANDARD_VERSION}' AND h.engine_hash='${ENGINE_HASH}' AND h.prompt_version='${PROMPT_VERSION}' AND h.prompt_hash='${PROMPT_HASH}'
    AND h.schema_version='${SCHEMA_VERSION}' AND h.input_policy_version='${INPUT_POLICY_VERSION}' AND h.input_scope='${INPUT_SCOPE}' AND h.comparison_group='${comparisonGroup()}'
    AND h.input_hash=idea_text_v5_hash(${alias}.title,${alias}.content)
    AND idea_text_v5_assessment_valid(h.assessment_json,${alias}.title,${alias}.content,h.score_milli)=1 ORDER BY h.id DESC LIMIT 1)`
}
export const selectRepresentativeScore=(idea:Row)=>representativeFor(idea.id)
export function representativeFor(ideaId:number):Row|null {
  const row=db.prepare('SELECT s.* FROM ideas i JOIN idea_scores s ON s.id='+representativeIdSql()+' WHERE i.id=?').get(ideaId) as Row|undefined
  return row?privateScore(row,'current'):null
}
export function privateScore(row:Row,status?:string):Row {
  const fields=['id','idea_id','user_id','score','score_milli','precision_version','idea_revision','summary','dimensions','model','angle','standard_version','analysis','validity','created_at','engine_hash','prompt_version','prompt_hash','model_fingerprint','input_hash','input_scope','comparison_group','schema_version','input_policy_version']
  const safe:Row=Object.fromEntries(fields.map(key=>[key,row[key]??null]))
  for(const key of ['dimensions','analysis']){try{safe[key]=typeof safe[key]==='string'?JSON.parse(safe[key]):safe[key]||(key==='dimensions'?[]:null)}catch{safe[key]=key==='dimensions'?[]:null}}
  try{safe.assessment=row.assessment??(row.assessment_json?JSON.parse(row.assessment_json):null)}catch{safe.assessment=null}
  if(safe.assessment?.manifest){safe.assessment=structuredClone(safe.assessment);delete safe.assessment.manifest.model_base_url_safe}
  safe.tracking_status=safe.standard_version===STANDARD_VERSION?'tracked':'legacy_read_only'
  safe.comparison_status=status??(safe.standard_version!==STANDARD_VERSION?'archived':'history')
  return serializeIdeaScore(safe)
}
export function scoreHistory(idea:Row,page:number,pageSize:number,publicView=false){
  const total=(db.prepare('SELECT COUNT(*) total FROM idea_scores WHERE idea_id=?').get(idea.id) as any).total,representative=representativeFor(idea.id)
  const rows=db.prepare('SELECT * FROM idea_scores WHERE idea_id=? ORDER BY id DESC LIMIT ? OFFSET ?').all(idea.id,pageSize,(page-1)*pageSize) as Row[]
  return {items:rows.map(row=>{
    const state=row.standard_version!==STANDARD_VERSION?'archived':row.idea_revision!==idea.idea_revision||row.input_hash!==inputHash(idea as any)?'stale':row.id===representative?.id?'current':'history'
    return publicView?publicScore(row,state):privateScore(row,state)
  }),page,pageSize,total,hasMore:page*pageSize<total}
}
export function publicScore(row:Row,status?:string):Row {
  const value=privateScore(row,status),fields=['id','score','score_milli','score_display','precision_version','idea_revision','model','angle','standard_version','validity','created_at','engine_hash','prompt_version','prompt_hash','schema_version','input_policy_version','model_fingerprint','input_scope','comparison_group','tracking_status','comparison_status']
  return {...Object.fromEntries(fields.map(key=>[key,value[key]])),summary:'文本评分记录；未外部核实',dimensions:value.dimensions.map((d:Row)=>({name:d.name,score:d.score,comment:'文本规则计算结果'}))}
}
