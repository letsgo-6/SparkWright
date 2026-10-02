// SPDX-License-Identifier: MPL-2.0
import type { FastifyInstance } from 'fastify'
import { db, nowIso } from './db'
import { permissionError, requireAuth } from './permissions'
import { featurePagination,createOriginGuard,requireId } from './request-validation'
import { serializeIdeaScore } from '../shared/idea-score'
import { representativeIdSql,representativeFor } from './score-selection'
import { scoringStatus } from './scoring-config'
import { PRECISION_VERSION } from '../shared/scoring-standard'

export const leaderboardEnabled = () => process.env.SPARKWRIGHT_LEADERBOARD_ENABLED !== 'false'
// Use the score's original operation, so cache hits and imported results cannot reset its duration.
const timelyScore = `EXISTS (SELECT 1 FROM scoring_operations o WHERE o.id=s.operation_id AND o.user_id=s.user_id
  AND o.status='success' AND o.cache_status='miss'
  AND json_type(o.telemetry_json,'$.operation_total_ms') IN ('integer','real')
  AND json_extract(o.telemetry_json,'$.operation_total_ms') BETWEEN 0 AND 60000)`
// Public eligibility and current-revision representative selection precede ranking.
const candidates = () => `SELECT i.id idea_id,i.title,i.public_summary,i.tags,u.name author,s.score_milli,s.created_at scored_at,s.model,s.id representative_score_id
  FROM ideas i JOIN users u ON u.id=i.user_id JOIN idea_scores s ON s.id=${representativeIdSql()}
  WHERE i.leaderboard_opt_in=1 AND i.is_public=1 AND i.score_public=1 AND i.plaza_removed_at IS NULL AND u.role IN ('owner','admin','user')
  AND s.score_milli<100000 AND ${timelyScore}`
export function leaderboard(page: number, pageSize: number) {
  return db.transaction(() => {
    const total=(db.prepare(`SELECT COUNT(*) total FROM (${candidates()})`).get() as {total:number}).total
    const items=db.prepare(`WITH eligible AS (${candidates()}), ranked AS (SELECT *,RANK() OVER (ORDER BY score_milli DESC) rank FROM eligible)
      SELECT * FROM ranked ORDER BY score_milli DESC,representative_score_id ASC,idea_id ASC LIMIT ? OFFSET ?`)
      .all(pageSize,(page-1)*pageSize)
      .map(row=>({...serializeIdeaScore(row as {score_milli:number}),standard_version:scoringStatus().standard_version,precision_version:PRECISION_VERSION,angle:'default'}))
    return {items,total,page,pageSize,hasMore:page*pageSize<total,generated_at:nowIso(),...scoringStatus()}
  }).deferred()
}
export function registerLeaderboard(app: FastifyInstance): void {
  const origin=createOriginGuard()
  app.put<{Params:{id:string};Body:unknown}>('/api/ideas/:id/leaderboard',async req=>{
    origin(req);requireAuth(req)
    const body=req.body as Record<string,unknown>
    if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).length!==1||typeof body.enabled!=='boolean')throw permissionError(400,'invalid_leaderboard_input','参榜参数不合法')
    return db.transaction(()=>{
      const id=requireId(req.params.id),idea=db.prepare('SELECT * FROM ideas WHERE id=? AND user_id=?').get(id,req.authUser!.id) as Record<string,any>|undefined
      if(!idea)throw permissionError(404,'idea_not_found','灵感不可访问')
      if(body.enabled){
        const score=representativeFor(id)
        if(!score)throw permissionError(409,'leaderboard_score_required','请先对当前正文完成V5评分')
        if(score.score_milli===100000)throw permissionError(409,'leaderboard_full_score_excluded','100.0分不能参榜')
        if(!(db.prepare(`SELECT ${timelyScore} eligible FROM idea_scores s WHERE s.id=?`).get(score.id) as {eligible:number}).eligible)
          throw permissionError(409,'leaderboard_scoring_too_slow','评分超过60秒或缺少有效耗时记录')
        if(idea.is_public!==1||idea.score_public!==1||idea.plaza_removed_at!==null)throw permissionError(409,'leaderboard_requires_public','参榜需公开灵感及评分')
      }
      const enabled=body.enabled?1:0
      if(idea.leaderboard_opt_in===enabled)req.activitySucceeded=false
      db.prepare('UPDATE ideas SET leaderboard_opt_in=? WHERE id=?').run(enabled,id)
      return db.prepare('SELECT * FROM ideas WHERE id=?').get(id)
    }).immediate()
  })
  app.get('/api/plaza/leaderboard/status',async(req,reply)=>{
    requireAuth(req);reply.header('Cache-Control','no-store');return {enabled:leaderboardEnabled(),...scoringStatus()}
  })
  app.get<{Querystring:Record<string,unknown>}>('/api/plaza/leaderboard',async(req,reply)=>{
    requireAuth(req);reply.header('Cache-Control','no-store')
    if(!leaderboardEnabled()) throw permissionError(503,'leaderboard_unavailable','排行榜尚未启用')
    const page=featurePagination(req.query);return leaderboard(page.page,page.pageSize)
  })
}
