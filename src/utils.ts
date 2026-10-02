// SPDX-License-Identifier: MPL-2.0
import { locale, tr, getLanguage, type Language } from './i18n/index'
import type { IdeaStatus } from './types'

export const STATUS_META: Record<IdeaStatus, { label: string; cls: string }> = {
  incubating: { label: '孵化中', cls: 'st-incubating' },
  in_progress: { label: '进行中', cls: 'st-inprogress' },
  done: { label: '已实现', cls: 'st-done' },
  shelved: { label: '搁置', cls: 'st-shelved' },
}

function parseDate(s: string): Date | null {
  if (!s) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(`${s}T23:59:59`)
  return new Date(s.includes('T') ? s : `${s.replace(' ', 'T')}Z`)
}

export interface DeadlineInfo {
  label: string
  cls: 'dl-ok' | 'dl-soon' | 'dl-overdue'
}

export function deadlineInfo(deadline: string | null | undefined, now = new Date(), language: Language = getLanguage()): DeadlineInfo | null {
  const d = parseDate(deadline || '')
  if (!d || Number.isNaN(d.getTime())) return null
  const days = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    - new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) / 86400000)
  if (days < 0) return { label: tr('已逾期 {0} 天', [-days], language), cls: 'dl-overdue' }
  if (days === 0) return { label: tr('今天到期', [], language), cls: 'dl-soon' }
  if (days <= 7) return { label: tr('还有 {0} 天', [days], language), cls: 'dl-soon' }
  return { label: tr('还有 {0} 天', [days], language), cls: 'dl-ok' }
}

export function fmtDate(iso: string | null | undefined): string {
  const d = parseDate(iso || '')
  if (!d || Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(locale(), { month: 'short', day: 'numeric' })
}

export function fmtTime(iso: string): string {
  const d = parseDate(iso)
  if (!d || Number.isNaN(d.getTime())) return ''
  return d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })
}
