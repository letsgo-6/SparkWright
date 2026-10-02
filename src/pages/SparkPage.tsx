// SPDX-License-Identifier: MPL-2.0
import { useCallback, useEffect, useRef, useState } from 'react'
import { SparkScene } from '../components/SparkScene'
import type { SparkPhase } from '../lib/spark-scene'
import { tr, useLanguage } from '../i18n/index'

const HOLD_MS = 900

export function SparkPage() {
  useLanguage()
  const [phase, setPhase] = useState<SparkPhase>('meditating')
  const [holding, setHolding] = useState(false)
  const [ready, setReady] = useState(false)
  const [failure, setFailure] = useState(false)
  const [retry, setRetry] = useState(0)
  const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const [saveData] = useState(() => {
    const connection = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection
    return !!connection?.saveData || /(^|-)2g$/.test(connection?.effectiveType || '')
  })
  const stage = useRef<HTMLElement>(null)
  const progress = useRef<HTMLSpanElement>(null)
  const current = useRef<SparkPhase>('meditating')
  const transitionTimer = useRef<number | undefined>(undefined)
  const holdFrame = useRef<number | undefined>(undefined)
  const holdInput = useRef<'pointer' | 'keyboard' | null>(null)

  const cancelHold = useCallback(() => {
    if (holdFrame.current !== undefined) cancelAnimationFrame(holdFrame.current)
    holdFrame.current = undefined; holdInput.current = null
    if (progress.current) progress.current.style.transform = 'scaleX(0)'
    setHolding(false)
  }, [])

  const switchMode = useCallback((next: 'meditating' | 'brainstorming') => {
    if (document.hidden || current.current === 'entering' || current.current === 'exiting') return
    current.current = next === 'brainstorming' ? 'entering' : 'exiting'
    setPhase(current.current)
    transitionTimer.current = window.setTimeout(() => { current.current = next; setPhase(next); transitionTimer.current = undefined }, reduced ? 160 : 800)
  }, [reduced])

  const startHold = (input: 'pointer' | 'keyboard') => {
    if (current.current !== 'brainstorming' || holdInput.current || document.hidden) return
    holdInput.current = input; setHolding(true)
    const started = performance.now()
    const tick = (now: number) => {
      const fraction = Math.min(1, (now - started) / HOLD_MS)
      if (progress.current) progress.current.style.transform = `scaleX(${fraction})`
      if (fraction >= 1) { cancelHold(); switchMode('meditating') }
      else holdFrame.current = requestAnimationFrame(tick)
    }
    holdFrame.current = requestAnimationFrame(tick)
  }

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)')
    const change = () => setReduced(query.matches)
    query.addEventListener('change', change)
    const visibility = () => { if (document.hidden) cancelHold() }
    const releasePointer = () => { if (holdInput.current === 'pointer') cancelHold() }
    const releaseKey = (event: KeyboardEvent) => { if (holdInput.current === 'keyboard' && (event.key === ' ' || event.key === 'Enter')) cancelHold() }
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('blur', cancelHold)
    window.addEventListener('pointerup', releasePointer)
    window.addEventListener('pointercancel', releasePointer)
    window.addEventListener('touchcancel', releasePointer)
    window.addEventListener('keyup', releaseKey)
    return () => {
      clearTimeout(transitionTimer.current); cancelHold()
      query.removeEventListener('change', change)
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('blur', cancelHold)
      window.removeEventListener('pointerup', releasePointer)
      window.removeEventListener('pointercancel', releasePointer)
      window.removeEventListener('touchcancel', releasePointer)
      window.removeEventListener('keyup', releaseKey)
    }
  }, [cancelHold])

  useEffect(() => {
    const page = stage.current
    if (!page) return
    const main = page.parentElement!
    const measure = () => {
      const top = page.getBoundingClientRect().top + (window.innerWidth <= 640 ? window.scrollY : main.scrollTop)
      const height = window.visualViewport?.height || window.innerHeight
      page.style.setProperty('--spark-height', `${Math.max(height < 500 ? 320 : 440, height - top)}px`)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(main)
    const sidebar = document.querySelector('.sidebar'), topbar = main.querySelector('.sw-topbar')
    if (sidebar) observer.observe(sidebar)
    if (topbar) observer.observe(topbar)
    measure()
    window.addEventListener('resize', measure); window.visualViewport?.addEventListener('resize', measure)
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); window.visualViewport?.removeEventListener('resize', measure) }
  }, [])

  const sceneReady = useCallback(() => { setReady(true); setFailure(false) }, [])
  const sceneFailed = useCallback(() => { setReady(false); setFailure(true) }, [])
  const transitioning = phase === 'entering' || phase === 'exiting'
  const expanded = phase === 'entering' || phase === 'brainstorming'

  return (
    <section ref={stage} className={`spark-page${reduced ? ' spark-reduced' : ''}`} data-state={phase} data-renderer={failure ? 'fallback' : ready ? 'webgl' : 'loading'} aria-label={tr('灵感酱')}>
      <div className="spark-aura" aria-hidden="true" />
      {!failure && <SparkScene phase={phase} reduced={reduced} saveData={saveData} retry={retry} onReady={sceneReady} onError={sceneFailed} />}
      {!ready && <img className="spark-fallback" src="/spark/reference.png" alt="" aria-hidden="true" />}
      <header className="spark-heading">
        <p className="spark-eyebrow">SPARKWRIGHT / SPARK</p>
        <h1>{tr('灵感酱')}</h1><p>{tr(expanded ? '头脑风暴' : '冥想')}</p>
      </header>
      <div className="spark-controls">
        <p className="spark-hint">{tr(expanded ? '让念头自由碰撞。' : '安静片刻，给灵感留一点空间。')}</p>
        {phase === 'meditating' || phase === 'entering' ? (
          <button type="button" className="spark-button" disabled={transitioning} onClick={() => switchMode('brainstorming')}>
            <span aria-hidden="true">✦</span> {tr(transitioning ? '正在进入头脑风暴…' : '进入头脑风暴')}
          </button>
        ) : (
          <button type="button" className={`spark-button spark-hold${holding ? ' spark-holding' : ''}`} disabled={transitioning}
            aria-label={tr('长按回到冥想')} aria-describedby="spark-hold-hint"
            onPointerDown={(event) => { if (event.button === 0) { event.currentTarget.focus({ preventScroll: true }); startHold('pointer') } }}
            onPointerUp={cancelHold} onPointerLeave={cancelHold} onPointerCancel={cancelHold} onBlur={cancelHold}
            onContextMenu={(event) => event.preventDefault()} onClick={(event) => event.preventDefault()}
            onKeyDown={(event) => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); if (!event.repeat) startHold('keyboard') } }}
            onKeyUp={(event) => { if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); cancelHold() } }}>
            <span ref={progress} className="spark-hold-progress" aria-hidden="true" /><span className="spark-button-label">{tr(transitioning ? '正在回到冥想…' : '长按回到冥想')}</span>
          </button>
        )}
        <p id="spark-hold-hint" className="spark-key-hint">{expanded && !transitioning ? tr('按住约 0.9 秒；也可按住空格或 Enter。') : tr('从一次深呼吸开始。')}</p>
        <div className="spark-status" role="status" aria-live="polite">
          {failure ? <><span>{tr('3D 场景暂不可用，已保留静态画面和操作。')}</span><button type="button" className="spark-retry" onClick={() => { setFailure(false); setRetry((value) => value + 1) }}>{tr('重试')}</button></>
            : !ready ? tr('正在加载星空浮岛…') : tr(reduced ? '已减少动态效果。' : '拖动空白处，轻轻转动视角。')}
        </div>
      </div>
    </section>
  )
}
