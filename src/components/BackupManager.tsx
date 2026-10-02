// SPDX-License-Identifier: MPL-2.0
import { tr } from '../i18n/index'
import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { Backup, Paged } from '../types'
import { downloadAttachment } from '../lib/download'
import { fmtDate, fmtTime } from '../utils'

export function BackupManager() {
  const [items, setItems] = useState<Backup[]>([])
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const controller = useRef<AbortController | null>(null)
  const pending = useRef(false)
  const load = async (request = controller.current) => {
    if (!request || request.signal.aborted) return
    setLoading(true); setError('')
    try {
      const result = await api.get(`/api/admin/backups?page=${page}&pageSize=10`, request.signal) as Paged<Backup>
      if (!request.signal.aborted) { setItems(result.items); setTotal(result.total) }
    } catch (err) { if (!request.signal.aborted) setError(err instanceof Error ? err.message : '备份列表读取失败') }
    finally { if (!request.signal.aborted) setLoading(false) }
  }
  useEffect(() => {
    const request = new AbortController()
    controller.current = request
    void load(request)
    return () => request.abort()
  }, [page])
  const perform = async (id?: string) => {
    const request = controller.current
    if (!request || request.signal.aborted || pending.current) return
    pending.current = true; setBusy(id || 'create'); setError(''); setNotice('')
    try {
      if (id) await downloadAttachment(`/api/admin/backups/${id}/download`, request.signal)
      else await api.post('/api/admin/backups', undefined, request.signal)
      if (request.signal.aborted) return
      setNotice(id ? '完整数据库已下载。' : '一致性备份已创建，可以下载。')
      if (!id) await load(request)
    } catch (err) { if (!request.signal.aborted) setError(err instanceof Error ? err.message : '备份操作失败，请重试') }
    finally { pending.current = false; if (!request.signal.aborted) setBusy('') }
  }
  return <section className="settings-card sw-backup-manager" aria-label={tr("完整数据库备份")}>
    <div className="panel-head"><h2>{tr("完整数据库备份")}</h2><span className="muted small">{tr("仅 owner")}</span></div>
    <p className="sw-backup-warning small">{tr("完整数据库包含全站数据与敏感凭证，请妥善保存。admin 和普通用户无权访问。")}</p>
    <p className="muted small">{tr("在线创建一致性 SQLite 文件，可继续使用网站。当前仅提供创建与下载，恢复功能后置。")}</p>
    {tr(error) && <p className="error-text" role="alert">{tr(error)} <button className="link-btn" disabled={Boolean(busy)} onClick={() => void load()}>{tr("重试列表")}</button></p>}
    {tr(notice) && <p className="save-flash" role="status">{tr(notice)}</p>}
    <div className="panel-actions"><button className="btn btn-primary" disabled={Boolean(busy)} onClick={() => void perform()}>{busy === 'create' ? tr("正在备份…") : tr("创建完整备份")}</button>
      <button className="btn btn-ghost" disabled={Boolean(busy) || loading} onClick={() => void load()}>{tr("刷新列表")}</button></div>
    <div className="sw-backup-list">
      {loading ? <p className="muted small">{tr("备份加载中…")}</p> : !items.length ? <p className="muted small">{tr("还没有通过本入口创建的备份。")}</p> : items.map((item) => <article className="sw-backup-item" key={item.id}>
        <div><b>{fmtDate(item.created_at)} {fmtTime(item.created_at)}</b><p className="muted small">{(item.size_bytes / 1024).toFixed(1)} KB · {item.file_name}</p></div>
        <button className="chip" disabled={Boolean(busy)} onClick={() => void perform(item.id)}>{busy === item.id ? tr("下载中…") : tr("下载 .db")}</button>
      </article>)}
    </div>
    {total > 10 && <div className="sw-notice-pagination"><button className="chip" disabled={page === 1 || Boolean(busy) || loading} onClick={() => setPage((value) => value - 1)}>{tr("上一页")}</button><span>{page} / {Math.ceil(total / 10)}</span><button className="chip" disabled={page * 10 >= total || Boolean(busy) || loading} onClick={() => setPage((value) => value + 1)}>{tr("下一页")}</button></div>}
  </section>
}
