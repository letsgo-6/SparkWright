// SPDX-License-Identifier: MPL-2.0
import type Database from 'better-sqlite3'
import { inputHash } from './scoring-config'
import { validateAssessment,evaluateAssessment } from './scoring-engine'
export function migrateScoringV5(db:Database.Database):void {
  // Immutable assessment checks repeat in COUNT/rank queries. Cache only this pure
  // validation, keyed by every input; never cache permissions or representative IDs.
  const checked=new Map<string,number>();let checkedBytes=0
  db.function('idea_text_v5_hash',{deterministic:true},(title:unknown,content:unknown)=>inputHash({title:String(title??''),content:String(content??'')}))
  db.function('idea_text_v5_assessment_valid',{deterministic:true},(json:unknown,title:unknown,content:unknown,milli:unknown)=>{
    const key=JSON.stringify([json,title,content,milli]),hit=checked.get(key);if(hit!==undefined)return hit
    let result=0;try{const a=validateAssessment(JSON.parse(String(json)).assessment,{title:String(title),content:String(content)}).assessment;result=a&&evaluateAssessment(a).score_milli===milli?1:0}catch{}
    const bytes=key.length*2
    if(bytes<=64*1024*1024){while(checked.size&&(checked.size>=10000||checkedBytes+bytes>64*1024*1024)){const first=checked.keys().next().value!;checked.delete(first);checkedBytes-=first.length*2}checked.set(key,result);checkedBytes+=bytes}
    return result
  })
  db.transaction(()=>{
    const add=(table:string,name:string,type:string)=>{if(!(db.prepare('PRAGMA table_info('+table+')').all() as {name:string}[]).some(x=>x.name===name))db.exec('ALTER TABLE '+table+' ADD COLUMN '+name+' '+type)}
    add('ideas','idea_revision','INTEGER NOT NULL DEFAULT 0')
    for(const name of ['schema_version','input_policy_version','model_base_url_safe','operation_id'])add('idea_scores',name,'TEXT')
    for(const name of ['prompt_version','prompt_hash','model_fingerprint','operation_id','outcome'])add('synthesis_runs',name,'TEXT')
    for(const name of ['a_revision','b_revision','gain_milli'])add('synthesis_runs',name,'INTEGER')
    db.exec(`CREATE TRIGGER IF NOT EXISTS idea_text_v4_changed AFTER UPDATE OF title,content ON ideas
      WHEN OLD.title IS NOT NEW.title OR OLD.content IS NOT NEW.content
      BEGIN UPDATE ideas SET idea_revision=OLD.idea_revision+1 WHERE id=NEW.id; END;
      CREATE INDEX IF NOT EXISTS idx_score_v4_representative ON idea_scores(idea_id,standard_version,engine_hash,input_scope,idea_revision,id DESC);
      CREATE INDEX IF NOT EXISTS idx_synthesis_v4_history ON synthesis_runs(user_id,synthesis_version,id DESC);
      CREATE TABLE IF NOT EXISTS scoring_operations(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,standard_version TEXT NOT NULL,engine_hash TEXT NOT NULL,prompt_hash TEXT NOT NULL,input_hash TEXT,
      status TEXT NOT NULL,score_id INTEGER REFERENCES idea_scores(id) ON DELETE SET NULL,attempt_count INTEGER NOT NULL,
      cache_status TEXT NOT NULL,telemetry_json TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_scoring_operations_user_time ON scoring_operations(user_id,created_at,id);`)
    const missing=['engine_hash','prompt_hash','prompt_version','model_fingerprint','input_hash','input_scope','assessment_json','schema_version','input_policy_version','operation_id'].map(k=>`NEW.${k} IS NULL OR trim(NEW.${k})=''`).join(' OR ')
    for(const event of ['INSERT','UPDATE'])db.exec(`CREATE TRIGGER IF NOT EXISTS score_v4_complete_${event.toLowerCase()} BEFORE ${event} ON idea_scores
      WHEN NEW.standard_version='sparkwright-idea-v4.0.0' AND (${missing} OR NEW.angle IS NOT 'default' OR NEW.validity IS NOT 'valid'
      OR NEW.precision_version IS NOT 'milli-v1' OR typeof(NEW.score_milli)!='integer' OR NEW.score_milli NOT BETWEEN 0 AND 100000 OR NEW.score_milli%250!=0
      OR typeof(NEW.idea_revision)!='integer' OR NEW.idea_revision<0 OR NEW.input_scope IS NOT 'idea-text-v4'
      OR NEW.schema_version IS NOT 'assessment-v4.0.0' OR NEW.input_policy_version IS NOT 'idea-text-v4.0.0'
      OR NOT json_valid(NEW.assessment_json))
      BEGIN SELECT RAISE(ABORT,'incomplete v4 score identity'); END;`)
    // V4.0 constraints remain intact. New names upgrade existing databases too.
    for(const event of ['INSERT','UPDATE'])db.exec(`CREATE TRIGGER IF NOT EXISTS score_v41_complete_${event.toLowerCase()} BEFORE ${event} ON idea_scores
      WHEN NEW.standard_version='sparkwright-idea-v4.1.0' AND (${missing} OR NEW.angle IS NOT 'default' OR NEW.validity IS NOT 'valid'
      OR NEW.precision_version IS NOT 'deci-v1' OR typeof(NEW.score_milli)!='integer' OR NEW.score_milli NOT BETWEEN 0 AND 100000 OR NEW.score_milli%100!=0
      OR typeof(NEW.idea_revision)!='integer' OR NEW.idea_revision<0 OR NEW.input_scope IS NOT 'idea-text-v4'
      OR NEW.schema_version IS NOT 'assessment-v4.0.0' OR NEW.input_policy_version IS NOT 'idea-text-v4.0.0'
      OR NOT json_valid(NEW.assessment_json))
      BEGIN SELECT RAISE(ABORT,'incomplete v4.1 score identity'); END;`)

    add('synthesis_runs','cache_key','TEXT')
    db.exec('CREATE INDEX IF NOT EXISTS idx_synthesis_v5_cache ON synthesis_runs(user_id,synthesis_version,cache_key,id DESC)')
    add('ideas','leaderboard_opt_in','INTEGER NOT NULL DEFAULT 0')
    db.exec("CREATE TRIGGER IF NOT EXISTS leaderboard_v5_withdraw AFTER UPDATE OF is_public,score_public,plaza_removed_at ON ideas WHEN NEW.leaderboard_opt_in=1 AND (NEW.is_public!=1 OR NEW.score_public!=1 OR NEW.plaza_removed_at IS NOT NULL) BEGIN UPDATE ideas SET leaderboard_opt_in=0 WHERE id=NEW.id; END;")
    for(const event of ['INSERT','UPDATE'])db.exec("CREATE TRIGGER IF NOT EXISTS score_v5_complete_"+event.toLowerCase()+" BEFORE "+event+" ON idea_scores "+
      "WHEN NEW.standard_version='sparkwright-idea-v5.0.0' AND ("+missing+" OR NEW.angle IS NOT 'default' OR NEW.validity IS NOT 'valid' "+
      "OR NEW.precision_version IS NOT 'deci-v1' OR typeof(NEW.score_milli)!='integer' OR NEW.score_milli NOT BETWEEN 0 AND 100000 OR NEW.score_milli%100!=0 "+
      "OR typeof(NEW.idea_revision)!='integer' OR NEW.idea_revision<0 OR NEW.input_scope IS NOT 'idea-text-v5' "+
      "OR NEW.schema_version IS NOT 'assessment-v5.0.0' OR NEW.input_policy_version IS NOT 'idea-text-v5.0.0' OR NOT json_valid(NEW.assessment_json)) "+
      "BEGIN SELECT RAISE(ABORT,'incomplete v5 score identity'); END;")
  }).immediate()
}
