// SPDX-License-Identifier: MPL-2.0
import { Phase2Dialog } from '../components/Phase2Dialog'
import { formatIdeaScore } from '../../shared/idea-score'
import { tr, uiText } from '../i18n/index'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import type { PlazaIdea, User } from '../types'
import { STATUS_META, fmtDate } from '../utils'
import { ScoreHistory } from '../components/ScoreHistory'
import { usePlazaPermission } from '../hooks/usePlazaPermission'

const DEFAULT_TAGS = ['AI副业', '学生党', '工具实测', '内容创作']

export function PlazaPage({ user }: { user: User }) {
  const permission = usePlazaPermission()
  const [sort, setSort] = useState<'latest' | 'hot'>('latest')
  const [tag, setTag] = useState('')
  const [q, setQ] = useState('')
  const [qInput, setQInput] = useState('')
  const [items, setItems] = useState<PlazaIdea[]>([])
  const [page, setPage] = useState(1)
  const [hasMore, setHasMore] = useState(false)
  const [composeOpen, setComposeOpen] = useState(false)
  const [compose, setCompose] = useState('')
  const [busy, setBusy] = useState(false)
  const sentinelRef = useRef<HTMLDivElement>(null)
  const loadingRef = useRef(false)
  const generationRef = useRef(0)
  const [loadError, setLoadError] = useState('')

  const load = useCallback(
    async (p: number, replace: boolean) => {
      if (!replace && loadingRef.current) return
      const generation = replace ? ++generationRef.current : generationRef.current
      loadingRef.current = true
      setBusy(true)
      setLoadError('')
      try {
        const r: any = await api.get(`/api/plaza?sort=${sort}&tag=${encodeURIComponent(tag)}&q=${encodeURIComponent(q)}&page=${p}`)
        if (generation !== generationRef.current) return
        setItems((prev) => replace ? r.items : [...prev, ...r.items.filter((item: PlazaIdea) => !prev.some((old) => old.id === item.id))])
        setHasMore(r.hasMore)
        setPage(p)
      } catch (e: any) {
        if (generation === generationRef.current) setLoadError(e.message)
      } finally {
        if (generation === generationRef.current) { loadingRef.current = false; setBusy(false) }
      }
    },
    [sort, tag, q]
  )

  useEffect(() => {
    load(1, true)
    return () => { generationRef.current++; loadingRef.current = false }
  }, [load])

  // 滚动分页：哨兵进入视口就加载下一页（替换旧的全量轮询）
  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const ob = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && hasMore && !busy) {
        load(page + 1, false)
      }
    })
    ob.observe(el)
    return () => ob.disconnect()
  }, [hasMore, page, busy, load])

  const tagChips = [...new Set([...DEFAULT_TAGS, ...items.flatMap((i) => (i.tags ? i.tags.split(',').map((t) => t.trim()) : []))])].filter(Boolean)

  const composePublish = async () => {
    const content = compose.trim()
    if (!content || busy || permission.muted || !permission.ready) return
    setBusy(true)
    try {
      await api.post('/api/plaza/compose', { content })
      setCompose(''); setComposeOpen(false)
      await load(1, true)
    } catch (e: any) {
      permission.denied(e)
      alert(tr(e.message))
    } finally {
      setBusy(false)
    }
  }

  const toggleLike = async (id: number) => {
    try {
      const r: any = await api.post(`/api/plaza/${id}/like`)
      setItems((prev) => prev.map((i) => (i.id === id ? { ...i, liked: r.liked ? 1 : 0, like_count: r.count } : i)))
    } catch (e: any) {
      alert(tr(e.message))
    }
  }

  const unpublish = async (id: number) => {
    if (!window.confirm(tr('撤下后广场不再显示这条灵感，确定？'))) return
    await api.post(`/api/plaza/${id}/unpublish`)
    setItems((prev) => prev.filter((i) => i.id !== id))
  }

  const share = async (id: number) => {
    try {
      await navigator.clipboard.writeText(`${location.origin}/plaza/${id}`)
      alert(tr('链接已复制，去粘贴给朋友吧'))
    } catch {
      alert(tr("链接：{0}/plaza/{1}", [location.origin, id]))
    }
  }

  const ago = (iso: string) => {
    const diff = Date.now() - new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`).getTime()
    const m = Math.floor(diff / 60000)
    if (m < 1) return '刚刚'
    if (m < 60) return uiText("{0} 分钟前", [m])
    const h = Math.floor(m / 60)
    if (h < 24) return uiText("{0} 小时前", [h])
    const d = Math.floor(h / 24)
    return d < 30 ? uiText("{0} 天前", [d]) : fmtDate(iso)
  }

  return (
    <div className="page plaza-page">
      {tr(loadError) && <p className="error-text">{tr(loadError)}</p>}
      <div className="page-header">
        <div>
          <h1 className="page-title">{tr("🌐 灵感广场")}</h1>
          <p className="page-sub">{tr("看看大家在想什么、做什么，给你的灵感找同路人。")}</p>
        </div>
        <div className="actions plaza-actions">
          <button className="btn btn-primary" disabled={!permission.ready||permission.muted} onClick={()=>setComposeOpen(true)}>{tr('分享灵感')}</button>
          <Link className="btn btn-ghost" to="/channels">{tr("💬 讨论区")}</Link>
        </div>
      </div>

      {composeOpen&&<Phase2Dialog title={tr('分享灵感')} onClose={()=>{if(!busy)setComposeOpen(false)}}><p className="hint-banner">{tr('发布后所有人可见，请勿包含个人隐私。')}</p>
      <div className="panel plaza-compose">
        <textarea
          rows={2}
          disabled={!permission.ready || permission.muted}
          placeholder={tr("分享一个灵感…（发布后所有人可见）")}
          value={compose}
          maxLength={2000}
          onChange={(e) => setCompose(e.target.value)}
        />
        <div className="plaza-compose-foot">
          <span className="muted small">{tr("未发布的灵感只有自己可见，随时可在「我的灵感」发布")}</span>
          <button className="btn btn-primary btn-sm" onClick={composePublish} disabled={busy || !permission.ready || permission.muted || !compose.trim()}>
            {tr("发布 🌐")}</button>
        </div>
      </div>
      </Phase2Dialog>}

      {(permission.muted || permission.error) && <p className="error-text" role="alert">{permission.muted ? tr("账号已被禁言，暂不能发布。{0}", [permission.reason || '']) : tr(permission.error)} <button className="link-btn" onClick={() => void permission.refresh()}>{tr("刷新发言权限")}</button></p>}

      <div className="chip-filter">
        <button className={`tab ${sort === 'latest' ? 'active' : ''}`} onClick={() => setSort('latest')}>{tr("最新")}</button>
        <button className={`tab ${sort === 'hot' ? 'active' : ''}`} onClick={() => setSort('hot')}>{tr("最热")}</button>
        <span className="chip-divider" />
        <button className={`tab ${tag === '' ? 'active' : ''}`} onClick={() => setTag('')}>{tr("全部")}</button>
        {tagChips.map((t) => (
          <button key={t} className={`tab ${tag === t ? 'active' : ''}`} onClick={() => setTag(tag === t ? '' : t)}>#{t}</button>
        ))}
      </div>

      <div className="plaza-search">
        <input
          placeholder={tr("🔍 搜索灵感标题或内容…")}
          value={qInput}
          onChange={(e) => setQInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && setQ(qInput.trim())}
        />
        {q && <button className="btn btn-ghost btn-sm" onClick={() => { setQ(''); setQInput('') }}>{tr("清除")}</button>}
      </div>

      {items.length === 0 && (
        <div className="empty">
          <div className="empty-emoji">🌐</div>
          <p>{tr("广场还空着。发布第一条灵感，让大家认识你！")}</p>
        </div>
      )}

      <div className="plaza-feed">
        {items.map((i) => {
          const own = i.user_id === user.id
          const tags = (i.tags || '').split(',').map((t) => t.trim()).filter(Boolean)
          return (
            <div key={i.id} className="panel plaza-card">
              <div className="plaza-card-head">
                <span className="plaza-author">
                  <span className="avatar small-avatar">{i.author.slice(0, 1)}</span>
                  <b>{own ? tr("我") : i.author}</b>
                  <span className="muted small">· {tr(ago(i.created_at))}</span>
                </span>
                <div className="plaza-card-tags">
                  <span className={`status-pill ${STATUS_META[i.status]?.cls || 'st-incubating'}`}>{tr(STATUS_META[i.status]?.label) || i.status}</span>
                  {tags.map((t) => <span key={t} className="plat-chip">#{t}</span>)}
                  {!!i.score_public&&<span className="muted small">{i.score==null?tr("当前标准待评分"):tr("当前代表分：")+formatIdeaScore(i.score)}</span>}
                  {!!i.score_public && <ScoreHistory ideaId={i.id} publicOnly />}
                  {own && (
                    <button className="link-btn" onClick={() => unpublish(i.id)}>{tr("[撤下]")}</button>
                  )}
                </div>
              </div>
              <h3 className="plaza-card-title">{i.title}</h3>
              {i.public_summary && <p className="plaza-card-summary">{i.public_summary}</p>}
              <div className="plaza-card-foot">
                <span className="plaza-stats">
                  <button className={`plaza-stat ${i.liked ? 'liked' : ''}`} onClick={() => toggleLike(i.id)}>
                    👍 {i.like_count}
                  </button>
                  <Link className="plaza-stat" to={`/plaza/${i.id}`}>💬 {i.comment_count}</Link>
                  <button className="plaza-stat" onClick={() => share(i.id)}>{tr("↗ 分享")}</button>
                </span>
                <Link className="link" to={`/plaza/${i.id}`}>{tr("进详情 →")}</Link>
              </div>
            </div>
          )
        })}
      </div>

      {hasMore && (
        <div ref={sentinelRef} className="plaza-sentinel">
          <button className="btn btn-ghost" onClick={() => load(page + 1, false)}>{tr("加载更多")}</button>
        </div>
      )}
    </div>
  )
}

