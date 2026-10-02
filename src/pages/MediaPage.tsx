// SPDX-License-Identifier: MPL-2.0
import { Phase2Dialog } from '../components/Phase2Dialog'
import { tr, locale } from '../i18n/index'
import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { api } from '../api'
import type { Idea, MediaItem, MediaStatus, User } from '../types'
import { fmtDate } from '../utils'

const PLATFORMS = ['全部', '抖音', '小红书', 'B站', '视频号', '快手', '其他']
const PLATFORM_COLS = ['抖音', '小红书', 'B站', '视频号', '快手', '其他']

const STATUS_META: Record<MediaStatus, { label: string; cls: string }> = {
  idea: { label: '选题idea', cls: 'st-incubating' },
  scripting: { label: '写稿中', cls: 'st-inprogress' },
  making: { label: '拍摄/剪辑', cls: 'st-making' },
  published: { label: '已发布', cls: 'st-done' },
  reviewed: { label: '已复盘', cls: 'st-shelved' },
}

const STATUS_FLOW: Record<MediaStatus, { next: MediaStatus | null; label: string }> = {
  idea: { next: 'scripting', label: '开始写稿' },
  scripting: { next: 'making', label: '去拍摄' },
  making: { next: 'published', label: '发布' },
  published: { next: 'reviewed', label: '去复盘' },
  reviewed: { next: null, label: '' },
}

interface ToolOpt {
  name: string
  category: string
  pros: string
  cons: string
  fit: number
  reason: string
}

export function MediaArchive({ user }: { user: User }) {
  const [items, setItems] = useState<MediaItem[]>([])
  const [loaded, setLoaded] = useState(false)
  const [stateFilter,setStateFilter] = useState<MediaStatus>('idea')
  const [filter, setFilter] = useState('全部')
  const [showNew, setShowNew] = useState(false)
  const [form, setForm] = useState({ title: '', topic: '', platform: '抖音', sourceIdeaId: '' })
  const [ideas, setIdeas] = useState<Idea[]>([])
  const [editFor, setEditFor] = useState<MediaItem | null>(null)
  const [dataFor, setDataFor] = useState<MediaItem | null>(null)
  const [dataForm, setDataForm] = useState({ views: '', likes: '', comments: '', publishDate: '' })
  const [dataBusy, setDataBusy] = useState(false)
  const [dataError, setDataError] = useState('')
  const [flash, setFlash] = useState('')
  const nav = useNavigate()

  const load = () => api.get('/api/media').then((l) => setItems(l as MediaItem[]))

  useEffect(() => {
    load().finally(() => setLoaded(true))
    api.get('/api/ideas').then((l) => setIdeas(l as Idea[])).catch(() => {})
  }, [])

  const shown = filter === '全部' ? items : items.filter((i) => i.platform === filter)

  const summary = useMemo(() => {
    const pub = shown.filter((i) => i.status === 'published' || i.status === 'reviewed')
    const now = new Date()
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const monthPub = pub.filter((i) => (i.publish_date || '').slice(0, 7) === month)
    const views = pub.reduce((s, i) => s + i.views, 0)
    const likes = pub.reduce((s, i) => s + i.likes, 0)
    const rate = views ? ((likes / views) * 100).toFixed(1) : '—'
    return { monthPub: monthPub.length, views, rate, pendingReview: shown.filter((i) => i.status === 'published').length }
  }, [shown])

  const advance = async (m: MediaItem) => {
    const flow = STATUS_FLOW[m.status]
    if (!flow.next) return
    await api.patch(`/api/media/${m.id}`, { status: flow.next })
    load()
  }

  const del = async (m: MediaItem) => {
    if (!window.confirm(tr("确定删除「{0}」？", [m.title]))) return
    await api.del(`/api/media/${m.id}`)
    load()
  }

  const submitNew = async () => {
    if (!form.title.trim()) return
    await api.post('/api/media', { ...form, sourceIdeaId: form.sourceIdeaId || null })
    setForm({ title: '', topic: '', platform: '抖音', sourceIdeaId: '' })
    setShowNew(false)
    load()
  }

  const openEdit = (m: MediaItem) => setEditFor({ ...m })
  const saveEdit = async () => {
    if (!editFor) return
    await api.patch(`/api/media/${editFor.id}`, {
      title: editFor.title,
      topic: editFor.topic,
      platform: editFor.platform,
      status: editFor.status,
      publishDate: (editFor.publish_date || '').slice(0, 10) || null,
    })
    setEditFor(null)
    load()
  }

  const openData = (m: MediaItem) => {
    setDataError('')
    setDataFor(m)
    setDataForm({ views: String(m.views), likes: String(m.likes), comments: String(m.comments), publishDate: (m.publish_date || '').slice(0, 10) })
  }

  const saveData = async () => {
    if (!dataFor || dataBusy) return
    setDataBusy(true)
    setDataError('')
    try {
      await api.patch(`/api/media/${dataFor.id}/data`, { ...dataForm, publishDate: dataForm.publishDate || null })
      await load()
      setDataFor(null)
      setFlash('作品数据已保存 ✓')
      setTimeout(() => setFlash(''), 2500)
    } catch (e: any) {
      setDataError(e.message)
    } finally {
      setDataBusy(false)
    }
  }

  const openContent = (m: MediaItem) => {
    if (!m.studio_id) return
    nav(`/media/${m.id}/content`)
  }

  const ledger = shown.filter((i) => i.status === 'published' || i.status === 'reviewed')

  return (
    <div className="archive-page">
      <div className="panel-head" style={{ marginBottom: 12 }}>
        <span className="muted small">{tr("选择平台筛选下方作品；状态显示在卡片上，可推进或编辑。")}</span>
        <button className="btn btn-primary" onClick={() => setShowNew(true)}>{tr("＋ 新选题")}</button>
      </div>

      {tr(flash) && <div className="save-flash" style={{ marginBottom: 10 }}>{tr(flash)}</div>}

      <div className="chip-filter">
        {PLATFORMS.map((p) => (
          <button key={p} className={`tab ${filter === p ? 'active' : ''}`} onClick={() => setFilter(p)}>{tr(p)}</button>
        ))}
      </div>

      <label className="mobile-state-filter">{tr('作品状态')}<select value={stateFilter} onChange={event=>setStateFilter(event.target.value as MediaStatus)}>{Object.entries(STATUS_META).map(([key,meta])=><option key={key} value={key}>{tr(meta.label)} · {shown.filter(item=>item.status===key).length}</option>)}</select></label>
      <div className="incentive-bar">
        <span>{tr("本月发布")}<b>{summary.monthPub}</b></span>
        <span>{tr("总播放")}<b>{summary.views.toLocaleString(locale())}</b></span>
        <span>{tr("平均点赞率")}<b>{summary.rate}{summary.rate === '—' ? '' : '%'}</b></span>
        <span>{tr("待复盘")}<b>{summary.pendingReview}</b></span>
      </div>

      {loaded && shown.length === 0 ? (
        <div className="empty">
          <div className="empty-emoji">🎬</div>
          <p>{filter === '全部' ? tr("还没有作品。从一条灵感开始你的下一条视频吧。") : tr("「{0}」平台还没有作品。", [filter])}</p>
          <button className="btn btn-primary" onClick={() => setShowNew(true)}>{tr("＋ 新选题")}</button>
        </div>
      ) : (
        <>
          <div className="media-kanban">
            {(['idea', 'scripting', 'making', 'published', 'reviewed'] as MediaStatus[]).map((status) => {
              const list = shown.filter((i) => i.status === status)
              return (
                <div key={status} data-selected={stateFilter===status} className="kanban-col media-col">
                  <div className="kanban-col-title"><span>{tr(STATUS_META[status].label)}</span><span>{list.length}</span></div>
                  {list.map((m) => {
                    const flow = STATUS_FLOW[m.status]
                    return (
                      <div key={m.id} className="task-card media-card">
                        <div className="task-title">{m.title}</div>
                        <div className="media-card-meta">
                          <span className={`status-pill ${STATUS_META[m.status].cls}`}>{tr(STATUS_META[m.status].label)}</span>
                          <span className="muted small">{m.platform}</span>
                          <span className="muted small">
                            {m.status === 'published' || m.status === 'reviewed' ? tr("发于 {0}", [fmtDate(m.publish_date)]) : fmtDate(m.created_at)}
                          </span>
                        </div>
                        {m.topic && <div className="muted small">{m.topic}</div>}
                        {m.source_idea_id && (
                          <Link className="link small" to={`/ideas/${m.source_idea_id}`}>{tr("源:灵感#")}{m.source_idea_id}</Link>
                        )}
                        <div className="task-foot">
                          <span className="task-actions">
                            <button title={tr("删除")} onClick={() => del(m)}>×</button>
                          </span>
                          <span className="task-actions">
                            <button title={tr("编辑作品类型")} onClick={() => openEdit(m)}>{tr("✎ 作品")}</button>
                            {m.studio_id && <button title={tr("编辑内容（制作方案与工具）")} onClick={() => openContent(m)}>{tr("✎ 内容")}</button>}
                            {flow.next && <button title={tr(flow.label)} onClick={() => advance(m)}>→ {tr(flow.label)}</button>}
                          </span>
                        </div>
                        {(m.status === 'published' || m.status === 'reviewed') && (
                          <button className="btn btn-ghost btn-sm" style={{ marginTop: 6 }} onClick={() => openData(m)}>{tr("✎ 录数据")}</button>
                        )}
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>

          {ledger.length > 0 && (
            <details className="panel context-details" style={{ marginTop: 16 }}><summary>{tr("数据台账")}</summary>
              <div className="panel-head"><h2>{tr("📊 数据台账")}</h2><span className="muted small">{tr("仅已发布/已复盘进表")}</span></div>
              <div className="ledger-table">
                <div className="ledger-row ledger-head">
                  <span>{tr("标题")}</span><span>{tr("平台")}</span><span>{tr("状态")}</span><span>{tr("发布日")}</span><span>{tr("播放")}</span><span>{tr("点赞")}</span><span>{tr("评论")}</span><span>{tr("点赞率")}</span><span></span>
                </div>
                {ledger.map((m) => (
                  <div key={m.id} className="ledger-row">
                    <span className="ledger-title">{m.title}</span>
                    <span>{m.platform}</span>
                    <span>{tr(STATUS_META[m.status].label)}</span>
                    <span>{fmtDate(m.publish_date)}</span>
                    <span>{m.views.toLocaleString(locale())}</span>
                    <span>{m.likes.toLocaleString(locale())}</span>
                    <span>{m.comments.toLocaleString(locale())}</span>
                    <span>{m.views ? ((m.likes / m.views) * 100).toFixed(1) + '%' : '—'}</span>
                    <span><button className="btn btn-ghost btn-sm" onClick={() => openData(m)}>{tr("✎ 录数据")}</button></span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </>
      )}

      {showNew && (
        <Phase2Dialog variant="drawer" title={tr("＋ 新选题")} onClose={() => setShowNew(false)}>
            <div className="form-field">
              <label>{tr("标题 *")}</label>
              <input autoFocus placeholder={tr("比如：十月 Agent 实测")} value={form.title} maxLength={60} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </div>
            <div className="form-field">
              <label>{tr("选题方向（可选）")}</label>
              <input placeholder={tr("想拍什么角度…")} value={form.topic} onChange={(e) => setForm({ ...form, topic: e.target.value })} />
            </div>
            <div className="form-field">
              <label>{tr("平台")}</label>
              <select value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })}>
                {PLATFORMS.slice(1).map((p) => <option key={p} value={p}>{tr(p)}</option>)}
              </select>
            </div>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setShowNew(false)}>{tr("取消")}</button>
              <button className="btn btn-primary" onClick={submitNew}>{tr("创建")}</button>
            </div>
        </Phase2Dialog>
      )}

      {editFor && (
        <Phase2Dialog variant="drawer" title={tr("✎ 编辑作品")} onClose={() => setEditFor(null)}>
            <div className="form-field">
              <label>{tr("标题 *")}</label>
              <input value={editFor.title} maxLength={60} onChange={(e) => setEditFor({ ...editFor, title: e.target.value })} />
            </div>
            <div className="form-field">
              <label>{tr("选题方向")}</label>
              <input value={editFor.topic} onChange={(e) => setEditFor({ ...editFor, topic: e.target.value })} />
            </div>
            <div className="form-inline">
              <div className="form-field">
                <label>{tr("平台")}</label>
                <select value={editFor.platform} onChange={(e) => setEditFor({ ...editFor, platform: e.target.value })}>
                  {PLATFORMS.slice(1).map((p) => <option key={p} value={p}>{tr(p)}</option>)}
                </select>
              </div>
              <div className="form-field">
                <label>{tr("状态")}</label>
                <select value={editFor.status} onChange={(e) => setEditFor({ ...editFor, status: e.target.value as MediaStatus })}>
                  {(Object.entries(STATUS_META) as [MediaStatus, { label: string }][]).map(([k, v]) => (
                    <option key={k} value={k}>{tr(v.label)}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setEditFor(null)}>{tr("取消")}</button>
              <button className="btn btn-primary" onClick={saveEdit}>{tr("保存")}</button>
            </div>
        </Phase2Dialog>
      )}

      {dataFor && (
        <div className="modal-overlay" onClick={() => !dataBusy && setDataFor(null)}>
          <form className="modal" role="dialog" aria-modal="true" aria-label={tr("录入作品数据")} onClick={(e) => e.stopPropagation()} onSubmit={(e) => { e.preventDefault(); saveData() }}>
            <h2>{tr("录入作品数据")}</h2>
            <p className="muted small">{dataFor.title}</p>
            {(['views', 'likes', 'comments'] as const).map((key) => (
              <div className="form-field" key={key}>
                <label htmlFor={`media-${key}`}>{tr(({ views: '播放量', likes: '点赞数', comments: '评论数' })[key])}</label>
                <input id={`media-${key}`} type="number" min="0" step="1" required value={dataForm[key]} onChange={(e) => setDataForm({ ...dataForm, [key]: e.target.value })} />
              </div>
            ))}
            <div className="form-field">
              <label htmlFor="media-date">{tr("发布日期")}</label>
              <input id="media-date" type="date" value={dataForm.publishDate} onChange={(e) => setDataForm({ ...dataForm, publishDate: e.target.value })} />
            </div>
            {tr(dataError) && <p className="error-text">{tr(dataError)}</p>}
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" disabled={dataBusy} onClick={() => setDataFor(null)}>{tr("取消")}</button>
              <button type="submit" className="btn btn-primary" disabled={dataBusy}>{dataBusy ? tr("保存中…") : tr("保存数据")}</button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
