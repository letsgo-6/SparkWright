// SPDX-License-Identifier: MPL-2.0
import { tr } from '../i18n/index'
import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { api } from '../api'
import type { Channel, Paged } from '../types'
import { fmtDate } from '../utils'
import { Phase2Dialog } from './Phase2Dialog'

type ManagedChannel = Channel & { message_count: number }
type Action = { kind: 'rename' | 'archive' | 'restore'; channel: ManagedChannel }
export function PublicChannelManager() {
  const [params, setParams] = useSearchParams()
  const channelType = params.get('type') === 'idea' ? 'idea' : 'public'
  const [page, setPage] = useState(1), [revision, setRevision] = useState(0)
  const [list, setList] = useState<Paged<ManagedChannel> | null>(null)
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false)
  const [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [name, setName] = useState(''), [newName, setNewName] = useState('')
  const [action, setAction] = useState<Action | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setList(null); setError('')
    api.get(`/api/admin/channels?type=${channelType}&page=${page}&pageSize=10`, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setList(result) })
      .catch((err) => { if (!controller.signal.aborted) setError(err.message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [page, revision, channelType])
  const write = async (create = false) => {
    if (busy || (create ? !newName.trim() : !action)) return
    setBusy(true); setError(''); setNotice('')
    try {
      if (create) { await api.post('/api/channels', { name: newName.trim() }); setNewName(''); setNotice('公共频道已创建。') }
      else if (action) {
        const url = `/api/admin/channels/${action.channel.id}`
        if (action.kind === 'rename') await api.patch(url, { name: name.trim() })
        else if (action.kind === 'archive') await api.del(url)
        else await api.post(`${url}/restore`)
        setNotice('频道操作已完成。'); setAction(null)
      }
      setRevision((v) => v + 1)
    } catch (err) { setError(err instanceof Error ? err.message : '频道操作失败') }
    finally { setBusy(false) }
  }
  return <section className="settings-card" aria-label={tr("频道管理")}><div className="panel-head"><h2>{tr("频道管理")}</h2><button className="chip" disabled={loading || busy} onClick={() => setRevision((v) => v + 1)}>{tr("刷新列表")}</button></div>
    <p className="muted small">{tr("仅 Owner 可改名、归档和恢复频道。只显示公共频道、当前公开的灵感频道和自己的灵感频道；归档保留历史消息。")}</p>
    <div className="actions" role="group" aria-label={tr("频道类型")}>{(['public', 'idea'] as const).map((type) => <button className="chip" key={type} aria-pressed={channelType === type} disabled={busy} onClick={() => { setPage(1); setAction(null); setNotice(''); setParams({ tab: 'channels', type }) }}>{type === 'public' ? tr("公共频道") : tr("灵感专属频道")}</button>)}</div>
    {channelType === 'public' && <form className="phase2-inline-form" onSubmit={(event) => { event.preventDefault(); void write(true) }}><label htmlFor="new-public-channel">{tr("新建公共频道")}</label><input id="new-public-channel" value={newName} maxLength={100} disabled={busy} onChange={(event) => setNewName(event.target.value)} /><button className="btn btn-primary btn-sm" disabled={busy || !newName.trim()}>{tr("创建")}</button></form>}
    {tr(notice) && <p className="save-flash" role="status">{tr(notice)}</p>}{tr(error) && <p className="error-text" role="alert">{tr(error)} <button className="link-btn" disabled={busy} onClick={() => setRevision((v) => v + 1)}>{tr("重试列表")}</button></p>}
    {loading ? <p role="status">{tr("频道加载中…")}</p> : list && !list.items.length ? <p className="muted">{tr("暂无可管理的频道。")}</p> : list && <div className="moderation-list">{list.items.map((channel) => <article className="moderation-item" key={channel.id}>
      <div><h3># {channel.name}</h3><p className="muted small">#{channel.id} · {channel.archived_at ? tr("已归档") : tr("开放")} · {channel.message_count} {tr("条历史消息 · 创建于")}{fmtDate(channel.created_at)}</p>
        {channel.idea_title && <p className="muted small">{tr("所属灵感：")}{channel.idea_title}</p>}</div>
      <div className="actions">{(['rename', channel.archived_at ? 'restore' : 'archive'] as const).map((kind) => <button className="btn btn-ghost btn-sm" disabled={busy} key={kind} onClick={() => { setAction({ kind, channel }); setName(channel.name); setError('') }}>{kind === 'rename' ? tr("改名") : kind === 'restore' ? tr("恢复") : tr("归档")}</button>)}</div>
    </article>)}</div>}
    {list && list.total > 10 && <div className="sw-notice-pagination"><button className="chip" disabled={page === 1 || loading || busy} onClick={() => setPage((v) => v - 1)}>{tr("上一页")}</button><span>{page} / {Math.ceil(list.total / 10)}</span><button className="chip" disabled={page * 10 >= list.total || loading || busy} onClick={() => setPage((v) => v + 1)}>{tr("下一页")}</button></div>}
    {action && <Phase2Dialog title={action.kind === 'rename' ? tr("修改频道名称") : action.kind === 'archive' ? tr("确认归档频道") : tr("确认恢复频道")} onClose={() => { if (!busy) setAction(null) }}>
      <p className="sw-plain-text"># {action.channel.name} · {action.kind === 'archive' ? tr("保留历史消息但停止普通访问。") : action.kind === 'restore' ? tr("恢复频道访问；灵感频道仍遵循父灵感的可见性。") : tr("修改名称不会清除历史消息。")}</p>
      {action.kind === 'rename' && <label className="form-field">{tr("频道名称")}<input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} /></label>}
      {tr(error) && <p className="error-text" role="alert">{tr(error)}</p>}<div className="modal-actions"><button className="btn btn-ghost" disabled={busy} onClick={() => setAction(null)}>{tr("取消")}</button><button className="btn btn-primary" disabled={busy || (action.kind === 'rename' && !name.trim())} onClick={() => void write()}>{busy ? tr("提交中…") : tr("确认操作")}</button></div>
    </Phase2Dialog>}
  </section>
}
