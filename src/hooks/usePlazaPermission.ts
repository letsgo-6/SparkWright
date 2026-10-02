// SPDX-License-Identifier: MPL-2.0
import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'

export function usePlazaPermission() {
  const [state, setState] = useState<{ plaza_muted_at: string | null; plaza_mute_reason: string | null } | null>(null)
  const [error, setError] = useState('')
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await api.get('/api/moderation/me', signal)
      if (!signal?.aborted) { setState(next); setError('') }
    } catch (err) { if (!signal?.aborted) setError(err instanceof Error ? err.message : '发言权限读取失败') }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    const visible = () => { if (!document.hidden) void refresh(controller.signal) }
    void refresh(controller.signal)
    document.addEventListener('visibilitychange', visible)
    window.addEventListener('focus', visible)
    return () => { controller.abort(); document.removeEventListener('visibilitychange', visible); window.removeEventListener('focus', visible) }
  }, [refresh])
  const denied = useCallback((err: unknown) => {
    if ((err as { code?: string })?.code === 'plaza_muted') {
      setState({ plaza_muted_at: 'denied', plaza_mute_reason: '服务端已拒绝发言，请等待解除禁言。' })
      void refresh()
    }
  }, [refresh])
  return { muted: !!state?.plaza_muted_at, ready: !!state, error,
    reason: state?.plaza_mute_reason, refresh, denied }
}
