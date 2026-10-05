// SPDX-License-Identifier: MPL-2.0
import { lazy, Suspense, useCallback, useEffect, useState } from 'react'
import { BrandMark } from '../components/BrandMark'
import { GitHubSupport } from '../components/GitHubSupport'
import type { NotificationSummary } from '../types'
import { setLanguage, useLanguage, tr } from '../i18n'
import { CommunityAuth } from './CommunityAuth'
import { CommunityChat } from './CommunityChat'
import { CommunityFeed, CommunitySubmission } from './CommunityFeed'
import { CommunityFeedback } from './CommunityFeedback'
import { CommunityAnnouncements } from './CommunityAnnouncements'
import { community, ct, cloudEdition, type CommunityUser } from './client'
const CommunityAdmin=lazy(()=>import('./CommunityAdmin'))
export default function CommunityApp({initialTab='chat'}:{initialTab?:string}){
  const language=useLanguage(),[user,setUser]=useState<CommunityUser|null>(null),[checking,setChecking]=useState(true),[tab,setTab]=useState(initialTab),[error,setError]=useState(''),[summary,setSummary]=useState<NotificationSummary|null>(null),[summaryError,setSummaryError]=useState(''),[noticeVersion,setNoticeVersion]=useState(0)
  const noticesChanged=useCallback(()=>setNoticeVersion(v=>v+1),[])
  const [theme,setTheme]=useState(()=>localStorage.getItem('ideabox.theme')||'starry')
  useEffect(()=>{document.documentElement.dataset.theme=['starry','glass','notion','brutal'].includes(theme)?theme:'starry';localStorage.setItem('ideabox.theme',theme)},[theme])
  useEffect(()=>{setTab(initialTab)},[initialTab])
  useEffect(()=>{const controller=new AbortController();void community.get('/api/community/auth/me',controller.signal).then(r=>{if(!controller.signal.aborted)setUser(r.user)}).catch(e=>{if(!controller.signal.aborted)setError(e.message)}).finally(()=>{if(!controller.signal.aborted)setChecking(false)});const expired=()=>setUser(null);window.addEventListener('sparkwright:community-expired',expired);return()=>{controller.abort();window.removeEventListener('sparkwright:community-expired',expired)}},[])
  useEffect(()=>{
    setSummary(null);setSummaryError('')
    if(!user)return
    let active=true,request:AbortController|null=null
    const poll=async()=>{
      if(document.hidden||request)return
      const current=new AbortController();request=current
      try{
        const [counts,session]=await Promise.all([community.get('/api/notification-summary',current.signal),community.get('/api/community/auth/me',current.signal)])
        if(active&&!current.signal.aborted){setSummary(counts);setSummaryError('');setUser(session.user)}
      }catch(e){if(active&&!current.signal.aborted){setSummary(null);setSummaryError((e as Error).message)}}
      finally{if(request===current)request=null}
    }
    const visible=()=>{if(document.hidden){request?.abort();request=null}else void poll()}
    void poll();const timer=setInterval(()=>void poll(),60000)
    document.addEventListener('visibilitychange',visible)
    return()=>{active=false;request?.abort();clearInterval(timer);document.removeEventListener('visibilitychange',visible)}
  },[user?.id,noticeVersion])
  useEffect(()=>{window.addEventListener('sparkwright:community-notices-changed',noticesChanged);return()=>window.removeEventListener('sparkwright:community-notices-changed',noticesChanged)},[noticesChanged])
  if(checking)return <p role="status" className="welcome">{ct('正在连接社区…','Connecting to community…')}</p>
  if(!user)return <><CommunityAuth onAuthed={u=>{setUser(u);setError('')}}/>{error&&<p className="community-connection-error" role="alert">{tr(error)}</p>}</>
  const tabs=[['chat','公共聊天','Public chat'],['leaderboard','排行榜','Leaderboard'],['plaza','公开灵感','Public ideas'],['announcements','公告','Announcements'],...(!cloudEdition?[['submit','我的社区投稿','My submissions']]:[]),['feedback','反馈','Feedback'],...(user.role!=='user'?[['admin','管理后台','Administration']]:[])]
  return <div className={`community-shell ${cloudEdition?'community-standalone':''}`}><header className="community-header"><BrandMark/><div className="community-account"><span>{user.name} <small>#{user.id}</small></span><button className="link-btn" onClick={async()=>{try{await community.post('/api/community/auth/logout');setUser(null)}catch(e){setError((e as Error).message)}}}>{ct('退出社区','Sign out')}</button></div></header>
    <div className="community-preferences"><label className="sr-only" htmlFor="community-theme">{ct('主题','Theme')}</label><select id="community-theme" value={theme} onChange={e=>setTheme(e.target.value)}>{[['starry','星空','Starry'],['glass','玻璃','Glass'],['notion','简约','Minimal'],['brutal','粗野','Brutalist']].map(([key,zh,en])=><option value={key} key={key}>{ct(zh,en)}</option>)}</select><label className="sr-only" htmlFor="community-language">{ct('语言','Language')}</label><select id="community-language" value={language} onChange={e=>setLanguage(e.target.value==='en'?'en':'zh-CN')}><option value="zh-CN">中文</option><option value="en">English</option></select><span className="muted small" aria-live="polite">{summary&&summary.total_unread>0?`${ct('社区未读','Community unread')}: ${summary.total_unread}`:''}</span></div>
    {summaryError&&<p role="alert" className="error-text">{tr(summaryError)} <button className="link-btn" onClick={noticesChanged}>{ct('重试','Retry')}</button></p>}
    <nav className="community-tabs" aria-label={ct('社区导航','Community navigation')}>{tabs.map(([key,zh,en])=><button key={key} className={`chip ${tab===key?'active':''}`} aria-pressed={tab===key} onClick={()=>{setTab(key);setError('')}}>{ct(zh,en)}{key==='announcements'&&!!summary?.announcements_unread&&<span className="sw-tab-count">{summary.announcements_unread>99?'99+':summary.announcements_unread}</span>}</button>)}</nav>
    <main className="community-content" id="community-content" key={user.id}>{error&&<p role="alert" className="error-text">{tr(error)}</p>}{tab==='chat'&&<CommunityChat/>}{(tab==='leaderboard'||tab==='plaza')&&<CommunityFeed key={tab} kind={tab}/>} {tab==='announcements'&&<CommunityAnnouncements onRead={noticesChanged}/>} {tab==='submit'&&!cloudEdition&&<CommunitySubmission/>}{tab==='feedback'&&<CommunityFeedback/>}{tab==='admin'&&user.role!=='user'&&<Suspense fallback={<p role="status">{ct('正在加载管理后台…','Loading administration…')}</p>}><CommunityAdmin key={user.role} user={user}/></Suspense>}</main>
    <footer className="community-footer"><GitHubSupport/><span className="muted small">{ct('私人创作在电脑，公共分享在这里。','Private creation on your computer. Public sharing here.')}</span></footer>
  </div>
}
