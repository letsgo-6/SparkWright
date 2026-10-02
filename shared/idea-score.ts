// SPDX-License-Identifier: MPL-2.0
import { STANDARD_VERSION,PRECISION_VERSION } from './scoring-standard'
export const IDEA_SCORE_VERSION = STANDARD_VERSION
export const IDEA_PRECISION_VERSION = PRECISION_VERSION

export function scoreMilli(value: { score?: unknown; score_milli?: unknown; standard_version?: unknown }): number | null {
  const milli = value.score_milli
  if(value.standard_version===IDEA_SCORE_VERSION&&(!Number.isSafeInteger(milli)||(milli as number)%100!==0))return null
  if(value.standard_version==='sparkwright-idea-v4.1.0'&&(!Number.isSafeInteger(milli)||(milli as number)%100!==0))return null
  if(value.standard_version==='sparkwright-idea-v4.0.0'&&(!Number.isSafeInteger(milli)||(milli as number)%250!==0))return null
  if (Number.isSafeInteger(milli) && (milli as number) >= 0 && (milli as number) <= 100000) return milli as number
  if(value.standard_version===IDEA_SCORE_VERSION)return null
  return typeof value.score === 'number' && Number.isFinite(value.score) && value.score >= 0 && value.score <= 100
    ? Math.round(value.score * 1000) : null
}

export function formatIdeaScore(value: number | null | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) : '—'
}

export function serializeIdeaScore<T extends { score?: unknown; score_milli?: unknown; standard_version?: unknown }>(row: T) {
  const milli = scoreMilli(row)
  return { ...row, score: milli === null ? null : milli / 1000, score_milli: milli,
    score_display: milli === null ? '—' : (milli / 1000).toFixed(1) }
}
