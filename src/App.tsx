// SPDX-License-Identifier: MPL-2.0
import { tr, setLanguage, useLanguage, validLanguage } from './i18n/index'
import { useEffect, useRef, useState } from 'react'
import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom'
import { api } from './api'
import type { User } from './types'
import { isAdmin } from './types'
import { AdminPage } from './pages/AdminPage'
import { AuthPage } from './pages/AuthPage'
import { ChatPage } from './pages/ChatPage'
import { ConsultPage } from './pages/ConsultPage'
import { SparkPage } from './pages/SparkPage'
import { DevPage } from './pages/DevPage'
import { IdeaDetailPage } from './pages/IdeaDetailPage'
import { IdeaListPage } from './pages/IdeaListPage'
import { MediaContentPage } from './pages/MediaContentPage'
import { OrdersPage } from './pages/OrdersPage'
import { PlazaDetailPage } from './pages/PlazaDetailPage'
import { PlazaPage } from './pages/PlazaPage'
import { SettingsPage } from './pages/SettingsPage'
import { StudioPage } from './pages/StudioPage'
import { WishesPage } from './pages/WishesPage'
import { NotificationCenter } from './components/NotificationCenter'
import { SupportAuthor } from './components/SupportAuthor'
import { IdeaSynthesisPage } from './pages/IdeaSynthesisPage'
import { ResourcesPage } from './pages/ResourcesPages'
import { FeedbackPage } from './pages/FeedbackPage'
import { LeaderboardNav, LeaderboardPage } from './pages/LeaderboardPage'
import { Phase2Dialog } from './components/Phase2Dialog'
import { BrandMark } from './components/BrandMark'
import { useInterfaceEffects } from './hooks/useInterfaceEffects'

const THEME_KEY = 'ideabox.theme'

export default function App() {
  const language = useLanguage()
  const [user, setUser] = useState<User | null>(null)
  const [personalEdition, setPersonalEdition] = useState(false)
  const [checking, setChecking] = useState(true)
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

  // 启动时向服务端确认会话（httpOnly Cookie 里的 JWT）
  useEffect(() => {
    let active = true
    const refresh = () => {
      const version = ++sessionVersion.current
      return api.get('/api/auth/me')
        .then(async (r: { user: User | null; personalEdition: boolean }) => {
          const settings = r.user ? await api.get('/api/settings').catch(() => null) : null
          if (active && version === sessionVersion.current) {
            setPersonalEdition(r.personalEdition === true)
            if (r.user) setLanguage(validLanguage(settings?.language) ? settings.language : 'zh-CN')
            setUser(r.user)
          }
        })
        .catch(() => { if (active && version === sessionVersion.current) setUser(null) })
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

  if (!user) return <AuthPage registrationEnabled={!personalEdition} notice={authNotice} onAuthed={async (next) => {
    const version = ++sessionVersion.current
    setChecking(true); setAuthNotice('')
    const settings = await api.get('/api/settings').catch(() => null)
    if (version === sessionVersion.current) {
      setLanguage(validLanguage(settings?.language) ? settings.language : 'zh-CN')
      setUser(next); setChecking(false)
    }
  }} />

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
            <LeaderboardNav key={user.id} />
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
            <NavLink to="/wishes">{tr("📺 心仪视频作品")}</NavLink>
            <NavLink to="/orders">{tr("💰 需求商单")}</NavLink>
          </div>
        </nav>
        <div id="sidebar-account" className="sidebar-foot">
          <nav className="nav">
            {!personalEdition && isAdmin(user) && <NavLink to="/admin">{tr("🛡️ 管理后台")}</NavLink>}
            <NavLink to="/settings">{tr("⚙️ 设置")}</NavLink>
            <NavLink to="/feedback">{tr('💬 用户反馈')}</NavLink>
          </nav>
          <div className="user-chip">
            <span className="avatar">{user.name.slice(0, 1)}</span>
            <div className="user-chip-text">
              <b>{user.name}</b>
              <button className="link-btn" onClick={logout}>
                {tr("退出登录")}</button>
            </div>
          </div>
        </div>
  </>

  return (
    <div className="shell">
      <a className="skip-link" href="#main-content">{tr('跳到主要内容')}</a>
      {!compact && <aside className="sidebar"><div className="logo logo-brand"><BrandMark /><small>{tr('记录每一个突发奇想')}</small></div>{navigation}</aside>}
      {compact && mobileNavOpen && <Phase2Dialog variant="drawer" title={tr('导航菜单')} onClose={() => setMobileNavOpen(false)}><div className="mobile-navigation" onClick={event => { if ((event.target as HTMLElement).closest('a')) setMobileNavOpen(false) }}>{navigation}<SupportAuthor /></div></Phase2Dialog>}

      <main id="main-content" className="main" tabIndex={-1}>
        <NotificationCenter key={`${user.id}:${user.role}`} user={user} refreshVersion={noticeVersion} actions={<><SupportAuthor /><NavLink className="btn btn-ghost" to="/consult">{tr("咨询接单管道")}</NavLink></>} leading={compact ? <><button className="sw-icon-button mobile-nav-toggle" aria-label={tr(mobileNavOpen ? '收起导航' : '导航菜单')} aria-expanded={mobileNavOpen} aria-controls="primary-navigation" onClick={() => setMobileNavOpen(open => !open)}><svg width="24" height="24" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="1.8" className={mobileNavOpen ? 'menu-open' : ''} aria-hidden="true"><path d="M4 6h16"/><path d="M4 12h16"/><path d="M4 18h16"/></svg></button><BrandMark /></> : undefined} />
        {tr(authNotice) && <div className="page" style={{ paddingBottom: 0 }}><p className="error-text" role="alert">{tr(authNotice)}</p></div>}
        <Routes>
          <Route path="/" element={<SparkPage key={user.id} />} />
          <Route path="/ideas" element={<IdeaListPage user={user} />} />
          <Route path="/ideas/:id" element={<IdeaDetailPage user={user} />} />
          <Route path="/media" element={<Navigate to="/studio?tab=archive" replace />} />
          <Route path="/media/:mediaId/content" element={<MediaContentPage user={user} />} />
          <Route path="/studio" element={<StudioPage user={user} />} />
          <Route path="/wishes" element={<WishesPage user={user} />} />
          <Route path="/consult" element={<ConsultPage user={user} />} />
          <Route path="/dev" element={<DevPage user={user} />} />
          <Route path="/orders" element={<OrdersPage user={user} />} />
          <Route path="/orders/resources" element={<ResourcesPage kind="orders" />} />
          <Route path="/settings/api-resources" element={<ResourcesPage kind="api" />} />
          <Route path="/synthesis" element={<IdeaSynthesisPage key={user.id} />} />
          <Route path="/leaderboard" element={<LeaderboardPage key={user.id} />} />
          <Route path="/feedback" element={<FeedbackPage key={user.id} />} />
          <Route path="/feedback/:id" element={<FeedbackPage key={user.id} />} />
          <Route path="/plaza" element={<PlazaPage user={user} />} />
          <Route path="/plaza/:id" element={<PlazaDetailPage user={user} />} />
          <Route path="/channels" element={<ChatPage user={user} />} />
          <Route path="/channels/:channelId" element={<ChatPage user={user} />} />
          <Route path="/chat" element={<Navigate to="/plaza" replace />} />
          <Route path="/chat/:channelId" element={<Navigate to="/plaza" replace />} />
          <Route path="/admin" element={personalEdition ? <Navigate to="/settings" replace /> : <AdminPage key={`${user.id}:${user.role}`} user={user} onAnnouncementsChanged={() => setNoticeVersion((version) => version + 1)}
            onRoleChanged={() => window.dispatchEvent(new CustomEvent('sparkwright:auth-refresh', { detail: { message: '账号角色已更新，权限已重新确认。' } }))} />} />
          <Route path="/settings" element={<SettingsPage key={user.id} user={user} theme={theme} setTheme={setTheme} />} />
          <Route path="*" element={<div className="page">{tr("页面不存在")}</div>} />
        </Routes>
      </main>
    </div>
  )
}
