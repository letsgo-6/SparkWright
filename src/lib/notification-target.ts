// SPDX-License-Identifier: MPL-2.0
import type { NotifItem } from '../types'

export function notificationTarget(item: Pick<NotifItem, 'type' | 'ref_id'>): string | null {
  if (!Number.isSafeInteger(item.ref_id) || !item.ref_id || item.ref_id < 1) return null
  if (['like', 'comment', 'mention'].includes(item.type)) return `/plaza/${item.ref_id}`
  if (item.type === 'followup') return '/consult'
  if (item.type === 'feedback_new') return `/admin?tab=feedback&feedbackId=${item.ref_id}`
  if (['feedback_reply','feedback_status'].includes(item.type)) return `/feedback/${item.ref_id}`
  return null
}
