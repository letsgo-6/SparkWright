// SPDX-License-Identifier: MPL-2.0
import { db } from './db'
type Row=Record<string,any>
export function canSeeParent(ideaId:number,userId:number){return !!db.prepare('SELECT id FROM ideas WHERE id=? AND (user_id=? OR (is_public=1 AND plaza_removed_at IS NULL))').get(ideaId,userId)}
export function safeSynthesisResult(result:Row,bVisible:boolean):Row {
  if(bVisible)return result
  const safe=structuredClone(result)
  if(safe.parents)safe.parents.B=null
  safe.contributions=null;safe.improvement=null;delete safe.credential_scope;safe.inherit_map=null;safe.avoid_map=null;safe.reuse_map=null;safe.weakness_map=null;safe.parent_analysis=null;safe.new_dependencies=null;delete safe.parent_snapshots
  // Entire generator/candidate context may quote the withdrawn parent, including diagnostic paths.
  delete safe.candidates;delete safe.relation;delete safe.strategy_facts;delete safe.source_facts;delete safe.generator_output
  if(safe.contract){safe.contract={baseline:safe.contract.baseline,gain_milli:safe.contract.gain_milli,failures:safe.contract.failures, both_mechanisms:safe.contract.both_mechanisms,weakness_improved:safe.contract.weakness_improved,no_new_core_flaw:safe.contract.no_new_core_flaw,total_gain:safe.contract.total_gain,c1_total_gain:safe.contract.c1_total_gain,c2_no_floor_break:safe.contract.c2_no_floor_break,c3_no_over_trade:safe.contract.c3_no_over_trade,c4_inherit_complete:safe.contract.c4_inherit_complete,no_new_hard_knot:safe.contract.no_new_hard_knot,strategy_valid:safe.contract.strategy_valid,ok:safe.contract.ok}}
  safe.reason='父灵感上下文已撤回';safe.strategy_reason=null;safe.context_withdrawn=true
  // Child content/assessment belongs to the caller, but mapped provenance is no longer accessible.
  if(safe.child_score?.assessment?.manifest)delete safe.child_score.assessment.manifest.source_parent_ids
  return safe
}
export function safeSynthesisLogs(rows:unknown[],userId:number):unknown[] {
  return rows.map(value=>{
    const row=value as Row
    let meta:Row={};try{meta=JSON.parse(row.telemetry_json||'{}')}catch{}
    const parents=Array.isArray(meta.source_parent_ids)?meta.source_parent_ids:[]
    if(parents.some((id:number)=>!canSeeParent(id,userId)))return {...row,request_prompt:'父灵感上下文已撤回',raw_response:'父灵感上下文已撤回',diagnostic:null,telemetry_json:JSON.stringify({stage:meta.stage,attempt:meta.attempt,total_ms:meta.total_ms,context_withdrawn:true})}
    return row
  })
}
