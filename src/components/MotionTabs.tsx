// SPDX-License-Identifier: MPL-2.0
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react'

export function MotionTabs<T extends string>({ value, items, onChange, label, panelId, vertical = false }: {
  value: T; items: { value: T; label: string; disabled?: boolean }[]; onChange: (value: T) => void; label: string; panelId: string; vertical?: boolean
}) {
  const id = useId()
  const root = useRef<HTMLDivElement>(null)
  const indicator = useRef<HTMLSpanElement>(null)
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width:640px)').matches)
  useEffect(() => { const media = window.matchMedia('(max-width:640px)'); const resize = () => setNarrow(media.matches); media.addEventListener('change', resize); return () => media.removeEventListener('change', resize) }, [])
  useLayoutEffect(() => {
    const measure = () => {
      const selected = root.current?.querySelector<HTMLElement>('[aria-selected="true"]')
      if (!selected || !indicator.current) return
      indicator.current.style.transform = `translate(${selected.offsetLeft}px, ${selected.offsetTop}px) scale(${selected.offsetWidth / 100}, ${selected.offsetHeight / 44})`
    }
    measure()
    const observer = new ResizeObserver(measure)
    if (root.current) { observer.observe(root.current); root.current.querySelectorAll('button').forEach(button => observer.observe(button)) }
    let active = true
    void document.fonts.ready.then(() => { if (active) measure() })
    return () => { active = false; observer.disconnect() }
  }, [value, items, vertical])
  const key = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const direction = ['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : ['ArrowLeft', 'ArrowUp'].includes(event.key) ? -1 : 0
    if (!direction && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    const enabled = items.map((item, i) => item.disabled ? -1 : i).filter(i => i >= 0)
    const next = event.key === 'Home' ? enabled[0] : event.key === 'End' ? enabled.at(-1)! : enabled[(enabled.indexOf(index) + direction + enabled.length) % enabled.length]
    if (next === undefined) return
    onChange(items[next].value)
    root.current?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus()
  }
  return <div ref={root} className={`motion-tabs ${vertical ? 'motion-tabs-vertical' : ''}`} role="tablist" aria-label={label} aria-orientation={vertical && !narrow ? 'vertical' : 'horizontal'}>
    <span ref={indicator} className="motion-tabs-indicator" aria-hidden="true" />
    {items.map((item, i) => <button key={item.value} id={`${id}-${item.value}`} type="button" role="tab" aria-controls={panelId} aria-selected={value === item.value} tabIndex={value === item.value ? 0 : -1} disabled={item.disabled} onKeyDown={event => key(event, i)} onClick={() => onChange(item.value)}>{item.label}</button>)}
  </div>
}
