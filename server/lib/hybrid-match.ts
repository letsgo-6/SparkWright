// SPDX-License-Identifier: MPL-2.0
// 混合匹配通用库（Phase D §4 重构）：需求商单 / 心仪视频作品 共用
// 确定性关键词通道 + 融合公式 + AI 返回解析守卫。纯函数，可单测。

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'from', 'that', 'this', 'com', 'www', 'http', 'https', 'html'])

export const SYNONYM_GROUPS: string[][] = [
  ['小程序', '微信小程序', '微程序', 'wxapp', 'miniprogram'],
  ['爬虫', '抓取', '采集', '爬取', 'spider', 'crawler', 'scraping'],
  ['可视化', '图表', '大屏', 'echarts', 'dashboard', 'chart'],
  ['商城', '电商', '购物', '下单', 'mall', 'ecommerce', 'shop'],
  ['简历', '履历', 'resume', 'cv'],
  ['思维导图', '脑图', 'xmind', 'mindmap'],
  ['数据库', '数据表', 'sql', 'mysql', 'sqlite'],
  ['公众号', '服务号', '订阅号', 'wechat-official'],
  // Phase D 新增（视频作品风格域）
  ['电影感', '胶片', '颗粒', '质感'],
  ['赛博朋克', '霓虹', 'cyberpunk'],
  ['国风', '古风', '汉服', '中式'],
  ['治愈', '温暖', '暖心'],
  ['抽帧', '定格', '逐格'],
  ['独白', '旁白', '第一人称'],
]

/** 分词：ASCII 词 + 中文整串/二元/三元滑窗，去重 */
export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>()
  const lower = (text || '').toLowerCase()
  for (const w of lower.match(/[a-z0-9#+.]+/g) || []) {
    if (w.length >= 2 && !STOPWORDS.has(w)) tokens.add(w)
  }
  for (const run of lower.match(/[\u4e00-\u9fff]+/g) || []) {
    if (run.length < 2) continue
    if (run.length <= 8) tokens.add(run)
    for (let i = 0; i + 2 <= run.length; i++) tokens.add(run.slice(i, i + 2))
    if (run.length >= 4) {
      for (let i = 0; i + 3 <= run.length; i++) tokens.add(run.slice(i, i + 3))
    }
  }
  return tokens
}

function groupHit(aTokens: Set<string>, bTokens: Set<string>, members: string[]): string | null {
  const hits = (tokens: Set<string>) => members.some((member) =>
    [...tokens].some((token) => token.includes(member.toLowerCase()) || member.toLowerCase().includes(token)))
  return hits(aTokens) && hits(bTokens) ? members[0] : null
}

export interface KwHit {
  kwScore: number
  hitTerms: string[]
}

/** 关键词打分：精确交集 +1 / 同义组 +1.5 / boost 文本（如技术栈）子串 +2；min(100, round(12×Σ)) */
export function kwScore(docA: string, docB: string, boost = ''): KwHit {
  const a = tokenize(docA)
  const b = tokenize(docB)
  let weight = 0
  const hits: string[] = []
  for (const t of a) {
    if (b.has(t)) {
      weight += 1
      hits.push(t)
    }
  }
  for (const group of SYNONYM_GROUPS) {
    const rep = groupHit(a, b, group)
    if (rep) {
      weight += 1.5
      hits.push(rep)
    }
  }
  const boostL = (boost || '').toLowerCase()
  if (boostL) {
    for (const t of a) {
      if (boostL.includes(t) || t.includes(boostL)) {
        weight += 2
        hits.push(t)
      }
    }
  }
  return { kwScore: Math.min(100, Math.round(12 * weight)), hitTerms: [...new Set(hits)] }
}

export const KW_WEIGHT = 0.45
export const AI_WEIGHT = 0.55

/** 融合：ai 缺失(-1) → kw；否则 0.45kw + 0.55ai */
export function fuse(kw: number, ai: number): number {
  return ai >= 0 ? Math.round(KW_WEIGHT * kw + AI_WEIGHT * ai) : kw
}

/** AI 原文解析守卫：提取首个 [ 到末个 ] 再 JSON.parse */
export function parseAiArray(raw: string, idKey: string): { ok: boolean; items: Record<string, unknown>[] } {
  const s = raw.indexOf('[')
  const e = raw.lastIndexOf(']')
  if (s === -1 || e <= s) return { ok: false, items: [] }
  try {
    const arr = JSON.parse(raw.slice(s, e + 1))
    if (Array.isArray(arr) && arr.every((x) => x && typeof x === 'object' && !Array.isArray(x)
      && Number.isSafeInteger(x[idKey]) && x[idKey] > 0
      && typeof x.score === 'number' && Number.isFinite(x.score) && x.score >= 0 && x.score <= 100
      && (x.reasons === undefined || typeof x.reasons === 'string'))
      && new Set(arr.map((x) => x[idKey])).size === arr.length) {
      return { ok: true, items: arr as Record<string, unknown>[] }
    }
  } catch {
    // 解析失败走 ok:false
  }
  return { ok: false, items: [] }
}
