// SPDX-License-Identifier: MPL-2.0
import { tr } from '../i18n/index'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import { Phase2Dialog } from './Phase2Dialog'

export function SynthesisSource({ ids }: { ids: string }) {
  const [open, setOpen] = useState(false)
  useEffect(() => setOpen(false), [ids])
  return <><button className="link-btn" onClick={() => setOpen(true)}>{tr('查看合成来源')}</button>{open && <Phase2Dialog variant="drawer" title={tr('合成来源')} onClose={() => setOpen(false)}><SourceDetails ids={ids}/></Phase2Dialog>}</>
}
function SourceDetails({ ids }: { ids: string }) {
  const [parents, setParents] = useState<({ title: string; url: string } | null)[]>([])
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const visible = () => { if (!document.hidden) setRevision((v) => v + 1) }
    document.addEventListener('visibilitychange', visible)
    return () => document.removeEventListener('visibilitychange', visible)
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    setParents([])
    const parentIds = JSON.parse(ids) as (number | null)[]
    void Promise.all(parentIds.slice(0, 2).map(async (id) => {
      if (!id) return null
      try {
        const own = await api.get(`/api/ideas/${id}`, controller.signal)
        return { title: own.idea.title as string, url: `/ideas/${id}` }
      } catch {
        if (controller.signal.aborted) return null
        try { const pub = await api.get(`/api/plaza/${id}`, controller.signal); return { title: pub.idea.title as string, url: `/plaza/${id}` } }
        catch { return null }
      }
    })).then((result) => { if (!controller.signal.aborted) setParents(result) })
    return () => controller.abort()
  }, [ids, revision])
  return <p className="synthesis-lineage small">{tr("合成来源 A + B：")}{!parents.length ? tr("正在确认来源…") : parents.map((parent, index) => <span key={index}>{index ? ' + ' : ''}{parent ? <Link className="link" to={parent.url}>{parent.title}</Link> : tr("来源已不可访问")}</span>)}</p>
}
