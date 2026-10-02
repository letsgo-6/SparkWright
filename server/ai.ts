// SPDX-License-Identifier: MPL-2.0
// AI 网关：用户自配 Key 优先，否则回落到服务器环境变量配置的平台默认模型。
// 兼容所有 OpenAI /chat/completions 格式的服务（智谱、DeepSeek、Kimi、OpenAI 等）。
import { ERROR_MESSAGES } from '../shared/error-messages'
const aiError = (code: string) => Object.assign(new Error(ERROR_MESSAGES[code][0]), { code, name: code === 'ai_timeout' ? 'TimeoutError' : 'Error' })

export interface AiConfig {
  baseUrl: string
  apiKey: string
  model: string
  source: 'user' | 'platform'
}

const DEFAULT_BASE = 'https://open.bigmodel.cn/api/paas/v4'
const DEFAULT_MODEL = 'glm-4-flash' // 智谱免费模型

export function resolveAiConfig(settings: { base_url?: string; api_key?: string; model?: string } | null | undefined): AiConfig | null {
  if (settings?.api_key) {
    return {
      baseUrl: (settings.base_url || DEFAULT_BASE).replace(/\/+$/, ''),
      apiKey: settings.api_key,
      model: settings.model || DEFAULT_MODEL,
      source: 'user',
    }
  }
  const key = process.env.AI_API_KEY || process.env.ZAI_API_KEY
  if (key) {
    const base = process.env.AI_BASE_URL || (process.env.ZAI_API_KEY && !process.env.AI_API_KEY ? 'https://api.z.ai/api/paas/v4' : DEFAULT_BASE)
    return { baseUrl: base.replace(/\/+$/, ''), apiKey: key, model: process.env.AI_MODEL || 'glm-4.5-flash', source: 'platform' }
  }
  return null
}

export function platformStatus(): { platformConfigured: boolean; platformModel: string | null } {
  const cfg = resolveAiConfig(null)
  return cfg ? { platformConfigured: true, platformModel: cfg.model } : { platformConfigured: false, platformModel: null }
}

export async function chatCompletion(cfg: AiConfig, messages: { role: string; content: string }[], temperature = 0.7): Promise<string> {
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({ model: cfg.model, messages, temperature }),
    signal: AbortSignal.timeout(90000),
  }).catch((error) => { throw aiError(error?.name === 'TimeoutError' ? 'ai_timeout' : 'ai_service_error') })
  if (!res.ok) {
    throw aiError('ai_service_error')
  }
  // 退化路径：上游返回 SSE（如部分中转/代理强制流式）→ 拼接 delta 为全文
  const ct = res.headers.get('content-type') || ''
  if (ct.includes('text/event-stream')) {
    const text = await res.text().catch(() => { throw aiError('ai_incomplete') })
    let full = ''
    let completed = false
    for (const line of text.split('\n')) {
      const l = line.trim()
      if (!l.startsWith('data:')) continue
      const data = l.slice(5).trim()
      if (data === '[DONE]') { completed = true; continue }
      try {
        const j = JSON.parse(data) as { error?: unknown; choices?: { delta?: { content?: string }; finish_reason?: string }[] }
        if (j.error) throw aiError('ai_service_error')
        if (j.choices?.[0]?.finish_reason) completed = true
        const delta = j.choices?.[0]?.delta?.content
        if (delta) full += delta
      } catch (error) { if ((error as { code?: string }).code) throw error }
    }
    if (!completed) throw aiError('ai_incomplete')
    if (!full.trim()) throw aiError('ai_empty_response')
    return full.trim()
  }
  const data: any = await res.json().catch(() => { throw aiError('ai_invalid_response') })
  const content = data?.choices?.[0]?.message?.content
  if (typeof content !== 'string' || !content.trim()) throw aiError('ai_empty_response')
  return content.trim()
}

const STATUS_LABEL: Record<string, string> = {
  incubating: '孵化中',
  in_progress: '进行中',
  done: '已实现',
  shelved: '搁置',
}

export function buildSystemPrompt(idea: { title?: string; content?: string; deadline?: string | null; status?: string }, steps: { title?: string; done?: number }[]): string {
  const lines = [
    `【灵感标题】${idea.title}`,
    idea.content ? `【灵感描述】${idea.content}` : null,
    `【当前状态】${STATUS_LABEL[String(idea.status || 'incubating')] || idea.status}`,
    idea.deadline ? `【目标实现时间】${idea.deadline}` : null,
    steps.length
      ? `【执行计划】\n${steps.map((s, i) => `${i + 1}. [${s.done ? '已完成' : '未完成'}] ${s.title}`).join('\n')}`
      : '【执行计划】尚未制定',
  ].filter(Boolean)
  return [
    '你是「SparkWright」应用里的 AI 创意伙伴，陪伴用户把突发奇想落地成现实。',
    '请用简体中文回答，语气友好、有洞察、接地气。回答保持简洁（默认不超过 250 字），除非用户明确要求展开。',
    '',
    '用户当前的灵感信息：',
    ...lines,
  ].join('\n')
}

// 从 AI 回复中解析综合评分：{"score":0-100,"summary":"...","dimensions":[{"name","score","comment"}]}
export function parseScore(text: string): { score: number; summary: string; dimensions: { name: string; score: number; comment: string }[] } | null {
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try {
    const j = JSON.parse(m[0])
    const score = Math.max(0, Math.min(100, Math.round(Number(j.score))))
    if (Number.isNaN(score)) return null
    const dims = Array.isArray(j.dimensions)
      ? j.dimensions.slice(0, 5).map((d: any) => ({
          name: String(d?.name || '维度').slice(0, 10),
          score: Math.max(0, Math.min(100, Math.round(Number(d?.score) || 0))),
          comment: String(d?.comment || '').slice(0, 60),
        }))
      : []
    return { score, summary: String(j.summary || '').slice(0, 60), dimensions: dims }
  } catch {
    return null
  }
}

// 从 AI 回复中解析计划步骤：优先取 JSON {"steps":[...]}，否则按行提取列表项
export function parsePlan(text: string): string[] {
  const m = text.match(/\{[\s\S]*\}/)
  if (m) {
    try {
      const j = JSON.parse(m[0])
      if (Array.isArray(j.steps)) {
        const steps = j.steps.map((s: unknown) => String(s).trim()).filter(Boolean)
        if (steps.length) return steps.slice(0, 8)
      }
    } catch {
      // 忽略，走行解析
    }
  }
  const lines = text
    .split(/\r?\n/)
    .map((s) => s.replace(/^\s*(?:[-*•]|\d+[.、)])\s*/, '').trim())
    .filter((s) => s && s.length <= 40 && !/^[【\[`#]/.test(s) && !/^(好的|以下是|当然|这是|我)/.test(s))
  return lines.slice(0, 8)
}
