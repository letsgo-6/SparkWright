// SPDX-License-Identifier: MPL-2.0
import { formatIdeaScore } from '../../shared/idea-score'
import { tr } from '../i18n/index'
import { useLayoutEffect, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api'
import type { Idea, IdeaStatus, User } from '../types'
import { STATUS_META, deadlineInfo, fmtDate } from '../utils'
import { ScoreHistory } from '../components/ScoreHistory'
import { Phase2Dialog } from '../components/Phase2Dialog'
import { usePlazaPermission } from '../hooks/usePlazaPermission'
import { ct } from '../community/client'

const FILTERS: { key: 'all' | IdeaStatus; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'incubating', label: '孵化中' },
  { key: 'in_progress', label: '进行中' },
  { key: 'done', label: '已实现' },
  { key: 'shelved', label: '搁置' },
]

export function IdeaListPage({ user }: { user: User }) {
  const nav = useNavigate()
  const permission = usePlazaPermission()
  const [ideas, setIdeas] = useState<Idea[]>([])
  const [loaded, setLoaded] = useState(false)
  const [listError, setListError] = useState('')
  const [revision, setRevision] = useState(0)
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<'all' | IdeaStatus>('all')
  const [showNew, setShowNew] = useState(false)
  const [form, setForm] = useState({ title: '', content: '', deadline: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => { if (showNew) document.getElementById('new-idea-title')?.focus() }, [showNew])

  useEffect(() => {
    const controller = new AbortController()
    setLoaded(false); setListError('')
    api.get('/api/ideas', controller.signal)
      .then((list) => { if (!controller.signal.aborted) setIdeas(list) })
      .catch((error) => { if (!controller.signal.aborted) setListError(error.message) })
      .finally(() => { if (!controller.signal.aborted) setLoaded(true) })
    return () => controller.abort()
  }, [revision])

  const stats = useMemo(() => {
    let active = 0
    let done = 0
    let dueSoon = 0
    for (const i of ideas) {
      if (i.status === 'done') done++
      else if (i.status === 'incubating' || i.status === 'in_progress') {
        active++
        const d = deadlineInfo(i.deadline)
        if (d && (d.cls === 'dl-soon' || d.cls === 'dl-overdue')) dueSoon++
      }
    }
    return { total: ideas.length, active, done, dueSoon }
  }, [ideas])

  const shown = ideas.filter((idea) => (filter === 'all' || idea.status === filter) && `${idea.title} ${idea.content || ''}`.toLowerCase().includes(search.trim().toLowerCase()))

  const submit = async () => {
    if (!form.title.trim() || busy) return
    setBusy(true)
    setErr('')
    try {
      await api.post('/api/ideas', form)
      setForm({ title: '', content: '', deadline: '' })
      setShowNew(false)
      setIdeas((await api.get('/api/ideas')) as Idea[])
    } catch (e: any) {
      setErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  const grid = useRef<HTMLDivElement>(null)
  const positions = useRef(new Map<string, DOMRect>())
  const animations = useRef<Animation[]>([])
  useEffect(() => { const clear = () => { animations.current.forEach(animation => animation.cancel()); positions.current.clear() }; const hidden = () => { if (document.hidden) clear() }; window.addEventListener('resize', clear); document.addEventListener('visibilitychange', hidden); return () => { clear(); window.removeEventListener('resize', clear); document.removeEventListener('visibilitychange', hidden) } }, [])
  useLayoutEffect(() => {
    animations.current.forEach(animation => animation.cancel())
    const items = Array.from(grid.current?.children || []) as HTMLElement[]
    const measured = items.map(item => ({item, id:item.dataset.layoutId!, rect:item.getBoundingClientRect()}))
    const visible = measured.filter(({rect}) => rect.bottom > 0 && rect.top < window.innerHeight)
    if (!document.hidden && !window.matchMedia('(prefers-reduced-motion: reduce)').matches && visible.length <= 12) {
      animations.current = visible.flatMap(({item,id,rect}) => { const before = positions.current.get(id); if (!before || typeof item.animate !== 'function') return []; const x = before.left - rect.left, y = before.top - rect.top; return Math.abs(x)+Math.abs(y)>1 ? [item.animate([{transform:`translate(${x}px,${y}px)`},{transform:'translate(0,0)'}],{duration:200,easing:'cubic-bezier(.22,1,.36,1)'})] : [] })
    }
    positions.current = new Map(measured.map(({id,rect}) => [id,rect]))
  }, [shown.map(idea => idea.id).join(',')])

  return (
    <div className="page ideas-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{tr("我的灵感")}</h1>
          <p className="page-sub">{tr("嗨，")}{user.name}{tr("！想到什么就记下来，别让它溜走。")}</p>
        </div>
        <div className="actions">
          <button className="btn btn-primary" onClick={() => { setErr(''); setShowNew(true) }}>
            {tr("＋ 记录新灵感")}</button>
        </div>
      </div>

      <div className="collection-summary" aria-label={tr('灵感概览')}><span>{tr('全部灵感')} <b>{stats.total}</b></span><span>{tr('推进中')} <b>{stats.active}</b></span><span>{tr('已实现')} <b>{stats.done}</b></span><span>{tr('临近截止')} <b>{stats.dueSoon}</b></span></div>

      <div className="idea-toolbar">
      <div className="tabs" aria-label={tr('灵感状态')}>
        {FILTERS.map((f) => (
          <button key={f.key} aria-pressed={filter === f.key} className={`tab ${filter === f.key ? 'active' : ''}`} onClick={() => setFilter(f.key)}>
            {tr(f.label)}
          </button>
        ))}
      </div>
      <input type="search" className="idea-search" aria-label={tr('搜索我的灵感')} placeholder={tr('搜索标题或正文')} value={search} onChange={(event) => setSearch(event.target.value)} />
      </div>

      {!loaded ? <p className="list-status" role="status">{tr('正在加载灵感…')}</p> : listError ? <div className="list-status" role="alert"><p className="error-text">{tr(listError)}</p><button className="btn btn-ghost" onClick={() => setRevision((value) => value + 1)}>{tr('重试列表')}</button></div> : shown.length === 0 ? (
        <div className="empty">
          <div className="empty-emoji">🌱</div>
          <p>{search.trim() ? tr('没有匹配的灵感，试试其他关键词。') : filter === 'all' ? tr("还没有灵感。今天有什么突发奇想吗？") : tr("这个状态下还没有灵感。")}</p>
          {search.trim() || filter !== 'all' ? <button className="btn btn-ghost" onClick={() => { setSearch(''); setFilter('all') }}>{tr('清除筛选')}</button> : <button className="btn btn-primary" onClick={() => { setErr(''); setShowNew(true) }}>{tr('记录新灵感')}</button>}
        </div>
      ) : (
        <div className="idea-grid" ref={grid}>
          {shown.map((idea) => {
            const st = STATUS_META[idea.status]
            const dl = deadlineInfo(idea.deadline)
            const pct = idea.step_count ? Math.round(((idea.done_count || 0) / idea.step_count) * 100) : null
            return (
              <div key={idea.id} data-layout-id={idea.id} className="idea-reflow"><article className="idea-card" onClick={() => nav(`/ideas/${idea.id}`)}>
                <div className="idea-card-top">
                  <h3><Link to={`/ideas/${idea.id}`} onClick={(event) => event.stopPropagation()}>{idea.title}</Link></h3>
                  <span className={`status-pill ${st.cls}`}>{tr(st.label)}</span>
                </div>
                {idea.content && <p className="idea-preview">{idea.content}</p>}
                {!!idea.is_public && (
                  <div className="muted small">{tr("🌐 已发布到灵感广场")}{idea.tags ? ` · ${idea.tags.split(',').map((t) => '#' + t.trim()).join(' ')}` : ''}</div>
                )}
                <p className="muted small">{idea.representative_score_milli==null?tr("当前标准待评分"):tr("当前代表分：")+formatIdeaScore(idea.representative_score_milli/1000)}</p>
                <div className="idea-topic-scores">{!idea.is_public && (idea.tags || '').split(',').filter(Boolean).map((tag) => <span key={tag} className="plat-chip">#{tag}</span>)}<ScoreHistory ideaId={idea.id} /></div>
                {pct !== null && (
                  <div className="progress">
                    <div className="progress-bar" style={{ width: `${pct}%` }} />
                  </div>
                )}
                <div className="card-foot">
                  <span className="muted small">
                    {pct !== null ? tr("{0}/{1} 步 · ", [idea.done_count, idea.step_count]) : ''}
                    {tr("更新于")}{fmtDate(idea.updated_at)}
                  </span>
                  <span className="card-actions" onClick={(e) => e.stopPropagation()}>
                    {idea.is_public ? (
                      <button
                        className="link-btn"
                        onClick={async () => {
                          await api.post(`/api/plaza/${idea.id}/unpublish`)
                          setIdeas((await api.get('/api/ideas')) as Idea[])
                        }}
                      >
                        {tr("[撤下]")}</button>
                    ) : (
                      <button
                        className="link-btn"
                        onClick={() => {
                          nav('/community/submit')
                        }}
                      >
                        {ct('[投稿到社区]','[Submit to community]')}
                      </button>
                    )}
                  </span>
                  {dl && <span className={`deadline-chip ${dl.cls}`}>{tr(dl.label)}</span>}
                </div>
              </article></div>
            )
          })}
        </div>
      )}


      {showNew && (
        <Phase2Dialog title={tr('记录新灵感')} onClose={() => { if (!busy) setShowNew(false) }}>
          <form onSubmit={(event) => { event.preventDefault(); void submit() }}>
            <div className="form-field">
              <label htmlFor="new-idea-title">{tr("灵感标题 *")}</label>
              <input
                id="new-idea-title"
                required
                disabled={busy}
                placeholder={tr("比如：做一个 3 分钟的口腔科普短视频")}
                value={form.title}
                maxLength={60}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
              />
            </div>
            <div className="form-field">
              <label htmlFor="new-idea-content">{tr("具体内容（可选）")}</label>
              <textarea
                id="new-idea-content"
                disabled={busy}
                rows={4}
                placeholder={tr("趁热写下来，越具体越好…")}
                value={form.content}
                onChange={(e) => setForm({ ...form, content: e.target.value })}
              />
            </div>
            <div className="form-field">
              <label htmlFor="new-idea-deadline">{tr("目标实现时间（可选）")}</label>
              <input id="new-idea-deadline" type="date" disabled={busy} value={form.deadline} onChange={(e) => setForm({ ...form, deadline: e.target.value })} />
            </div>
            {tr(err) && <p className="error-text" role="alert">{tr(err)}</p>}
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setShowNew(false)}>
                {tr("取消")}</button>
              <button type="submit" className="btn btn-primary" disabled={busy || !form.title.trim()}>
                {busy ? tr("保存中…") : tr("保存")}
              </button>
            </div>
          </form>
        </Phase2Dialog>
      )}
    </div>
  )
}
