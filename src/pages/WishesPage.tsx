// SPDX-License-Identifier: MPL-2.0
import { Phase2Dialog } from '../components/Phase2Dialog'
import { uiText, tr } from '../i18n/index'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import type { Idea, User } from '../types'
import { fmtDate } from '../utils'

interface WishMatch {
  studio_id: number
  studio_title: string
  tool_name: string
  score: number
  kw_score: number
  ai_score: number
  hit_terms: string
  reasons: string
}

interface WishItem {
  id: number
  user_id: number
  title: string
  video_url: string
  description: string
  features: string
  art_style: string
  analysis_raw: string
  analysis_channel: '' | 'multimodal' | 'page' | 'manual'
  source_idea_id: number | null
  adopted_studio_id: number | null
  created_at: string
  updated_at: string
  matches: WishMatch[]
}

const CHANNEL_BADGE: Record<string, string> = {
  multimodal: '解析通道: 多模态',
  page: '解析通道: 页面信息',
  manual: '解析通道: 作品描述',
}

export function WishesPage({ user }: { user: User }) {
  const [wishes, setWishes] = useState<WishItem[]>([])
  const [loaded, setLoaded] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [form, setForm] = useState({ title: '', videoUrl: '', description: '', sourceIdeaId: '' })
  const [ideas, setIdeas] = useState<Idea[]>([])
  const [busy, setBusy] = useState(false)
  const [rematchingAll, setRematchingAll] = useState(false)
  const [flash, setFlash] = useState('')
  const [editFor, setEditFor] = useState<WishItem | null>(null)
  const [delFor, setDelFor] = useState<WishItem | null>(null)
  const [manualFor, setManualFor] = useState<WishItem | null>(null)
  const [manualText, setManualText] = useState('')

  const load = () => api.get('/api/wishes').then((r: any) => setWishes(r.items))

  useEffect(() => {
    load().finally(() => setLoaded(true))
    api.get('/api/ideas').then((l) => setIdeas(l as Idea[])).catch(() => {})
  }, [])

  const analyze = async (w: WishItem) => {
    setBusy(true)
    try {
      const r: any = await api.post(`/api/wishes/${w.id}/analyze`)
      if (r.code === 'manual_needed') {
        setManualFor(w)
        setManualText(w.description || '')
      } else {
        setFlash(uiText("分析完成（通道: {0}）", [r.channel]))
        setTimeout(() => setFlash(''), 2600)
      }
      load()
    } catch (e: any) {
      alert(tr(e.message))
    } finally {
      setBusy(false)
    }
  }

  const submitManual = async () => {
    if (!manualFor) return
    setBusy(true)
    try {
      await api.patch(`/api/wishes/${manualFor.id}`, { description: manualText })
      await api.post(`/api/wishes/${manualFor.id}/analyze`)
      setManualFor(null)
      setFlash('分析完成 ✓')
      setTimeout(() => setFlash(''), 2600)
      load()
    } catch (e: any) {
      alert(tr(e.message))
    } finally {
      setBusy(false)
    }
  }

  const rematch = async (w: WishItem) => {
    setBusy(true)
    try {
      await api.post(`/api/wishes/${w.id}/rematch`)
      load()
    } catch (e: any) {
      alert(tr(e.message))
    } finally {
      setBusy(false)
    }
  }

  const rematchAll = async () => {
    if (rematchingAll) return
    setRematchingAll(true)
    try {
      const r: any = await api.post('/api/wishes/rematch-all')
      setFlash(uiText("已重匹配 {0} 个心仪作品 · 落库 {1} 条匹配", [r.count, r.saved]))
      setTimeout(() => setFlash(''), 3000)
      load()
    } catch (e: any) {
      alert(tr(e.message))
    } finally {
      setRematchingAll(false)
    }
  }

  const attach = async (w: WishItem, studioId: number) => {
    await api.post(`/api/wishes/${w.id}/attach`, { studioId })
    load()
  }

  const detach = async (w: WishItem) => {
    await api.post(`/api/wishes/${w.id}/detach`)
    load()
  }

  const submitNew = async () => {
    if (!form.title.trim() || busy) return
    setBusy(true)
    try {
      await api.post('/api/wishes', { ...form, sourceIdeaId: form.sourceIdeaId || null })
      setForm({ title: '', videoUrl: '', description: '', sourceIdeaId: '' })
      setShowNew(false)
      await load()
    } catch (e: any) {
      alert(tr(e.message))
    } finally {
      setBusy(false)
    }
  }

  const saveEdit = async () => {
    if (!editFor) return
    await api.patch(`/api/wishes/${editFor.id}`, {
      title: editFor.title,
      videoUrl: editFor.video_url,
      description: editFor.description,
    })
    setEditFor(null)
    load()
  }

  return (
    <div className="page wishes-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{tr("📺 心仪视频作品")}</h1>
          <p className="page-sub">{tr("收藏想做出的视频作品，AI 整理特色与风格，匹配你的制作方案。")}</p>
        </div>
        <div className="actions">
          <button className="btn btn-ghost" onClick={rematchAll} disabled={rematchingAll || wishes.length === 0}>
            {rematchingAll ? tr("🔄 重匹配中…") : tr("🔄 全局重匹配")}
          </button>
          <button className="btn btn-primary" onClick={() => setShowNew(true)}>{tr("＋ 加心仪")}</button>
        </div>
      </div>

      {tr(flash) && <div className="save-flash" style={{ marginBottom: 10 }}>{tr(flash)}</div>}

      {loaded && wishes.length === 0 ? (
        <div className="empty">
          <div className="empty-emoji">📺</div>
          <p>{tr("还没有心仪作品。看到一个想复刻的视频？把链接加进来。")}</p>
          <button className="btn btn-primary" onClick={() => setShowNew(true)}>{tr("＋ 加心仪")}</button>
        </div>
      ) : (
        <div className="orders-list">
          {wishes.map((w) => {
            const adopted = w.matches.find((m) => m.studio_id === w.adopted_studio_id)
            return (
              <div key={w.id} className="panel order-card">
                <div className="order-head">
                  <b className="order-title">{w.title}</b>
                  {w.analysis_channel && <span className="plat-chip">{tr(CHANNEL_BADGE[w.analysis_channel]) || w.analysis_channel}</span>}
                </div>
                {w.video_url && (
                  <a className="order-url" href={w.video_url} target="_blank" rel="noopener noreferrer">
                    🔗 {w.video_url}
                  </a>
                )}
                {w.description&&<p className="order-req">{w.description}</p>}
                {w.features && (
                  <p className="muted small" style={{ margin: '8px 0 4px' }}><b>{tr("特色:")}</b> {w.features}</p>
                )}
                {w.art_style && (
                  <p className="muted small"><b>{tr("艺术风格:")}</b> {w.art_style}</p>
                )}

                <details className="order-match context-details"><summary>{tr("匹配制作方案与依据")} · {w.matches.length}</summary>
                  <div className="order-match-head">
                    <span className="muted small">{tr("🤖 匹配制作方案")}</span>
                    <button className="link-btn" onClick={() => rematch(w)} disabled={busy}>
                      {tr("↻ 重匹配")}</button>
                  </div>
                  {w.matches.length === 0 ? (
                    <p className="muted small">
                      {tr("还没有匹配的制作方案。先在「自媒体制作」生成方案，或点 [↻ 重匹配]。")}</p>
                  ) : (
                    <div className="order-match-list">
                      {w.matches.map((m, idx) => (
                        <div key={m.studio_id} className="order-match-row">
                          <span className="order-match-rank">{idx + 1}</span>
                          <span className="order-match-name">
                            {tr("方案#")}{m.studio_id}《{m.studio_title}》
                            {m.tool_name && <span className="muted small"> {tr("· 工具:")}{m.tool_name}</span>}
                          </span>
                          <span className="order-match-bar">
                            <span className="progress"><span className="progress-bar" style={{ width: `${m.score}%` }} /></span>
                          </span>
                          <b className="order-match-score">{m.score}</b>
                          <small className="order-match-split muted">(kw{m.kw_score}/ai{m.ai_score >= 0 ? m.ai_score : '—'})</small>
                          <div className="order-match-hits">
                            {m.hit_terms ? m.hit_terms.split(',').filter(Boolean).slice(0, 4).map((t) => (
                              <span key={t} className="plat-chip">{t}</span>
                            )) : null}
                          </div>
                          <small className="order-match-reason">“{m.reasons || tr("关键词命中")}”</small>
                          {idx === 0 && !w.adopted_studio_id && (
                            <button className="btn btn-ghost btn-sm" onClick={() => attach(w, m.studio_id)}>{tr("采纳关联")}</button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </details>

                <div className="order-foot">
                  <span className="task-actions">
                    <button className="btn btn-ghost btn-sm" onClick={() => analyze(w)} disabled={busy}>
                      {busy ? tr("分析中…") : tr("🔍 分析链接/描述")}
                    </button>
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => {
                        setEditFor(w)
                      }}
                    >
                      {tr("✎ 编辑")}</button>
                    <button className="btn btn-danger-ghost btn-sm" onClick={() => setDelFor(w)}>{tr("✕ 删除")}</button>
                  </span>
                  {adopted && (
                    <span className="muted small">
                      {tr("已关联: 方案#")}{adopted.studio_id}《{adopted.studio_title}》
                      <button className="link-btn" onClick={() => detach(w)}> {tr("[解除]")}</button>
                    </span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {showNew && (
        <Phase2Dialog variant="drawer" title={tr("＋ 加心仪")} onClose={() => setShowNew(false)}>
            <div className="form-field">
              <label>{tr("标题 *")}</label>
              <input autoFocus placeholder={tr("比如：雨夜复古电影感短片")} value={form.title} maxLength={60} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </div>
            <div className="form-field">
              <label>{tr("视频链接（可填）")}</label>
              <input placeholder="https://bilibili.com/video/BV…" value={form.videoUrl} onChange={(e) => setForm({ ...form, videoUrl: e.target.value })} />
            </div>
            <div className="form-field">
              <label>{tr("作品描述（可选，链接解析不了时兜底）")}</label>
              <textarea rows={3} placeholder={tr("描述这个视频的风格与内容…")} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>
            <div className="form-field">
              <label>{tr("关联灵感（可空）")}</label>
              <select value={form.sourceIdeaId} onChange={(e) => setForm({ ...form, sourceIdeaId: e.target.value })}>
                <option value="">{tr("不关联")}</option>
                {ideas.map((i) => <option key={i.id} value={i.id}>{i.title}</option>)}
              </select>
            </div>
            <p className="muted small">{tr("保存后自动分析链接/描述，并匹配你的制作方案。")}</p>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setShowNew(false)}>{tr("取消")}</button>
              <button className="btn btn-primary" onClick={submitNew} disabled={busy}>{tr("保存并自动分析+匹配")}</button>
            </div>
        </Phase2Dialog>
      )}

      {editFor && (
        <Phase2Dialog variant="drawer" title={tr("✎ 编辑心仪作品")} onClose={() => setEditFor(null)}>
            <div className="form-field">
              <label>{tr("标题 *")}</label>
              <input value={editFor.title} maxLength={60} onChange={(e) => setEditFor({ ...editFor, title: e.target.value })} />
            </div>
            <div className="form-field">
              <label>{tr("视频链接")}</label>
              <input value={editFor.video_url} onChange={(e) => setEditFor({ ...editFor, video_url: e.target.value })} />
            </div>
            <div className="form-field">
              <label>{tr("作品描述")}</label>
              <textarea rows={3} value={editFor.description} onChange={(e) => setEditFor({ ...editFor, description: e.target.value })} />
            </div>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setEditFor(null)}>{tr("取消")}</button>
              <button className="btn btn-primary" onClick={saveEdit}>{tr("保存")}</button>
            </div>
        </Phase2Dialog>
      )}

      {manualFor && (
        <Phase2Dialog variant="drawer" title={tr("📝 补填作品描述")} onClose={() => setManualFor(null)}>
            <p className="muted small" style={{ marginBottom: 10 }}>
              {tr("该平台链接有反爬（抖音/B站常见），无法自动解析。请补填作品描述后分析。")}</p>
            <div className="form-field">
              <textarea rows={4} placeholder={tr("描述这个视频的风格、内容、运镜…")} value={manualText} onChange={(e) => setManualText(e.target.value)} />
            </div>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setManualFor(null)}>{tr("取消")}</button>
              <button className="btn btn-primary" onClick={submitManual} disabled={busy || !manualText.trim()}>{tr("保存并分析")}</button>
            </div>
        </Phase2Dialog>
      )}

      {delFor && (
        <Phase2Dialog title={tr("删除心仪作品")} onClose={() => setDelFor(null)}>
            <p style={{ lineHeight: 1.7 }}>
              {tr("确定删除「")}<b>{delFor.title}</b>{tr("」？匹配记录会一并删除。")}</p>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setDelFor(null)}>{tr("取消")}</button>
              <button className="btn btn-danger-ghost" onClick={async () => { setDelFor(null); await api.del(`/api/wishes/${delFor.id}`); load() }}>{tr("确认删除")}</button>
            </div>
        </Phase2Dialog>
      )}

      <p className="muted small" style={{ marginTop: 16 }}>
        {tr("当前用户：")}{user.name} {tr("· 心仪作品与制作方案的匹配基于关键词 + 语义混合检索。")}</p>
    </div>
  )
}
