// SPDX-License-Identifier: MPL-2.0
import type { FastifyInstance } from 'fastify'
import { db, nowIso } from './db'
import { permissionError, requireAuth } from './permissions'
import { serializeIdeaScore } from '../shared/idea-score'
import { privateScore } from './score-selection'
import { safeSynthesisResult } from './synthesis-privacy'

type Row = Record<string, unknown>
const credentialField = (key: string) => /^(password(?:hash)?|apikey|authorization|cookie|authsecret|accesstoken|refreshtoken|token|secret|sessiontoken|clientsecret|privatekey|credentials)$/.test(key.toLowerCase().replace(/[_-]/g, ''))

function redact(value: unknown, secrets: string[]): unknown {
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !credentialField(key)).map(([key, item]) => [key, redact(item, secrets)]))
  if (typeof value !== 'string') return value
  if (/^\s*[\[{]/.test(value)) {
    try { return JSON.stringify(redact(JSON.parse(value), secrets)) } catch { /* Free text may start with a bracket. */ }
  }
  let text = value
  for (const secret of secrets) for (const form of new Set([secret, encodeURIComponent(secret)])) text = text.replaceAll(form, '[REDACTED]')
  text = text.replace(/(authorization\s*[:=]\s*(?:bearer|basic)\s+)[^\\\s"',;]+/gi, '$1[REDACTED]')
    .replace(/((?:set-cookie|cookie)\s*:\s*)[^\r\n\\]+/gi, '$1[REDACTED]')
    .replace(/((?:ideabox_session|api[_-]?key|auth_secret|password|access_token|refresh_token)\s*[:=]\s*)[^\\\s"',;]+/gi, '$1[REDACTED]')
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED]')
  return text.replace(/https?:\/\/[^\s<>"'\\]+/g, (address) => {
    try {
      const url = new URL(address)
      let changed = Boolean(url.username || url.password)
      url.username = ''; url.password = ''
      for (const key of [...url.searchParams.keys()]) if (credentialField(key)) { url.searchParams.delete(key); changed = true }
      if (/(?:token|secret|key|password)\s*=/i.test(url.hash)) { url.hash = ''; changed = true }
      return changed ? url.href : address
    } catch { return address }
  })
}

export function redactAiLogs(value: unknown, userId: number, cookie?: string, extraSecrets: string[] = []): unknown {
  const settings = db.prepare('SELECT api_key FROM user_settings WHERE user_id = ?').get(userId) as { api_key?: string } | undefined
  const credentials = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(userId) as { password_hash?: string } | undefined
  const secrets = [...extraSecrets, settings?.api_key, credentials?.password_hash, cookie, process.env.AUTH_SECRET, process.env.AI_API_KEY, process.env.ZAI_API_KEY,
    process.env.EMAIL_SMTP_PASS, process.env.EMAIL_VERIFICATION_SECRET].filter((v): v is string => typeof v === 'string' && v.length > 0).sort((a, b) => b.length - a.length)
  return redact(value, secrets)
}

function stripEndpoints(value:any):any {
  if(Array.isArray(value))return value.map(stripEndpoints)
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>key!=='model_base_url_safe').map(([key,item])=>[key,stripEndpoints(item)]))
  return value
}
function personalData(id: number): Record<string, Row[]> {
  const rows = (sql: string, ...args: number[]) => db.prepare(sql).all(...args) as Row[]
  const synthesis = rows(`SELECT r.id, r.user_id, r.idea_a_id,
    CASE WHEN b.id IS NOT NULL AND (b.user_id = r.user_id OR (b.is_public = 1 AND b.plaza_removed_at IS NULL)) THEN r.idea_b_id END idea_b_id,
    r.result_json, r.contract_ok, r.imported_idea_id, r.created_at,
    CASE WHEN b.id IS NOT NULL AND (b.user_id = r.user_id OR (b.is_public = 1 AND b.plaza_removed_at IS NULL)) THEN 1 ELSE 0 END b_visible
    FROM synthesis_runs r LEFT JOIN ideas b ON b.id = r.idea_b_id WHERE r.user_id = ? ORDER BY r.id`, id)
    .map((row) => {
      const { b_visible, ...safe } = row
      if (b_visible) return safe
      return { ...safe, result_json: JSON.stringify(safeSynthesisResult(JSON.parse(String(row.result_json)),false)) }
    })
  return {
    ideas: rows('SELECT id, user_id, title, content, deadline, status, created_at, updated_at, is_public, public_summary, tags, score_public, leaderboard_opt_in, source_parent_ids, synthesis_contract_ok, score_revision, idea_revision FROM ideas WHERE user_id = ? ORDER BY id', id),
    plan_steps: rows('SELECT s.id, s.idea_id, s.title, s.done, s.sort FROM plan_steps s JOIN ideas i ON i.id = s.idea_id WHERE i.user_id = ? ORDER BY s.id', id),
    ai_messages: rows('SELECT m.id, m.idea_id, m.user_id, m.role, m.content, m.created_at FROM ai_messages m JOIN ideas i ON i.id = m.idea_id WHERE i.user_id = ? AND m.user_id = ? ORDER BY m.id', id, id),
    idea_scores: rows('SELECT s.* FROM idea_scores s JOIN ideas i ON i.id = s.idea_id WHERE i.user_id = ? AND s.user_id = ? ORDER BY s.id', id, id).map(row=>privateScore(row)),
    user_feedback: rows('SELECT id,user_id,category,title,content,page_path,status,version,created_at,updated_at,closed_at FROM user_feedback WHERE user_id=? ORDER BY id', id),
    feedback_events: rows("SELECT e.id,e.feedback_id,e.kind,e.content,e.from_status,e.to_status,e.created_at FROM feedback_events e JOIN user_feedback f ON f.id=e.feedback_id WHERE f.user_id=? AND e.kind != 'internal_note' AND (e.kind != 'status' OR e.from_status != e.to_status) ORDER BY e.id", id),
    synthesis_runs: synthesis.map(row=>({...row,result_json:JSON.stringify(stripEndpoints(JSON.parse(String(row.result_json))))})),
    scoring_operations: rows('SELECT id,kind,standard_version,engine_hash,prompt_hash,input_hash,status,score_id,attempt_count,cache_status,telemetry_json,created_at FROM scoring_operations WHERE user_id=? ORDER BY rowid',id),
    dev_projects: rows(`SELECT p.id, p.user_id, p.name, p.description, p.milestone, p.priority, p.status, p.created_at, p.repo_url, p.tech_stack, p.deadline,
      CASE WHEN EXISTS (SELECT 1 FROM ideas i WHERE i.id = p.source_idea_id AND i.user_id = p.user_id) THEN p.source_idea_id END source_idea_id,
      CASE WHEN EXISTS (SELECT 1 FROM order_leads o WHERE o.id = p.source_lead_id AND o.user_id = p.user_id) THEN p.source_lead_id END source_lead_id
      FROM dev_projects p WHERE p.user_id = ? ORDER BY p.id`, id),
    dev_tasks: rows('SELECT t.id, t.project_id, t.title, t.done, t.sort, t.status, t.priority FROM dev_tasks t JOIN dev_projects p ON p.id = t.project_id WHERE p.user_id = ? ORDER BY t.id', id),
    dev_milestones: rows('SELECT m.id, m.project_id, m.title, m.target_date, m.done, m.created_at FROM dev_milestones m JOIN dev_projects p ON p.id = m.project_id WHERE p.user_id = ? ORDER BY m.id', id),
    dev_logs: rows('SELECT l.id, l.project_id, l.content, l.created_at FROM dev_logs l JOIN dev_projects p ON p.id = l.project_id WHERE p.user_id = ? ORDER BY l.id', id),
    order_leads: rows(`SELECT o.id, o.user_id, o.title, o.requirement, o.url, o.amount, o.deadline, o.status,
      CASE WHEN EXISTS (SELECT 1 FROM dev_projects p WHERE p.id = o.matched_project_id AND p.user_id = o.user_id) THEN o.matched_project_id END matched_project_id,
      o.matched_at, o.created_at, o.updated_at FROM order_leads o WHERE o.user_id = ? ORDER BY o.id`, id),
    order_matches: rows(`SELECT m.id, m.lead_id, m.project_id, m.score, m.reasons, m.created_at, m.kw_score, m.ai_score, m.hit_terms
      FROM order_matches m JOIN order_leads o ON o.id = m.lead_id JOIN dev_projects p ON p.id = m.project_id
      WHERE o.user_id = ? AND p.user_id = ? ORDER BY m.id`, id, id),
    idea_order_scores: rows(`SELECT s.id, s.idea_id, s.user_id, s.order_id, s.score, s.reasons, s.created_at
      FROM idea_order_scores s JOIN ideas i ON i.id = s.idea_id JOIN order_leads o ON o.id = s.order_id
      WHERE s.user_id = ? AND i.user_id = ? AND o.user_id = ? ORDER BY s.id`, id, id, id),
    studio_projects: rows(`SELECT s.id, s.user_id, CASE WHEN EXISTS (SELECT 1 FROM ideas i WHERE i.id = s.source_idea_id AND i.user_id = s.user_id) THEN s.source_idea_id END source_idea_id,
      s.title, s.brief, s.form, s.synopsis, s.characters, s.scenes, s.tools, s.chosen_tool, s.status, s.created_at, s.updated_at
      FROM studio_projects s WHERE s.user_id = ? ORDER BY s.id`, id),
    video_wishes: rows(`SELECT w.id, w.user_id, w.title, w.video_url, w.description, w.features, w.art_style, w.analysis_channel,
      CASE WHEN EXISTS (SELECT 1 FROM ideas i WHERE i.id = w.source_idea_id AND i.user_id = w.user_id) THEN w.source_idea_id END source_idea_id,
      CASE WHEN EXISTS (SELECT 1 FROM studio_projects s WHERE s.id = w.adopted_studio_id AND s.user_id = w.user_id) THEN w.adopted_studio_id END adopted_studio_id,
      w.created_at, w.updated_at FROM video_wishes w WHERE w.user_id = ? ORDER BY w.id`, id),
    wish_matches: rows(`SELECT m.id, m.wish_id, m.studio_id, m.score, m.kw_score, m.ai_score, m.hit_terms, m.reasons, m.created_at
      FROM wish_matches m JOIN video_wishes w ON w.id = m.wish_id JOIN studio_projects s ON s.id = m.studio_id
      WHERE w.user_id = ? AND s.user_id = ? ORDER BY m.id`, id, id),
    media_items: rows(`SELECT m.id, m.user_id, m.title, m.topic, m.platform, m.status, m.publish_date, m.views, m.likes, m.comments, m.created_at,
      CASE WHEN EXISTS (SELECT 1 FROM ideas i WHERE i.id = m.source_idea_id AND i.user_id = m.user_id) THEN m.source_idea_id END source_idea_id,
      CASE WHEN EXISTS (SELECT 1 FROM studio_projects s WHERE s.id = m.studio_id AND s.user_id = m.user_id) THEN m.studio_id END studio_id
      FROM media_items m WHERE m.user_id = ? ORDER BY m.id`, id),
    consult_items: rows('SELECT id, user_id, client, project, deliverable, status, next_follow_up, hours, amount, settled_amount, created_at FROM consult_items WHERE user_id = ? ORDER BY id', id),
    daily_plans: rows(`SELECT d.id, d.user_id, d.plan_date, d.title, d.plan_time, d.priority, d.done, d.created_at,
      CASE WHEN EXISTS (SELECT 1 FROM plan_steps s JOIN ideas i ON i.id = s.idea_id WHERE s.id = d.source_step_id AND i.user_id = d.user_id) THEN d.source_step_id END source_step_id
      FROM daily_plans d WHERE d.user_id = ? ORDER BY d.id`, id),
    daily_reviews: rows('SELECT id, user_id, review_date, content, updated_at FROM daily_reviews WHERE user_id = ? ORDER BY id', id),
    notifications: rows(`SELECT n.id, n.user_id, n.type,
      CASE WHEN n.type IN ('like','comment','mention') AND EXISTS (SELECT 1 FROM ideas i WHERE i.id = n.ref_id AND (i.user_id = n.user_id OR i.is_public = 1)) THEN n.ref_id
        WHEN n.type = 'followup' AND EXISTS (SELECT 1 FROM consult_items c WHERE c.id = n.ref_id AND c.user_id = n.user_id) THEN n.ref_id
        WHEN n.type IN ('feedback_reply','feedback_status') AND EXISTS (SELECT 1 FROM user_feedback f WHERE f.id=n.ref_id AND f.user_id=n.user_id) THEN n.ref_id END ref_id,
      CASE WHEN n.actor_id = n.user_id THEN n.actor_id END actor_id,
      CASE WHEN n.type IN ('like','comment','mention') AND NOT EXISTS
        (SELECT 1 FROM ideas i WHERE i.id = n.ref_id AND (i.user_id = n.user_id OR (i.is_public = 1 AND i.plaza_removed_at IS NULL)))
        THEN '相关灵感已不可访问' ELSE n.content END content,
      n.read, n.created_at FROM notifications n WHERE n.user_id = ? AND n.type != 'feedback_new' ORDER BY n.id`, id),
    announcement_reads: rows(`SELECT CASE WHEN EXISTS (SELECT 1 FROM announcements a WHERE a.id = r.announcement_id AND a.status = 'published') THEN r.announcement_id END announcement_id,
      r.user_id, r.read_at FROM announcement_reads r WHERE r.user_id = ? ORDER BY r.announcement_id`, id),
    plaza_likes: rows(`SELECT l.id, l.user_id, CASE WHEN EXISTS (SELECT 1 FROM ideas i WHERE i.id = l.idea_id AND (i.user_id = l.user_id OR i.is_public = 1)) THEN l.idea_id END idea_id,
      l.created_at FROM plaza_likes l WHERE l.user_id = ? ORDER BY l.id`, id),
    plaza_comments: rows(`SELECT c.id, c.user_id, CASE WHEN EXISTS (SELECT 1 FROM ideas i WHERE i.id = c.idea_id AND (i.user_id = c.user_id OR i.is_public = 1)) THEN c.idea_id END idea_id,
      CASE WHEN EXISTS (SELECT 1 FROM plaza_comments parent WHERE parent.id = c.parent_id AND parent.user_id = c.user_id AND parent.idea_id = c.idea_id) THEN c.parent_id END parent_id,
      c.content, c.created_at FROM plaza_comments c WHERE c.user_id = ? ORDER BY c.id`, id),
    messages: rows(`SELECT m.id, m.user_id, CASE WHEN EXISTS (SELECT 1 FROM channels c LEFT JOIN ideas i ON i.id = c.idea_id
      WHERE c.id = m.channel_id AND (c.idea_id IS NULL OR i.user_id = m.user_id OR i.is_public = 1)) THEN m.channel_id END channel_id,
      m.content, m.created_at FROM messages m WHERE m.user_id = ? ORDER BY m.id`, id),
    user_settings: rows('SELECT model, language, updated_at FROM user_settings WHERE user_id = ?', id),
  }
}

export function registerExportRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: Record<string, unknown> }>('/api/export/me', async (req, reply) => {
    if (Object.keys(req.query).length) throw permissionError(400, 'invalid_export_request', '个人导出不接受用户 ID 或其他参数')
    try {
      const snapshot = db.transaction(() => {
        const user = requireAuth(req)
        const settings = db.prepare('SELECT api_key FROM user_settings WHERE user_id = ?').get(user.id) as { api_key: string | null } | undefined
        const credential = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id) as { password_hash: string | null }
        const secrets = [settings?.api_key, credential.password_hash, process.env.AUTH_SECRET, process.env.AI_API_KEY, process.env.ZAI_API_KEY, process.env.EMAIL_SMTP_PASS, process.env.EMAIL_VERIFICATION_SECRET]
          .filter((value): value is string => typeof value === 'string' && value.length > 0).sort((a, b) => b.length - a.length)
        return { user: { id: user.id, name: user.name, email: user.email, role: user.role, created_at: user.created_at }, data: personalData(user.id), secrets }
      }).deferred()
      const content = { export_version: 1, exported_at: nowIso(), user: snapshot.user, data: snapshot.data, excluded: {
        sensitive_credentials: '密码哈希、会话 Cookie/JWT、平台及个人密钥不导出；已知密钥与可识别凭证在自由文本和嵌套 JSON 中脱敏。',
        shared_tables: ['channels', 'announcements', 'other_users'],
        ai_raw_logs: '原始 AI 请求/响应可能包含凭证与第三方上下文，第一版排除。',
        raw_fields: ['order_leads.match_raw', 'studio_projects.tools_raw', 'video_wishes.analysis_raw'],
        user_settings: '仅保留本人 model / language / updated_at；api_key 和可能带凭证的 base_url 排除，主题存于浏览器，不在数据库导出中。',
        references: '跨用户或不可访问的业务关联置空；不展开他人身份、讨论上下文或共享公告正文。',
      } }
      const json = JSON.stringify(redact(content, snapshot.secrets), null, 2)
      return reply.header('Content-Type', 'application/json; charset=utf-8').header('Content-Disposition', `attachment; filename="sparkwright-my-data-${new Date().toISOString().slice(0, 10)}.json"`)
        .header('Cache-Control', 'no-store').send(json)
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode && (error as { statusCode: number }).statusCode < 500) throw error
      console.error('[export] personal export failed', error instanceof Error ? error.name : 'unknown')
      return reply.code(500).send({ error: { code: 'export_failed', message: '个人数据导出失败，请稍后重试' } })
    }
  })
}
