// SPDX-License-Identifier: MPL-2.0
import Fastify, { type FastifyInstance } from 'fastify'
import { performance } from 'node:perf_hooks'
import fstatic from '@fastify/static'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { db, nowIso, touchIdea } from './db'
import { buildSystemPrompt, chatCompletion, parsePlan, platformStatus, resolveAiConfig, type AiConfig } from './ai'
import { requestScore } from './ai-scoring'
import { scoringStatus } from './scoring-config'
import { representativeIdSql, representativeFor, privateScore, publicScore, scoreHistory } from './score-selection'
import { disconnectSignal } from './scoring-operations'
import { safeSynthesisLogs } from './synthesis-privacy'
import { serializeIdeaScore, formatIdeaScore } from '../shared/idea-score'
import { kwScore, parseAiArray } from './lib/hybrid-match'
import {
  clearAuthCookie,
  comparePassword,
  setAuthCookie,
  signToken,
} from './auth'
import { currentUser, findUser, permissionError, requireAuth, requireOwner, type AuthUser } from './permissions'
import { registerAdminRoutes } from './admin'
import { registerModerationRoutes, requirePlazaWrite } from './moderation'
import { ChannelPresence } from './presence'
import { registerSynthesisRoutes } from './idea-synthesis'
import { registerNoticeRoutes } from './notices'
import { registerBackupRoutes } from './backups'
import { registerExportRoutes, redactAiLogs } from './user-export'
import { ERROR_MESSAGES } from '../shared/error-messages'
import { createOriginGuard, pagination, featurePagination, requireEmptyBody, requireId } from './request-validation'
import { registerEmailRegistration, type RegistrationOptions } from './email-registration'
import { emailAccountId } from './email-identity'
import { ActivityTracker, registerActivity } from './activity'
import { registerFeedbackRoutes } from './feedback'
import { registerLeaderboard } from './leaderboard'
import { PERSONAL_EDITION } from './edition'
import { localWorkspace, requireLocalRequest } from './local-workspace'
import { registerCommunityBridge } from './community-bridge'

type Any = Record<string, any>

// 商单匹配 v1.1 常量（Phase C 补丁 §4）
const MATCH_SAVE_THRESHOLD = 40
const MATCH_CHIP_THRESHOLD = 50
const KW_WEIGHT = 0.45
const AI_WEIGHT = 0.55

interface CandidateProject {
  id: number
  name: string
  description: string
  tech_stack: string | null
  status: string
}

interface MatchRow {
  project_id: number
  kw_score: number
  ai_score: number
  hit_terms: string
  reasons: string
  score: number
}

const NO_AI_CONFIG = {
  statusCode: 400,
  code: 'no_ai_config',
  message: '还没有可用的 AI 模型：请在「设置」页填入你自己的 API Key（OpenAI 兼容接口均可），或在服务器 .env 中配置 AI_API_KEY。',
}

// 多人版的公开接口；个人版所有业务请求使用本地工作区身份。
const PUBLIC_PATHS = new Set(['/api/health', '/api/auth/login', '/api/auth/register', '/api/auth/register/send-code', '/api/auth/logout', '/api/auth/me'])

export interface AppOptions {
  configure?: (app: FastifyInstance) => Promise<void>
  registration?: (app: FastifyInstance) => void
  allowedRoute?: (method: string, pathname: string) => boolean
  distDir?: string
  indexFile?: string
  trustProxy?: string[]
}
export async function buildApp(registration: RegistrationOptions = {}, personalEdition = PERSONAL_EDITION, options: AppOptions = {}) {
  const localUser = personalEdition ? localWorkspace() : null
  const app = Fastify({ logger: false, trustProxy: options.trustProxy || false })
  app.addHook('onSend',async(req,reply,payload)=>{
    if(/^\/api\/(ideas(?:[/?]|$)|plaza(?:[/?]|$)|synthesis(?:[/?]|$))/.test(req.url))reply.header('Cache-Control','no-store')
    const operationId=(req as any).scoringOperationId
    if(operationId){const recordingStart=performance.now(),row=db.prepare('SELECT telemetry_json FROM scoring_operations WHERE id=?').get(operationId) as Any|undefined
      if(row){const meta=JSON.parse(row.telemetry_json);meta.http_total_ms=performance.now()-(req as any).scoringReceivedAt;meta.response_bytes=typeof payload==='string'?Buffer.byteLength(payload):null
        meta.operation_total_ms=performance.now()-meta.received_at_monotonic_ms
        const logs=db.prepare("SELECT id,telemetry_json FROM ai_raw_logs WHERE json_extract(telemetry_json,'$.operation_id')=?").all(operationId) as Any[]
        for(const log of logs)db.prepare('UPDATE ai_raw_logs SET telemetry_json=? WHERE id=?').run(JSON.stringify({...JSON.parse(log.telemetry_json),...meta}),log.id)
        meta.database_ms+=performance.now()-recordingStart
        meta.http_total_ms=performance.now()-(req as any).scoringReceivedAt;meta.operation_total_ms=performance.now()-meta.received_at_monotonic_ms
        db.prepare('UPDATE scoring_operations SET telemetry_json=? WHERE id=?').run(JSON.stringify(meta),operationId)}}

    return payload
  })
  const presence = new ChannelPresence()
  const activity = new ActivityTracker()
  const requireOrigin = createOriginGuard()
  app.decorateRequest('authUser', null)
  app.decorateRequest('scoringReceivedAt', 0)

  // ---------- 登录守卫（移植「起念」guard.ts 思路：所有业务 API 按会话用户隔离） ----------
  app.addHook('onRequest', async (req) => {
    ;(req as any).scoringReceivedAt=performance.now()
    if (localUser) {
      requireLocalRequest(req)
      req.authUser = localUser
    }
    const url = (req.url || '').split('?')[0]
    if (options.allowedRoute && !options.allowedRoute(req.method, url)) throw permissionError(404, 'route_unavailable', '此服务不提供该功能')
    if (!url.startsWith('/api')) return
    if (localUser && (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.headers.origin)) requireOrigin(req)
    if (PUBLIC_PATHS.has(url) || ['/api/community/auth/register', '/api/community/auth/login', '/api/community/auth/me'].includes(url)) return
    requireAuth(req)
  })

  if (options.configure) await options.configure(app)
  if (localUser) await registerCommunityBridge(app)

  registerBackupRoutes(app)
  registerExportRoutes(app)
  registerActivity(app, activity)
  registerFeedbackRoutes(app, (id) => activity.record(id))
  registerLeaderboard(app)

  const me = (req: any): AuthUser => req.authUser as AuthUser

  const ownIdea = (ideaId: number, userId: number) => {
    const idea = db.prepare('SELECT * FROM ideas WHERE id = ? AND user_id = ?').get(ideaId, userId) as Any
    if (!idea) throw Object.assign(new Error('灵感不存在'), { statusCode: 404  , code: 'idea_not_found' })
    return idea
  }

  const ownProject = (projectId: number, userId: number) => {
    const p = db.prepare('SELECT * FROM dev_projects WHERE id = ? AND user_id = ?').get(projectId, userId) as Any
    if (!p) throw Object.assign(new Error('项目不存在'), { statusCode: 404  , code: 'project_not_found' })
    return p
  }

  const visibleChannel = (id: number, userId: number) => {
    const channel = db.prepare(`SELECT c.*, i.title AS idea_title, i.user_id AS idea_owner_id FROM channels c LEFT JOIN ideas i ON i.id = c.idea_id
      WHERE c.id = ? AND c.archived_at IS NULL AND (c.idea_id IS NULL OR i.user_id = ? OR (i.is_public = 1 AND i.plaza_removed_at IS NULL))`).get(id, userId)
    if (!channel) throw Object.assign(new Error('频道不存在或不可访问'), { statusCode: 404  , code: 'channel_not_found' })
    return channel
  }

  const onlineCount = (channelId: number) => presence.count(channelId, (userId) => Boolean(db.prepare(`
    SELECT u.id FROM users u JOIN channels c ON c.id = ? LEFT JOIN ideas i ON i.id = c.idea_id
    WHERE u.id = ? AND c.archived_at IS NULL AND (c.idea_id IS NULL OR i.user_id = u.id OR (i.is_public = 1 AND i.plaza_removed_at IS NULL))`
  ).get(channelId, userId)))

  app.get('/api/health', async () => ({ status: 'ok', app: 'SparkWright', now: nowIso() }))

  // ---------- 认证：注册 / 登录 / 登出 / 当前用户 ----------
  if (!personalEdition) {
    if (options.registration) options.registration(app)
    else registerEmailRegistration(app, registration)

    app.post<{ Body: Any }>('/api/auth/login', async (req, reply) => {
      const mail = String(req.body?.email || '').trim().toLowerCase()
      const pass = String(req.body?.password || '')
      if (!mail || !pass) throw Object.assign(new Error('请填写邮箱和密码'), { statusCode: 400  , code: 'login_fields_required' })

      const id = emailAccountId(db, mail)
      const user = id ? db.prepare('SELECT * FROM users WHERE id = ?').get(id) as Any : null
      if (!user || !user.password_hash || !comparePassword(pass, user.password_hash)) {
        throw Object.assign(new Error('邮箱或密码不正确'), { statusCode: 401  , code: 'invalid_credentials' })
      }
      const trusted = findUser(user.id)
      if (!trusted) throw Object.assign(new Error('账号状态异常，请联系维护者'), { statusCode: 401  , code: 'account_unavailable' })
      setAuthCookie(reply, signToken(trusted.id, trusted.name))
      return trusted
    })

    app.post('/api/auth/logout', async (_req, reply) => {
      const user = currentUser(_req)
      if (user) presence.leaveAll(user.id)
      clearAuthCookie(reply)
      return { ok: true }
    })
  }

  app.get('/api/auth/me', async (req) => {
    return { user: currentUser(req), personalEdition }
  })

  registerAdminRoutes(app)
  registerModerationRoutes(app, presence)
  registerSynthesisRoutes(app)

  app.get('/api/moderation/me', async (req) =>
    db.prepare('SELECT plaza_muted_at, plaza_mute_reason FROM users WHERE id = ?').get(me(req).id)
  )

  // ---------- 灵感 ----------
  app.get<{ Querystring: { status?: string; q?: string; tag?: string; sort?: string } }>('/api/ideas', async (req) => {
    const userId = me(req).id
    const status = ['incubating', 'in_progress', 'done', 'shelved'].includes(String(req.query.status || ''))
      ? String(req.query.status)
      : null
    const q = String(req.query.q || '').trim()
    const tag = String(req.query.tag || '').trim()
    const sort = ['updated', 'created', 'deadline', 'score', 'progress'].includes(String(req.query.sort || ''))
      ? String(req.query.sort)
      : 'updated'

    const where = ['i.user_id = @userId']
    const params: Record<string, unknown> = { userId }
    if (status) {
      where.push('i.status = @status')
      params.status = status
    }
    if (q) {
      where.push('(i.title LIKE @q OR i.content LIKE @q)')
      params.q = `%${q}%`
    }
    if (tag) {
      where.push("(',' || i.tags || ',') LIKE @tagpat")
      params.tagpat = `%,${tag},%`
    }
    const order: Record<string, string> = {
      updated: 'i.updated_at DESC',
      created: 'i.created_at DESC',
      deadline: `CASE WHEN i.deadline IS NULL THEN 2 WHEN i.deadline < date('now', 'localtime') THEN 0 ELSE 1 END ASC, i.deadline ASC`,
      score: `(SELECT s.score_milli FROM idea_scores s WHERE s.id=${representativeIdSql()}) DESC`,
      progress:
        '(SELECT CASE WHEN COUNT(*) = 0 THEN -1 ELSE CAST(SUM(done) AS REAL) / COUNT(*) END FROM plan_steps WHERE idea_id = i.id) DESC',
    }
    return db
      .prepare(
        `SELECT i.*, u.name AS author,
           (SELECT COUNT(*) FROM plan_steps s WHERE s.idea_id = i.id) AS step_count,
           (SELECT COUNT(*) FROM plan_steps s WHERE s.idea_id = i.id AND s.done = 1) AS done_count,
           (SELECT h.score_milli FROM idea_scores h WHERE h.id=${representativeIdSql()}) AS representative_score_milli
         FROM ideas i JOIN users u ON u.id = i.user_id
         WHERE ${where.join(' AND ')}
         ORDER BY ${order[sort]}`
      )
      .all(params)
  })

  app.post<{ Body: Any }>('/api/ideas', async (req) => {
    const { title, content, deadline } = req.body || {}
    if (!String(title || '').trim()) throw Object.assign(new Error('标题不能为空'), { statusCode: 400  , code: 'title_required' })
    const r = db
      .prepare('INSERT INTO ideas (user_id, title, content, deadline, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(me(req).id, String(title).trim(), String(content || ''), deadline ? String(deadline) : null, 'incubating', nowIso(), nowIso())
    return db.prepare('SELECT * FROM ideas WHERE id = ?').get(r.lastInsertRowid)
  })

  app.get<{ Params: { id: string } }>('/api/ideas/:id', async (req) => {
    const id = Number(req.params.id)
    const idea = ownIdea(id, me(req).id)
    const author = db.prepare('SELECT name FROM users WHERE id = ?').get(idea.user_id) as Any
    const steps = db.prepare('SELECT * FROM plan_steps WHERE idea_id = ? ORDER BY sort, id').all(id)
    const aiMessages = db.prepare('SELECT * FROM ai_messages WHERE idea_id = ? ORDER BY id').all(id)
    const channel = db.prepare('SELECT * FROM channels WHERE idea_id = ? ORDER BY archived_at IS NOT NULL, id LIMIT 1').get(id) || null
    const scoreRow = representativeFor(id)
    const scoreCount = (db.prepare('SELECT COUNT(*) AS c FROM idea_scores WHERE idea_id = ?').get(id) as Any).c
    const devProject = db.prepare('SELECT * FROM dev_projects WHERE source_idea_id = ? ORDER BY id DESC LIMIT 1').get(id) || null
    return {
      idea: { ...idea, author: author?.name },
      steps,
      aiMessages,
      channel,
      score: scoreRow,
      scoreCount,
      representative_status: scoreRow ? 'current' : 'pending',
      personal_score: scoreRow ? privateScore(scoreRow,'current') : null,
      scoring_meta: scoringStatus(),
      devProject,
    }
  })

  app.patch<{ Params: { id: string }; Body: Any }>('/api/ideas/:id', async (req) => {
    const idea = ownIdea(Number(req.params.id), me(req).id)
    if (idea.is_public) requirePlazaWrite(me(req).id)
    const b = req.body || {}
    const next = {
      title: b.title !== undefined ? String(b.title).trim() || idea.title : idea.title,
      content: b.content !== undefined ? String(b.content) : idea.content,
      tags: b.tags !== undefined ? String(b.tags).trim() : idea.tags,
      deadline: b.deadline !== undefined ? (b.deadline ? String(b.deadline) : null) : idea.deadline,
      status: ['incubating', 'in_progress', 'done', 'shelved'].includes(b.status) ? b.status : idea.status,
    }
    db.prepare('UPDATE ideas SET title = ?, content = ?, tags = ?, deadline = ?, status = ?, updated_at = ? WHERE id = ?').run(
      next.title, next.content, next.tags, next.deadline, next.status, nowIso(), idea.id
    )
    return db.prepare('SELECT * FROM ideas WHERE id = ?').get(idea.id)
  })

  app.delete<{ Params: { id: string } }>('/api/ideas/:id', async (req) => {
    const idea = ownIdea(Number(req.params.id), me(req).id)
    return db.transaction(() => {
      db.prepare('DELETE FROM plan_steps WHERE idea_id = ?').run(idea.id)
      db.prepare('DELETE FROM ai_messages WHERE idea_id = ?').run(idea.id)
      const ch = db.prepare('SELECT id FROM channels WHERE idea_id = ?').get(idea.id) as Any
      if (ch) {
        db.prepare('DELETE FROM messages WHERE channel_id = ?').run(ch.id)
        db.prepare('DELETE FROM channels WHERE id = ?').run(ch.id)
      }
      db.prepare('DELETE FROM idea_scores WHERE idea_id = ?').run(idea.id)
      db.prepare('UPDATE dev_projects SET source_idea_id = NULL WHERE source_idea_id = ?').run(idea.id)
      db.prepare('DELETE FROM ideas WHERE id = ?').run(idea.id)
      return { ok: true }
    })()
  })

  // ---------- 执行计划步骤 ----------
  app.post<{ Params: { id: string }; Body: Any }>('/api/ideas/:id/steps', async (req) => {
    const idea = ownIdea(Number(req.params.id), me(req).id)
    const title = String(req.body?.title || '').trim()
    if (!title) throw Object.assign(new Error('步骤内容不能为空'), { statusCode: 400  , code: 'step_required' })
    const max = (db.prepare('SELECT COALESCE(MAX(sort), -1) AS m FROM plan_steps WHERE idea_id = ?').get(idea.id) as Any).m
    const r = db.prepare('INSERT INTO plan_steps (idea_id, title, done, sort) VALUES (?, ?, 0, ?)').run(idea.id, title, max + 1)
    touchIdea(idea.id)
    return db.prepare('SELECT * FROM plan_steps WHERE id = ?').get(r.lastInsertRowid)
  })

  app.patch<{ Params: { id: string }; Body: Any }>('/api/steps/:id', async (req) => {
    const id = Number(req.params.id)
    const step = db
      .prepare('SELECT s.* FROM plan_steps s JOIN ideas i ON i.id = s.idea_id WHERE s.id = ? AND i.user_id = ?')
      .get(id, me(req).id) as Any
    if (!step) throw Object.assign(new Error('步骤不存在'), { statusCode: 404  , code: 'step_not_found' })
    const done = req.body?.done !== undefined ? (req.body.done ? 1 : 0) : step.done
    const title = req.body?.title !== undefined ? String(req.body.title).trim() || step.title : step.title
    db.prepare('UPDATE plan_steps SET done = ?, title = ? WHERE id = ?').run(done, title, id)
    touchIdea(step.idea_id)
    return db.prepare('SELECT * FROM plan_steps WHERE id = ?').get(id)
  })

  app.delete<{ Params: { id: string } }>('/api/steps/:id', async (req) => {
    const id = Number(req.params.id)
    const step = db
      .prepare('SELECT s.* FROM plan_steps s JOIN ideas i ON i.id = s.idea_id WHERE s.id = ? AND i.user_id = ?')
      .get(id, me(req).id) as Any
    if (step) {
      db.prepare('DELETE FROM plan_steps WHERE id = ?').run(id)
      touchIdea(step.idea_id)
    }
    return { ok: true }
  })

  // ---------- AI ----------
  app.get('/api/ai/status', async () => platformStatus())

  app.get<{ Params: { id: string } }>('/api/ideas/:id/ai/messages', async (req) => {
    const idea = ownIdea(Number(req.params.id), me(req).id)
    return db.prepare('SELECT * FROM ai_messages WHERE idea_id = ? ORDER BY id').all(idea.id)
  })

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/ideas/:id/ai/chat', async (req, reply) => {
    const idea = ownIdea(Number(req.params.id), me(req).id)
    const message = String(req.body?.message || '').trim()
    if (!message) throw Object.assign(new Error('消息不能为空'), { statusCode: 400  , code: 'message_required' })

    const cfg = resolveAiConfig(db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(me(req).id) as Any)
    if (!cfg) throw Object.assign(new Error(NO_AI_CONFIG.message), { statusCode: 400, code: NO_AI_CONFIG.code })

    const ins = db.prepare('INSERT INTO ai_messages (idea_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)')
    ins.run(idea.id, me(req).id, 'user', message, nowIso())

    const steps = db.prepare('SELECT title, done FROM plan_steps WHERE idea_id = ? ORDER BY sort, id').all(idea.id) as Any[]
    const history = (db.prepare('SELECT role, content FROM ai_messages WHERE idea_id = ? ORDER BY id DESC LIMIT 20').all(idea.id) as Any[]).reverse()
    const systemPrompt = buildSystemPrompt(idea, steps)
    const requestPrompt = `system:\n${systemPrompt}\n\nuser:\n${message}`

    // SSE 流式响应
    reply.hijack()
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    const writeFrame = (payload: string) => {
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.write(`data: ${payload}\n\n`)
    }

    let full = ''
    let failed = ''
    let failureCode = 'ai_service_error'
    let completed = false
    let clientGone = false
    const disconnect = new AbortController()
    const onClose = () => { clientGone = true; disconnect.abort() }
    reply.raw.on('close', onClose)
    try {
      const upstream = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          model: cfg.model,
          messages: [
            { role: 'system', content: systemPrompt },
            ...history.map((h) => ({ role: h.role, content: h.content })),
          ],
          stream: true,
          temperature: 0.7,
        }),
        signal: AbortSignal.any([AbortSignal.timeout(180000), disconnect.signal]),
      })
      if (!upstream.ok || !upstream.body) {
        failed = ERROR_MESSAGES.ai_service_error[0]
      } else if ((upstream.headers.get('content-type') || '').includes('text/event-stream')) {
        // 流式逐帧转发
        const reader = upstream.body.getReader()
        const decoder = new TextDecoder()
        let buf = ''
        const consume = (line: string) => {
          const l = line.trim()
          if (!l.startsWith('data:')) return
          const data = l.slice(5).trim()
          if (data === '[DONE]') { completed = true; return }
          try {
            const j = JSON.parse(data)
            if (j.error) { failed = ERROR_MESSAGES.ai_service_error[0]; return }
            const choice = j.choices?.[0]
            if (choice?.finish_reason) completed = true
            const delta = choice?.delta?.content
            if (typeof delta === 'string') { full += delta; writeFrame(JSON.stringify({ delta })) }
          } catch {
            failureCode = 'ai_invalid_response'; failed = ERROR_MESSAGES[failureCode][0]
          }
        }
        while (!clientGone) {
          const { done, value } = await reader.read()
          if (done) { consume(buf + decoder.decode()); break }
          buf += decoder.decode(value, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop() || ''
          lines.forEach(consume)
        }
        if (clientGone) await reader.cancel().catch(() => {})
        if (!completed && !failed) { failureCode = 'ai_incomplete'; failed = ERROR_MESSAGES[failureCode][0] }
      } else {
        // 退化路径：上游返回普通 JSON（未开启流式）→ 读全文包成单帧 + [DONE]
        const data: any = await upstream.json()
        full = String(data?.choices?.[0]?.message?.content || '')
        completed = Boolean(full.trim())
        if (!completed) { failureCode = 'ai_empty_response'; failed = ERROR_MESSAGES[failureCode][0] }
        if (full) writeFrame(JSON.stringify({ delta: full }))
      }
    } catch (e: any) {
      failureCode = e.name === 'TimeoutError' ? 'ai_timeout' : e instanceof SyntaxError ? 'ai_invalid_response' : 'ai_service_error'
      failed = ERROR_MESSAGES[failureCode][0]
    }

    reply.raw.off('close', onClose)
    if (full && completed && !failed && !clientGone) {
      // 完整内容才落库（半截/失败不写 ai_messages）
      ins.run(idea.id, me(req).id, 'assistant', full, nowIso())
      db.prepare('INSERT INTO ai_raw_logs (idea_id, kind, request_prompt, raw_response, parsed_ok, created_at) VALUES (?, ?, ?, ?, 1, ?)').run(
        idea.id, 'chat', requestPrompt, full, nowIso()
      )
      touchIdea(idea.id)
      activity.record(me(req).id)
    }
    if (failed) writeFrame(JSON.stringify({ error: failed, code: failureCode }))
    writeFrame('[DONE]')
    reply.raw.end()
  })

  app.post<{ Params: { id: string }; Body: Any }>('/api/ideas/:id/ai/plan', async (req) => {
    const idea = ownIdea(Number(req.params.id), me(req).id)
    const overwrite = Boolean(req.body?.overwrite)
    const cfg = resolveAiConfig(db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(me(req).id) as Any)
    if (!cfg) throw Object.assign(new Error(NO_AI_CONFIG.message), { statusCode: 400, code: NO_AI_CONFIG.code })

    const steps = db.prepare('SELECT title, done FROM plan_steps WHERE idea_id = ? ORDER BY sort, id').all(idea.id) as Any[]
    // 换角度重试（Phase A Step2）：timeline | role | risk
    const ANGLE_PLAN: Record<string, string> = {
      timeline: '本次请按时间线拆解计划',
      role: '本次请按角色与人员分工拆解计划',
      risk: '本次请按风险与依赖拆解计划',
    }
    const angleHint = ANGLE_PLAN[String(req.body?.angle || '')] || ''
    const userPrompt = `请把这个灵感拆解成可执行的计划。严格只输出一个 JSON，不要输出任何其他文字，格式：{"steps":["步骤1","步骤2",...]}，共 3 到 6 步，每步不超过 20 字，按执行顺序排列。${angleHint ? `\n${angleHint}` : ''}`
    const requestPrompt = `system:\n${buildSystemPrompt(idea, steps)}\n\nuser:\n${userPrompt}`
    const reply = await chatCompletion(cfg, [
      { role: 'system', content: buildSystemPrompt(idea, steps) },
      { role: 'user', content: userPrompt },
    ])
    const titles = parsePlan(reply)
    const parsedOk = titles.length > 0
    db.prepare('INSERT INTO ai_raw_logs (idea_id, kind, request_prompt, raw_response, parsed_ok, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      idea.id, 'plan', requestPrompt, reply, parsedOk ? 1 : 0, nowIso()
    )
    if (!titles.length) throw Object.assign(new Error('AI 返回的计划无法解析，请重试'), { statusCode: 502  , code: 'ai_invalid_response' })

    return db.transaction(() => {
      if (overwrite) db.prepare('DELETE FROM plan_steps WHERE idea_id = ?').run(idea.id)
      const ins = db.prepare('INSERT INTO plan_steps (idea_id, title, done, sort) VALUES (?, ?, 0, ?)')
      const base = overwrite ? 0 : (db.prepare('SELECT COALESCE(MAX(sort), -1) AS m FROM plan_steps WHERE idea_id = ?').get(idea.id) as Any).m + 1
      const created = titles.map((t, i) => {
        const r = ins.run(idea.id, t, base + i)
        return db.prepare('SELECT * FROM plan_steps WHERE id = ?').get(r.lastInsertRowid)
      })
      const summary = `✅ 已根据 AI 建议生成 ${titles.length} 步执行计划：\n${titles.map((t, i) => `${i + 1}. ${t}`).join('\n')}\n现在可以去左侧勾选推进啦。`
      db.prepare('INSERT INTO ai_messages (idea_id, user_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)').run(
        idea.id, me(req).id, 'assistant', summary, nowIso()
      )
      touchIdea(idea.id)
      const aiMessages = db.prepare('SELECT * FROM ai_messages WHERE idea_id = ? ORDER BY id').all(idea.id)
      return { steps: created, aiMessages }
    })()
  })

  app.post<{ Params: { id: string }; Body: Any }>('/api/ideas/:id/ai/score', async (req, reply) => {
    requireOrigin(req)
    const idea = ownIdea(Number(req.params.id), me(req).id)
    const cfg = resolveAiConfig(db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(me(req).id) as Any)
    if (!cfg) throw Object.assign(new Error(NO_AI_CONFIG.message), { statusCode: 400, code: NO_AI_CONFIG.code })
    const body=req.body??{}
    if (!body || typeof body!=='object' || Array.isArray(body) || Object.keys(body).some(key=>!['angle','request_id','force','response_mode'].includes(key)) ||
      (body.angle!==undefined&&body.angle!=='default')) throw permissionError(400,'invalid_score_angle','仅支持标准角度及允许字段')
    if ((body.force!==undefined&&typeof body.force!=='boolean') || (body.response_mode!==undefined&&!['compact','legacy'].includes(body.response_mode)) ||
      (body.request_id!==undefined&&(typeof body.request_id!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.request_id)))) throw permissionError(400,'invalid_body','评分请求格式不正确')
    const connection=disconnectSignal(req,reply)
    try {
      const result=await requestScore({idea,config:cfg,userId:me(req).id,requestId:body.request_id,force:body.force===true,responseMode:body.response_mode||'compact',signal:connection.signal,receivedAt:(req as any).scoringReceivedAt})
      const representative=representativeFor(idea.id),score=privateScore(result.score,representative?.id===result.score.id?'current':'history')
      ;(req as any).scoringOperationId=result.operation_id
      if(body.response_mode!=='legacy')return {...result,score,representative_score:representative,representative_status:representative?'current':'pending',scoring_meta:scoringStatus()}
      return {score,aiMessages:db.prepare('SELECT * FROM ai_messages WHERE idea_id=? ORDER BY id').all(idea.id)}
    }catch(e:any){(req as any).scoringOperationId=e.operation_id;throw e}finally{connection.close()}
  })

  // 把灵感及其执行计划一键导入开发工程
  app.post<{ Params: { id: string } }>('/api/ideas/:id/import-to-dev', async (req) => {
    const idea = ownIdea(Number(req.params.id), me(req).id)
    return db.transaction(() => {
      const existed = db.prepare('SELECT * FROM dev_projects WHERE source_idea_id = ? ORDER BY id DESC LIMIT 1').get(idea.id) as Any
      if (existed) return { project: existed, created: false }
      const r = db.prepare(
        "INSERT INTO dev_projects (user_id, name, description, priority, status, deadline, source_idea_id) VALUES (?, ?, ?, 'mid', 'planning', ?, ?)"
      ).run(me(req).id, idea.title, idea.content || '', idea.deadline, idea.id)
      const projectId = Number(r.lastInsertRowid)
      const steps = db.prepare('SELECT title FROM plan_steps WHERE idea_id = ? ORDER BY sort, id').all(idea.id) as Any[]
      const insTask = db.prepare("INSERT INTO dev_tasks (project_id, title, status, done, priority, sort) VALUES (?, ?, 'todo', 0, 'mid', ?)")
      steps.forEach((s, i) => insTask.run(projectId, s.title, i))
      if (idea.deadline) {
        db.prepare('INSERT INTO dev_milestones (project_id, title, target_date, done) VALUES (?, ?, ?, 0)').run(projectId, '灵感目标实现', idea.deadline)
      }
      db.prepare('INSERT INTO dev_logs (project_id, content) VALUES (?, ?)').run(projectId, '📥 由灵感一键导入创建项目')
      return { project: db.prepare('SELECT * FROM dev_projects WHERE id = ?').get(projectId), created: true, taskCount: steps.length }
    })()
  })

  // ---------- 首页总览 ----------
  app.get('/api/dashboard', async (req) => {
    const userId = me(req).id
    const stats = (db.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN status IN ('incubating','in_progress') THEN 1 ELSE 0 END) AS active,
              SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done
       FROM ideas WHERE user_id = ?`
    ).get(userId) as Any) || { total: 0, active: 0, done: 0 }
    const dueSoon = db.prepare(
      `SELECT id, title, deadline, status FROM ideas
       WHERE user_id = ? AND status IN ('incubating','in_progress') AND deadline IS NOT NULL AND deadline <= date('now', '+7 day')
       ORDER BY deadline ASC LIMIT 6`
    ).all(userId)
    const recent = db.prepare('SELECT id, title, updated_at, status FROM ideas WHERE user_id = ? ORDER BY updated_at DESC LIMIT 5').all(userId)
    const devActive = (db.prepare("SELECT COUNT(*) AS c FROM dev_projects WHERE user_id = ? AND status IN ('planning','active')").get(userId) as Any).c
    const devTodo = (db.prepare(
      `SELECT COUNT(*) AS c FROM dev_tasks t JOIN dev_projects p ON p.id = t.project_id
       WHERE p.user_id = ? AND t.status = 'todo'`
    ).get(userId) as Any).c
    const followups = db
      .prepare(
        `SELECT id, client, project, next_follow_up FROM consult_items
         WHERE user_id = ? AND next_follow_up IS NOT NULL AND next_follow_up < ? AND status NOT IN ('settled', 'lost')
         ORDER BY next_follow_up ASC`
      )
      .all(userId, todayStr())
    return {
      ideaStats: { total: stats.total || 0, active: stats.active || 0, done: stats.done || 0, dueSoon: dueSoon.length },
      dueSoon,
      recent,
      dev: { active: devActive, todo: devTodo },
      followups,
    }
  })

  // ---------- 开发工程 ----------
  app.get<{ Querystring: { userId?: string } }>('/api/dev', async (req) => {
    const userId = me(req).id
    const projects = db.prepare('SELECT * FROM dev_projects WHERE user_id = ? ORDER BY id DESC').all(userId) as Any[]
    const taskStmt = db.prepare('SELECT * FROM dev_tasks WHERE project_id = ? ORDER BY sort, id')
    const logStmt = db.prepare('SELECT * FROM dev_logs WHERE project_id = ? ORDER BY id DESC LIMIT 10')
    const msStmt = db.prepare('SELECT * FROM dev_milestones WHERE project_id = ? ORDER BY (target_date IS NULL), target_date, id')
    return projects.map((p) => {
      if (p.status === 'done') p.status = 'released' // 兼容旧数据
      return { ...p, tasks: taskStmt.all(p.id), logs: logStmt.all(p.id), milestones: msStmt.all(p.id) }
    })
  })

  app.post<{ Body: Any }>('/api/dev', async (req) => {
    const { name, description, repoUrl, techStack, priority, deadline } = req.body || {}
    if (!String(name || '').trim()) throw Object.assign(new Error('项目名不能为空'), { statusCode: 400  , code: 'project_name_required' })
    const prio = ['high', 'mid', 'low'].includes(priority) ? priority : 'mid'
    const r = db.prepare(
      'INSERT INTO dev_projects (user_id, name, description, priority, status, repo_url, tech_stack, deadline) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(
      me(req).id, String(name).trim(), String(description || ''), prio, 'planning',
      repoUrl ? String(repoUrl).trim() : null, techStack ? String(techStack).trim() : null, deadline ? String(deadline) : null
    )
    const projectId = Number(r.lastInsertRowid)
    void reverseMatchProject(projectId, me(req).id).catch(() => {}) // 工程新建 → 反向匹配池内商单
    return db.prepare('SELECT * FROM dev_projects WHERE id = ?').get(r.lastInsertRowid)
  })

  app.patch<{ Params: { id: string }; Body: Any }>('/api/dev/:id', async (req) => {
    const p = ownProject(Number(req.params.id), me(req).id)
    const b = req.body || {}
    const status = ['planning', 'active', 'paused', 'released', 'archived'].includes(b.status) ? b.status : p.status
    const priority = ['high', 'mid', 'low'].includes(b.priority) ? b.priority : p.priority
    db.prepare('UPDATE dev_projects SET name = ?, description = ?, repo_url = ?, tech_stack = ?, deadline = ?, priority = ?, status = ? WHERE id = ?').run(
      b.name !== undefined ? String(b.name).trim() || p.name : p.name,
      b.description !== undefined ? String(b.description) : p.description,
      b.repoUrl !== undefined ? (b.repoUrl ? String(b.repoUrl).trim() : null) : p.repo_url,
      b.techStack !== undefined ? (b.techStack ? String(b.techStack).trim() : null) : p.tech_stack,
      b.deadline !== undefined ? (b.deadline ? String(b.deadline) : null) : p.deadline,
      priority, status, p.id
    )
    void reverseMatchProject(p.id, me(req).id).catch(() => {}) // 工程编辑 → 反向匹配池内商单
    return db.prepare('SELECT * FROM dev_projects WHERE id = ?').get(p.id)
  })

  app.delete<{ Params: { id: string } }>('/api/dev/:id', async (req) => {
    const p = ownProject(Number(req.params.id), me(req).id)
    db.prepare('DELETE FROM dev_tasks WHERE project_id = ?').run(p.id)
    db.prepare('DELETE FROM dev_logs WHERE project_id = ?').run(p.id)
    db.prepare('DELETE FROM dev_milestones WHERE project_id = ?').run(p.id)
    db.prepare('DELETE FROM dev_projects WHERE id = ?').run(p.id)
    return { ok: true }
  })

  app.post<{ Params: { id: string }; Body: Any }>('/api/dev/:id/tasks', async (req) => {
    const p = ownProject(Number(req.params.id), me(req).id)
    const title = String(req.body?.title || '').trim()
    if (!title) throw Object.assign(new Error('任务内容不能为空'), { statusCode: 400  , code: 'task_required' })
    const prio = ['high', 'mid', 'low'].includes(req.body?.priority) ? req.body.priority : 'mid'
    const max = (db.prepare('SELECT COALESCE(MAX(sort), -1) AS m FROM dev_tasks WHERE project_id = ?').get(p.id) as Any).m
    const r = db.prepare("INSERT INTO dev_tasks (project_id, title, status, done, priority, sort) VALUES (?, ?, 'todo', 0, ?, ?)").run(p.id, title, prio, max + 1)
    return db.prepare('SELECT * FROM dev_tasks WHERE id = ?').get(r.lastInsertRowid)
  })

  const ownTask = (taskId: number, userId: number) => {
    const t = db
      .prepare('SELECT t.* FROM dev_tasks t JOIN dev_projects p ON p.id = t.project_id WHERE t.id = ? AND p.user_id = ?')
      .get(taskId, userId) as Any
    if (!t) throw Object.assign(new Error('任务不存在'), { statusCode: 404  , code: 'task_not_found' })
    return t
  }

  app.patch<{ Params: { id: string }; Body: Any }>('/api/dev/tasks/:id', async (req) => {
    const t = ownTask(Number(req.params.id), me(req).id)
    const b = req.body || {}
    const status = ['todo', 'doing', 'done'].includes(b.status) ? b.status : t.status
    const priority = ['high', 'mid', 'low'].includes(b.priority) ? b.priority : t.priority
    const title = b.title !== undefined ? String(b.title).trim() || t.title : t.title
    db.prepare('UPDATE dev_tasks SET status = ?, priority = ?, title = ?, done = ? WHERE id = ?').run(status, priority, title, status === 'done' ? 1 : 0, t.id)
    return db.prepare('SELECT * FROM dev_tasks WHERE id = ?').get(t.id)
  })

  app.delete<{ Params: { id: string } }>('/api/dev/tasks/:id', async (req) => {
    const t = ownTask(Number(req.params.id), me(req).id)
    db.prepare('DELETE FROM dev_tasks WHERE id = ?').run(t.id)
    return { ok: true }
  })

  app.post<{ Params: { id: string }; Body: Any }>('/api/dev/:id/milestones', async (req) => {
    const p = ownProject(Number(req.params.id), me(req).id)
    const title = String(req.body?.title || '').trim()
    if (!title) throw Object.assign(new Error('里程碑内容不能为空'), { statusCode: 400  , code: 'milestone_required' })
    const r = db.prepare('INSERT INTO dev_milestones (project_id, title, target_date) VALUES (?, ?, ?)').run(
      p.id, title, req.body?.targetDate ? String(req.body.targetDate) : null
    )
    return db.prepare('SELECT * FROM dev_milestones WHERE id = ?').get(r.lastInsertRowid)
  })

  const ownMilestone = (id: number, userId: number) => {
    const m = db
      .prepare('SELECT m.* FROM dev_milestones m JOIN dev_projects p ON p.id = m.project_id WHERE m.id = ? AND p.user_id = ?')
      .get(id, userId) as Any
    if (!m) throw Object.assign(new Error('里程碑不存在'), { statusCode: 404  , code: 'milestone_not_found' })
    return m
  }

  app.patch<{ Params: { id: string }; Body: Any }>('/api/dev/milestones/:id', async (req) => {
    const m = ownMilestone(Number(req.params.id), me(req).id)
    const done = req.body?.done !== undefined ? (req.body.done ? 1 : 0) : m.done
    db.prepare('UPDATE dev_milestones SET done = ? WHERE id = ?').run(done, m.id)
    return db.prepare('SELECT * FROM dev_milestones WHERE id = ?').get(m.id)
  })

  app.delete<{ Params: { id: string } }>('/api/dev/milestones/:id', async (req) => {
    const m = ownMilestone(Number(req.params.id), me(req).id)
    db.prepare('DELETE FROM dev_milestones WHERE id = ?').run(m.id)
    return { ok: true }
  })

  app.post<{ Params: { id: string }; Body: Any }>('/api/dev/:id/logs', async (req) => {
    const p = ownProject(Number(req.params.id), me(req).id)
    const content = String(req.body?.content || '').trim()
    if (!content) throw Object.assign(new Error('日志内容不能为空'), { statusCode: 400  , code: 'log_required' })
    const r = db.prepare('INSERT INTO dev_logs (project_id, content) VALUES (?, ?)').run(p.id, content)
    return db.prepare('SELECT * FROM dev_logs WHERE id = ?').get(r.lastInsertRowid)
  })

  const ownLog = (id: number, userId: number) => {
    const l = db
      .prepare('SELECT l.* FROM dev_logs l JOIN dev_projects p ON p.id = l.project_id WHERE l.id = ? AND p.user_id = ?')
      .get(id, userId) as Any
    if (!l) throw Object.assign(new Error('日志不存在'), { statusCode: 404  , code: 'log_not_found' })
    return l
  }

  app.delete<{ Params: { id: string } }>('/api/dev/logs/:id', async (req) => {
    const l = ownLog(Number(req.params.id), me(req).id)
    db.prepare('DELETE FROM dev_logs WHERE id = ?').run(l.id)
    return { ok: true }
  })

  // ---------- 用户设置（BYOK） ----------
  function settingsPayload(userId: number) {
    const row = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId) as Any
    const envKey = process.env.AI_API_KEY || process.env.ZAI_API_KEY
    const keySource = row?.api_key ? 'user' : envKey ? 'platform' : 'none'
    const mask = (k: string) => (k.length > 8 ? k.slice(0, 4) + '••••' + k.slice(-4) : '••••••••')
    return {
      base_url: row?.base_url || null,
      model: row?.model || null,
      language: row?.language || 'zh-CN',
      hasKey: Boolean(row?.api_key),
      maskedKey: row?.api_key ? mask(row.api_key) : null,
      keySource,
      updated_at: row?.updated_at || null,
      ...platformStatus(),
    }
  }

  app.get('/api/settings', async (req) => settingsPayload(me(req).id))

  app.get('/api/settings/reveal', async (req) => {
    const row = db.prepare('SELECT api_key FROM user_settings WHERE user_id = ?').get(me(req).id) as Any
    return { apiKey: row?.api_key || null }
  })

  app.put<{ Body: Any }>('/api/settings', async (req) => {
    const userId = me(req).id
    const b = req.body || {}
    const existing = db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId) as Any
    const apiKey = b.clearKey ? null : b.apiKey ? String(b.apiKey).trim() : existing?.api_key || null
    const language = b.language === undefined ? existing?.language || 'zh-CN' : b.language
    if (language !== 'zh-CN' && language !== 'en') throw permissionError(400, 'invalid_language', '语言仅支持 zh-CN 或 en')
    const baseUrl = b.baseUrl !== undefined ? String(b.baseUrl).trim() || null : existing?.base_url || null
    const model = b.model !== undefined ? String(b.model).trim() || null : existing?.model || null
    db.prepare(
      `INSERT INTO user_settings (user_id, base_url, api_key, model, language, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET base_url = excluded.base_url, api_key = excluded.api_key, model = excluded.model, language = excluded.language, updated_at = excluded.updated_at`
    ).run(userId, baseUrl, apiKey, model, language, nowIso())
    return settingsPayload(userId)
  })

  // ---------- 频道与聊天（灵感广场：登录用户共享） ----------
  app.get('/api/channels', async (req) =>
    (db
      .prepare(
        `SELECT c.*, i.title AS idea_title, i.user_id AS idea_owner_id FROM channels c LEFT JOIN ideas i ON i.id = c.idea_id
         WHERE c.archived_at IS NULL AND (c.idea_id IS NULL OR i.user_id = ? OR (i.is_public = 1 AND i.plaza_removed_at IS NULL))
         ORDER BY CASE c.type WHEN 'public' THEN 0 ELSE 1 END, c.id`
      )
      .all(me(req).id) as Any[]).map((channel) => ({ ...channel, online_count: onlineCount(channel.id) }))
  )

  app.post<{ Body: Any }>('/api/channels', async (req) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) ||
        Object.keys(req.body).some((key) => key !== 'name' && key !== 'ideaId'))
      throw permissionError(400, 'invalid_channel_request', '频道参数不合法')
    const name = String(req.body?.name || '').trim()
    const ideaId = req.body.ideaId === undefined ? null : Number(req.body.ideaId)
    if (!name || name.length > 100 || (ideaId !== null && (!Number.isSafeInteger(ideaId) || ideaId <= 0)))
      throw permissionError(400, 'invalid_channel_request', '频道名需为 1–100 字，灵感 ID 必须是正整数')
    if (ideaId) {
      ownIdea(ideaId, me(req).id)
      if (db.prepare('SELECT id FROM channels WHERE idea_id = ? AND archived_at IS NOT NULL LIMIT 1').get(ideaId))
        throw permissionError(409, 'idea_channel_archived', '该灵感的讨论频道已归档，请联系 Owner 恢复')
    }
    else { requireOwner(req); requireOrigin(req) }
    const r = db.prepare('INSERT INTO channels (type, idea_id, name, created_at) VALUES (?, ?, ?, ?)').run(
      ideaId ? 'idea' : 'public', ideaId, name, nowIso()
    )
    return db.prepare('SELECT * FROM channels WHERE id = ?').get(r.lastInsertRowid)
  })

  app.get<{ Params: { id: string } }>('/api/channels/:id', async (req) =>
    ({ ...visibleChannel(requireId(req.params.id), me(req).id) as Any, online_count: onlineCount(requireId(req.params.id)) })
  )

  app.post<{ Params: { id: string }; Body: unknown }>('/api/channels/:id/presence', async (req) => {
    requireOrigin(req); requireEmptyBody(req.body)
    const id = requireId(req.params.id)
    visibleChannel(id, me(req).id)
    presence.heartbeat(id, me(req).id)
    return { online_count: onlineCount(id) }
  })

  app.delete<{ Params: { id: string }; Body: unknown }>('/api/channels/:id/presence', async (req) => {
    requireOrigin(req); requireEmptyBody(req.body)
    const id = requireId(req.params.id)
    presence.leave(id, me(req).id)
    return { ok: true }
  })

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/api/channels/:id/messages', async (req) => {
    const channelId = Number(req.params.id)
    visibleChannel(channelId, me(req).id)
    const after = Number(req.query.after || 0)
    if (after > 0) {
      return db
        .prepare(
          `SELECT m.*, u.name AS author FROM messages m JOIN users u ON u.id = m.user_id
           WHERE m.channel_id = ? AND m.id > ? ORDER BY m.id ASC LIMIT 200`
        )
        .all(channelId, after)
    }
    return (
      db
        .prepare(
          `SELECT * FROM (SELECT m.*, u.name AS author FROM messages m JOIN users u ON u.id = m.user_id
           WHERE m.channel_id = ? ORDER BY m.id DESC LIMIT 200) ORDER BY id ASC`
        )
        .all(channelId) as Any[]
    )
  })

  app.post<{ Params: { id: string }; Body: Any }>('/api/channels/:id/messages', async (req) => {
    requirePlazaWrite(me(req).id)
    const channelId = Number(req.params.id)
    const content = String(req.body?.content || '').trim()
    if (!content) throw Object.assign(new Error('消息不能为空'), { statusCode: 400  , code: 'message_required' })
    if (content.length > 2000) throw Object.assign(new Error('消息太长了'), { statusCode: 400  , code: 'message_too_long' })
    visibleChannel(channelId, me(req).id)
    const r = db.prepare('INSERT INTO messages (channel_id, user_id, content, created_at) VALUES (?, ?, ?, ?)').run(channelId, me(req).id, content, nowIso())
    return db
      .prepare('SELECT m.*, u.name AS author FROM messages m JOIN users u ON u.id = m.user_id WHERE m.id = ?')
      .get(r.lastInsertRowid)
  })

  const notify = (userId: number, type: string, refId: number, actorId: number, content: string) =>
    db.prepare('INSERT INTO notifications (user_id, type, ref_id, actor_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
      userId, type, refId, actorId, content, nowIso()
    )

  const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const todayStr = () => localDate()
  const validDate = (s: unknown) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? String(s) : null)

  // ---------- 自媒体选题库（v0.2 §2，激活 media_items） ----------
  app.get('/api/media', async (req) =>
    db
      .prepare(
        `SELECT m.*, sp.title AS studio_title, sp.chosen_tool, sp.tools AS studio_tools FROM media_items m
         LEFT JOIN studio_projects sp ON sp.id = m.studio_id WHERE m.user_id = ? ORDER BY m.id DESC`
      )
      .all(me(req).id)
  )

  app.post<{ Body: Any }>('/api/media', async (req) => {
    const title = String(req.body?.title || '').trim()
    if (!title) throw Object.assign(new Error('标题不能为空'), { statusCode: 400  , code: 'title_required' })
    if (req.body?.sourceIdeaId) ownIdea(Number(req.body.sourceIdeaId), me(req).id)
    const r = db.prepare('INSERT INTO media_items (user_id, title, topic, platform, status, source_idea_id) VALUES (?, ?, ?, ?, ?, ?)').run(
      me(req).id, title, String(req.body?.topic || ''), String(req.body?.platform || '抖音'), 'idea',
      req.body?.sourceIdeaId ? Number(req.body.sourceIdeaId) : null
    )
    return db.prepare('SELECT * FROM media_items WHERE id = ?').get(r.lastInsertRowid)
  })

  const ownMedia = (id: number, userId: number) => {
    const m = db.prepare('SELECT * FROM media_items WHERE id = ? AND user_id = ?').get(id, userId) as Any
    if (!m) throw Object.assign(new Error('选题不存在'), { statusCode: 404  , code: 'media_not_found' })
    return m
  }

  app.patch<{ Params: { id: string }; Body: Any }>('/api/media/:id', async (req) => {
    const m = ownMedia(Number(req.params.id), me(req).id)
    const b = req.body || {}
    const status = ['idea', 'scripting', 'making', 'published', 'reviewed'].includes(b.status) ? b.status : m.status
    let publishDate = b.publishDate !== undefined ? (b.publishDate ? String(b.publishDate) : null) : m.publish_date
    if (status === 'published' && !publishDate) publishDate = todayStr()
    const num = (v: unknown, fb: number) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? fb : Math.max(0, Math.round(Number(v))))
    db.prepare('UPDATE media_items SET status = ?, publish_date = ?, views = ?, likes = ?, comments = ?, title = ?, topic = ?, platform = ? WHERE id = ?').run(
      status, publishDate,
      num(b.views, m.views), num(b.likes, m.likes), num(b.comments, m.comments),
      b.title !== undefined ? String(b.title).trim() || m.title : m.title,
      b.topic !== undefined ? String(b.topic) : m.topic,
      b.platform !== undefined ? String(b.platform) : m.platform,
      m.id
    )
    return db.prepare('SELECT * FROM media_items WHERE id = ?').get(m.id)
  })

  app.patch<{ Params: { id: string }; Body: Any }>('/api/media/:id/data', async (req) => {
    const m = ownMedia(Number(req.params.id), me(req).id)
    const num = (v: unknown, fb: number) => (v === undefined || v === null || v === '' || Number.isNaN(Number(v)) ? fb : Math.max(0, Math.round(Number(v))))
    let publishDate = m.publish_date
    if (req.body?.publishDate !== undefined) publishDate = req.body.publishDate ? String(req.body.publishDate) : publishDate
    if (!publishDate) publishDate = todayStr()
    db.prepare('UPDATE media_items SET views = ?, likes = ?, comments = ?, publish_date = ? WHERE id = ?').run(
      num(req.body?.views, m.views), num(req.body?.likes, m.likes), num(req.body?.comments, m.comments), publishDate, m.id
    )
    return db.prepare('SELECT * FROM media_items WHERE id = ?').get(m.id)
  })

  app.delete<{ Params: { id: string } }>('/api/media/:id', async (req) => {
    const m = ownMedia(Number(req.params.id), me(req).id)
    db.prepare('DELETE FROM media_items WHERE id = ?').run(m.id)
    return { ok: true }
  })

  // ---------- 咨询接单管道（v0.2 §3，激活 consult_items） ----------
  app.get('/api/consult', async (req) =>
    db.prepare('SELECT * FROM consult_items WHERE user_id = ? ORDER BY id DESC').all(me(req).id)
  )

  app.post<{ Body: Any }>('/api/consult', async (req) => {
    const client = String(req.body?.client || '').trim()
    if (!client) throw Object.assign(new Error('客户名不能为空'), { statusCode: 400  , code: 'client_required' })
    const num = (v: unknown) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? 0 : Number(v))
    const r = db.prepare(
      'INSERT INTO consult_items (user_id, client, project, deliverable, amount, status) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(me(req).id, client, String(req.body?.project || ''), String(req.body?.deliverable || ''), num(req.body?.amount), 'talking')
    return db.prepare('SELECT * FROM consult_items WHERE id = ?').get(r.lastInsertRowid)
  })

  const ownConsult = (id: number, userId: number) => {
    const c = db.prepare('SELECT * FROM consult_items WHERE id = ? AND user_id = ?').get(id, userId) as Any
    if (!c) throw Object.assign(new Error('接单不存在'), { statusCode: 404  , code: 'consult_not_found' })
    return c
  }

  app.patch<{ Params: { id: string }; Body: Any }>('/api/consult/:id', async (req) => {
    const c = ownConsult(Number(req.params.id), me(req).id)
    const b = req.body || {}
    const status = ['talking', 'doing', 'delivered', 'settled', 'lost'].includes(b.status) ? b.status : c.status
    const nextFollowUp = b.nextFollowUp !== undefined ? (b.nextFollowUp ? String(b.nextFollowUp) : null) : c.next_follow_up
    const num = (v: unknown, fb: number) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? fb : Math.max(0, Number(v)))
    db.prepare(
      'UPDATE consult_items SET status = ?, next_follow_up = ?, deliverable = ?, project = ?, amount = ?, settled_amount = ? WHERE id = ?'
    ).run(
      status, nextFollowUp,
      b.deliverable !== undefined ? String(b.deliverable) : c.deliverable,
      b.project !== undefined ? String(b.project) : c.project,
      num(b.amount, c.amount), num(b.settledAmount, c.settled_amount),
      c.id
    )
    return db.prepare('SELECT * FROM consult_items WHERE id = ?').get(c.id)
  })

  app.post<{ Params: { id: string }; Body: Any }>('/api/consult/:id/hours', async (req) => {
    const c = ownConsult(Number(req.params.id), me(req).id)
    const delta = Number(req.body?.delta) || 0
    const hours = Math.max(0, Math.round((c.hours + delta) * 10) / 10)
    db.prepare('UPDATE consult_items SET hours = ? WHERE id = ?').run(hours, c.id)
    return db.prepare('SELECT * FROM consult_items WHERE id = ?').get(c.id)
  })

  app.delete<{ Params: { id: string } }>('/api/consult/:id', async (req) => {
    const c = ownConsult(Number(req.params.id), me(req).id)
    db.prepare('DELETE FROM consult_items WHERE id = ?').run(c.id)
    return { ok: true }
  })

  // ---------- 灵感广场 feed（v0.2 §4） ----------
  app.get<{ Querystring: { sort?: string; tag?: string; q?: string; page?: string; author?: string } }>('/api/plaza', async (req) => {
    const meId = me(req).id
    const sort = req.query.sort === 'hot' ? 'hot' : 'latest'
    const tag = String(req.query.tag || '').trim()
    const q = String(req.query.q || '').trim()
    const author = Number(req.query.author || 0)
    const page = Math.max(1, Number(req.query.page || 1))
    const limit = 10
    const where = ['i.is_public = 1']
    const params: Any = { me: meId, limit, offset: (page - 1) * limit }
    if (tag) {
      where.push('i.tags LIKE @taglike')
      params.taglike = `%${tag}%`
    }
    if (q) {
      where.push('(i.title LIKE @qlike OR i.public_summary LIKE @qlike OR i.content LIKE @qlike)')
      params.qlike = `%${q}%`
    }
    if (author) {
      where.push('i.user_id = @author')
      params.author = author
    }
    const inner = `
      SELECT i.id, i.title, i.public_summary, i.tags, i.status, i.score_public, i.user_id, i.created_at,
        u.name AS author,
        (SELECT COUNT(*) FROM plaza_likes l WHERE l.idea_id = i.id) AS like_count,
        (SELECT COUNT(*) FROM plaza_comments c WHERE c.idea_id = i.id) AS comment_count,
        (SELECT COUNT(*) FROM plaza_likes l WHERE l.idea_id = i.id AND l.user_id = @me) AS liked,
        CASE WHEN i.score_public = 1 THEN (SELECT s.score_milli / 1000.0 FROM idea_scores s WHERE s.id=${representativeIdSql()}) ELSE NULL END AS score
      FROM ideas i JOIN users u ON u.id = i.user_id
      WHERE ${where.join(' AND ')}`
    const order =
      sort === 'hot'
        ? "ORDER BY (like_count * 2 + comment_count * 3) * (1.0 / (1 + (julianday('now') - julianday(created_at)) / 7.0)) DESC, id DESC"
        : 'ORDER BY created_at DESC, id DESC'
    const items = db.prepare(`SELECT * FROM (${inner}) ${order} LIMIT @limit OFFSET @offset`).all(params)
    const total = (db.prepare(`SELECT COUNT(*) AS c FROM (${inner})`).get(params) as Any).c
    return { items, page, total, hasMore: (page - 1) * limit + (items as Any[]).length < total }
  })

  app.get<{ Params: { id: string } }>('/api/plaza/:id', async (req) => {
    const id = Number(req.params.id)
    const idea = db
      .prepare('SELECT i.*, u.name AS author FROM ideas i JOIN users u ON u.id = i.user_id WHERE i.id = ? AND i.is_public = 1 AND i.plaza_removed_at IS NULL')
      .get(id) as Any
    if (!idea) throw Object.assign(new Error('灵感不存在或未发布'), { statusCode: 404  , code: 'public_idea_not_found' })
    const meId = me(req).id
    const likeCount = (db.prepare('SELECT COUNT(*) AS c FROM plaza_likes WHERE idea_id = ?').get(id) as Any).c
    const liked = Boolean(db.prepare('SELECT id FROM plaza_likes WHERE idea_id = ? AND user_id = ?').get(id, meId))
    const commentCount = (db.prepare('SELECT COUNT(*) AS c FROM plaza_comments WHERE idea_id = ?').get(id) as Any).c
    const scoreRow = representativeFor(id)
    const channel = db.prepare('SELECT * FROM channels WHERE idea_id = ? AND archived_at IS NULL ORDER BY id LIMIT 1').get(id) || null
    return {
      idea: { id: idea.id, title: idea.title, content: idea.content, public_summary: idea.public_summary, tags: idea.tags, status: idea.status, score_public: idea.score_public, user_id: idea.user_id, author: idea.author, created_at: idea.created_at },
      likeCount,
      liked,
      commentCount,
      score: idea.score_public && scoreRow ? serializeIdeaScore(scoreRow).score : null,
      channel,
    }
  })

  app.get<{ Params: { id: string }; Querystring:Any }>('/api/plaza/:id/scores', async (req) => {
    const id = requireId(req.params.id)
    const idea = db.prepare('SELECT * FROM ideas WHERE id = ? AND is_public = 1 AND plaza_removed_at IS NULL AND score_public = 1').get(id)
    if (!idea) throw permissionError(404, 'public_scores_not_found', '公开评分不存在')
    const p=featurePagination(req.query);return scoreHistory(idea as Any,p.page,p.pageSize,true)
  })

  app.post<{ Params: { id: string }; Body: Any }>('/api/plaza/:id/publish', async (req) => {
    requirePlazaWrite(me(req).id)
    const idea = ownIdea(Number(req.params.id), me(req).id)
    if (idea.plaza_removed_at) throw permissionError(409, 'idea_removed', '下架灵感须由 owner 恢复')
    const summary = String(req.body?.summary || '').trim() || (idea.content || idea.title).slice(0, 100)
    const tags = String(req.body?.tags || '').trim()
    const scorePublic = req.body?.scorePublic === false ? 0 : 1
    db.prepare('UPDATE ideas SET is_public = 1, public_summary = ?, tags = ?, score_public = ? WHERE id = ?').run(summary, tags, scorePublic, idea.id)
    return db.prepare('SELECT * FROM ideas WHERE id = ?').get(idea.id)
  })

  app.post<{ Params: { id: string } }>('/api/plaza/:id/unpublish', async (req) => {
    const idea = ownIdea(Number(req.params.id), me(req).id)
    db.prepare('UPDATE ideas SET is_public = 0 WHERE id = ?').run(idea.id)
    return db.prepare('SELECT * FROM ideas WHERE id = ?').get(idea.id)
  })

  app.post<{ Params: { id: string } }>('/api/plaza/:id/like', async (req) => {
    const ideaId = Number(req.params.id)
    const idea = db.prepare('SELECT id, user_id, title FROM ideas WHERE id = ? AND is_public = 1').get(ideaId) as Any
    if (!idea) throw Object.assign(new Error('灵感不存在或未发布'), { statusCode: 404  , code: 'public_idea_not_found' })
    const meId = me(req).id
    const existing = db.prepare('SELECT id FROM plaza_likes WHERE user_id = ? AND idea_id = ?').get(meId, ideaId) as Any
    let liked: boolean
    if (existing) {
      db.prepare('DELETE FROM plaza_likes WHERE id = ?').run(existing.id)
      liked = false
    } else {
      db.prepare('INSERT INTO plaza_likes (user_id, idea_id, created_at) VALUES (?, ?, ?)').run(meId, ideaId, nowIso())
      liked = true
      if (idea.user_id !== meId) notify(idea.user_id, 'like', ideaId, meId, `赞了你的灵感「${idea.title}」`)
    }
    const count = (db.prepare('SELECT COUNT(*) AS c FROM plaza_likes WHERE idea_id = ?').get(ideaId) as Any).c
    return { liked, count }
  })

  app.get<{ Params: { id: string } }>('/api/plaza/:id/comments', async (req) => {
    const id = Number(req.params.id)
    if (!db.prepare('SELECT id FROM ideas WHERE id = ? AND is_public = 1').get(id)) {
      throw Object.assign(new Error('灵感不存在或未发布'), { statusCode: 404  , code: 'public_idea_not_found' })
    }
    return db
      .prepare('SELECT c.*, u.name AS author FROM plaza_comments c JOIN users u ON u.id = c.user_id WHERE c.idea_id = ? ORDER BY c.id')
      .all(id)
  })

  app.post<{ Params: { id: string }; Body: Any }>('/api/plaza/:id/comments', async (req) => {
    requirePlazaWrite(me(req).id)
    const ideaId = Number(req.params.id)
    const idea = db.prepare('SELECT id, user_id, title FROM ideas WHERE id = ? AND is_public = 1').get(ideaId) as Any
    if (!idea) throw Object.assign(new Error('灵感不存在或未发布'), { statusCode: 404  , code: 'public_idea_not_found' })
    const content = String(req.body?.content || '').trim()
    if (!content) throw Object.assign(new Error('评论内容不能为空'), { statusCode: 400  , code: 'comment_required' })
    const parentId = req.body?.parentId ? Number(req.body.parentId) : null
    if (parentId && !db.prepare('SELECT id FROM plaza_comments WHERE id = ? AND idea_id = ?').get(parentId, ideaId)) {
      throw Object.assign(new Error('回复的评论不存在'), { statusCode: 400  , code: 'comment_parent_not_found' })
    }
    const r = db.prepare('INSERT INTO plaza_comments (idea_id, user_id, parent_id, content, created_at) VALUES (?, ?, ?, ?, ?)').run(
      ideaId, me(req).id, parentId, content, nowIso()
    )
    if (idea.user_id !== me(req).id) notify(idea.user_id, 'comment', ideaId, me(req).id, `评论了你的灵感「${idea.title}」`)
    // @提及：扫描内容里出现的成员昵称
    for (const u of db.prepare('SELECT id, name FROM users').all() as Any[]) {
      if (u.id !== me(req).id && content.includes('@' + u.name)) {
        notify(u.id, 'mention', ideaId, me(req).id, `在灵感「${idea.title}」的评论里提到了你 @${u.name}`)
      }
    }
    return db.prepare('SELECT c.*, u.name AS author FROM plaza_comments c JOIN users u ON u.id = c.user_id WHERE c.id = ?').get(r.lastInsertRowid)
  })

  app.get('/api/plaza/members', async () => db.prepare('SELECT id, name FROM users ORDER BY id').all())

  app.post<{ Body: Any }>('/api/plaza/compose', async (req) => {
    requirePlazaWrite(me(req).id)
    const content = String(req.body?.content || '').trim()
    if (!content) throw Object.assign(new Error('写点什么再发布吧'), { statusCode: 400  , code: 'post_required' })
    const title = content.split('\n')[0].slice(0, 30) || '未命名灵感'
    const tags = String(req.body?.tags || '').trim()
    const r = db.prepare(
      "INSERT INTO ideas (user_id, title, content, is_public, public_summary, tags, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?)"
    ).run(me(req).id, title, content, content.slice(0, 100), tags, nowIso(), nowIso())
    return db.prepare('SELECT * FROM ideas WHERE id = ?').get(r.lastInsertRowid)
  })

  // ---------- 通知铃铛（v0.2 §4.4） ----------
  const ensureFollowups = (userId: number) => {
    // 懒生成：接单跟进逾期 → followup 通知（同单未读仅一条）
    const overdue = db
      .prepare(
        `SELECT * FROM consult_items WHERE user_id = ? AND next_follow_up IS NOT NULL AND next_follow_up < ?
         AND status NOT IN ('settled', 'lost')`
      )
      .all(userId, todayStr()) as Any[]
    for (const it of overdue) {
      const days = Math.max(0, Math.round((Date.now() - new Date(`${it.next_follow_up}T00:00:00`).getTime()) / 86400000))
      const content = `接单「${it.client}${it.project ? '·' + it.project : ''}」跟进逾期 ${days} 天`
      // 按 内容+单据 去重：逾期天数变化或改跟进日期后才产生新提醒
      const dup = db
        .prepare("SELECT id FROM notifications WHERE user_id = ? AND type = 'followup' AND ref_id = ? AND content = ?")
        .get(userId, it.id, content)
      if (dup) continue
      notify(userId, 'followup', it.id, userId, content)
    }
  }

  registerNoticeRoutes(app, ensureFollowups)

  app.get<{ Querystring: Record<string, unknown> }>('/api/notifications', async (req) => {
    const { page, pageSize, offset } = pagination(req.query, 30)
    const userId = me(req).id
    db.transaction(() => ensureFollowups(userId)).immediate()
    const items = db
      .prepare(
        `SELECT n.id, n.user_id, n.type, n.actor_id, n.read, n.created_at, u.name AS actor_name,
          CASE WHEN n.type IN ('like', 'comment', 'mention') AND NOT EXISTS
            (SELECT 1 FROM ideas i WHERE i.id = n.ref_id AND (i.user_id = n.user_id OR (i.is_public = 1 AND i.plaza_removed_at IS NULL)))
            THEN NULL ELSE n.ref_id END AS ref_id,
          CASE WHEN n.type IN ('like', 'comment', 'mention') AND NOT EXISTS
            (SELECT 1 FROM ideas i WHERE i.id = n.ref_id AND (i.user_id = n.user_id OR (i.is_public = 1 AND i.plaza_removed_at IS NULL)))
            THEN '相关灵感已不可访问' ELSE n.content END AS content
         FROM notifications n LEFT JOIN users u ON u.id = n.actor_id
         WHERE n.user_id = ? ORDER BY n.id DESC LIMIT ? OFFSET ?`
      )
      .all(userId, pageSize, offset)
    const unread = (db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ? AND read = 0').get(userId) as Any).c
    const total = (db.prepare('SELECT COUNT(*) AS c FROM notifications WHERE user_id = ?').get(userId) as Any).c
    return { items, unread, page, pageSize, total }
  })

  app.post('/api/notifications/read-all', async (req) => {
    requireEmptyBody(req.body)
    db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ?').run(me(req).id)
    return { ok: true }
  })

  // ---------- 需求商单 + AI 供需匹配（Phase C） ----------
  const ORDER_STATUSES = ['pool', 'taken', 'passed'] as const

  interface OrderLeadRow {
    id: number
    user_id: number
    title: string
    requirement: string
    url: string
    amount: number
    deadline: string | null
    status: string
    matched_project_id: number | null
    match_raw: string
    matched_at: string | null
    created_at: string
    updated_at: string
    matched_project_name?: string | null
    match_channel?: 'kw+ai' | 'kw' | 'parse_failed' | 'no_ai' | 'none'
  }

  const validUrl = (u: string) => /^https?:\/\/\S+/.test(u)

  const ownLead = (id: number, userId: number): OrderLeadRow => {
    const lead = db.prepare('SELECT * FROM order_leads WHERE id = ? AND user_id = ?').get(id, userId) as unknown as OrderLeadRow | undefined
    if (!lead) throw Object.assign(new Error('商单不存在'), { statusCode: 404  , code: 'order_not_found' })
    return lead
  }

  // ---------- 商单匹配引擎 v1.1：关键词通道 + 语义通道混合（补丁 §1-§3） ----------
  const fuseScore = (kw: number, ai: number) => (ai >= 0 ? Math.round(KW_WEIGHT * kw + AI_WEIGHT * ai) : kw)

  const projectRows = (userId: number): CandidateProject[] =>
    db
      .prepare('SELECT id, name, description, tech_stack, status FROM dev_projects WHERE user_id = ?')
      .all(userId) as unknown as CandidateProject[]

  const kwScoreProjects = (lead: { title: string; requirement: string }, projects: CandidateProject[]) => {
    const docA = `${lead.title} ${lead.requirement}`
    return projects.map((p) => {
      const hit = kwScore(docA, `${p.name} ${p.description || ''} ${p.tech_stack || ''}`, p.tech_stack || '')
      return { project_id: p.id, kw_score: hit.kwScore, hit_terms: hit.hitTerms.join(',') }
    })
  }

  const kwScoreLeads = (project: CandidateProject, leads: { id: number; title: string; requirement: string }[]) => {
    const docB = `${project.name} ${project.description || ''} ${project.tech_stack || ''}`
    return leads.map((l) => {
      const hit = kwScore(`${l.title} ${l.requirement}`, docB, project.tech_stack || '')
      return { lead_id: l.id, kw_score: hit.kwScore, hit_terms: hit.hitTerms.join(',') }
    })
  }

  // §3.1 正向语义：商单 → 逐候选工程强制打分
  const semanticForward = async (
    cfg: AiConfig,
    lead: { title: string; requirement: string; amount: number; deadline: string | null },
    candidates: CandidateProject[]
  ) => {
    const system = [
      '你是开发接单匹配评分引擎。对「商单(需求)」与每一个「候选工程(供给)」逐一评分。',
      '每个候选必须恰好输出一条，不许省略、不许新增候选。',
      '只输出 JSON 数组，格式：',
      '[{"project_id":number,"score":0到100整数,"reasons":"不超过40字中文，须点明命中点或不命中原因"}]',
      '评分维度：技术栈重合40 + 需求场景相似40 + 档期与体量合理20；',
      'status 为 released/archived 的工程档期分减半。',
      '低相关也要给出分数与理由，禁止省略。',
      '不要输出 JSON 以外的任何文字。',
    ].join('\n')
    const userPrompt = `商单：${JSON.stringify({ title: lead.title, requirement: lead.requirement, amount: lead.amount, deadline: lead.deadline })}\n候选工程：${JSON.stringify(candidates)}`
    const raw = await chatCompletion(cfg, [
      { role: 'system', content: system },
      { role: 'user', content: userPrompt },
    ])
    const { ok, items } = parseAiArray(raw, 'project_id')
    const aiMap = new Map<number, { score: number; reasons: string }>()
    if (ok) {
      for (const x of items) {
        const pid = Number(x.project_id)
        if (!candidates.some((c) => c.id === pid)) continue // 守卫：归属校验
        aiMap.set(pid, {
          score: Math.max(0, Math.min(100, Math.round(Number(x.score) || 0))),
          reasons: String(x.reasons || '').slice(0, 40),
        })
      }
    }
    return { raw, aiMap, ok }
  }

  // §3.2 反向语义：工程 → 逐候选池内商单强制打分
  const semanticReverse = async (
    cfg: AiConfig,
    project: CandidateProject,
    candidates: { id: number; title: string; requirement: string; amount: number; deadline: string | null }[]
  ) => {
    const system = [
      '你是开发接单匹配评分引擎。对「开发工程(供给)」与每一个「候选商单(需求)」逐一评分。',
      '每个候选必须恰好输出一条，不许省略、不许新增候选。',
      '只输出 JSON 数组，格式：',
      '[{"lead_id":number,"score":0到100整数,"reasons":"不超过40字中文，须点明命中点或不命中原因"}]',
      '评分维度：技术栈重合40 + 需求场景相似40 + 档期与体量合理20；',
      'status 为 released/archived 的工程档期分减半。',
      '低相关也要给出分数与理由，禁止省略。',
      '不要输出 JSON 以外的任何文字。',
    ].join('\n')
    const userPrompt = `工程：${JSON.stringify({ id: project.id, name: project.name, description: project.description, tech_stack: project.tech_stack, status: project.status })}\n候选商单：${JSON.stringify(candidates)}`
    const raw = await chatCompletion(cfg, [
      { role: 'system', content: system },
      { role: 'user', content: userPrompt },
    ])
    const { ok, items } = parseAiArray(raw, 'lead_id')
    const aiMap = new Map<number, { score: number; reasons: string }>()
    if (ok) {
      for (const x of items) {
        const lid = Number(x.lead_id)
        if (!candidates.some((c) => c.id === lid)) continue
        aiMap.set(lid, {
          score: Math.max(0, Math.min(100, Math.round(Number(x.score) || 0))),
          reasons: String(x.reasons || '').slice(0, 40),
        })
      }
    }
    return { raw, aiMap, ok }
  }

  const upsertMatch = (leadId: number, row: MatchRow) => {
    db.prepare(
      `INSERT INTO order_matches (lead_id, project_id, score, reasons, kw_score, ai_score, hit_terms)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(lead_id, project_id) DO UPDATE SET score = excluded.score, reasons = excluded.reasons,
       kw_score = excluded.kw_score, ai_score = excluded.ai_score, hit_terms = excluded.hit_terms`
    ).run(leadId, row.project_id, row.score, row.reasons, row.kw_score, row.ai_score, row.hit_terms)
  }

  // 正向重匹配一条商单（关键词全量 + 语义逐候选 + 融合落库）
  const rematchOrder = async (leadId: number, userId: number): Promise<{ saved: number; badge: string }> => {
    const lead = ownLead(leadId, userId)
    const projects = projectRows(userId)
    if (projects.length === 0) {
      db.prepare('DELETE FROM order_matches WHERE lead_id = ?').run(leadId)
      return { saved: 0, badge: 'none' }
    }
    const kwRows = kwScoreProjects(lead, projects)
    // 候选集：工程数 ≤12 全量；>12 = 关键词召回（kw>0）top12
    const candidates = kwRows.length <= 12
      ? kwRows
      : kwRows.filter((r) => r.kw_score > 0).sort((a, b) => b.kw_score - a.kw_score).slice(0, 12)
    const candidateProjects = candidates
      .map((c) => projects.find((p) => p.id === c.project_id))
      .filter((p): p is CandidateProject => Boolean(p))

    let badge = 'no_ai'
    let raw = ''
    let aiMap = new Map<number, { score: number; reasons: string }>()
    const cfg = resolveAiConfig(db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId) as Any)
    if (cfg && candidateProjects.length) {
      try {
        const res = await semanticForward(cfg, lead, candidateProjects)
        raw = res.raw
        aiMap = res.aiMap
        badge = res.ok ? 'kw+ai' : 'parse_failed'
      } catch {
        badge = 'ai_failed'
      }
    }

    const rows: MatchRow[] = candidates.map((c) => {
      const ai = aiMap.get(c.project_id)
      const aiScore = ai ? ai.score : -1
      return {
        project_id: c.project_id,
        kw_score: c.kw_score,
        ai_score: aiScore,
        hit_terms: c.hit_terms,
        reasons: ai?.reasons || '',
        score: fuseScore(c.kw_score, aiScore),
      }
    })
    const toSave = rows.filter((r) => r.score >= MATCH_SAVE_THRESHOLD).sort((a, b) => b.score - a.score)
    db.transaction(() => {
      db.prepare('DELETE FROM order_matches WHERE lead_id = ?').run(leadId)
      const ins = db.prepare('INSERT INTO order_matches (lead_id, project_id, score, reasons, kw_score, ai_score, hit_terms) VALUES (?, ?, ?, ?, ?, ?, ?)')
      for (const r of toSave) ins.run(leadId, r.project_id, r.score, r.reasons, r.kw_score, r.ai_score, r.hit_terms)
      db.prepare('UPDATE order_leads SET match_raw = ?, matched_at = ? WHERE id = ?').run(raw, nowIso(), leadId)
    })()
    return { saved: toSave.length, badge }
  }

  // 反向重匹配一个工程：池内商单全部与该工程配对（关键词 + 一次反向语义调用）
  const reverseMatchProject = async (projectId: number, userId: number): Promise<{ saved: number }> => {
    const p = ownProject(projectId, userId)
    const leads = db
      .prepare("SELECT id, title, requirement, amount, deadline FROM order_leads WHERE user_id = ? AND status = 'pool'")
      .all(userId) as unknown as { id: number; title: string; requirement: string; amount: number; deadline: string | null }[]
    if (leads.length === 0) return { saved: 0 }
    const kwRows = kwScoreLeads(p as unknown as CandidateProject, leads)
    const candidates = leads.length <= 12
      ? kwRows
      : kwRows.filter((r) => r.kw_score > 0).sort((a, b) => b.kw_score - a.kw_score).slice(0, 12)
    const candidateLeads = candidates
      .map((c) => leads.find((l) => l.id === c.lead_id))
      .filter((l): l is { id: number; title: string; requirement: string; amount: number; deadline: string | null } => Boolean(l))

    let aiMap = new Map<number, { score: number; reasons: string }>()
    const cfg = resolveAiConfig(db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId) as Any)
    if (cfg && candidateLeads.length) {
      try {
        const res = await semanticReverse(cfg, p as unknown as CandidateProject, candidateLeads)
        aiMap = res.aiMap
      } catch {
        // AI 不可用时继续按关键词重匹配。
      }
    }

    let saved = 0
    db.transaction(() => {
      db.prepare("DELETE FROM order_matches WHERE project_id = ? AND lead_id IN (SELECT id FROM order_leads WHERE user_id = ? AND status = 'pool')").run(p.id, userId)
      for (const c of candidates) {
        const ai = aiMap.get(c.lead_id)
        const aiScore = ai ? ai.score : -1
        const score = fuseScore(c.kw_score, aiScore)
        if (score >= MATCH_SAVE_THRESHOLD) {
          upsertMatch(c.lead_id, {
            project_id: p.id,
            kw_score: c.kw_score,
            ai_score: aiScore,
            hit_terms: c.hit_terms,
            reasons: ai?.reasons || '',
            score,
          })
          db.prepare('UPDATE order_leads SET matched_at = ? WHERE id = ?').run(nowIso(), c.lead_id)
          saved++
        } else {
          db.prepare('DELETE FROM order_matches WHERE lead_id = ? AND project_id = ?').run(c.lead_id, p.id)
        }
      }
    })()
    return { saved }
  }

  // 全局重匹配：全部池内商单逐个正向重匹配（顺序执行）
  const rematchAllOrders = async (userId: number): Promise<{ count: number; saved: number }> => {
    const leads = db
      .prepare("SELECT id FROM order_leads WHERE user_id = ? AND status = 'pool' ORDER BY id DESC")
      .all(userId) as unknown as { id: number }[]
    let saved = 0
    for (const l of leads) {
      try {
        const r = await rematchOrder(l.id, userId)
        saved += r.saved
      } catch {
        // 单条失败不阻塞全局
      }
    }
    return { count: leads.length, saved }
  }

  app.get<{ Querystring: { status?: string; sort?: string } }>('/api/orders', async (req) => {
    const userId = me(req).id
    const statusFilter = (ORDER_STATUSES as readonly string[]).includes(req.query.status || '') ? (req.query.status as string) : null
    const sort = ['amount', 'deadline', 'created'].includes(req.query.sort || '') ? (req.query.sort as string) : 'created'
    let items = db
      .prepare(
        `SELECT o.*, p.name AS matched_project_name FROM order_leads o
         LEFT JOIN dev_projects p ON p.id = o.matched_project_id WHERE o.user_id = ?`
      )
      .all(userId) as unknown as (OrderLeadRow & { is_expired: boolean; days_left: number | null; matches: { project_id: number; project_name: string; score: number; reasons: string; kw_score: number; ai_score: number; hit_terms: string }[] })[]
    if (statusFilter) items = items.filter((o) => o.status === statusFilter)

    const today = todayStr()
    const isExpired = (o: OrderLeadRow) => o.status === 'pool' && o.deadline !== null && o.deadline < today
    for (const o of items) {
      o.is_expired = isExpired(o)
      o.days_left = o.deadline ? Math.ceil((new Date(`${o.deadline}T23:59:59`).getTime() - Date.now()) / 86400000) : null
    }
    if (sort === 'amount') {
      items.sort((a, b) => b.amount - a.amount)
    } else if (sort === 'deadline') {
      items.sort((a, b) => {
        if (a.is_expired !== b.is_expired) return a.is_expired ? 1 : -1
        if (a.deadline && b.deadline) return a.deadline.localeCompare(b.deadline)
        if (a.deadline) return -1
        if (b.deadline) return 1
        return b.id - a.id
      })
    } else {
      items.sort((a, b) => {
        if (a.is_expired !== b.is_expired) return a.is_expired ? 1 : -1
        return b.id - a.id
      })
    }

    // 匹配 Top3 随列表一次带出
    const matchesByLead: Record<number, { project_id: number; project_name: string; score: number; reasons: string; kw_score: number; ai_score: number; hit_terms: string }[]> = {}
    if (items.length) {
      const ids = items.map((o) => o.id)
      const rows = db
        .prepare(
          `SELECT m.lead_id, m.project_id, m.score, m.reasons, m.kw_score, m.ai_score, m.hit_terms, p.name AS project_name
           FROM order_matches m JOIN dev_projects p ON p.id = m.project_id
           WHERE m.lead_id IN (${ids.map(() => '?').join(',')}) ORDER BY m.score DESC`
        )
        .all(...ids) as unknown as { lead_id: number; project_id: number; score: number; reasons: string; kw_score: number; ai_score: number; hit_terms: string; project_name: string }[]
      for (const r of rows) {
        matchesByLead[r.lead_id] = matchesByLead[r.lead_id] || []
        matchesByLead[r.lead_id].push({
          project_id: r.project_id,
          project_name: r.project_name,
          score: r.score,
          reasons: r.reasons,
          kw_score: r.kw_score,
          ai_score: r.ai_score,
          hit_terms: r.hit_terms,
        })
      }
    }
    // 通道徽标派生：任一匹配有语义分 → 关键词+语义；原文解析失败 → 语义解析失败；无语义调用 → 仅关键词
    const rawParses = (rawText: string) => {
      const s = rawText.indexOf('[')
      const e = rawText.lastIndexOf(']')
      if (s === -1 || e <= s) return false
      try {
        return Array.isArray(JSON.parse(rawText.slice(s, e + 1)))
      } catch {
        return false
      }
    }
    for (const o of items) {
      o.matches = matchesByLead[o.id] || []
      const anyAi = o.matches.some((m) => m.ai_score >= 0)
      if (anyAi) o.match_channel = 'kw+ai'
      else if (o.match_raw && o.matched_at) o.match_channel = rawParses(o.match_raw) ? 'kw+ai' : 'parse_failed'
      else if (o.matched_at) o.match_channel = 'no_ai'
      else o.match_channel = 'none'
    }

    const pool = items.filter((o) => o.status === 'pool')
    const in7 = Date.now() + 7 * 86400000
    const dueSoon = pool.filter((o) => {
      if (!o.deadline) return false
      const end = new Date(`${o.deadline}T23:59:59`).getTime()
      return end >= Date.now() && end <= in7
    }).length
    return {
      items,
      stats: {
        poolCount: pool.length,
        poolAmount: pool.reduce((s, o) => s + o.amount, 0),
        takenCount: items.filter((o) => o.status === 'taken').length,
        dueSoon,
      },
    }
  })

  app.post<{ Body: Record<string, unknown> }>('/api/orders', async (req) => {
    const title = String(req.body?.title || '').trim()
    const url = String(req.body?.url || '').trim()
    if (!title) throw Object.assign(new Error('请填写开发项目名称'), { statusCode: 400  , code: 'project_name_required' })
    if (!validUrl(url)) throw Object.assign(new Error('商单网址必须以 http(s):// 开头'), { statusCode: 400  , code: 'order_url_invalid' })
    const amount = Number(req.body?.amount) || 0
    const deadline = validDate(req.body?.deadline)
    const r = db
      .prepare("INSERT INTO order_leads (user_id, title, requirement, url, amount, deadline, status) VALUES (?, ?, ?, ?, ?, ?, 'pool')")
      .run(me(req).id, title, String(req.body?.requirement || ''), url, amount, deadline)
    const lead = ownLead(Number(r.lastInsertRowid), me(req).id)
    void rematchOrder(lead.id, me(req).id).catch(() => {}) // 保存后自动匹配（fire-and-forget，不阻塞保存）
    return lead
  })

  app.get<{ Params: { id: string } }>('/api/orders/:id', async (req) => {
    const lead = ownLead(Number(req.params.id), me(req).id)
    const matches = db.prepare('SELECT project_id, score, reasons FROM order_matches WHERE lead_id = ? ORDER BY score DESC').all(lead.id)
    return { ...lead, matches }
  })

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/orders/:id', async (req) => {
    const lead = ownLead(Number(req.params.id), me(req).id)
    const b = req.body || {}
    const url = b.url !== undefined ? String(b.url).trim() : lead.url
    if (!validUrl(url)) throw Object.assign(new Error('商单网址必须以 http(s):// 开头'), { statusCode: 400  , code: 'order_url_invalid' })
    const num = (v: unknown, fb: number) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? fb : Math.max(0, Number(v)))
    const status = (ORDER_STATUSES as readonly string[]).includes(String(b.status || '')) ? String(b.status) : lead.status
    db.prepare('UPDATE order_leads SET title = ?, requirement = ?, url = ?, amount = ?, deadline = ?, status = ?, updated_at = ? WHERE id = ?').run(
      b.title !== undefined ? String(b.title).trim() || lead.title : lead.title,
      b.requirement !== undefined ? String(b.requirement) : lead.requirement,
      url,
      num(b.amount, lead.amount),
      b.deadline !== undefined ? (b.deadline ? String(b.deadline) : null) : lead.deadline,
      status,
      nowIso(),
      lead.id
    )
    void rematchOrder(lead.id, me(req).id).catch(() => {}) // 商单编辑 → 重匹配该商单
    return ownLead(lead.id, me(req).id)
  })

  app.delete<{ Params: { id: string } }>('/api/orders/:id', async (req) => {
    const lead = ownLead(Number(req.params.id), me(req).id)
    db.prepare('DELETE FROM order_matches WHERE lead_id = ?').run(lead.id)
    db.prepare('DELETE FROM order_leads WHERE id = ?').run(lead.id)
    return { ok: true }
  })

  app.post<{ Params: { id: string } }>('/api/orders/:id/match', async (req) => {
    const result = await rematchOrder(Number(req.params.id), me(req).id)
    const matches = db
      .prepare('SELECT m.*, p.name AS project_name FROM order_matches m JOIN dev_projects p ON p.id = m.project_id WHERE m.lead_id = ? ORDER BY m.score DESC')
      .all(Number(req.params.id))
    return { ok: true, badge: result.badge, saved: result.saved, matches }
  })

  // 全局重匹配：全部池内商单（顺序执行）
  app.post('/api/orders/rematch-all', async (req) => {
    const r = await rematchAllOrders(me(req).id)
    return { ok: true, ...r }
  })

  app.get<{ Params: { id: string } }>('/api/orders/:id/matches', async (req) => {
    const lead = ownLead(Number(req.params.id), me(req).id)
    return db
      .prepare('SELECT m.*, p.name AS project_name FROM order_matches m JOIN dev_projects p ON p.id = m.project_id WHERE m.lead_id = ? ORDER BY m.score DESC')
      .all(lead.id)
  })

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/orders/:id/attach', async (req) => {
    const lead = ownLead(Number(req.params.id), me(req).id)
    const projectId = Number(req.body?.projectId)
    ownProject(projectId, me(req).id)
    db.prepare("UPDATE order_leads SET matched_project_id = ?, status = 'taken', updated_at = ? WHERE id = ?").run(projectId, nowIso(), lead.id)
    return db.prepare('SELECT * FROM order_leads WHERE id = ?').get(lead.id)
  })

  app.post<{ Params: { id: string } }>('/api/orders/:id/detach', async (req) => {
    const lead = ownLead(Number(req.params.id), me(req).id)
    db.prepare("UPDATE order_leads SET matched_project_id = NULL, status = 'pool', updated_at = ? WHERE id = ?").run(nowIso(), lead.id)
    return db.prepare('SELECT * FROM order_leads WHERE id = ?').get(lead.id)
  })

  app.post<{ Params: { id: string } }>('/api/orders/:id/to-project', async (req) => {
    const lead = ownLead(Number(req.params.id), me(req).id)
    // 幂等：同 lead 已建过工程则直接返回
    const existed = db.prepare('SELECT * FROM dev_projects WHERE source_lead_id = ?').get(lead.id) as unknown as { id: number; name: string } | undefined
    if (existed) {
      db.prepare("UPDATE order_leads SET matched_project_id = ?, status = 'taken', updated_at = ? WHERE id = ?").run(existed.id, nowIso(), lead.id)
      return { project: existed, created: false }
    }
    const r = db
      .prepare("INSERT INTO dev_projects (user_id, name, description, deadline, status, source_lead_id) VALUES (?, ?, ?, ?, 'planning', ?)")
      .run(me(req).id, lead.title, lead.requirement, lead.deadline, lead.id)
    const projectId = Number(r.lastInsertRowid)
    db.prepare('INSERT INTO dev_logs (project_id, content) VALUES (?, ?)').run(projectId, '💰 由商单创建项目')
    db.prepare("UPDATE order_leads SET matched_project_id = ?, status = 'taken', updated_at = ? WHERE id = ?").run(projectId, nowIso(), lead.id)
    return { project: db.prepare('SELECT * FROM dev_projects WHERE id = ?').get(projectId), created: true }
  })

  app.get<{ Params: { id: string } }>('/api/dev/:id/leads', async (req) => {
    const p = ownProject(Number(req.params.id), me(req).id)
    return db
      .prepare(
        `SELECT DISTINCT o.*, m.score AS match_score, m.hit_terms AS match_hit_terms FROM order_leads o
         LEFT JOIN order_matches m ON m.lead_id = o.id AND m.project_id = ?
         WHERE o.matched_project_id = ? OR (m.project_id = ? AND m.score >= ${MATCH_CHIP_THRESHOLD})
         ORDER BY o.id DESC`
      )
      .all(p.id, p.id, p.id)
  })

  // ---------- 灵感 ↔ 商单匹配度打分（v0.2.1 新功能） ----------
  app.post<{ Params: { id: string } }>('/api/ideas/:id/score-orders', async (req) => {
    const idea = ownIdea(Number(req.params.id), me(req).id)
    const orders = db
      .prepare("SELECT id, title, requirement, amount, deadline FROM order_leads WHERE user_id = ? AND status = 'pool'")
      .all(me(req).id) as unknown as { id: number; title: string; requirement: string; amount: number; deadline: string | null }[]
    if (orders.length === 0) throw Object.assign(new Error('没有在池商单可匹配'), { statusCode: 400  , code: 'no_pool_orders' })
    const cfg = resolveAiConfig(db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(me(req).id) as Any)
    if (!cfg) throw Object.assign(new Error(NO_AI_CONFIG.message), { statusCode: 400, code: 'no_ai_config' })

    const system = [
      '你是供需匹配评分引擎。评估「用户灵感(能力/想法)」与每一个「候选商单(需求)」的匹配度。',
      '每个候选必须恰好输出一条，不许省略、不许新增候选。',
      '只输出 JSON 数组，格式：',
      '[{"order_id":number,"score":0到100整数,"reasons":"不超过40字中文，说明这条灵感若落地为工程能否承接该商单"}]',
      '评分维度：需求场景契合 50 + 可实现性 30 + 时间与体量合理 20。',
      '低相关也要给出分数与理由，禁止省略。',
      '不要输出 JSON 以外的任何文字。',
    ].join('\n')
    const userPrompt = `灵感：${JSON.stringify({ title: idea.title, content: idea.content })}\n候选商单：${JSON.stringify(orders)}`
    const raw = await chatCompletion(cfg, [
      { role: 'system', content: system },
      { role: 'user', content: userPrompt },
    ])
    const parsed = parseAiArray(raw, 'order_id')
    const rows = parsed.items.filter((x) => orders.some((o) => o.id === x.order_id))
      .map((x) => ({ order_id: Number(x.order_id), score: Math.round(Number(x.score)), reasons: String(x.reasons || '').slice(0, 40) }))
    if (!rows.length) throw Object.assign(new Error('AI 返回内容解析失败，请重试'), { statusCode: 502  , code: 'ai_invalid_response' })

    return db.transaction(() => {
      db.prepare('DELETE FROM idea_order_scores WHERE idea_id = ?').run(idea.id)
      const ins = db.prepare('INSERT INTO idea_order_scores (idea_id, user_id, order_id, score, reasons, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      for (const r of rows) ins.run(idea.id, me(req).id, r.order_id, r.score, r.reasons, nowIso())
      return {
        rows: db
          .prepare(
            `SELECT s.*, o.title AS order_title, o.amount, o.url FROM idea_order_scores s
             JOIN order_leads o ON o.id = s.order_id WHERE s.idea_id = ? ORDER BY s.score DESC`
          )
          .all(idea.id),
      }
    })()
  })

  app.get<{ Params: { id: string } }>('/api/ideas/:id/score-orders', async (req) => {
    const idea = ownIdea(Number(req.params.id), me(req).id)
    return {
      rows: db
        .prepare(
          `SELECT s.*, o.title AS order_title, o.amount, o.url FROM idea_order_scores s
           JOIN order_leads o ON o.id = s.order_id WHERE s.idea_id = ? ORDER BY s.score DESC`
        )
        .all(idea.id),
    }
  })

  // ---------- 自媒体制作工坊（Phase D §2） ----------
  const STUDIO_FORMS = ['short', 'graphic', 'mid']
  const STUDIO_FORM_LABEL: Record<string, string> = { short: '短视频', graphic: '图文', mid: '中长视频' }

  const ownStudio = (id: number, userId: number) => {
    const s = db.prepare('SELECT * FROM studio_projects WHERE id = ? AND user_id = ?').get(id, userId) as unknown as Record<string, unknown> | undefined
    if (!s) throw Object.assign(new Error('制作方案不存在'), { statusCode: 404  , code: 'studio_not_found' })
    return s
  }

  const parseStudioAi = (raw: string) => {
    const s = raw.indexOf('{')
    const e = raw.lastIndexOf('}')
    if (s === -1 || e <= s) return null
    try {
      const j = JSON.parse(raw.slice(s, e + 1)) as Record<string, unknown>
      if (!j || typeof j.title !== 'string' || !j.title.trim() || typeof j.synopsis !== 'string' || !j.synopsis.trim()) return null
      if (!['characters', 'scenes', 'tools'].every((key) => Array.isArray(j[key])
        && (j[key] as unknown[]).every((x: any) => x && typeof x === 'object' && typeof x.name === 'string' && x.name.trim()))) return null
      const title = String(j.title || '').slice(0, 20)
      const synopsis = String(j.synopsis || '')
      const chars = (Array.isArray(j.characters) ? j.characters : [])
        .map((c) => c as Record<string, unknown>)
        .filter((c) => String(c.name || '').trim())
        .map((c) => ({ name: String(c.name).slice(0, 20), desc: String(c.desc || '').slice(0, 60) }))
      const scenes = (Array.isArray(j.scenes) ? j.scenes : [])
        .map((c) => c as Record<string, unknown>)
        .filter((c) => String(c.name || '').trim())
        .map((c) => ({ name: String(c.name).slice(0, 30), desc: String(c.desc || '').slice(0, 80) }))
      const tools = (Array.isArray(j.tools) ? j.tools : [])
        .map((t) => t as Record<string, unknown>)
        .filter((t) => String(t.name || '').trim())
        .map((t) => ({
          name: String(t.name).slice(0, 30),
          category: String(t.category || 'video'),
          pros: String(t.pros || '').slice(0, 40),
          cons: String(t.cons || '').slice(0, 40),
          fit: Math.max(0, Math.min(100, Math.round(Number(t.fit) || 0))),
          reason: String(t.reason || '').slice(0, 30),
        }))
      return { title, synopsis, chars, scenes, tools }
    } catch {
      return null
    }
  }

  const STUDIO_AI_SYSTEM = [
    '你是自媒体 AIGC 制作策划师。根据用户给的灵感（剧情或场景描述）生成一份可执行的完整制作方案。',
    '只输出 JSON，格式：',
    '{"title":"不超过20字的作品标题",',
    '"synopsis":"完整剧情，三幕结构，200-400字",',
    '"characters":[{"name":"人名或角色名","desc":"不超过60字：外貌/性格/服装"}],',
    '"scenes":[{"name":"场N 场景名","desc":"不超过80字：画面内容+光线+构图+运镜"}],',
    '"tools":[{"name":"工具名","category":"video|image|cut|graphic",',
    '"pros":"不超过40字优点","cons":"不超过40字缺点","fit":0到100整数,',
    '"reason":"不超过30字：为何适合本方案"}]}',
    'characters 2-4 个；scenes 3-6 个；tools 3-4 个，从主流专业 AIGC 工具中选',
    '（即梦/Seedance、可灵Kling、海螺MiniMax、Vidu、Runway、Pika、Sora、剪映、',
    '稿定/创客贴等图文工具），fit 为与本方案的适配度，选项间要有差异（免费/付费/能力边界）。',
    '不要输出 JSON 以外的任何文字。',
  ].join('\n')

  app.get('/api/studio', async (req) =>
    db.prepare('SELECT * FROM studio_projects WHERE user_id = ? ORDER BY id DESC').all(me(req).id)
  )

  // 手动创建方案（不经过 AI）
  app.post<{ Body: Record<string, unknown> }>('/api/studio', async (req) => {
    const title = String(req.body?.title || '').trim()
    const brief = String(req.body?.brief || '').trim()
    if (!title && !brief) throw Object.assign(new Error('请填写标题或灵感'), { statusCode: 400  , code: 'brief_required' })
    const form = STUDIO_FORMS.includes(String(req.body?.form || '')) ? String(req.body.form) : 'short'
    const r = db
      .prepare("INSERT INTO studio_projects (user_id, title, brief, form, synopsis, status) VALUES (?, ?, ?, ?, ?, 'draft')")
      .run(me(req).id, title, brief, form, String(req.body?.synopsis || ''))
    const projectId = Number(r.lastInsertRowid)
    void reverseMatchWishesForStudio(projectId, me(req).id).catch(() => {})
    return db.prepare('SELECT * FROM studio_projects WHERE id = ?').get(projectId)
  })

  // AI 生成制作方案（§2.4 prompt 原文 + 解析守卫）
  app.get<{ Params: { id: string } }>('/api/studio/:id', async (req) => {
    const s = ownStudio(Number(req.params.id), me(req).id)
    return s
  })

  app.post<{ Body: Record<string, unknown> }>('/api/studio/generate', async (req) => {
    const brief = String(req.body?.brief || '').trim()
    if (!brief) throw Object.assign(new Error('请填写剧情/场景灵感'), { statusCode: 400  , code: 'scene_required' })
    const form = STUDIO_FORMS.includes(String(req.body?.form || '')) ? String(req.body.form) : 'short'
    const sourceIdeaId = req.body?.sourceIdeaId ? Number(req.body.sourceIdeaId) : null
    const cfg = resolveAiConfig(db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(me(req).id) as Any)
    if (!cfg) throw Object.assign(new Error(NO_AI_CONFIG.message), { statusCode: 400, code: 'no_ai_config' })

    let ideaContext = ''
    if (sourceIdeaId) {
      const idea = ownIdea(sourceIdeaId, me(req).id)
      ideaContext = `\n灵感库上下文：${idea.title} ${String(idea.content || '').slice(0, 300)}`
    }
    const userPrompt = `灵感：${brief}\n目标形态：${STUDIO_FORM_LABEL[form]}${ideaContext}`
    const raw = await chatCompletion(cfg, [
      { role: 'system', content: STUDIO_AI_SYSTEM },
      { role: 'user', content: userPrompt },
    ])

    const parsed = parseStudioAi(raw)
    const r = db
      .prepare(
        `INSERT INTO studio_projects (user_id, source_idea_id, title, brief, form, synopsis, characters, scenes, tools, tools_raw, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        me(req).id, sourceIdeaId, parsed?.title || '', brief, form,
        parsed?.synopsis || '', JSON.stringify(parsed?.chars || []), JSON.stringify(parsed?.scenes || []),
        JSON.stringify(parsed?.tools || []), raw, parsed ? 'generated' : 'draft'
      )
    const project = db.prepare('SELECT * FROM studio_projects WHERE id = ?').get(r.lastInsertRowid)
    void reverseMatchWishesForStudio(Number(r.lastInsertRowid), me(req).id).catch(() => {})
    return { project, parseFailed: !parsed }
  })

  app.post<{ Params: { id: string } }>('/api/studio/:id/regenerate', async (req) => {
    const s = ownStudio(Number(req.params.id), me(req).id)
    const cfg = resolveAiConfig(db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(me(req).id) as Any)
    if (!cfg) throw Object.assign(new Error(NO_AI_CONFIG.message), { statusCode: 400, code: 'no_ai_config' })
    const userPrompt = `灵感：${s.brief}\n目标形态：${STUDIO_FORM_LABEL[String(s.form)] || '短视频'}`
    const raw = await chatCompletion(cfg, [
      { role: 'system', content: STUDIO_AI_SYSTEM },
      { role: 'user', content: userPrompt },
    ])
    const parsed = parseStudioAi(raw)
    if (!parsed) return { project: s, parseFailed: true }
    db.prepare(
      `UPDATE studio_projects SET title = ?, synopsis = ?, characters = ?, scenes = ?, tools = ?, tools_raw = ?, status = ?, updated_at = ? WHERE id = ?`
    ).run(
      parsed?.title || String(s.title), parsed?.synopsis || String(s.synopsis),
      JSON.stringify(parsed?.chars || []), JSON.stringify(parsed?.scenes || []), JSON.stringify(parsed?.tools || []),
      raw, parsed ? 'generated' : 'draft', nowIso(), s.id
    )
    const updated = ownStudio(Number(s.id), me(req).id)
    void reverseMatchWishesForStudio(Number(s.id), me(req).id).catch(() => {})
    return { project: updated, parseFailed: !parsed }
  })

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/studio/:id', async (req) => {
    const s = ownStudio(Number(req.params.id), me(req).id)
    const b = req.body || {}
    const str = (key: string, fb: unknown, max?: number): string => {
      if (b[key] === undefined) return String(fb ?? '')
      const v = String(b[key])
      return max ? v.slice(0, max) : v
    }
    const arr = (key: string, fb: unknown): string => {
      if (b[key] === undefined) return String(fb ?? '')
      try {
        const parsed = JSON.parse(String(b[key]))
        return Array.isArray(parsed) ? JSON.stringify(parsed) : String(fb ?? '')
      } catch {
        return String(fb ?? '')
      }
    }
    db.prepare(
      `UPDATE studio_projects SET title = ?, synopsis = ?, characters = ?, scenes = ?, tools = ?, chosen_tool = ?, status = ?, updated_at = ? WHERE id = ?`
    ).run(
      str('title', s.title, 20),
      str('synopsis', s.synopsis),
      arr('characters', s.characters),
      arr('scenes', s.scenes),
      arr('tools', s.tools),
      str('chosenTool', s.chosen_tool, 30),
      ['draft', 'generated', 'producing', 'done'].includes(String(b.status || '')) ? String(b.status) : s.status,
      nowIso(),
      s.id as number
    )
    const updated = ownStudio(s.id as number, me(req).id)
    void reverseMatchWishesForStudio(s.id as number, me(req).id).catch(() => {}) // 方案编辑/选工具 → 反向重匹配 wishes
    return updated
  })

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/studio/:id/archive', async (req) => {
    const s = ownStudio(Number(req.params.id), me(req).id)
    const platform = String(req.body?.platform || '其他')
    const status = ['idea', 'scripting', 'making', 'published', 'reviewed'].includes(String(req.body?.status || ''))
      ? String(req.body.status)
      : 'idea'
    const r = db
      .prepare("INSERT INTO media_items (user_id, title, topic, platform, status, studio_id) VALUES (?, ?, ?, ?, ?, ?)")
      .run(me(req).id, String(s.title) || String(s.brief).slice(0, 20), String(s.brief).slice(0, 80), platform, status, s.id)
    return db.prepare('SELECT * FROM media_items WHERE id = ?').get(r.lastInsertRowid)
  })

  app.delete<{ Params: { id: string } }>('/api/studio/:id', async (req) => {
    const s = ownStudio(Number(req.params.id), me(req).id)
    db.prepare('DELETE FROM studio_projects WHERE id = ?').run(s.id)
    return { ok: true }
  })

  // ---------- 心仪视频作品（Phase D §3） ----------
  const ANALYZE_SYSTEM = [
    '你是视频作品分析师。整理该视频的特色与艺术风格，供后续 AIGC 复刻参考。',
    '只输出 JSON：',
    '{"features":"不超过80字：内容特色/叙事手法/运镜/节奏/声音设计",',
    '"art_style":"不超过60字：视觉风格/色调/美学流派/质感",',
    '"summary":"不超过40字一句话概括"}',
    '不要输出 JSON 以外的任何文字。',
  ].join('\n')

  const parseAnalyze = (raw: string) => {
    const s = raw.indexOf('{')
    const e = raw.lastIndexOf('}')
    if (s === -1 || e <= s) return null
    try {
      const j = JSON.parse(raw.slice(s, e + 1)) as Record<string, unknown>
      return {
        features: String(j.features || '').slice(0, 120),
        art_style: String(j.art_style || '').slice(0, 90),
      }
    } catch {
      return null
    }
  }

  const fetchPageText = async (url: string): Promise<string> => {
    const res = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      },
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) throw new Error(`页面请求返回 ${res.status}`)
    const html = await res.text()
    const pick = (re: RegExp) => {
      const m = html.match(re)
      return m ? m[1].trim() : ''
    }
    const title = pick(/<title[^>]*>([^<]*)<\/title>/i)
    const ogTitle = pick(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']*)["']/i)
    const ogDesc = pick(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i)
    const desc = pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)
    const text = `标题：${ogTitle || title}\n描述：${ogDesc || desc}`
    return text.replace(/：\s*$/, '').trim().length > 20 ? text : ''
  }

  const ownWish = (id: number, userId: number) => {
    const w = db.prepare('SELECT * FROM video_wishes WHERE id = ? AND user_id = ?').get(id, userId) as unknown as Record<string, unknown> | undefined
    if (!w) throw Object.assign(new Error('心仪作品不存在'), { statusCode: 404  , code: 'wish_not_found' })
    return w
  }

  // 三路径降级分析（§3.4）：multimodal → page → manual；analysis_channel 记录实际路径
  const analyzeWishById = async (wishId: number, userId: number): Promise<{ ok: true; channel: string; features: string; art_style: string }> => {
    const w = ownWish(wishId, userId)
    const cfg = resolveAiConfig(db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId) as Any)
    if (!cfg) throw Object.assign(new Error(NO_AI_CONFIG.message), { statusCode: 400, code: 'no_ai_config' })
    const videoUrl = String(w.video_url || '')
    const description = String(w.description || '').trim()

    let raw = ''
    let channel = ''
    let parsed: { features: string; art_style: string } | null = null

    // 路径 1：多模态（video_url 内容数组格式，DashScope qwen-vl / 智谱 glm-4v 等）
    if (videoUrl) {
      try {
        const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
          body: JSON.stringify({
            model: cfg.model,
            messages: [
              { role: 'system', content: ANALYZE_SYSTEM },
              {
                role: 'user',
                content: [
                  { type: 'video_url', video_url: { url: videoUrl } },
                  { type: 'text', text: '请分析这个视频链接的特色与艺术风格。' },
                ],
              },
            ],
          }),
          signal: AbortSignal.timeout(30000),
        })
        if (res.ok) {
          const data: any = await res.json()
          raw = String(data?.choices?.[0]?.message?.content || '')
          parsed = parseAnalyze(raw)
          if (parsed) channel = 'multimodal'
        }
      } catch {
        // 降级到路径 2
      }
    }

    // 路径 2：服务端抓取页面元信息 → 普通对话分析
    if (!parsed && videoUrl) {
      try {
        const pageText = await fetchPageText(videoUrl)
        if (pageText) {
          const raw2 = await chatCompletion(cfg, [
            { role: 'system', content: ANALYZE_SYSTEM },
            { role: 'user', content: `以下是视频页面的提取信息：\n${pageText}\n请据此整理该视频的特色与艺术风格。` },
          ])
          const p2 = parseAnalyze(raw2)
          if (p2) {
            raw = raw2
            channel = 'page'
            parsed = p2
          }
        }
      } catch {
        // 降级到路径 3
      }
    }

    // 路径 3：用作品描述分析（描述为空则引导补填，不死路）
    if (!parsed) {
      if (!description) {
        throw Object.assign(new Error('该平台链接有反爬（抖音/B站常见），请补填作品描述后再分析'), {
          statusCode: 400,
          code: 'manual_needed',
        })
      }
      const raw3 = await chatCompletion(cfg, [
        { role: 'system', content: ANALYZE_SYSTEM },
        { role: 'user', content: `作品描述：${description}\n请据此整理该视频的特色与艺术风格。` },
      ])
      const p3 = parseAnalyze(raw3)
      if (!p3) throw Object.assign(new Error('AI 返回内容解析失败，请重试'), { statusCode: 502  , code: 'ai_invalid_response' })
      raw = raw3
      channel = 'manual'
      parsed = p3
    }

    db.prepare('UPDATE video_wishes SET features = ?, art_style = ?, analysis_raw = ?, analysis_channel = ?, updated_at = ? WHERE id = ?').run(
      parsed.features, parsed.art_style, raw, channel, nowIso(), w.id as number
    )
    return { ok: true, channel, features: parsed.features, art_style: parsed.art_style }
  }

  app.post<{ Params: { id: string } }>('/api/wishes/:id/analyze', async (req) => {
    try {
      const r = await analyzeWishById(Number(req.params.id), me(req).id)
      const wish = ownWish(Number(req.params.id), me(req).id)
      return { ...r, wish }
    } catch (e: any) {
      if (e.code === 'manual_needed') {
        return { ok: false, code: 'manual_needed', message: e.message }
      }
      throw e
    }
  })

  app.get('/api/wishes', async (req) => {
    const userId = me(req).id
    const wishes = db.prepare('SELECT * FROM video_wishes WHERE user_id = ? ORDER BY id DESC').all(userId) as unknown as Record<string, unknown>[]
    const matchesByWish: Record<number, unknown[]> = {}
    if (wishes.length) {
      const ids = wishes.map((w) => w.id as number)
      const rows = db
        .prepare(
          `SELECT wm.*, sp.title AS studio_title, sp.chosen_tool, sp.tools AS studio_tools
           FROM wish_matches wm JOIN studio_projects sp ON sp.id = wm.studio_id
           WHERE wm.wish_id IN (${ids.map(() => '?').join(',')}) ORDER BY wm.score DESC`
        )
        .all(...ids) as unknown as Record<string, unknown>[]
      for (const r of rows) {
        matchesByWish[r.wish_id as number] = matchesByWish[r.wish_id as number] || []
        let toolName = String(r.chosen_tool || '')
        if (!toolName && r.studio_tools) {
          try {
            const tools = JSON.parse(String(r.studio_tools)) as { name: string; fit: number }[]
            toolName = [...tools].sort((a, b) => b.fit - a.fit)[0]?.name || ''
          } catch {
            toolName = ''
          }
        }
        matchesByWish[r.wish_id as number].push({
          studio_id: r.studio_id,
          studio_title: r.studio_title,
          tool_name: toolName,
          score: r.score,
          kw_score: r.kw_score,
          ai_score: r.ai_score,
          hit_terms: r.hit_terms,
          reasons: r.reasons,
        })
      }
    }
    return { items: wishes.map((w) => ({ ...w, matches: matchesByWish[w.id as number] || [] })) }
  })

  app.post<{ Body: Record<string, unknown> }>('/api/wishes', async (req) => {
    const title = String(req.body?.title || '').trim()
    if (!title) throw Object.assign(new Error('请填写标题'), { statusCode: 400  , code: 'title_required' })
    if (req.body?.sourceIdeaId) ownIdea(Number(req.body.sourceIdeaId), me(req).id)
    const r = db
      .prepare('INSERT INTO video_wishes (user_id, title, video_url, description, source_idea_id) VALUES (?, ?, ?, ?, ?)')
      .run(
        me(req).id, title,
        String(req.body?.videoUrl || '').trim(),
        String(req.body?.description || ''),
        req.body?.sourceIdeaId ? Number(req.body.sourceIdeaId) : null
      )
    const wishId = Number(r.lastInsertRowid)
    void (async () => {
      try {
        await analyzeWishById(wishId, me(req).id)
        await rematchWish(wishId, me(req).id)
      } catch {
        // 自动分析失败不阻塞保存，可在卡片上手动重试
      }
    })()
    return ownWish(wishId, me(req).id)
  })

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/wishes/:id', async (req) => {
    const w = ownWish(Number(req.params.id), me(req).id)
    const b = req.body || {}
    db.prepare('UPDATE video_wishes SET title = ?, video_url = ?, description = ?, updated_at = ? WHERE id = ?').run(
      b.title !== undefined ? String(b.title).trim() || w.title : w.title,
      b.videoUrl !== undefined ? String(b.videoUrl).trim() : w.video_url,
      b.description !== undefined ? String(b.description) : w.description,
      nowIso(),
      w.id as number
    )
    const updated = ownWish(w.id as number, me(req).id)
    void rematchWish(w.id as number, me(req).id).catch(() => {}) // 编辑后重匹配
    return updated
  })

  app.delete<{ Params: { id: string } }>('/api/wishes/:id', async (req) => {
    const w = ownWish(Number(req.params.id), me(req).id)
    db.prepare('DELETE FROM wish_matches WHERE wish_id = ?').run(w.id as number)
    db.prepare('DELETE FROM video_wishes WHERE id = ?').run(w.id as number)
    return { ok: true }
  })

  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>('/api/wishes/:id/attach', async (req) => {
    const w = ownWish(Number(req.params.id), me(req).id)
    const studioId = Number(req.body?.studioId)
    ownStudio(studioId, me(req).id)
    db.prepare('UPDATE video_wishes SET adopted_studio_id = ?, updated_at = ? WHERE id = ?').run(studioId, nowIso(), w.id as number)
    return ownWish(w.id as number, me(req).id)
  })

  app.post<{ Params: { id: string } }>('/api/wishes/:id/detach', async (req) => {
    const w = ownWish(Number(req.params.id), me(req).id)
    db.prepare('UPDATE video_wishes SET adopted_studio_id = NULL, updated_at = ? WHERE id = ?').run(nowIso(), w.id as number)
    return ownWish(w.id as number, me(req).id)
  })

  const studioDoc = (s: Record<string, unknown>) => {
    let text = `${s.brief} ${s.synopsis}`
    try {
      for (const c of JSON.parse(String(s.characters || '[]')) as { name: string; desc: string }[]) text += ` ${c.name} ${c.desc}`
    } catch {}
    try {
      for (const sc of JSON.parse(String(s.scenes || '[]')) as { name: string; desc: string }[]) text += ` ${sc.name} ${sc.desc}`
    } catch {}
    try {
      for (const t of JSON.parse(String(s.tools || '[]')) as { name: string }[]) text += ` ${t.name}`
    } catch {}
    return text
  }


  // wish ↔ studio 混合匹配（沿用需求商单 v1.1 规格：kw + 语义 + 融合 + 阈值落库）
  const rematchWish = async (wishId: number, userId: number): Promise<{ saved: number; badge: string }> => {
    const w = ownWish(wishId, userId)
    const studios = db
      .prepare('SELECT id, title, brief, synopsis, characters, scenes, tools, chosen_tool FROM studio_projects WHERE user_id = ?')
      .all(userId) as unknown as Record<string, unknown>[]
    if (studios.length === 0) {
      db.prepare('DELETE FROM wish_matches WHERE wish_id = ?').run(wishId)
      return { saved: 0, badge: 'none' }
    }
    const docA = `${w.title} ${w.features} ${w.art_style} ${w.description}`
    const kwRows = studios.map((s) => {
      const hit = kwScore(docA, studioDoc(s))
      return { studio_id: s.id as number, kw_score: hit.kwScore, hit_terms: hit.hitTerms.join(',') }
    })
    const candidates = studios.length <= 12
      ? kwRows
      : kwRows.filter((r) => r.kw_score > 0).sort((a, b) => b.kw_score - a.kw_score).slice(0, 12)
    const candidateStudios = candidates
      .map((c) => studios.find((s) => s.id === c.studio_id))
      .filter((s): s is Record<string, unknown> => Boolean(s))

    let badge = 'no_ai'
    let raw = ''
    const aiMap = new Map<number, { score: number; reasons: string }>()
    const cfg = resolveAiConfig(db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId) as Any)
    if (cfg && candidateStudios.length) {
      const system = [
        '你是视频制作方案匹配评分引擎。对「心仪视频作品(目标风格)」与每一个「候选制作方案(供给)」逐一评分。',
        '每个候选必须恰好输出一条，不许省略、不许新增候选。',
        '只输出 JSON 数组，格式：',
        '[{"studio_id":number,"score":0到100整数,"reasons":"不超过40字中文，须点明命中点或不命中原因"}]',
        '评分维度：题材与剧情相似40 + 艺术风格与视觉语言相似40 + 推荐工具能力覆盖20。',
        '低相关也要给出分数与理由，禁止省略。',
        '不要输出 JSON 以外的任何文字。',
      ].join('\n')
      const userPrompt = `心仪作品：${JSON.stringify({ title: String(w.title), features: String(w.features), art_style: String(w.art_style), description: String(w.description) })}\n候选制作方案：${JSON.stringify(
        candidateStudios.map((s) => {
          let chars: unknown[] = []
          let scns: unknown[] = []
          let tls: string[] = []
          try { chars = JSON.parse(String(s.characters || '[]')) } catch {}
          try { scns = JSON.parse(String(s.scenes || '[]')) } catch {}
          try { tls = (JSON.parse(String(s.tools || '[]')) as { name: string }[]).map((t) => t.name) } catch {}
          return { id: s.id, brief: String(s.brief), synopsis: String(s.synopsis), characters: chars, scenes: scns, tools: tls }
        })
      )}`
      try {
        raw = await chatCompletion(cfg, [
          { role: 'system', content: system },
          { role: 'user', content: userPrompt },
        ])
        const { ok, items } = parseAiArray(raw, 'studio_id')
        if (ok) {
          for (const x of items) {
            const sid = Number(x.studio_id)
            if (!candidateStudios.some((s) => s.id === sid)) continue
            aiMap.set(sid, {
              score: Math.max(0, Math.min(100, Math.round(Number(x.score) || 0))),
              reasons: String(x.reasons || '').slice(0, 40),
            })
          }
          badge = 'kw+ai'
        } else {
          badge = 'parse_failed'
        }
      } catch {
        badge = 'ai_failed'
      }
    }

    const toSave: { studio_id: number; score: number; kw_score: number; ai_score: number; hit_terms: string; reasons: string }[] = []
    for (const c of candidates) {
      const ai = aiMap.get(c.studio_id)
      const aiScore = ai ? ai.score : -1
      const score = fuseScore(c.kw_score, aiScore)
      if (score >= MATCH_SAVE_THRESHOLD) {
        toSave.push({ studio_id: c.studio_id, score, kw_score: c.kw_score, ai_score: aiScore, hit_terms: c.hit_terms, reasons: ai?.reasons || '' })
      }
    }
    db.transaction(() => {
      db.prepare('DELETE FROM wish_matches WHERE wish_id = ?').run(wishId)
      const ins = db.prepare('INSERT INTO wish_matches (wish_id, studio_id, score, kw_score, ai_score, hit_terms, reasons) VALUES (?, ?, ?, ?, ?, ?, ?)')
      for (const r of toSave) ins.run(wishId, r.studio_id, r.score, r.kw_score, r.ai_score, r.hit_terms, r.reasons)
    })()
    return { saved: toSave.length, badge }
  }

  // 制作方案编辑/选工具 → 反向重匹配全部 wishes
  const reverseMatchWishesForStudio = async (studioId: number, userId: number): Promise<{ saved: number }> => {
    const s = ownStudio(studioId, userId)
    const wishes = db.prepare('SELECT id, title, features, art_style, description FROM video_wishes WHERE user_id = ?').all(userId) as unknown as Record<string, unknown>[]
    if (wishes.length === 0) return { saved: 0 }
    const docB = studioDoc(s)
    const kwRows = wishes.map((w) => {
      const docA = `${w.title} ${w.features} ${w.art_style} ${w.description}`
      const hit = kwScore(docA, docB)
      return { wish_id: w.id as number, kw_score: hit.kwScore, hit_terms: hit.hitTerms.join(',') }
    })
    let saved = 0
    const aiMap = new Map<number, { score: number; reasons: string }>()
    const candidates = wishes.length <= 12
      ? kwRows
      : kwRows.filter((r) => r.kw_score > 0).sort((a, b) => b.kw_score - a.kw_score).slice(0, 12)
    const cfg = resolveAiConfig(db.prepare('SELECT * FROM user_settings WHERE user_id = ?').get(userId) as Any)
    if (cfg && candidates.length) {
      const candidateWishes = candidates.map((c) => wishes.find((w) => w.id === c.wish_id)!).filter(Boolean)
      const system = [
        '你是视频制作方案匹配评分引擎。对「制作方案(供给)」与每一个「心仪视频作品(目标风格)」逐一评分。',
        '每个候选必须恰好输出一条，不许省略、不许新增候选。',
        '只输出 JSON 数组，格式：',
        '[{"wish_id":number,"score":0到100整数,"reasons":"不超过40字中文，须点明命中点或不命中原因"}]',
        '评分维度：题材与剧情相似40 + 艺术风格与视觉语言相似40 + 推荐工具能力覆盖20。',
        '低相关也要给出分数与理由，禁止省略。',
        '不要输出 JSON 以外的任何文字。',
      ].join('\n')
      const userPrompt = `制作方案：${JSON.stringify({ id: s.id, brief: String(s.brief), synopsis: String(s.synopsis), chosen_tool: String(s.chosen_tool || '') })}\n候选心仪作品：${JSON.stringify(
        candidateWishes.map((w) => ({ id: w.id, title: String(w.title), features: String(w.features), art_style: String(w.art_style), description: String(w.description) }))
      )}`
      try {
        const raw = await chatCompletion(cfg, [
          { role: 'system', content: system },
          { role: 'user', content: userPrompt },
        ])
        const { ok, items } = parseAiArray(raw, 'wish_id')
        if (ok) {
          for (const x of items) {
            const wid = Number(x.wish_id)
            if (!candidateWishes.some((w) => w.id === wid)) continue
            aiMap.set(wid, {
              score: Math.max(0, Math.min(100, Math.round(Number(x.score) || 0))),
              reasons: String(x.reasons || '').slice(0, 40),
            })
          }
        }
      } catch {
        // AI 不可用时继续按关键词重匹配。
      }
    }
    db.transaction(() => {
      db.prepare('DELETE FROM wish_matches WHERE studio_id = ? AND wish_id IN (SELECT id FROM video_wishes WHERE user_id = ?)').run(s.id, userId)
      for (const c of candidates) {
        const ai = aiMap.get(c.wish_id)
        const aiScore = ai ? ai.score : -1
        const score = fuseScore(c.kw_score, aiScore)
        if (score >= MATCH_SAVE_THRESHOLD) {
          db.prepare(
            `INSERT INTO wish_matches (wish_id, studio_id, score, reasons, kw_score, ai_score, hit_terms)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(wish_id, studio_id) DO UPDATE SET score = excluded.score, reasons = excluded.reasons,
             kw_score = excluded.kw_score, ai_score = excluded.ai_score, hit_terms = excluded.hit_terms`
          ).run(c.wish_id, s.id, score, ai?.reasons || '', c.kw_score, aiScore, c.hit_terms)
          saved++
        } else {
          db.prepare('DELETE FROM wish_matches WHERE wish_id = ? AND studio_id = ?').run(c.wish_id, s.id)
        }
      }
    })()
    return { saved }
  }

  app.post<{ Params: { id: string } }>('/api/wishes/:id/rematch', async (req) => {
    return rematchWish(Number(req.params.id), me(req).id)
  })

  app.post('/api/wishes/rematch-all', async (req) => {
    const wishes = db.prepare('SELECT id FROM video_wishes WHERE user_id = ? ORDER BY id DESC').all(me(req).id) as unknown as { id: number }[]
    let saved = 0
    for (const w of wishes) {
      try {
        const r = await rematchWish(w.id, me(req).id)
        saved += r.saved
      } catch {
        // 单条失败不阻塞全局
      }
    }
    return { ok: true, count: wishes.length, saved }
  })

  // ---------- Phase A：评分历史 / AI 原始记录 / 标签统计 ----------
  app.get<{ Params: { id: string }; Querystring:Any }>('/api/ideas/:id/scores', async (req) => {
    const idea = ownIdea(Number(req.params.id), me(req).id)
    const p=featurePagination(req.query);return scoreHistory(idea,p.page,p.pageSize)
  })

  app.get<{ Params: { id: string } }>('/api/ideas/:id/raw-logs', async (req) => {
    const idea = ownIdea(Number(req.params.id), me(req).id)
    return redactAiLogs(safeSynthesisLogs(db.prepare('SELECT * FROM ai_raw_logs WHERE idea_id = ? ORDER BY id DESC LIMIT 50').all(idea.id), me(req).id), me(req).id, req.headers.cookie)
  })

  app.get('/api/ideas-tags', async (req) => {
    const rows = db.prepare("SELECT tags FROM ideas WHERE user_id = ? AND tags != ''").all(me(req).id) as unknown as { tags: string }[]
    const counts = new Map<string, number>()
    for (const r of rows) {
      for (const t of r.tags.split(',').map((x) => x.trim()).filter(Boolean)) {
        counts.set(t, (counts.get(t) || 0) + 1)
      }
    }
    return [...counts.entries()].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
  })

  app.setErrorHandler((err: any, req, reply) => {
    if (Number.isFinite(err.retryAfter)) reply.header('Retry-After', Math.max(1, Math.ceil(err.retryAfter)))
    const statusCode = err.statusCode || 500
    const fallback = statusCode === 401 ? 'unauthorized' : statusCode === 403 ? 'forbidden' : statusCode === 404 ? 'not_found'
      : statusCode === 409 ? 'conflict' : statusCode === 429 ? 'rate_limited' : statusCode >= 500 ? 'server_error' : 'invalid_body'
    const code = typeof err.code === 'string' && Object.hasOwn(ERROR_MESSAGES, err.code) ? err.code : fallback
    const message = statusCode < 500 && code === err.code ? err.message : ERROR_MESSAGES[code][0]
    if (['/api/auth/register', '/api/auth/register/send-code'].includes(req.url.split('?')[0])) {
      const safeStatus = [400, 403, 404, 409, 429, 503].includes(statusCode) ? statusCode : 500
      return reply.code(safeStatus).send({ error: { message: safeStatus === 500 ? '注册操作失败，请稍后重试' : message,
        code: safeStatus === 500 ? 'registration_failed' : code } })
    }
    if (req.url.split('?')[0].startsWith('/api/admin/')) {
      const safeStatus = [400, 401, 403, 404, 409, 413, 429].includes(statusCode) ? statusCode : 500
      return reply.code(safeStatus).send({ error: {
        message: safeStatus === 500 ? '管理操作失败，请稍后重试' : message,
        code: safeStatus === 500 ? 'admin_operation_failed' : code,
      } })
    }
    if (statusCode >= 500) console.error('[api]', statusCode, code)
    reply.code(statusCode).send({ error: { message, code, ...(code === 'feedback_duplicate' && Number.isSafeInteger(err.feedback_id) ? { feedback_id: err.feedback_id } : {}) } })
  })

  // 生产模式：托管前端构建产物
  const distDir = options.distDir || path.join(process.cwd(), 'dist')
  if (existsSync(distDir)) {
    await app.register(fstatic, { root: distDir })
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api')) return reply.code(404).send({ error: { message: '接口不存在', code: 'not_found' } })
      return reply.sendFile(options.indexFile || 'index.html')
    })
  } else {
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: { message: '接口不存在', code: 'not_found' } }))
  }

  return app
}
