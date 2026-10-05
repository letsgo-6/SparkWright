// SPDX-License-Identifier: MPL-2.0
import { useEffect, useState } from 'react'
import type { Announcement, Paged } from '../types'
import { useFeatureData } from '../lib/useFeatureData'
import { fmtDate } from '../utils'
import { safeActionUrl } from '../../shared/links'
import { tr } from '../i18n'
import { community, ct } from './client'

export function CommunityAnnouncements({ onRead }: { onRead: () => void }) {
  const [page, setPage] = useState(1), [selected, setSelected] = useState<number | null>(null)
  const [busy, setBusy] = useState(false), [writeError, setWriteError] = useState('')
  const { data, error, loading, reload } = useFeatureData<Paged<Announcement>>(`/api/announcements?page=${page}&pageSize=20`, 60000, community.get)
  const read = async (id?: number) => {
    if (busy) return
    setBusy(true); setWriteError('')
    try { await community.post(id ? `/api/announcements/${id}/read` : '/api/announcements/read-all'); onRead(); reload() }
    catch (e) { setWriteError((e as Error).message) }
    finally { setBusy(false) }
  }
  return <section aria-label={ct('社区公告', 'Community announcements')}>
    <div className="panel-head"><h2>{ct('社区公告', 'Community announcements')}</h2><button className="chip" disabled={busy || loading || !data?.items.length} onClick={() => void read()}>{ct('全部标记已读', 'Mark all as read')}</button></div>
    <p className="muted small">{ct('管理员发布的公共社区公告，电脑与手机同步。', 'Published community announcements, shared across desktop and mobile.')}</p>
    {writeError && <p className="error-text" role="alert">{tr(writeError)}</p>}
    {selected !== null ? <AnnouncementDetail key={selected} id={selected} onRead={onRead} onBack={() => { setSelected(null); reload() }} /> : <>
      {error && <p className="error-text" role="alert">{tr(error)} <button className="link-btn" onClick={reload}>{ct('重试', 'Retry')}</button></p>}
      {loading && !data ? <p role="status">{ct('公告加载中…', 'Loading announcements…')}</p> : data && !data.items.length ? <p className="community-empty">{ct('还没有公告。', 'No announcements yet.')}</p> : data?.items.map(item => <article className={`sw-notice-item ${item.is_read ? '' : 'is-unread'}`} key={item.id}>
        <button className="sw-notice-open" onClick={() => setSelected(item.id)}><b>{item.title}</b><time>{fmtDate(item.published_at)} · {item.is_read ? ct('已读', 'Read') : ct('未读', 'Unread')}</time></button>
        {!item.is_read && <button className="link-btn" disabled={busy} onClick={() => void read(item.id)}>{ct('标记已读', 'Mark as read')}</button>}
      </article>)}
      {data && data.total > 20 && <div className="sw-notice-pagination"><button className="chip" disabled={page === 1 || loading || busy} onClick={() => setPage(p => p - 1)}>{ct('上一页', 'Previous')}</button><span>{page} / {Math.ceil(data.total / 20)}</span><button className="chip" disabled={page * 20 >= data.total || loading || busy} onClick={() => setPage(p => p + 1)}>{ct('下一页', 'Next')}</button></div>}
    </>}
  </section>
}

function AnnouncementDetail({ id, onRead, onBack }: { id: number; onRead: () => void; onBack: () => void }) {
  const { data, error, reload } = useFeatureData<Announcement>(`/api/announcements/${id}`, 60000, community.get)
  const [readError, setReadError] = useState(''), [readVersion, setReadVersion] = useState(0)
  useEffect(() => {
    if (!data || data.is_read) return
    const request = new AbortController()
    void community.post(`/api/announcements/${id}/read`, undefined, request.signal).then(() => { if (!request.signal.aborted) { setReadError(''); onRead() } }).catch(e => { if (!request.signal.aborted) setReadError(e.message) })
    return () => request.abort()
  }, [data?.id, data?.is_read, id, onRead, readVersion])
  const action = safeActionUrl(data?.action_url)
  return <article className="community-detail">
    <button className="link-btn" onClick={onBack}>{ct('← 返回公告列表', '← Back to announcements')}</button>
    {error ? <p className="error-text" role="alert">{tr(error)} <button className="link-btn" onClick={reload}>{ct('重试', 'Retry')}</button></p> : data ? <><h3>{data.title}</h3><time className="muted small">{fmtDate(data.published_at)}</time><p className="community-plain">{data.content}</p>
      {action && data.action_label && <a className="btn btn-primary" href={action} target={action.startsWith('/') ? undefined : '_blank'} rel={action.startsWith('/') ? undefined : 'noopener noreferrer'}>{data.action_label}</a>}</> : <p role="status">{ct('公告加载中…', 'Loading announcements…')}</p>}
    {readError && <p className="error-text" role="alert">{tr(readError)} <button className="link-btn" onClick={() => setReadVersion(v => v + 1)}>{ct('重试标记已读', 'Retry marking as read')}</button></p>}
  </article>
}
