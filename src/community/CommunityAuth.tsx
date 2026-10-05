// SPDX-License-Identifier: MPL-2.0
import { useState } from 'react'
import { BrandMark } from '../components/BrandMark'
import { setLanguage, useLanguage, tr } from '../i18n'
import { community, ct, type CommunityUser } from './client'
export function CommunityAuth({onAuthed,onOffline}:{onAuthed:(user:CommunityUser)=>void;onOffline?:()=>void}) {
  useLanguage()
  const [mode,setMode]=useState<'login'|'register'>('login'),[email,setEmail]=useState(''),[password,setPassword]=useState(''),[name,setName]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('')
  return <div className="welcome"><div className="welcome-card">
    <div className="auth-brand"><BrandMark animated={!!onOffline} /></div>
    <h1>{ct('一起，让灵感发生','Make room for inspiration')}</h1>
    <p className="muted">{ct('登录社区，和大家聊天、分享灵感。','Join the community to chat and share ideas.')}</p>
    <div className="community-language"><button className="link-btn" onClick={()=>setLanguage('zh-CN')}>中文</button><span aria-hidden="true"> / </span><button className="link-btn" onClick={()=>setLanguage('en')}>English</button></div>
    <div className="auth-tabs">{(['login','register'] as const).map(key=><button type="button" key={key} disabled={busy} aria-pressed={mode===key} className={`auth-tab ${mode===key?'active':''}`} onClick={()=>{setMode(key);setError('')}}>{key==='login'?ct('登录','Sign in'):ct('注册','Register')}</button>)}</div>
    <form onSubmit={async e=>{e.preventDefault();if(busy)return;setBusy(true);setError('');try{const r=await community.post(`/api/community/auth/${mode}`,{email,password,...(mode==='register'?{name}:{})});setPassword('');onAuthed(r.user)}catch(e){setError((e as Error).message)}finally{setBusy(false)}}}>
      {mode==='register'&&<div className="form-field"><label htmlFor="community-name">{ct('昵称','Nickname')}</label><input id="community-name" autoComplete="nickname" maxLength={20} required value={name} onChange={e=>setName(e.target.value)} disabled={busy}/></div>}
      <div className="form-field"><label htmlFor="community-email">{ct('邮箱','Email')}</label><input id="community-email" type="email" autoComplete="username" maxLength={254} required value={email} onChange={e=>setEmail(e.target.value)} disabled={busy}/></div>
      <div className="form-field"><label htmlFor="community-password">{ct('密码','Password')}</label><input id="community-password" type="password" autoComplete={mode==='login'?'current-password':'new-password'} minLength={6} maxLength={72} required value={password} onChange={e=>setPassword(e.target.value)} disabled={busy}/></div>
      {error&&<p className="error-text" role="alert">{tr(error)}</p>}
      <button className="btn btn-primary auth-submit" disabled={busy}>{busy?ct('请稍候…','Please wait…'):mode==='login'?ct('登录社区','Sign in'):ct('注册并登录','Register and sign in')}</button>
    </form>
    {mode==='register'&&<p className="muted small">{ct('不发送邮箱验证码。邮箱仅用于登录，不提供未经验证的邮箱找回。','No email code is sent. Email is a login identifier; unverified email recovery is unavailable.')}</p>}
    {onOffline&&<><button className="btn btn-ghost community-offline" onClick={onOffline}>{ct('先使用本地个人功能','Use my local workspace')}</button><p className="muted small">{ct('私人数据保存在电脑。社区离线时仍可创作。','Private data stays on your computer. Create even while the community is offline.')}</p></>}
  </div></div>
}
