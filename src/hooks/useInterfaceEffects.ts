// SPDX-License-Identifier: MPL-2.0
import { useEffect } from 'react'

// Visual feedback only: existing click handlers, keyboard actions and focus stay in control.
export function useInterfaceEffects(theme: string, routeKey: string) {
  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)')
    const finePointer = window.matchMedia('(hover: hover) and (pointer: fine)')
    const ripples = new Map<HTMLElement, number>()
    let card: HTMLElement | null = null, frame: number | undefined, x = 0, y = 0
    const clearCard = () => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = undefined
      if (!card) return
      delete card.dataset.uiSpotlight
      card.style.removeProperty('--mouse-x')
      card.style.removeProperty('--mouse-y')
      card = null
    }
    const clearRipple = (button: HTMLElement) => {
      clearTimeout(ripples.get(button))
      ripples.delete(button)
      delete button.dataset.uiRipple
      for (const name of ['--ui-ripple-x', '--ui-ripple-y', '--ui-ripple-size']) button.style.removeProperty(name)
    }
    const ripple = (event: MouseEvent) => {
      if (reduced.matches || !(event.target instanceof Element)) return
      const button = event.target.closest<HTMLElement>('button.btn-primary, button.btn-ghost, button.auth-tab, button.spark-button:not(.spark-hold)')
      if (!button || button.matches(':disabled, [aria-disabled="true"], .mobile-nav-toggle')) return
      const bounds = button.getBoundingClientRect()
      const left = event.detail ? event.clientX - bounds.left : bounds.width / 2
      const top = event.detail ? event.clientY - bounds.top : bounds.height / 2
      const diameter = 2 * Math.hypot(Math.max(left, bounds.width - left), Math.max(top, bounds.height - top))
      clearRipple(button)
      button.style.setProperty('--ui-ripple-x', `${left}px`)
      button.style.setProperty('--ui-ripple-y', `${top}px`)
      button.style.setProperty('--ui-ripple-size', `${diameter}px`)
      button.dataset.uiRipple = 'ready'
      void button.offsetWidth
      button.dataset.uiRipple = 'active'
      ripples.set(button, window.setTimeout(() => clearRipple(button), 380))
    }
    const move = (event: PointerEvent) => {
      if (theme !== 'starry' || reduced.matches || !finePointer.matches || event.pointerType !== 'mouse' || !(event.target instanceof Element)) return
      const next = event.target.closest<HTMLElement>('.idea-card, .resource-card')
      if (next !== card) { clearCard(); card = next }
      if (!card) return
      x = event.clientX; y = event.clientY
      if (frame !== undefined) return
      frame = requestAnimationFrame(() => {
        frame = undefined
        if (!card) return
        const bounds = card.getBoundingClientRect()
        card.style.setProperty('--mouse-x', `${x - bounds.left}px`)
        card.style.setProperty('--mouse-y', `${y - bounds.top}px`)
        card.dataset.uiSpotlight = 'active'
      })
    }
    const leave = (event: PointerEvent) => {
      if (card && (!(event.relatedTarget instanceof Node) || !card.contains(event.relatedTarget))) clearCard()
    }
    const clear = () => { clearCard(); for (const button of ripples.keys()) clearRipple(button) }
    const visibility = () => { if (document.hidden) clear() }
    document.addEventListener('click', ripple, { capture: true, passive: true })
    document.addEventListener('pointermove', move, { passive: true })
    document.addEventListener('pointerout', leave, { passive: true })
    document.addEventListener('visibilitychange', visibility)
    reduced.addEventListener('change', clear)
    finePointer.addEventListener('change', clear)
    return () => {
      clear()
      document.removeEventListener('click', ripple, true)
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerout', leave)
      document.removeEventListener('visibilitychange', visibility)
      reduced.removeEventListener('change', clear)
      finePointer.removeEventListener('change', clear)
    }
  }, [theme, routeKey])
}
