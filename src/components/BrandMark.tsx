// SPDX-License-Identifier: MPL-2.0
import { useEffect, useRef, useState } from 'react'

export function BrandMark({ animated = false }: { animated?: boolean }) {
  const video = useRef<HTMLVideoElement>(null)
  const [playing, setPlaying] = useState(false)
  const [opaque, setOpaque] = useState(false)

  useEffect(() => {
    if (!animated || !video.current) return
    const media = video.current
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    let alive = true, sequence = 0, frame: number | undefined
    const sync = () => {
      const version = ++sequence
      if (frame !== undefined) media.cancelVideoFrameCallback(frame)
      frame = undefined
      if (document.hidden || reduced.matches) {
        media.pause()
        setPlaying(false)
        return
      }
      void media.play().then(() => {
        if (!alive || version !== sequence) return
        if (typeof media.requestVideoFrameCallback === 'function') {
          frame = media.requestVideoFrameCallback(() => { if (alive && version === sequence) setPlaying(true) })
        } else setPlaying(true)
      }).catch(() => { if (alive && version === sequence) setPlaying(false) })
    }
    const failed = () => { sequence++; media.pause(); setPlaying(false) }
    document.addEventListener('visibilitychange', sync)
    reduced.addEventListener('change', sync)
    media.addEventListener('error', failed)
    sync()
    return () => {
      alive = false; sequence++
      if (frame !== undefined) media.cancelVideoFrameCallback(frame)
      media.pause()
      document.removeEventListener('visibilitychange', sync)
      reduced.removeEventListener('change', sync)
      media.removeEventListener('error', failed)
    }
  }, [animated])

  return <span className={`brand-mark${playing ? ' brand-playing' : ''}${opaque ? ' brand-opaque' : ''}`} role="img" aria-label="SparkWright">
    <img src="/brand/spark-logo.png" alt="" width="800" height="416" />
    {animated && <video ref={video} muted loop playsInline preload="metadata" aria-hidden="true" tabIndex={-1}
      onLoadedMetadata={() => setOpaque(!!video.current?.currentSrc.endsWith('.mp4'))}>
      <source src="/brand/spark-logo.webm" type="video/webm" />
      <source src="/brand/spark-logo.mp4" type="video/mp4" />
    </video>}
  </span>
}
