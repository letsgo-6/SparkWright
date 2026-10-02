// SPDX-License-Identifier: MPL-2.0
import { useEffect, useRef } from 'react'
import type { SparkPhase, SparkSceneHandle } from '../lib/spark-scene'

export function SparkScene({ phase, reduced, saveData, retry, onReady, onError }: {
  phase: SparkPhase; reduced: boolean; saveData: boolean; retry: number; onReady: () => void; onError: () => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const scene = useRef<SparkSceneHandle | null>(null)
  const latest = useRef({ phase, reduced, onReady, onError })
  latest.current = { phase, reduced, onReady, onError }
  useEffect(() => {
    const controller = new AbortController()
    let handle: SparkSceneHandle | undefined
    void import('../lib/spark-scene').then(({ createSparkScene }) => {
      if (controller.signal.aborted || !host.current) throw new DOMException('Cancelled', 'AbortError')
      return createSparkScene(host.current, controller.signal, latest.current.phase, latest.current.reduced, saveData, () => latest.current.onError())
    }).then((result) => {
      handle = result
      if (controller.signal.aborted) { result.dispose(); return }
      scene.current = result
      result.update(latest.current.phase, latest.current.reduced)
      latest.current.onReady()
    }).catch(() => { if (!controller.signal.aborted) latest.current.onError() })
    return () => { controller.abort(); handle?.dispose(); scene.current = null }
  }, [saveData, retry])
  useEffect(() => { scene.current?.update(phase, reduced) }, [phase, reduced])
  return <div ref={host} className="spark-scene" />
}
