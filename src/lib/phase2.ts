// SPDX-License-Identifier: MPL-2.0
import { STANDARD_VERSION } from '../../shared/scoring-standard'
import { safeActionUrl } from '../../shared/links'
import { tr } from '../i18n/index'
import type { ScoreRecord } from '../types'

export const SCORE_DIMENSIONS = ['问题价值', '解决方案质量', '差异化', '可行性'] as const
export const dimensionLabel = (name: string) => [...SCORE_DIMENSIONS, '新颖度', '潜在价值', '资源匹配度', '合规与版权'].includes(name) ? tr(name) : name
export const SCORE_ANGLES = { default: '标准角度', strict: '更严格', encourage: '更鼓励', compliance: '合规与版权' }
export const ONLINE_NOTE = '最近约 75 秒在此频道活动的已登录账号，多标签只算 1 人。进程重启、多实例、断网及后台标签页会影响准确性。'

export function externalHttps(value: unknown): string | null {
  const safe = safeActionUrl(value)
  return safe?.startsWith('https://') ? safe : null
}

export function comparableScores(a: ScoreRecord, b: ScoreRecord): boolean {
  const fields=['standard_version','engine_hash','prompt_hash','schema_version','input_policy_version','comparison_group','input_scope','angle','precision_version','model_fingerprint'] as const
  return a.standard_version===STANDARD_VERSION&&b.standard_version===a.standard_version&&a.validity==='valid'&&b.validity==='valid'&&fields.every(key=>typeof a[key]==='string'&&!!a[key]&&a[key]===b[key])
}

export function dimensionChange(a: ScoreRecord, b: ScoreRecord, name: string): number | null {
  const old = a.dimensions.find((d) => d.name === name), next = b.dimensions.find((d) => d.name === name)
  return comparableScores(a, b) && old && next ? next.score - old.score : null
}
