// SPDX-License-Identifier: MPL-2.0
import { tr } from '../i18n/index'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Phase2Dialog } from './Phase2Dialog'
import { useLocation, useNavigate } from 'react-router-dom'
import { api } from '../api'
import type { Announcement, NotifItem, NotificationSummary, Paged, User } from '../types'
import { fmtDate, fmtTime } from '../utils'
import { safeActionUrl } from '../../shared/links'
import { GITHUB_REPOSITORY } from '../lib/github'
import { notificationTarget } from '../lib/notification-target'

const EMPTY: NotificationSummary = { notifications_unread: 0, announcements_unread: 0, total_unread: 0 }
const badge = (count: number) => count > 99 ? '99+' : count

export function NotificationCenter({ user, refreshVersion, actions, leading }: { user: User; refreshVersion: number; actions?: ReactNode; leading?: ReactNode }) {
  const navigate = useNavigate(), location = useLocation()
  const [toolsOpen, setToolsOpen] = useState(false)
  useEffect(() => { setToolsOpen(false); setOpen(false) }, [location.pathname])
  const modules: Record<string,string> = { ideas: '我的灵感', plaza: '灵感广场', synthesis: '灵感合成', leaderboard: '灵感评分排行榜', channels: '频道聊天', studio: '自媒体制作', media: '作品内容', dev: '开发工程', wishes: '心仪视频作品', orders: '需求商单', consult: '咨询管理', settings: '设置', feedback: '用户反馈', admin: '管理后台' }
  const [open, setOpen] = useState(false)
  const [tab, setTab] = useState<'notifications' | 'announcements'>('notifications')
  const [summary, setSummary] = useState(EMPTY)
  const [notifications, setNotifications] = useState<NotifItem[]>([])
  const [announcements, setAnnouncements] = useState<Announcement[]>([])
  const [detail, setDetail] = useState<Announcement | null>(null)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [summaryError, setSummaryError] = useState('')
  const [notice, setNotice] = useState('')
  const bell = useRef<HTMLButtonElement>(null)
  const controller = useRef<AbortController | null>(null)
  const listRequest = useRef<AbortController | null>(null)
  const summarySequence = useRef(0)
  const listSequence = useRef(0)
  const detailSequence = useRef(0)
  const lastVersion = useRef(refreshVersion)

  const refreshSummary = useCallback(async () => {
    const request = controller.current
    if (!request || request.signal.aborted) return
    const sequence = ++summarySequence.current
    try {
      const result = await api.get('/api/notification-summary', request.signal) as NotificationSummary
      if (!request.signal.aborted && sequence === summarySequence.current) { setSummary(result); setSummaryError('') }
    } catch (err) {
      if (!request.signal.aborted && sequence === summarySequence.current) setSummaryError(err instanceof Error ? err.message : '未读数量读取失败')
    }
  }, [])
  const loadList = useCallback(async () => {
    if (!controller.current || controller.current.signal.aborted) return
    listRequest.current?.abort()
    const request = new AbortController(); listRequest.current = request
    const sequence = ++listSequence.current
    setLoading(true); setError(''); setNotice(''); setDetail(null); detailSequence.current++
    try {
      const result = await api.get(`/api/${tab}?page=${page}&pageSize=20`, request.signal) as Paged<NotifItem | Announcement>
      if (request.signal.aborted || sequence !== listSequence.current) return
      if (tab === 'notifications') setNotifications(result.items as NotifItem[])
      else setAnnouncements(result.items as Announcement[])
      setTotal(result.total)
    } catch (err) {
      if (!request.signal.aborted && sequence === listSequence.current) setError(err instanceof Error ? err.message : '列表加载失败')
    } finally { if (!request.signal.aborted && sequence === listSequence.current) setLoading(false) }
  }, [tab, page])

  useEffect(() => {
    const request = new AbortController()
    controller.current = request
    void refreshSummary()
    const timer = window.setInterval(() => { if (!document.hidden) void refreshSummary() }, 60000)
    const visible = () => { if (!document.hidden) void refreshSummary() }
    document.addEventListener('visibilitychange', visible)
    return () => { request.abort(); listRequest.current?.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', visible) }
  }, [user.id, refreshSummary])
  useEffect(() => {
    if (lastVersion.current === refreshVersion) return
    lastVersion.current = refreshVersion
    void refreshSummary()
  }, [refreshVersion, refreshSummary])
  useEffect(() => {
    if (!open) return
    void refreshSummary(); void loadList()
    return () => { listRequest.current?.abort(); listSequence.current++; detailSequence.current++ }
  }, [open, refreshSummary, loadList])
  const close = useCallback(() => { setOpen(false); detailSequence.current++; bell.current?.focus() }, [])

  const write = async (work: (request: AbortController) => Promise<void>) => {
    const request = controller.current
    if (!request || request.signal.aborted || busy) return
    setBusy(true); setError(''); setNotice('')
    try { await work(request) }
    catch (err) { if (!request.signal.aborted) { setError(err instanceof Error ? err.message : '操作失败'); await refreshSummary() } }
    finally { if (!request.signal.aborted) setBusy(false) }
  }
  const readNotification = (item: NotifItem, jump: boolean) => write(async (request) => {
    await api.post(`/api/notifications/${item.id}/read`, undefined, request.signal)
    if (request.signal.aborted) return
    setNotifications((items) => items.map((row) => row.id === item.id ? { ...row, read: 1 } : row))
    await refreshSummary()
    if (!jump || request.signal.aborted) return
    const target = notificationTarget(item)
    if (!target) { setNotice('这条通知暂无可打开的页面，已标记已读。'); return }
    if (target.startsWith('/plaza/')) {
      try { await api.get(`/api${target}`, request.signal) }
      catch { throw new Error('关联灵感已删除、撤下或不可访问；通知已标记已读。') }
    } else if (target.startsWith('/feedback/') || target.startsWith('/admin?tab=feedback')) {
      await api.get(`/api/${item.type==='feedback_new'?'admin/':''}feedback/${item.ref_id}`,request.signal)
    } else {
      const items = await api.get('/api/consult', request.signal) as { id: number }[]
      if (!items.some((row) => row.id === item.ref_id)) throw new Error('关联咨询记录已删除或不可访问；通知已标记已读。')
    }
    if (!request.signal.aborted) { close(); navigate(target) }
  })
  const showAnnouncement = (item: Announcement) => write(async (request) => {
    const sequence = ++detailSequence.current
    const result = await api.get(`/api/announcements/${item.id}`, request.signal) as Announcement
    if (request.signal.aborted || sequence !== detailSequence.current) return
    setDetail(result)
    await api.post(`/api/announcements/${item.id}/read`, undefined, request.signal)
    if (request.signal.aborted) return
    setAnnouncements((items) => items.map((row) => row.id === item.id ? { ...row, is_read: true } : row))
    await refreshSummary()
  })
  const readAll = () => write(async (request) => {
    await api.post(`/api/${tab}/read-all`, undefined, request.signal)
    if (request.signal.aborted) return
    if (tab === 'notifications') setNotifications((items) => items.map((row) => ({ ...row, read: 1 })))
    else setAnnouncements((items) => items.map((row) => ({ ...row, is_read: true })))
    setNotice('本页签全部标记已读。')
    await refreshSummary()
  })
  const actionUrl = safeActionUrl(detail?.action_url)

  return <header className="sw-topbar">
    <div className="sw-topbar-leading">{leading}<span className="sw-topbar-caption">{tr(modules[location.pathname.split('/')[1]] || '✦ 灵感酱')}</span></div>
    <div className="sw-topbar-actions">
      <div className="sw-notice-root">
        <button ref={bell} className="sw-icon-button" aria-label={tr("通知与公告{0}", [summary.total_unread ? tr('，{0} 条未读', [summary.total_unread]) : ''])} aria-expanded={open} aria-controls="sw-notice-panel"
          onClick={() => { if (open) close(); else setOpen(true) }}>
          <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M9 20h6" /></svg>
          {summary.total_unread > 0 && <span className="sw-unread-badge">{badge(summary.total_unread)}</span>}
          {tr(summaryError) && <span className="sw-count-error" title={tr("未读数量读取失败")}>!</span>}
        </button>
        {open && <Phase2Dialog variant="drawer" title={tr("通知中心")} onClose={close}><div className="sw-notice-panel" id="sw-notice-panel">
          
          <div className="sw-notice-tabs" role="tablist" aria-label={tr("消息分类")}>
            {(['notifications', 'announcements'] as const).map((key) => <button key={key} role="tab" id={`sw-tab-${key}`} aria-selected={tab === key} aria-controls="sw-notice-content" disabled={busy}
              onClick={() => { setTab(key); setPage(1) }}>{key === 'notifications' ? tr("通知") : tr("公告")}
              {summary[`${key}_unread`] > 0 && <span className="sw-tab-count">{badge(summary[`${key}_unread`])}</span>}</button>)}
          </div>
          <div className="sw-notice-tools"><span className="muted small">{tab === 'notifications' ? tr("个人消息") : tr("已发布公告")}</span><button className="link-btn" disabled={busy || loading} onClick={readAll}>{tr("本页签全部已读")}</button></div>
          {(error || tr(summaryError)) && <div className="sw-notice-error" role="alert">{tr(error) || tr(summaryError)}<button className="link-btn" disabled={busy} onClick={() => { void refreshSummary(); void loadList() }}>{tr("重试")}</button></div>}
          {tr(notice) && <p className="sw-notice-feedback" role="status">{tr(notice)}</p>}
          <div className="sw-notice-content" role="tabpanel" id="sw-notice-content" aria-labelledby={`sw-tab-${tab}`}>
            {loading ? <p className="sw-empty">{tr("加载中…")}</p> : detail && tab === 'announcements' ? <article className="sw-announcement-detail">
              <button className="link-btn" onClick={() => setDetail(null)}>{tr("← 返回公告列表")}</button><h3>{detail.title}</h3>
              <time className="muted small">{fmtDate(detail.published_at)}</time><p className="sw-plain-text">{detail.content}</p>
              {actionUrl && detail.action_label && <a className="btn btn-primary" href={actionUrl} target={actionUrl.startsWith('/') ? undefined : '_blank'} rel={actionUrl.startsWith('/') ? undefined : 'noopener noreferrer'}>{detail.action_label}</a>}
            </article> : tab === 'notifications' ? notifications.length ? notifications.map((item) => <article key={item.id} className={`sw-notice-item ${item.read ? '' : 'is-unread'}`}>
              <button className="sw-notice-open" disabled={busy} onClick={() => readNotification(item, true)}><b>{item.actor_name || tr("系统")}</b> {item.type.startsWith('feedback_') ? tr(item.content) : item.content}<time>{fmtDate(item.created_at)} {fmtTime(item.created_at)}</time></button>
              {!item.read && <button className="link-btn" disabled={busy} onClick={() => readNotification(item, false)}>{tr("标记已读")}</button>}
            </article>) : <p className="sw-empty">{tr("还没有通知。")}</p> : announcements.length ? announcements.map((item) => <article key={item.id} className={`sw-notice-item ${item.is_read ? '' : 'is-unread'}`}>
              <button className="sw-notice-open" disabled={busy} onClick={() => showAnnouncement(item)}><b>{item.title}</b><time>{fmtDate(item.published_at)}{item.is_read ? tr(" · 已读") : tr(" · 未读")}</time></button>
            </article>) : <p className="sw-empty">{tr("还没有公告。")}</p>}
          </div>
          {!detail && total > 20 && <div className="sw-notice-pagination"><button className="chip" disabled={page === 1 || busy || loading} onClick={() => setPage((value) => value - 1)}>{tr("上一页")}</button><span>{page} / {Math.ceil(total / 20)}</span><button className="chip" disabled={page * 20 >= total || busy || loading} onClick={() => setPage((value) => value + 1)}>{tr("下一页")}</button></div>}
        </div></Phase2Dialog>}
      </div>
      <button className="sw-icon-button" aria-label={tr('更多工具')} aria-haspopup="dialog" onClick={() => setToolsOpen(true)}>•••</button>
      {toolsOpen && <Phase2Dialog variant="drawer" title={tr('更多工具')} onClose={() => setToolsOpen(false)}><div className="global-tools">{actions}
      {GITHUB_REPOSITORY ? <a className="sw-icon-button sw-github" href={GITHUB_REPOSITORY} target="_blank" rel="noopener noreferrer" aria-label={tr("GitHub 仓库")}><GitHubIcon /></a>
        : <button className="sw-icon-button sw-github" disabled title={tr("GitHub 未配置")} aria-label={tr("GitHub 未配置")}><GitHubIcon /><span className="small">{tr("未配置")}</span></button>}<p className="muted small">{user.name}</p></div></Phase2Dialog>}

    </div>
  </header>
}

function GitHubIcon() {
  return <svg width="21" height="21" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .75a11.25 11.25 0 0 0-3.56 21.92c.56.1.77-.24.77-.54v-2.1c-3.14.68-3.8-1.33-3.8-1.33-.51-1.3-1.25-1.65-1.25-1.65-1.03-.7.08-.69.08-.69 1.13.08 1.72 1.16 1.72 1.16 1 .1.5 2.14 3.28 1.5.1-.73.39-1.24.71-1.52-2.5-.28-5.13-1.25-5.13-5.56 0-1.23.44-2.24 1.16-3.03-.12-.29-.51-1.44.11-3 0 0 .95-.3 3.1 1.16a10.8 10.8 0 0 1 5.64 0c2.15-1.46 3.1-1.16 3.1-1.16.62 1.56.23 2.71.11 3 .72.79 1.16 1.8 1.16 3.03 0 4.32-2.64 5.27-5.15 5.55.4.35.77 1.04.77 2.1v3.1c0 .3.2.65.78.54A11.25 11.25 0 0 0 12 .75Z" /></svg>
}
