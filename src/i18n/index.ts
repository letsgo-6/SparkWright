// SPDX-License-Identifier: MPL-2.0
import { useSyncExternalStore } from 'react'
import { EN, EN_SINGLE } from './en'
import { ERROR_MESSAGES } from '../../shared/error-messages'

export type Language = 'zh-CN' | 'en'
const LANGUAGE_KEY = 'sparkwright.language'
const TOKEN = '\u0001sw:'
const listeners = new Set<() => void>()
export const validLanguage = (value: unknown): value is Language => value === 'zh-CN' || value === 'en'
function lastLanguage(): Language {
  try { const value = localStorage.getItem(LANGUAGE_KEY); return validLanguage(value) ? value : 'zh-CN' } catch { return 'zh-CN' }
}
let language = lastLanguage()
export const getLanguage = () => language
export const locale = () => language === 'en' ? 'en-US' : 'zh-CN'
export function setLanguage(next: Language): void {
  language = next
  try { localStorage.setItem(LANGUAGE_KEY, next) } catch {}
  if (typeof document !== 'undefined') document.documentElement.lang = next
  listeners.forEach((listener) => listener())
}
function subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
export const useLanguage = () => useSyncExternalStore(subscribe, getLanguage, getLanguage)

// Deferred system text stays translatable after a language switch. Parameters are data, never dictionary keys.
export function uiText(source: string, values: unknown[] = []): string { return TOKEN + JSON.stringify([source, values]) }
export function uiParam(source: string): { $ui: string } { return { $ui: source } }
export function tr(source: string | null | undefined, values: unknown[] = [], selected: Language = language): string {
  if (source == null) return ''
  if (source.startsWith(TOKEN)) {
    const [key, parameters] = JSON.parse(source.slice(TOKEN.length)) as [string, unknown[]]
    return tr(key, parameters, selected)
  }
  const error = source.startsWith('error.') && Object.hasOwn(ERROR_MESSAGES, source.slice(6)) ? ERROR_MESSAGES[source.slice(6)] : undefined
  const key = source.trim()
  const translated = error ? error[selected === 'en' ? 1 : 0] : selected === 'en'
    ? (values[0] === 1 && Object.hasOwn(EN_SINGLE, key) ? EN_SINGLE[key] : undefined) ?? (Object.hasOwn(EN, key) ? EN[key] : source) : source
  return translated.replace(/\{(\d+)\}/g, (placeholder, index: string) => {
    const value = values[Number(index)]
    if (value === undefined) return placeholder
    if (typeof value === 'number') return value.toLocaleString(selected === 'en' ? 'en-US' : 'zh-CN')
    return value && typeof value === 'object' && '$ui' in value ? tr(String(value.$ui), [], selected) : String(value)
  })
}
