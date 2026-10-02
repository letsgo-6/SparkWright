// SPDX-License-Identifier: MPL-2.0
import { tr } from '../i18n/index'
import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import { isAdmin, isOwner, type AdminSystem, type User } from '../types'
import { AnnouncementManager } from '../components/AnnouncementManager'
import { BackupManager } from '../components/BackupManager'
import { UserManager } from '../components/UserManager'
import { PlazaModeration } from '../components/PlazaModeration'
import { PublicChannelManager } from '../components/PublicChannelManager'
import {ActivityAnalytics} from '../components/ActivityAnalytics'
import {FeedbackInbox} from '../components/FeedbackInbox'

const TABS = { overview: '系统概览', activity:'活跃分析', feedback:'反馈收件箱', users: '用户管理', announcements: '公告管理', backups: '数据库备份', plaza: '广场治理', channels: '频道管理' }
type Tab = keyof typeof TABS

export function AdminPage({ user, onAnnouncementsChanged, onRoleChanged }: {
  user: User; onAnnouncementsChanged: () => void; onRoleChanged: () => void
}) {
  const [params,setParams] = useSearchParams()
  const requested = params.get('tab') || 'overview'
  const tab: Tab = Object.hasOwn(TABS, requested) ? requested as Tab : 'overview'
  if (!isAdmin(user)) return <div className="page">
    <h1 className="page-title">{tr("无权访问管理后台")}</h1>
    <p className="page-sub">{tr("此页面仅向 admin 和 owner 开放。")}</p>
    <Link className="btn btn-primary" to="/">{tr("返回首页")}</Link>
  </div>

  return <div className="page admin-page">
    <div className="page-header"><div><h1 className="page-title">{tr("管理后台")}</h1>
      <p className="page-sub">{tr("管理账号、公告与系统数据。当前角色：")}{user.role}</p></div>
      <Link className="btn btn-ghost" to="/settings">{tr("个人设置与导出")}</Link></div>
    <label className="admin-mobile-section">{tr('后台分区')}<select value={tab} onChange={event=>setParams({tab:event.target.value})}>{(Object.entries(TABS) as [Tab,string][]).filter(([key])=>!['plaza','channels'].includes(key)||isOwner(user)).map(([key,label])=><option key={key} value={key}>{tr(label)}</option>)}</select></label>
    <div className="admin-workspace"><nav className="admin-tabs" aria-label={tr("后台分区")}>
      {(Object.entries(TABS) as [Tab, string][]).filter(([key]) => !['plaza', 'channels'].includes(key) || isOwner(user)).map(([key, label]) => <Link key={key} to={`?tab=${key}`} aria-current={tab === key ? 'page' : undefined}>{tr(label)}</Link>)}
    </nav>
    <div className="admin-content">
      {tab === 'overview' && <SystemOverview />}
      {tab === 'activity' && <ActivityAnalytics />}
      {tab === 'feedback' && <FeedbackInbox />}
      {tab === 'users' && <UserManager user={user} onSelfRoleChanged={onRoleChanged} />}
      {['plaza', 'channels'].includes(tab) && !isOwner(user) && <p className="error-text" role="alert">{tr("此管理区需要 Owner 权限。")}</p>}
      {tab === 'plaza' && isOwner(user) && <PlazaModeration />}
      {tab === 'channels' && isOwner(user) && <PublicChannelManager />}
      {tab === 'announcements' && <AnnouncementManager onChanged={onAnnouncementsChanged} />}
      {tab === 'backups' && (isOwner(user) ? <BackupManager /> : <section className="settings-card" aria-label={tr("数据库备份权限")}>
        <h2>{tr("数据库备份")}</h2><p className="muted">{tr("完整数据库备份仅 owner 可用。")}</p></section>)}
    </div></div>
  </div>
}

function SystemOverview() {
  const [system, setSystem] = useState<AdminSystem | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const controller = useRef<AbortController | null>(null)
  const load = async (request = controller.current) => {
    if (!request || request.signal.aborted) return
    setLoading(true); setError(''); setSystem(null)
    try {
      const result = await api.get('/api/admin/system', request.signal) as AdminSystem
      if (!request.signal.aborted) setSystem(result)
    } catch (err) { if (!request.signal.aborted) setError(err instanceof Error ? err.message : '系统状态读取失败') }
    finally { if (!request.signal.aborted) setLoading(false) }
  }
  useEffect(() => {
    const request = new AbortController(); controller.current = request
    void load(request)
    return () => request.abort()
  }, [])
  return <section className="settings-card" aria-label={tr("系统概览")}>
    <div className="panel-head"><h2>{tr("系统概览")}</h2><button className="chip" disabled={loading} onClick={() => void load()}>{tr("刷新状态")}</button></div>
    {loading && <p className="muted" role="status">{tr("正在读取系统状态…")}</p>}
    {tr(error) && <p className="error-text" role="alert">{tr(error)} <button className="link-btn" disabled={loading} onClick={() => void load()}>{tr("重试")}</button></p>}
    {system && <dl className="admin-overview">
      <div><dt>{tr("服务状态")}</dt><dd>{system.status === 'ok' ? tr("正常") : tr("不可用")}</dd></div>
      <div><dt>{tr("应用版本")}</dt><dd>{system.version}</dd></div>
      <div><dt>{tr("运行时长")}</dt><dd>{Math.floor(system.uptime_seconds / 3600)} {tr("小时")}{Math.floor(system.uptime_seconds / 60) % 60} {tr("分钟")}{system.uptime_seconds % 60} {tr("秒")}</dd></div>
      <div><dt>{tr("数据库连接")}</dt><dd>{system.database === 'ok' ? tr("正常") : tr("不可用")}</dd></div>
      <div><dt>{tr("账号总数")}</dt><dd>{system.users_total}</dd></div>
      <div><dt>{tr("公告")}</dt><dd>{system.announcements.published} {tr("已发布 ·")}{system.announcements.draft} {tr("草稿")}</dd></div>
    </dl>}
    <p className="muted small">{tr("状态按本次读取展示。账号列表只提供基本信息，不提供用户私有业务内容。")}</p>
  </section>
}
