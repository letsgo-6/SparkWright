// SPDX-License-Identifier: MPL-2.0
import { uiText, uiParam, tr } from '../i18n/index'
import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { User } from '../types'
import { BrandMark } from '../components/BrandMark'

export function AuthPage({ onAuthed, notice, registrationEnabled = true }: { onAuthed: (u: User) => void; notice?: string; registrationEnabled?: boolean }) {
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [form, setForm] = useState({ name: '', email: '', password: '' })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [code, setCode] = useState('')
  const [verificationId, setVerificationId] = useState('')
  const [verifiedEmail, setVerifiedEmail] = useState('')
  const [sending, setSending] = useState(false)
  const [mailNotice, setMailNotice] = useState('')
  const [retryAt, setRetryAt] = useState(0)
  const [expiresAt, setExpiresAt] = useState(0)
  const [now, setNow] = useState(Date.now)
  const emailRef = useRef('')
  const sequence = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const submitting = useRef(false)
  useEffect(() => () => { sequence.current++; controller.current?.abort() }, [])
  useEffect(() => {
    if (mode !== 'register' || (!retryAt && !expiresAt)) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [mode, retryAt, expiresAt])
  const remaining = Math.max(0, Math.ceil((retryAt - now) / 1000))
  const normalizedEmail = form.email.trim().toLowerCase()
  const emailValid = normalizedEmail.length <= 254 && /^[^\s@<>,;:"\\]+@[^\s@<>,;:"\\]+\.[^\s@<>,;:"\\]+$/.test(normalizedEmail)
  const clearVerification = () => {
    sequence.current++; controller.current?.abort(); controller.current = null
    setCode(''); setVerificationId(''); setVerifiedEmail(''); setSending(false)
    setMailNotice(''); setErr(''); setRetryAt(0); setExpiresAt(0)
  }
  const sendCode = async () => {
    if (sending || (controller.current && !controller.current.signal.aborted) || remaining > 0 || busy) return
    const email = normalizedEmail
    if (!emailValid) { setErr('请先填写有效邮箱'); return }
    clearVerification()
    const version = sequence.current, request = new AbortController()
    controller.current = request; setSending(true)
    try {
      const result = await api.post('/api/auth/register/send-code', { email }, request.signal) as { verificationId: string; expiresIn: number; retryAfter: number }
      if (request.signal.aborted || version !== sequence.current || emailRef.current.trim().toLowerCase() !== email) return
      const current = Date.now(); setNow(current)
      setVerificationId(result.verificationId); setVerifiedEmail(email)
      setRetryAt(current + result.retryAfter * 1000); setExpiresAt(current + result.expiresIn * 1000)
      setMailNotice('邮件已被发信服务接受，请查收收件箱或垃圾邮件。')
    } catch (error) {
      if (request.signal.aborted || version !== sequence.current) return
      const failure = error as Error & { retryAfter?: number }
      setErr(failure.message)
      if (failure.retryAfter) { const current = Date.now(); setNow(current); setRetryAt(current + failure.retryAfter * 1000) }
    } finally { if (version === sequence.current) { controller.current = null; setSending(false) } }
  }

  const submit = async () => {
    if (submitting.current || busy || sending) return
    if (mode === 'register' && (!verificationId || verifiedEmail !== form.email.trim().toLowerCase() || !/^\d{6}$/.test(code) || Date.now() >= expiresAt)) {
      setErr('请先获取邮件验证码，再填写完整六位码；过期后请重新获取'); return
    }
    submitting.current = true
    setBusy(true)
    setErr('')
    try {
      if (mode === 'register') {
        onAuthed((await api.post('/api/auth/register', { name: form.name.trim(), email: form.email.trim(), password: form.password, verificationId, code })) as User)
      } else {
        onAuthed((await api.post('/api/auth/login', { email: form.email.trim(), password: form.password })) as User)
      }
    } catch (e: any) {
      setErr(e.retryAfter ? uiText('{0}（请 {1} 秒后重试）', [uiParam(e.message), e.retryAfter]) : e.message)
    } finally {
      setBusy(false)
      submitting.current = false
    }
  }

  return (
    <div className="welcome">
      <div className="welcome-card">
        <h1 className="auth-brand"><BrandMark animated /></h1>
        <p className="muted">
          {tr("把每一个突发奇想，变成落地的事。")}<br />
          {tr("记录灵感 · 设定截止 · AI 陪你拆解 · 广场讨论")}</p>

        <div className="auth-tabs">
          <button aria-pressed={mode === 'login'} disabled={busy} className={`auth-tab ${mode === 'login' ? 'active' : ''}`} onClick={() => { clearVerification(); setMode('login') }}>
            {tr("登录")}</button>
          {registrationEnabled && <button aria-pressed={mode === 'register'} disabled={busy} className={`auth-tab ${mode === 'register' ? 'active' : ''}`} onClick={() => { clearVerification(); setMode('register') }}>
            {tr("注册")}</button>}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          {tr(notice) && <p className="error-text" role="alert">{tr(notice)}</p>}
          {mode === 'register' && (
            <div className="form-field">
              <label htmlFor="auth-name">{tr("昵称")}</label>
              <input
                id="auth-name"
                autoComplete="nickname"
                required
                autoFocus
                placeholder={tr("你的昵称")}
                maxLength={20}
                value={form.name}
                disabled={busy}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
          )}
          <div className="form-field">
            <label htmlFor="auth-email">{tr("邮箱")}</label>
            <input
              id="auth-email"
              autoComplete="username"
              autoFocus={mode === 'login'}
              type="email"
              required
              placeholder="you@example.com"
              value={form.email}
              disabled={busy}
              onChange={(e) => { clearVerification(); emailRef.current = e.target.value; setForm({ ...form, email: e.target.value }) }}
            />
          </div>
          <div className="form-field">
            <label htmlFor="auth-password">{tr("密码")}</label>
            <input
              id="auth-password"
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              type="password"
              required
              minLength={6}
              placeholder={tr("至少 6 位")}
              value={form.password}
              disabled={busy}
              onChange={(e) => setForm({ ...form, password: e.target.value })}
            />
          </div>
          {mode === 'register' && <div className="form-field">
            <label htmlFor="auth-code">{tr("邮箱验证码")}</label>
            <div className="auth-code-row"><input id="auth-code" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} required pattern="[0-9]{6}"
              placeholder={tr("六位数字")} value={code} disabled={busy} onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} />
              <button type="button" className="btn btn-ghost" disabled={busy || sending || remaining > 0 || !emailValid} onClick={() => void sendCode()}>
                {sending ? tr("发送中…") : remaining > 0 ? tr("{0} 秒后重发", [remaining]) : tr("发送验证码")}
              </button></div>
            {tr(mailNotice) && <p className="muted small auth-code-hint" role="status">{expiresAt <= now ? tr("验证码已过期，请重新获取。") : tr(mailNotice)}</p>}
          </div>}
          {tr(err) && <p className="error-text" role="alert">{tr(err)}</p>}
          <button type="submit" className="btn btn-primary auth-submit" disabled={busy || sending}>
            {busy ? (mode === 'register' ? tr('注册中…') : tr('登录中…')) : mode === 'register' ? tr("注册并登录") : tr("登录")}
          </button>
        </form>

        {mode === 'register' && (
          <p className="muted small" style={{ marginTop: 12, lineHeight: 1.7 }}>
            {tr("注册前请验证邮箱。昵称与邮箱需唯一，已有账号直接使用邮箱登录。")}</p>
        )}
      </div>
    </div>
  )
}
