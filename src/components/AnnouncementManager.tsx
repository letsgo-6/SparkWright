// SPDX-License-Identifier: MPL-2.0
import { tr } from '../i18n/index'
import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { Announcement, Paged } from '../types'
import { fmtDate } from '../utils'
import { GITHUB_REPOSITORY } from '../lib/github'

const EMPTY_FORM = { title: '', content: '', action_label: '', action_url: '' }

/** Shared editor; authorization always stays on the server. */
export function AnnouncementManager({ onChanged, client = api }: { onChanged?: () => void; client?: Pick<typeof api, 'get' | 'post' | 'patch'> }) {
  const [items, setItems] = useState<Announcement[]>([])
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [editing, setEditing] = useState<number | null>(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const controller = useRef<AbortController | null>(null)
  const pending = useRef(false)
  const sequence = useRef(0)

  const load = async (request = controller.current) => {
    if (!request || request.signal.aborted) return
    const version = ++sequence.current
    setLoading(true); setError('')
    try {
      const result = await client.get(`/api/admin/announcements?page=${page}&pageSize=10`, request.signal) as Paged<Announcement>
      if (!request.signal.aborted && version === sequence.current) { setItems(result.items); setTotal(result.total) }
    } catch (err) { if (!request.signal.aborted && version === sequence.current) setError(err instanceof Error ? err.message : '公告列表加载失败') }
    finally { if (!request.signal.aborted && version === sequence.current) setLoading(false) }
  }
  useEffect(() => {
    const request = new AbortController()
    controller.current = request
    void load(request)
    return () => request.abort()
  }, [page, client])

  const mutate = async (work: (signal: AbortSignal) => Promise<unknown>, message: string) => {
    const request = controller.current
    if (!request || request.signal.aborted || pending.current) return
    pending.current = true
    setBusy(true); setError(''); setNotice('')
    try {
      await work(request.signal)
      if (request.signal.aborted) return
      setNotice(message); setEditing(null); setForm(EMPTY_FORM)
      onChanged?.()
      await load(request)
    } catch (err) { if (!request.signal.aborted) setError(err instanceof Error ? err.message : '公告保存失败') }
    finally { pending.current = false; if (!request.signal.aborted) setBusy(false) }
  }
  const save = () => mutate((signal) => editing === null ? client.post('/api/admin/announcements', form, signal) : client.patch(`/api/admin/announcements/${editing}`, form, signal), editing === null ? '草稿已保存。' : '修改已保存，已有阅读状态保留。')

  return <section className="settings-card sw-announcement-manager" aria-label={tr("公告管理")}>
    <div className="panel-head"><h2>{tr("公告管理")}</h2><button className="chip" disabled={busy} onClick={() => { setEditing(null); setForm(EMPTY_FORM); setNotice('') }}>{tr("新建公告")}</button></div>
    <p className="muted small">{tr("先保存草稿再发布。编辑或重新发布会保留阅读状态；需再次提醒时新建一条公告。")}</p>
    {tr(error) && <p className="error-text" role="alert">{tr(error)} <button className="link-btn" disabled={busy} onClick={() => void load()}>{tr("重试加载")}</button></p>}
    {tr(notice) && <p className="sw-manager-feedback" role="status">{tr(notice)}</p>}
    <form onSubmit={(event) => { event.preventDefault(); void save() }}>
      <div className="form-field"><label htmlFor="announcement-title">{tr("公告标题")}</label><input id="announcement-title" required maxLength={120} value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></div>
      <div className="form-field"><label htmlFor="announcement-content">{tr("公告正文（纯文本）")}</label><textarea id="announcement-content" required maxLength={10000} rows={5} value={form.content} onChange={(event) => setForm({ ...form, content: event.target.value })} /></div>
      <div className="form-field"><label htmlFor="announcement-action-label">{tr("按钮文字（可选）")}</label><input id="announcement-action-label" maxLength={80} value={form.action_label} onChange={(event) => setForm({ ...form, action_label: event.target.value })} /></div>
      <div className="form-field"><label htmlFor="announcement-action-url">{tr("按钮链接（与文字同时填写）")}</label><input id="announcement-action-url" maxLength={2048} placeholder={tr("https://… 或 /站内路径")} value={form.action_url} onChange={(event) => setForm({ ...form, action_url: event.target.value })} /></div>
      <div className="panel-actions"><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? tr("处理中…") : editing === null ? tr("保存草稿") : tr("保存修改")}</button>
        <button type="button" className="btn btn-ghost" disabled={busy || !GITHUB_REPOSITORY} title={GITHUB_REPOSITORY ? tr("填入当前仓库地址") : tr("GitHub 未配置")}
          onClick={() => { if (GITHUB_REPOSITORY) setForm({ ...form, action_label: '去 GitHub Star ⭐', action_url: GITHUB_REPOSITORY }) }}>{tr("填入 GitHub Star 动作")}</button></div>
      {!GITHUB_REPOSITORY && <p className="muted small">{tr("仓库尚未配置，开源后填入真实地址即可启用 Star 入口。")}</p>}
    </form>
    <div className="sw-manager-list">
      {loading ? <p className="muted">{tr("公告加载中…")}</p> : !items.length ? <p className="muted">{tr("还没有公告，先创建一条草稿。")}</p> : items.map((item) => <article className="sw-manager-item" key={item.id}>
        <div><b>{item.title}</b><p className="muted small">{item.status === 'published' ? tr("已发布") : tr("草稿")} · {fmtDate(item.updated_at)}</p></div>
        <div className="actions"><button className="chip" disabled={busy} onClick={() => { setEditing(item.id); setForm({ title: item.title, content: item.content, action_label: item.action_label || '', action_url: item.action_url || '' }); setNotice('') }}>{tr("编辑")}</button>
          <button className="chip" disabled={busy} onClick={() => void mutate((signal) => client.post(`/api/admin/announcements/${item.id}/${item.status === 'published' ? 'unpublish' : 'publish'}`, undefined, signal), item.status === 'published' ? '已撤下公告。' : '公告已发布。')}>{item.status === 'published' ? tr("撤下") : tr("发布")}</button></div>
      </article>)}
    </div>
    {total > 10 && <div className="sw-notice-pagination"><button className="chip" disabled={page === 1 || busy || loading} onClick={() => setPage((value) => value - 1)}>{tr("上一页")}</button><span>{page} / {Math.ceil(total / 10)}</span><button className="chip" disabled={page * 10 >= total || busy || loading} onClick={() => setPage((value) => value + 1)}>{tr("下一页")}</button></div>}
  </section>
}
