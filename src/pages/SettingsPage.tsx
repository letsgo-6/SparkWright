// SPDX-License-Identifier: MPL-2.0
import { tr, setLanguage, useLanguage, type Language } from '../i18n/index'
import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import type { AiSettings, User } from '../types'
import { isAdmin } from '../types'
import { Link } from 'react-router-dom'
import { MotionTabs } from '../components/MotionTabs'
import { PersonalDataExport } from '../components/PersonalDataExport'
import { fmtDate, fmtTime } from '../utils'

const THEMES = [
  { key: 'starry', name: '星空', desc: '深邃星蓝 · 清晰文字 · 灵动反馈' },
  { key: 'glass', name: '流光玻璃', desc: '渐变光晕 · 柔和卡片 · 空间感' },
  { key: 'notion', name: '极简笔记', desc: '黑白灰 · 紧凑画布 · 低装饰' },
  { key: 'brutal', name: '硬朗印刷', desc: '粗边框 · 硬阴影 · 高饱和撞色' },
]

const SOURCE_META: Record<string, { label: string; cls: string }> = {
  user: { label: '个人 Key', cls: 'src-user' },
  platform: { label: '平台默认', cls: 'src-platform' },
  none: { label: '未配置', cls: 'src-none' },
}

export function SettingsPage({ user, theme, setTheme }: { user: User; theme: string; setTheme: (t: string) => void }) {
  const [section, setSection] = useState<'appearance'|'ai'|'data'>('appearance')
  const language = useLanguage()
  const languageRequest = useRef<AbortController | null>(null)
  const [languageBusy, setLanguageBusy] = useState(false)
  const [languageError, setLanguageError] = useState('')
  const [s, setS] = useState<AiSettings | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [flash, setFlash] = useState('')
  const [revealed, setRevealed] = useState(false)
  const [fullKey, setFullKey] = useState<string | null>(null)
  const [settingsError, setSettingsError] = useState('')
  const [saveError, setSaveError] = useState('')
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    setSettingsError('')
    api.get('/api/settings', controller.signal).then((v) => {
      const st = v as AiSettings
      setS(st)
      setBaseUrl(st.base_url || '')
      setModel(st.model || '')
    }).catch((error) => { if (!controller.signal.aborted) setSettingsError(error.message) })
    return () => { controller.abort(); languageRequest.current?.abort() }
  }, [revision])

  const changeLanguage = async (next: Language) => {
    if (languageBusy || next === language) return
    const previous = language, controller = new AbortController()
    languageRequest.current = controller
    setLanguageBusy(true); setLanguageError(''); setLanguage(next)
    try {
      const settings = await api.put('/api/settings', { language: next }, controller.signal) as AiSettings
      if (!controller.signal.aborted) setS(settings)
    } catch (error) {
      if (!controller.signal.aborted) { setLanguage(previous); setLanguageError((error as Error).message) }
    } finally { if (!controller.signal.aborted) setLanguageBusy(false) }
  }

  const toggleReveal = async () => {
    if (revealed) {
      setRevealed(false)
      return
    }
    if (fullKey === null) {
      try {
        const r: any = await api.get('/api/settings/reveal')
        setFullKey(r.apiKey || '')
      } catch {
        setFullKey('')
      }
    }
    setRevealed(true)
  }

  const save = async (extra: Record<string, unknown> = {}) => {
    setBusy(true)
    setFlash('')
    setSaveError('')
    try {
      const next: any = { baseUrl: baseUrl.trim(), model: model.trim(), ...extra }
      if (apiKey.trim()) next.apiKey = apiKey.trim()
      const st = (await api.put('/api/settings', next)) as AiSettings
      setS(st)
      setApiKey('')
      setRevealed(false)
      setFullKey(null)
      setFlash('已保存 ✓')
    } catch (e: any) {
      setSaveError(e.message)
    } finally {
      setBusy(false)
    }
  }

  const source = s ? SOURCE_META[s.keySource] : SOURCE_META.none
  const showModel = s?.model || (s?.keySource === 'platform' ? s?.platformModel : null)

  return (
    <div className="page settings-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{tr("设置")}</h1>
          <p className="page-sub">{tr("配置 AI 服务、切换界面风格、查看数据说明。")}</p>
        </div>
      </div>

      <div className="settings-grid settings-sections">
        <MotionTabs vertical panelId="settings-section-content" label={tr('设置分类')} value={section} onChange={setSection} items={[{value:'appearance',label:tr('外观与语言')},{value:'ai',label:tr('AI 服务')},{value:'data',label:tr('数据与帮助')}]} />
        <div className="settings-left" id="settings-section-content" role="tabpanel" aria-label={tr(section==='appearance'?'外观与语言':section==='ai'?'AI 服务':'数据与帮助')}>
          {section === 'appearance' && <>
          <div className="settings-card">
            <h2>{tr("🎨 界面风格")}</h2>
            <p className="muted small">{tr("星空为默认外观，原有三种主题仍可选择；只改变界面，不影响任何数据。")}</p>
            <div className="theme-grid" role="group" aria-label={tr('界面风格')}>
              {THEMES.map((t) => (
                <button key={t.key} type="button" aria-pressed={theme === t.key} className={`theme-card ${theme === t.key ? 'active' : ''}`} onClick={() => setTheme(t.key)}>
                  <span className={`theme-preview ${t.key}`} aria-hidden="true">
                    <i className="tp-dot" />
                    <i className="tp-line" />
                    <i className="tp-line short" />
                    <i className="tp-block" />
                  </span>
                  <b>{tr(t.name)}</b>
                  <small>{tr(t.desc)}</small>
                  {theme === t.key && <span className="theme-check">{tr("当前 ✓")}</span>}
                </button>
              ))}
            </div>
          </div>

          <div className="settings-card">
            <h2>{tr('界面语言')}</h2>
            <p className="muted small">{tr('语言保存到当前账号；用户内容和 AI 原文保持原样。')}</p>
            <label className="form-field">{tr('语言')}
              <select aria-label={tr('界面语言')} value={language} onChange={(event) => void changeLanguage(event.target.value as Language)} disabled={languageBusy}>
                <option value="zh-CN">中文</option><option value="en">English</option>
              </select>
            </label>
            {languageBusy && <p className="muted small" role="status">{tr('正在保存语言…')}</p>}
            {tr(languageError) && <p className="error-text" role="alert">{tr(languageError)}</p>}
          </div>
          </>}
          {section === 'ai' && <>
          <form className="settings-card ai-settings" onSubmit={(event) => { event.preventDefault(); void save() }}>
            <h2>{tr("✨ AI 服务")}</h2>
            {settingsError && <p className="error-text" role="alert">{tr(settingsError)} <button type="button" className="link-btn" onClick={() => setRevision((value) => value + 1)}>{tr('重试')}</button></p>}
            {s && s.keySource === 'none' && (
              <div className="hint-banner">
                {tr("平台没有预置默认模型，填入你自己的 API Key 后即可使用 AI 功能。服务需提供 OpenAI 兼容接口，模型名称与实际额度请以服务商官网为准。")}</div>
            )}
            <div className="form-field">
              <label htmlFor="settings-base-url">{tr("API 地址（Base URL）")}</label>
              <input id="settings-base-url" placeholder="https://open.bigmodel.cn/api/paas/v4" disabled={busy || !s} value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); setFlash('') }} />
            </div>
            <div className="form-field">
              <label htmlFor="settings-api-key">API Key {s?.hasKey && <span className="muted small">{tr("（已保存，留空则不修改）")}</span>} <Link className="link" to="/settings/api-resources">{tr("获取 API Key →")}</Link></label>
              <input id="settings-api-key" type="password" autoComplete="off" disabled={busy || !s} placeholder={s?.hasKey ? '••••••••' : tr("sk-… 或平台签发的 Key")} value={apiKey} onChange={(e) => { setApiKey(e.target.value); setFlash('') }} />
            </div>
            <div className="form-field">
              <label htmlFor="settings-model">{tr("模型名称")}</label>
              <input id="settings-model" placeholder="glm-4-flash" disabled={busy || !s} value={model} onChange={(e) => { setModel(e.target.value); setFlash('') }} />
            </div>
            <div className="panel-actions">
              <button type="submit" className="btn btn-primary" disabled={busy || !s}>
                {tr(busy ? '保存中…' : '保存')}</button>
              {s?.hasKey && (
                <button type="button" className="btn btn-danger-ghost" onClick={() => save({ clearKey: true })} disabled={busy}>
                  {tr("清除已保存的 Key")}</button>
              )}
              {tr(flash) && <span className="save-flash" role="status">{tr(flash)}</span>}
            </div>
            {saveError && <p className="error-text" role="alert">{tr(saveError)}</p>}
            <p className="muted small">
              {tr("Key 只保存在你本地的 SQLite 数据库中，请求 AI 时由本机服务端直连服务商，不经过任何第三方。")}</p>
          </form>

          </>}
          {section === 'data' && <>
          <div className="settings-card">
            <h2>{tr("📦 数据说明")}</h2>
            <p className="small">
              {tr("应用数据保存在本机")}<code>SparkWright/data/ideabox.db</code>{tr("（SQLite）。备份前请正常关闭应用，或使用 SQLite 一致性备份；运行时只复制主文件可能遗漏 WAL 中的数据。AI 功能会将相关内容发送给你配置的模型服务。")}</p>
            <p className="small muted">{tr("SparkWright · 让灵感成为作品")}</p>
          </div>
          {isAdmin(user) && <div className="settings-card"><h2>{tr("管理后台")}</h2><p className="muted small">{tr("账号、公告和数据库备份已集中到后台。")}</p><Link className="btn btn-ghost" to="/admin">{tr("进入管理后台")}</Link></div>}
          <PersonalDataExport key={`export-${user.id}`} />
          <div className="settings-card"><h2>{tr('用户反馈')}</h2><p className="muted small">{tr('提交 Bug、建议或问题，管理员将在这里处理。')}</p><Link className="btn btn-ghost" to="/feedback">{tr('反馈问题')}</Link></div>
          </>}
        </div>

        {section === 'ai' && <div className="settings-card config-card">
          <div className="panel-head">
            <h2>{tr("🧷 当前配置")}</h2>
            <span className={`src-badge ${source.cls}`}>{tr(source.label)}</span>
          </div>

          {s && (
            <div className="config-body">
              <div className="config-row">
                <span className="config-label">{tr("模型名称")}</span>
                <b className="config-model">{showModel || tr("未设置")}</b>
              </div>
              <div className="config-row">
                <span className="config-label">{tr("API 地址")}</span>
                <span className="config-url">{s.base_url || (s.keySource === 'platform' ? tr('平台默认地址') : tr('未设置'))}</span>
              </div>
              <div className="config-row">
                <span className="config-label">API Key</span>
                <span className="key-line">
                  <code className="key-code">
                    {s.hasKey ? (revealed ? fullKey || tr('（读取失败）') : s.maskedKey) : tr("（未保存）")}
                  </code>
                  {s.hasKey && (
                    <button className="chip" onClick={toggleReveal}>
                      {revealed ? tr("🙈 隐藏") : tr("👁 显示")}
                    </button>
                  )}
                </span>
              </div>
              {s.updated_at && (
                <p className="muted small">
                  {tr("上次更新：")}{fmtDate(s.updated_at)} {fmtTime(s.updated_at)}
                </p>
              )}
              <div className="config-tip">
                {tr("💡 想切换大模型？在左侧改「模型名称」或「API Key」后点保存即可，新 Key 会替换旧 Key；右侧立即刷新。")}</div>
            </div>
          )}
          {!s && <p className="muted small">{tr("加载中…")}</p>}
        </div>}
      </div>
    </div>
  )
}
