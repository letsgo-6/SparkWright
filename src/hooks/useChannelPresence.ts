// SPDX-License-Identifier: MPL-2.0
import { useEffect, useState } from 'react'
import { api } from '../api'

export function useChannelPresence(channelId: number | undefined, enabled = true) {
  const [count, setCount] = useState<number | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    setCount(null); setError('')
    if (!channelId || !enabled) return
    let stopped = false
    let controller: AbortController | null = null
    let timer: ReturnType<typeof setInterval> | undefined
    const leave = () => {
      controller?.abort()
      void fetch(`/api/channels/${channelId}/presence`, { method: 'DELETE', keepalive: true }).catch(() => {})
    }
    const heartbeat = async () => {
      if (stopped || document.hidden || (controller && !controller.signal.aborted)) return
      const request = new AbortController(); controller = request
      try {
        const result = await api.post(`/api/channels/${channelId}/presence`, undefined, request.signal)
        if (!stopped && !request.signal.aborted) { setCount(result.online_count); setError('') }
      } catch (err) {
        if (!stopped && !request.signal.aborted) { setCount(null); setError(err instanceof Error ? err.message : '在线人数读取失败') }
      } finally { if (controller === request) controller = null }
    }
    const visible = () => {
      if (timer) clearInterval(timer)
      if (document.hidden) { leave(); setCount(null) }
      else { void heartbeat(); timer = setInterval(() => void heartbeat(), 25000) }
    }
    visible()
    document.addEventListener('visibilitychange', visible)
    window.addEventListener('pagehide', leave)
    return () => { stopped = true; if (timer) clearInterval(timer); leave(); document.removeEventListener('visibilitychange', visible); window.removeEventListener('pagehide', leave) }
  }, [channelId, enabled])
  return { count, error }
}
