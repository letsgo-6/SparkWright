// SPDX-License-Identifier: MPL-2.0
import { tr } from '../i18n/index'
import { useEffect, useRef, type ReactNode } from 'react'

export function Phase2Dialog({ title, children, onClose, variant = 'dialog' }: { title: string; children: ReactNode; onClose: () => void; variant?: 'dialog' | 'drawer' }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const close = useRef(onClose); close.current = onClose
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    dialog.current?.showModal()
    return () => { dialog.current?.close(); previous?.focus() }
  }, [])
  return <dialog ref={dialog} className={`phase2-dialog ${variant === 'drawer' ? 'phase2-drawer' : ''}`} aria-label={title} onCancel={(event) => { event.preventDefault(); close.current() }}
    onClick={(event) => { if (event.target === event.currentTarget) close.current() }}>
    <div className="panel-head"><h2>{title}</h2><button className="sw-close" aria-label={tr("关闭{0}", [title])} onClick={onClose}>×</button></div>
    {children}
  </dialog>
}
