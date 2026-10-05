// SPDX-License-Identifier: MPL-2.0
import { tr, setLanguage, useLanguage, validLanguage } from './i18n/index'
import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom'
import { api } from './api'
import type { User } from './types'
import { isAdmin } from './types'
import { NotificationCenter } from './components/NotificationCenter'
import { SupportAuthor } from './components/SupportAuthor'
import { Phase2Dialog } from './components/Phase2Dialog'
import { BrandMark } from './components/BrandMark'
import { useInterfaceEffects } from './hooks/useInterfaceEffects'
import { ct } from './community/client'
const CommunityApp = lazy(() => import('./community/CommunityApp'))
const AuthPage = lazy(() => import('./pages/AuthPage').then(m => ({default:m.AuthPage})))
const AdminPage = lazy(() => import('./pages/AdminPage').then(m => ({default:m.AdminPage})))
const ConsultPage = lazy(() => import('./pages/ConsultPage').then(m => ({default:m.ConsultPage})))
const SparkPage = lazy(() => import('./pages/SparkPage').then(m => ({default:m.SparkPage})))
const DevPage = lazy(() => import('./pages/DevPage').then(m => ({default:m.DevPage})))
const IdeaDetailPage = lazy(() => import('./pages/IdeaDetailPage').then(m => ({default:m.IdeaDetailPage})))
const IdeaListPage = lazy(() => import('./pages/IdeaListPage').then(m => ({default:m.IdeaListPage})))
const MediaContentPage = lazy(() => import('./pages/MediaContentPage').then(m => ({default:m.MediaContentPage})))
const OrdersPage = lazy(() => import('./pages/OrdersPage').then(m => ({default:m.OrdersPage})))
const SettingsPage = lazy(() => import('./pages/SettingsPage').then(m => ({default:m.SettingsPage})))
const StudioPage = lazy(() => import('./pages/StudioPage').then(m => ({default:m.StudioPage})))
const IdeaSynthesisPage = lazy(() => import('./pages/IdeaSynthesisPage').then(m => ({default:m.IdeaSynthesisPage})))
const ResourcesPage = lazy(() => import('./pages/ResourcesPages').then(m => ({default:m.ResourcesPage})))

const THEME_KEY = 'ideabox.theme'

export default function App() {
  const language = useLanguage()
  const [user, setUser] = useState<User | null>(null)
  const [personalEdition, setPersonalEdition] = useState(false)
  const [checking, setChecking] = useState(true)
  const [startupFailed, setStartupFailed] = useState(false)
  const [authNotice, setAuthNotice] = useState('')
  const [noticeVersion, setNoticeVersion] = useState(0)
  const sessionVersion = useRef(0)
  const loggingOut = useRef(false)
  const location = useLocation()
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 640px)').matches)
  useEffect(() => { const media = window.matchMedia('(max-width: 640px)'); const update = () => { setCompact(media.matches); setMobileNavOpen(false) }; media.addEventListener('change', update); return () => media.removeEventListener('change', update) }, [])
  useEffect(() => { setMobileNavOpen(false) }, [location.pathname, location.search])
  const [theme, setTheme] = useState(() => {
    const saved = localStorage.getItem(THEME_KEY)
    return saved && ['starry', 'glass', 'notion', 'brutal'].includes(saved) ? saved : 'starry'
  })
  useInterfaceEffects(theme, location.key)

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem(THEME_KEY, theme)
  }, [theme])

  useEffect(() => {
    document.documentElement.lang = language
    document.title = tr('SparkWright · 让灵感成为作品')
  }, [language])

  // 个人版获取本地工作区；多人版向服务端确认会话。
  useEffect(() => {
    let active = true
    const refresh = () => {
      const version = ++sessionVersion.current
      return api.get('/api/auth/me')
        .then(async (r: { user: User | null; personalEdition: boolean }) => {
          const settings = r.user ? await api.get('/api/settings').catch(() => null) : null
          if (active && version === sessionVersion.current) {
            setPersonalEdition(r.personalEdition === true)
            setStartupFailed(false)
            if (r.user) setLanguage(validLanguage(settings?.language) ? settings.language : 'zh-CN')
            setUser(r.user)
          }
        })
        .catch(() => { if (active && version === sessionVersion.current) { setUser(null); setStartupFailed(true) } })
        .finally(() => { if (active && version === sessionVersion.current) setChecking(false) })
    }
    const onDenied = (event: Event) => {
      if (loggingOut.current) return
      setAuthNotice((event as CustomEvent<{ message: string }>).detail.message)
      setChecking(true)
      void refresh()
    }
    void refresh()
    window.addEventListener('sparkwright:auth-refresh', onDenied)
    return () => { active = false; window.removeEventListener('sparkwright:auth-refresh', onDenied) }
  }, [])

  if (checking) {
    return (
      <div className="welcome">
        <div className="welcome-card muted">{tr("正在进入 SparkWright…")}</div>
      </div>
    )
  }

  if (!user && (personalEdition || startupFailed)) return <div className="welcome"><div className="welcome-card"><p role="alert">{tr('网络连接失败，请检查网站服务后重试。')}</p><button className="btn" onClick={() => window.location.reload()}>{tr('重试')}</button></div></div>

  if (!user) return <Suspense fallback={null}><AuthPage registrationEnabled={!personalEdition} notice={authNotice} onAuthed={async (next) => {
    const version = ++sessionVersion.current
    setChecking(true); setAuthNotice('')
    const settings = await api.get('/api/settings').catch(() => null)
    if (version === sessionVersion.current) {
      setLanguage(validLanguage(settings?.language) ? settings.language : 'zh-CN')
      setUser(next); setChecking(false)
    }
  }} /></Suspense>

  const logout = async () => {
    loggingOut.current = true
    const version = ++sessionVersion.current
    setChecking(true)
    try {
      await api.post('/api/auth/logout')
    } finally {
      loggingOut.current = false
      if (version === sessionVersion.current) { setUser(null); setAuthNotice(''); setChecking(false) }
    }
  }

  const navigation = <>
        <nav id="primary-navigation" className="nav" aria-label={tr('主要导航')}>
          <NavLink to="/" end>
            {tr("✦ 灵感酱")}</NavLink>
          <div className="nav-group">
            <div className="group-label">{tr("灵感")}</div>
            <NavLink to="/ideas">{tr("📝 我的灵感")}</NavLink>
            <NavLink to="/plaza">{tr("🌐 灵感广场")}</NavLink>
            <NavLink to="/leaderboard">{ct('灵感排行榜','Idea leaderboard')}</NavLink>
            <NavLink to="/community">{ct('公共社区','Public community')}</NavLink>
            <NavLink to="/community/announcements">{ct('社区公告','Community announcements')}</NavLink>
            <NavLink to="/synthesis">{tr("🧬 灵感合成")}</NavLink>
          </div>
          <div className="nav-group">
            <div className="group-label">{tr("社媒")}</div>
            <NavLink to="/studio">{tr("🎬 自媒体制作")}</NavLink>
          </div>
          <div className="nav-group">
            <div className="group-label">{tr("开发")}</div>
            <NavLink to="/dev">{tr("🛠️ 开发工程")}</NavLink>
          </div>
          <div className="nav-group">
            <div className="group-label">{tr("目标")}</div>
            <NavLink to="/orders">{tr("💰 需求商单")}</NavLink>
          </div>
        </nav>
        <div id="sidebar-account" className="sidebar-foot">
          <nav className="nav">
            {!personalEdition && isAdmin(user) && <NavLink to="/admin">{tr("🛡️ 管理后台")}</NavLink>}
            <NavLink to="/settings">{tr("⚙️ 设置")}</NavLink>
            <NavLink to="/feedback">{tr('💬 用户反馈')}</NavLink>
          </nav>
          {personalEdition ? <div className="user-chip"><span className="muted">{tr('本地个人版')}</span></div> : <div className="user-chip">
            <span className="avatar">{user.name.slice(0, 1)}</span>
            <div className="user-chip-text">
              <b>{user.name}</b>
              <button className="link-btn" onClick={logout}>
                {tr("退出登录")}</button>
            </div>
          </div>}
        </div>
  </>

  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">{tr('跳到主要内容')}</a>
      {!compact && <aside className="sidebar"><div className="logo logo-brand"><BrandMark /><small>{tr('记录每一个突发奇想')}</small></div>{navigation}</aside>}
      {compact && mobileNavOpen && <Phase2Dialog variant="drawer" title={tr('导航菜单')} onClose={() => setMobileNavOpen(false)}><div className="mobile-navigation" onClick={event => { if ((event.target as HTMLElement).closest('a')) setMobileNavOpen(false) }}>{navigation}<SupportAuthor /></div></Phase2Dialog>}

      <main id="main-content" className="main" tabIndex={-1}>
        <NotificationCenter communityAnnouncements={personalEdition} key={`${user.id}:${user.role}`} user={user} refreshVersion={noticeVersion} actions={<><SupportAuthor /><NavLink className="btn btn-ghost" to="/consult">{tr("咨询接单管道")}</NavLink></>} leading={compact ? <><button className="sw-icon-button mobile-nav-toggle" aria-label={tr(mobileNavOpen ? '收起导航' : '导航菜单')} aria-expanded={mobileNavOpen} aria-controls="primary-navigation" onClick={() => setMobileNavOpen(open => !open)}><svg width="24" height="24" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8" className={mobileNavOpen ? 'menu-open' : ''} aria-hidden="true"><path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/></svg></button><BrandMark /></> : undefined} />
        {tr(authNotice) && <div className="page" style={{ paddingBottom: 0 }}><p className="error-text" role="alert">{tr(authNotice)}</p></div>}
        <Suspense fallback={<p role="status">{tr('正在加载…')}</p>}><Routes>
          <Route path="/" element={<SparkPage key={user.id} />} />
          <Route path="/ideas" element={<IdeaListPage user={user} />} />
          <Route path="/ideas/:id" element={<IdeaDetailPage user={user} />} />
          <Route path="/media" element={<Navigate to="/studio?tab=archive" replace />} />
          <Route path="/media/:mediaId/content" element={<MediaContentPage user={user} />} />
          <Route path="/studio" element={<StudioPage user={user} />} />
          <Route path="/wishes/*" element={<Navigate to="/orders" replace />} />
          <Route path="/consult" element={<ConsultPage user={user} />} />
          <Route path="/dev" element={<DevPage user={user} />} />
          <Route path="/orders" element={<OrdersPage user={user} />} />
          <Route path="/orders/resources" element={<ResourcesPage kind="orders" />} />
          <Route path="/settings/api-resources" element={<ResourcesPage kind="api" />} />
          <Route path="/synthesis" element={<IdeaSynthesisPage key={user.id} />} />
          <Route path="/community" element={<CommunityApp key="community" />} />
          <Route path="/community/announcements" element={<CommunityApp key="announcements" initialTab="announcements"/>} />
          <Route path="/community/submit" element={<CommunityApp key="submit" initialTab="submit" />} />
          <Route path="/leaderboard" element={<CommunityApp key="leaderboard" initialTab="leaderboard" />} />
          <Route path="/feedback" element={<CommunityApp key="feedback" initialTab="feedback" />} />
          <Route path="/feedback/:id" element={<CommunityApp key="feedback" initialTab="feedback" />} />
          <Route path="/plaza" element={<CommunityApp key="plaza" initialTab="plaza" />} />
          <Route path="/plaza/:id" element={<CommunityApp key="plaza" initialTab="plaza" />} />
          <Route path="/channels" element={<CommunityApp key="chat" />} />
          <Route path="/channels/:channelId" element={<CommunityApp key="chat" />} />
          <Route path="/chat" element={<Navigate to="/plaza" replace />} />
          <Route path="/chat/:channelId" element={<Navigate to="/plaza" replace />} />
          <Route path="/admin" element={personalEdition ? <Navigate to="/settings" replace /> : <AdminPage key={`${user.id}:${user.role}`} user={user} onAnnouncementsChanged={() => setNoticeVersion((version) => version + 1)}
            onRoleChanged={() => window.dispatchEvent(new CustomEvent('sparkwright:auth-refresh', { detail: { message: '账号角色已更新，权限已重新确认。' } }))} />} />
          <Route path="/settings" element={<SettingsPage key={user.id} user={user} theme={theme} setTheme={setTheme} />} />
          <Route path="*" element={<div className="page">{tr("页面不存在")}</div>} />
        </Routes></Suspense>
      </main>
    </div>
  )
}
