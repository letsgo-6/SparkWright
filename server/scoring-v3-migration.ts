// SPDX-License-Identifier: MPL-2.0
import type Database from 'better-sqlite3'
export function migrateScoringV3(db:Database.Database):void {
  db.transaction(()=>{
    const add=(table:string,name:string,type:string)=>{if(!(db.prepare(`PRAGMA table_info(${table})`).all() as {name:string}[]).some(x=>x.name===name))db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`)}
    for(const column of ['engine_hash','prompt_version','prompt_hash','model_fingerprint','input_hash','input_scope','comparison_group','cache_key','assessment_json','request_id','request_hash'])add('idea_scores',column,'TEXT')
    add('ai_raw_logs','telemetry_json','TEXT');add('synthesis_runs','synthesis_version','TEXT');add('synthesis_runs','engine_hash','TEXT')
    add('user_settings','ai_config_revision','INTEGER NOT NULL DEFAULT 0')
    db.exec(`CREATE INDEX IF NOT EXISTS idx_score_v3_representative ON idea_scores(idea_id,standard_version,engine_hash,comparison_group,input_scope,idea_revision,id DESC);
      CREATE INDEX IF NOT EXISTS idx_score_v3_cache ON idea_scores(user_id,cache_key,validity,id DESC);
      CREATE TABLE IF NOT EXISTS scoring_request_receipts(user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,request_hash TEXT NOT NULL,score_id INTEGER NOT NULL REFERENCES idea_scores(id) ON DELETE CASCADE,created_at TEXT NOT NULL,PRIMARY KEY(user_id,request_id));
      CREATE TRIGGER IF NOT EXISTS ai_config_revision_changed AFTER UPDATE OF base_url,api_key,model ON user_settings
      WHEN OLD.base_url IS NOT NEW.base_url OR OLD.api_key IS NOT NEW.api_key OR OLD.model IS NOT NEW.model
      BEGIN UPDATE user_settings SET ai_config_revision=OLD.ai_config_revision+1 WHERE user_id=NEW.user_id; END;
      CREATE TRIGGER IF NOT EXISTS score_v3_complete BEFORE INSERT ON idea_scores
      WHEN NEW.standard_version='sparkwright-four-dim-v3-grid1' AND (NEW.engine_hash IS NULL OR NEW.prompt_hash IS NULL OR NEW.prompt_version IS NULL
      OR NEW.model_fingerprint IS NULL OR NEW.input_hash IS NULL OR NEW.input_scope IS NULL OR NEW.assessment_json IS NULL OR NEW.precision_version IS NOT 'milli-v1'
      OR NEW.validity IS NOT 'valid' OR typeof(NEW.score_milli)!='integer' OR NEW.score_milli NOT BETWEEN 0 AND 100000)
      BEGIN SELECT RAISE(ABORT,'incomplete v3 score identity'); END;`)
  }).immediate()
}
