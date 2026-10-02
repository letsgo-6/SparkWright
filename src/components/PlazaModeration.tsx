// SPDX-License-Identifier: MPL-2.0
import { uiText, uiParam, tr } from '../i18n/index'
import { useEffect, useState } from 'react'
import { api } from '../api'
import type { ModerationIdea, Paged } from '../types'
import { fmtDate, fmtTime } from '../utils'
import { Phase2Dialog } from './Phase2Dialog'

export function PlazaModeration() {
  const [status, setStatus] = useState<'active' | 'removed'>('active')
  const [page, setPage] = useState(1)
  const [list, setList] = useState<Paged<ModerationIdea> | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [target, setTarget] = useState<ModerationIdea | null>(null)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setList(null); setError('')
    api.get(`/api/admin/plaza/ideas?status=${status}&page=${page}&pageSize=10`, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setList(result) })
      .catch((err) => { if (!controller.signal.aborted) setError(err.message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [status, page, revision])
  const confirm = async () => {
    if (!target || busy) return
    setBusy(true); setError(''); setNotice('')
    try {
      await api.post(`/api/admin/plaza/ideas/${target.id}/${status === 'active' ? 'remove' : 'restore'}`, status === 'active' ? { reason: reason.trim() } : undefined)
      setNotice(uiText("灵感 #{0} 已{1}。", [target.id, uiParam(status === 'active' ? '下架' : '恢复公开')]))
      setTarget(null); setRevision((v) => v + 1)
    } catch (err) { setError(err instanceof Error ? err.message : '操作失败') }
    finally { setBusy(false) }
  }
  return <section className="settings-card" aria-label={tr("广场治理")}>
    <div className="panel-head"><h2>{tr("广场治理")}</h2><button className="chip" disabled={loading || busy} onClick={() => setRevision((v) => v + 1)}>{tr("刷新列表")}</button></div>
    <p className="muted small">{tr("仅 Owner 可操作。下架保留原内容；作者不能自行重新发布，须由 Owner 恢复。")}</p>
    <div className="tabs">{(['active', 'removed'] as const).map((key) => <button className={`tab ${status === key ? 'active' : ''}`} disabled={busy} key={key} onClick={() => { setStatus(key); setPage(1); setNotice('') }}>{key === 'active' ? tr("公开灵感") : tr("已下架灵感")}</button>)}</div>
    {tr(notice) && <p className="save-flash" role="status">{tr(notice)}</p>}
    {tr(error) && <p className="error-text" role="alert">{tr(error)} <button className="link-btn" disabled={busy} onClick={() => setRevision((v) => v + 1)}>{tr("重试列表")}</button></p>}
    {loading ? <p role="status">{tr("灵感加载中…")}</p> : list && !list.items.length ? <p className="muted">{tr("本页没有")}{status === 'active' ? tr("公开") : tr("已下架")}{tr("灵感。")}</p> : list && <div className="moderation-list">
      {list.items.map((item) => <article className="moderation-item" key={item.id}><div><h3>{item.title}</h3><p className="muted small">#{item.id} · {item.author} · {item.plaza_removed_at ? tr("已下架") : tr("公开")} · {fmtDate(item.created_at)} {fmtTime(item.created_at)}</p>
        <p className="sw-plain-text">{item.public_summary || tr("无公开摘要")}</p><p className="muted small">{item.tags || tr("无标签")}</p>
        {item.plaza_removed_at && <p className="small">{tr("下架于")}{fmtDate(item.plaza_removed_at)} {fmtTime(item.plaza_removed_at)} {tr("· 原因：")}{item.plaza_remove_reason || tr("未填写")}</p>}</div>
        <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { setTarget(item); setReason(''); setError('') }}>{status === 'active' ? tr("下架") : tr("恢复")}</button></article>)}
    </div>}
    {list && list.total > 10 && <div className="sw-notice-pagination"><button className="chip" disabled={page === 1 || loading || busy} onClick={() => setPage((v) => v - 1)}>{tr("上一页")}</button><span>{page} / {Math.ceil(list.total / 10)}</span><button className="chip" disabled={page * 10 >= list.total || loading || busy} onClick={() => setPage((v) => v + 1)}>{tr("下一页")}</button></div>}
    {target && <Phase2Dialog title={status === 'active' ? tr("确认下架灵感") : tr("确认恢复灵感")} onClose={() => { if (!busy) setTarget(null) }}>
      <p className="sw-plain-text">{target.title}（#{target.id}）{status === 'active' ? tr("下架后广场不再显示，但保留作者数据。") : tr("恢复后将重新出现在广场，所有已登录用户可见。")}</p>
      {status === 'active' && <label className="form-field">{tr("下架原因（可选）")}<textarea value={reason} maxLength={500} rows={3} onChange={(event) => setReason(event.target.value)} /></label>}
      {tr(error) && <p className="error-text" role="alert">{tr(error)}</p>}
      <div className="modal-actions"><button className="btn btn-ghost" disabled={busy} onClick={() => setTarget(null)}>{tr("取消")}</button><button className="btn btn-primary" disabled={busy} onClick={() => void confirm()}>{busy ? tr("提交中…") : tr("确认操作")}</button></div>
    </Phase2Dialog>}
  </section>
}
