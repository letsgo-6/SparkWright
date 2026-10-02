// SPDX-License-Identifier: MPL-2.0
// Read-only diagnostics. Never prints user text, credentials or AI output.
import Database from 'better-sqlite3'
import path from 'node:path'
const filename=process.argv[2]
if(!filename)throw new Error('Usage: tsx scripts/new-round-data-audit.ts <consistent-copy.db>')
const db=new Database(path.resolve(filename),{readonly:true,fileMustExist:true})
try{
  const columns=(db.pragma('table_info(idea_scores)') as {name:string}[]).map(row=>row.name)
  console.log(JSON.stringify({integrity:db.pragma('integrity_check'),foreign_keys:db.pragma('foreign_key_check'),score_columns:columns,
    legacy_anomalies:db.prepare("SELECT id,typeof(score) storage_type,CASE WHEN typeof(score)!='integer' THEN 'non_integer_legacy' ELSE 'out_of_range' END reason FROM idea_scores WHERE typeof(score)!='integer' OR score NOT BETWEEN 0 AND 100").all(),
    precision_summary:columns.includes('score_milli')?db.prepare('SELECT precision_version,COUNT(*) records,SUM(score_milli IS NULL) missing_milli FROM idea_scores GROUP BY precision_version').all():null},null,2))
}finally{db.close()}
