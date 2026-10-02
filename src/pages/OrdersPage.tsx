// SPDX-License-Identifier: MPL-2.0
import { Phase2Dialog } from '../components/Phase2Dialog'
import { tr, uiText, locale } from '../i18n/index'
import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import type { OrderLead, OrderMatch, OrderStatus, User } from '../types'
import { fmtDate } from '../utils'

const STATUS_META: Record<OrderStatus, { label: string; cls: string }> = {
  pool: { label: '在池', cls: 'st-incubating' },
  taken: { label: '已接单', cls: 'st-inprogress' },
  passed: { label: '已放弃', cls: 'st-shelved' },
}

const SORTS = [
  { key: 'amount', label: '金额↓' },
  { key: 'deadline', label: '截止最近' },
  { key: 'created', label: '最新' },
]

interface LeadForm {
  title: string
  requirement: string
  url: string
  amount: string
  deadline: string
}

const EMPTY_FORM: LeadForm = { title: '', requirement: '', url: '', amount: '', deadline: '' }

export function OrdersPage({ user }: { user: User }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const statusParam = searchParams.get('status') || 'all'
  const sortParam = searchParams.get('sort') || 'created'

  const [leads, setLeads] = useState<OrderLead[]>([])
  const [stats, setStats] = useState({ poolCount: 0, poolAmount: 0, takenCount: 0, dueSoon: 0 })
  const [loaded, setLoaded] = useState(false)
  const [aiReady, setAiReady] = useState<boolean | null>(null)

  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState<OrderLead | null>(null)
  const [form, setForm] = useState<LeadForm>(EMPTY_FORM)
  const [formErr, setFormErr] = useState('')
  const [busy, setBusy] = useState(false)

  const [delFor, setDelFor] = useState<OrderLead | null>(null)
  const [rawFor, setRawFor] = useState<OrderLead | null>(null)
  const [matchingId, setMatchingId] = useState<number | null>(null)
  const [matchErr, setMatchErr] = useState<Record<number, string>>({})
  const [rematchingAll, setRematchingAll] = useState(false)
  const [flash, setFlash] = useState('')

  const load = () =>
    api
      .get(`/api/orders?status=${statusParam === 'all' ? '' : statusParam}&sort=${sortParam}`)
      .then((r: any) => {
        setLeads(r.items)
        setStats(r.stats)
      })
      .finally(() => setLoaded(true))

  useEffect(() => {
    load()
  }, [statusParam, sortParam])

  useEffect(() => {
    // keySource: user=个人Key platform=平台默认 none=未配置
    api.get('/api/settings').then((r: any) => setAiReady(r.keySource !== 'none'))
  }, [])

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(searchParams)
    if (value && value !== 'all') next.set(key, value)
    else next.delete(key)
    setSearchParams(next, { replace: true })
  }

  const openCreate = () => {
    setEditing(null)
    setForm(EMPTY_FORM)
    setFormErr('')
    setFormOpen(true)
  }

  const openEdit = (o: OrderLead) => {
    setEditing(o)
    setForm({ title: o.title, requirement: o.requirement, url: o.url, amount: String(o.amount), deadline: (o.deadline || '').slice(0, 10) })
    setFormErr('')
    setFormOpen(true)
  }

  const submitForm = async () => {
    const title = form.title.trim()
    const url = form.url.trim()
    if (!title) return setFormErr('请填写开发项目名称')
    if (!/^https?:\/\/\S+/.test(url)) return setFormErr('商单网址必须以 http(s):// 开头')
    setBusy(true)
    setFormErr('')
    try {
      const body = { ...form, amount: form.amount || 0, deadline: form.deadline || null }
      const lead: any = editing ? await api.patch(`/api/orders/${editing.id}`, body) : await api.post('/api/orders', body)
      setFormOpen(false)
      await load()
      // 保存后自动匹配：稍等片刻再刷新匹配区（后端 fire-and-forget）
      if (!editing) {
        setMatchingId(lead.id)
        setTimeout(async () => {
          try {
            await api.get(`/api/orders/${lead.id}/matches`)
          } catch {
            // 匹配失败由卡片重匹配入口兜底
          }
          setMatchingId(null)
          load()
        }, 2500)
      }
    } catch (e: any) {
      setFormErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  const rematch = async (o: OrderLead) => {
    setMatchingId(o.id)
    setMatchErr((m) => ({ ...m, [o.id]: '' }))
    try {
      await api.post(`/api/orders/${o.id}/match`)
    } catch (e: any) {
      setMatchErr((m) => ({ ...m, [o.id]: e.message }))
    } finally {
      setMatchingId(null)
      load()
    }
  }

  const attach = async (o: OrderLead, projectId: number) => {
    await api.post(`/api/orders/${o.id}/attach`, { projectId })
    load()
  }

  const toProject = async (o: OrderLead) => {
    try {
      await api.post(`/api/orders/${o.id}/to-project`)
      load()
    } catch (e: any) {
      alert(tr(e.message))
    }
  }

  const rematchAll = async () => {
    if (rematchingAll) return
    setRematchingAll(true)
    try {
      const r: any = await api.post('/api/orders/rematch-all')
      setFlash(uiText("已重匹配 {0} 条 · 落库 {1} 条匹配", [r.count, r.saved]))
      setTimeout(() => setFlash(''), 3000)
      load()
    } catch (e: any) {
      alert(tr(e.message))
    } finally {
      setRematchingAll(false)
    }
  }

  const setStatus = async (o: OrderLead, status: OrderStatus) => {
    await api.patch(`/api/orders/${o.id}`, { status })
    load()
  }

  const del = async (o: OrderLead) => {
    setDelFor(null)
    try {
      await api.del(`/api/orders/${o.id}`)
      load()
    } catch (e: any) {
      alert(tr("删除失败：{0}", [e.message]))
    }
  }

  const statusTabs: { key: string; label: string }[] = [
    { key: 'all', label: '全部' },
    { key: 'pool', label: '在池' },
    { key: 'taken', label: '已接单' },
    { key: 'passed', label: '已放弃' },
  ]

  return (
    <div className="page orders-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{tr("💰 需求商单")}</h1>
          <p className="page-sub">{tr("存放可接的商单网址，AI 自动匹配你的开发工程。")}</p>
        </div>
        <div className="actions">
          <Link className="btn btn-ghost" to="/orders/resources">{tr("接单平台推荐")}</Link>
          <button className="btn btn-ghost" onClick={rematchAll} disabled={rematchingAll || stats.poolCount === 0}>
            {rematchingAll ? tr("🔄 重匹配中…") : tr("🔄 全局重匹配")}
          </button>
          <button className="btn btn-primary" onClick={openCreate}>{tr("＋ 记商单")}</button>
        </div>
      </div>

      {tr(flash) && <div className="save-flash" style={{ marginBottom: 10 }}>{tr(flash)}</div>}

      <div className="incentive-bar">
        <span>{tr("在池")}<b>{stats.poolCount}</b></span>
        <span>{tr("在池总额")}<b>¥{stats.poolAmount.toLocaleString(locale())}</b></span>
        <span>{tr("已接单")}<b>{stats.takenCount}</b></span>
        <span>{tr("7天内到期")}<b>{stats.dueSoon}</b></span>
      </div>

      <div className="chip-filter">
        {statusTabs.map((t) => (
          <button key={t.key} className={`tab ${statusParam === t.key ? 'active' : ''}`} onClick={() => setParam('status', t.key)}>
            {tr(t.label)}
          </button>
        ))}
        <span className="chip-divider" />
        <span className="muted small">{tr("排序：")}</span>
        <select className="sort-select" value={sortParam} onChange={(e) => setParam('sort', e.target.value)}>
          {SORTS.map((s) => (
            <option key={s.key} value={s.key}>{tr(s.label)}</option>
          ))}
        </select>
      </div>

      {loaded && leads.length === 0 ? (
        <div className="empty">
          <div className="empty-emoji">💰</div>
          <p>{tr("商单池是空的。看到合适的单子就把网址记进来。")}</p>
          <button className="btn btn-primary" onClick={openCreate}>{tr("＋ 记商单")}</button>
        </div>
      ) : (
        <div className="orders-list">
          {leads.map((o) => {
            const st = STATUS_META[o.status]
            return (
              <div key={o.id} className={`panel order-card ${o.is_expired ? 'order-expired' : ''}`}>
                <div className="order-title">{o.title}</div>
                <div className="order-head">
                  <span className="plaza-card-tags">
                    <span className={`status-pill ${st.cls}`}>{tr(st.label)}</span>
                    {o.is_expired && <span className="deadline-chip dl-overdue">{tr("已过期⚠")}</span>}
                    {o.deadline && !o.is_expired && o.status === 'pool' && (
                      <span className={`deadline-chip ${o.days_left !== null && o.days_left <= 7 ? 'dl-soon' : 'dl-ok'}`}>
                        ⏳ {o.days_left !== null && o.days_left >= 0 ? tr("剩{0}天", [o.days_left]) : fmtDate(o.deadline)}
                      </span>
                    )}
                  </span>
                  <b className="order-amount">¥{o.amount.toLocaleString(locale())}</b>
                </div>
                {o.requirement && <p className="order-req">{o.requirement}</p>}
                <a className="order-url" href={o.url} target="_blank" rel="noopener noreferrer">
                  🔗 {o.url}
                </a>

                <details className="order-match context-details"><summary>{tr("匹配工程与依据")} · {o.matches.length}</summary>
                  <div className="order-match-head">
                    <span className="muted small">
                      {tr("🤖 AI 匹配")}{o.matched_at ? `（${fmtDate(o.matched_at)} ${o.matched_at.slice(11, 16)}）` : ''}
                    </span>
                    <span className="plaza-card-tags">
                      {o.match_channel === 'kw+ai' && <span className="plat-chip">{tr("关键词+语义")}</span>}
                      {o.match_channel === 'no_ai' && <span className="plat-chip">{tr("仅关键词（AI 未配置）")}</span>}
                      {o.match_channel === 'parse_failed' && <span className="plat-chip">{tr("仅关键词（语义解析失败）")}</span>}
                      <button className="link-btn" onClick={() => rematch(o)} disabled={matchingId === o.id}>
                        {matchingId === o.id ? tr("匹配中…") : tr("↻ 重匹配")}
                      </button>
                    </span>
                  </div>
                  {matchingId === o.id ? (
                    <p className="muted small">{tr("匹配中…")}</p>
                  ) : o.matches.length > 0 ? (
                    <div className="order-match-list">
                      {o.matches.map((m: OrderMatch, idx: number) => (
                        <div key={m.project_id} className="order-match-row">
                          <span className="order-match-rank">{idx + 1}</span>
                          <span className="order-match-name">{m.project_name}</span>
                          <span className="order-match-bar">
                            <span className="progress">
                              <span className="progress-bar" style={{ width: `${m.score}%` }} />
                            </span>
                          </span>
                          <b className="order-match-score">{m.score}</b>
                          <small className="order-match-split muted">
                            (kw{m.kw_score}/ai{m.ai_score >= 0 ? m.ai_score : '—'})
                          </small>
                          <div className="order-match-hits">
                            {m.hit_terms
                              ? m.hit_terms
                                  .split(',')
                                  .filter(Boolean)
                                  .slice(0, 4)
                                  .map((t) => <span key={t} className="plat-chip">{t}</span>)
                              : null}
                          </div>
                          <small className="order-match-reason">“{m.reasons || tr("关键词命中")}”</small>
                          {idx === 0 && !o.matched_project_id && (
                            <button className="btn btn-ghost btn-sm" onClick={() => attach(o, m.project_id)}>{tr("采纳关联")}</button>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : o.matched_at ? (
                    <p className="muted small">{tr("本次匹配没有合适工程")}{matchErr[o.id] ? ` · ${tr(matchErr[o.id])}` : ''}。</p>
                  ) : aiReady === false ? (
                    <p className="muted small">
                      {tr("未配置 AI Key（关键词匹配仍可用），")}<Link className="link" to="/settings">{tr("去设置 →")}</Link> {tr("配置后可叠加语义评分")}</p>
                  ) : (
                    <p className="muted small">
                      {tr("还没有匹配结果。")}{o.match_raw && <button className="link-btn" onClick={() => setRawFor(o)}>{tr("查看原始返回")}</button>}
                    </p>
                  )}
                  {matchErr[o.id] && <p className="error-text small">{tr(matchErr[o.id])}</p>}
                  {o.match_raw && (
                    <button className="link-btn" onClick={() => setRawFor(o)}>{tr("📄 查看原始返回")}</button>
                  )}
                </details>

                <div className="order-foot">
                  <span className="task-actions">
                    {o.status === 'pool' && <button className="btn btn-ghost btn-sm" onClick={() => setStatus(o, 'taken')}>{tr("接单")}</button>}
                    {o.status === 'pool' && <button className="btn btn-ghost btn-sm" onClick={() => setStatus(o, 'passed')}>{tr("放弃")}</button>}
                    {(o.status === 'pool' || o.status === 'taken') && (
                      <button className="btn btn-ghost btn-sm" onClick={() => toProject(o)}>{tr("按此单建工程")}</button>
                    )}
                    <button className="btn btn-ghost btn-sm" onClick={() => openEdit(o)}>{tr("✎ 编辑")}</button>
                    <button className="btn btn-danger-ghost btn-sm" onClick={() => setDelFor(o)}>{tr("✕ 删除")}</button>
                  </span>
                  {o.matched_project_name && (
                    <Link className="link small" to={`/dev`}>{tr("已关联: 🛠")}{o.matched_project_name} ↗</Link>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {formOpen && (
        <Phase2Dialog variant="drawer" title={tr("✎ 编辑商单")} onClose={() => setFormOpen(false)}>
            <div className="form-field">
              <label>{tr("开发项目名称 *")}</label>
              <input autoFocus placeholder={tr("比如：校园二手书小程序")} value={form.title} maxLength={60} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            </div>
            <div className="form-field">
              <label>{tr("开发需求")}</label>
              <textarea rows={3} placeholder={tr("微信小程序，旧书上架 + 校内自提 + 聊天议价…")} value={form.requirement} onChange={(e) => setForm({ ...form, requirement: e.target.value })} />
            </div>
            <div className="form-field">
              <label>{tr("商单网址 *")}</label>
              <input placeholder="https://…" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
            </div>
            <div className="form-inline">
              <div className="form-field">
                <label>{tr("商单金额（元）")}</label>
                <input type="number" min={0} placeholder="800" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
              </div>
              <div className="form-field">
                <label>{tr("时间限制（可空）")}</label>
                <input type="date" value={form.deadline} onChange={(e) => setForm({ ...form, deadline: e.target.value })} />
              </div>
            </div>
            {tr(formErr) && <p className="error-text">{tr(formErr)}</p>}
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setFormOpen(false)}>{tr("取消")}</button>
              <button className="btn btn-primary" onClick={submitForm} disabled={busy}>
                {busy ? tr("保存中…") : editing ? tr("保存") : tr("保存并自动匹配")}
              </button>
            </div>
        </Phase2Dialog>
      )}

      {delFor && (
        <Phase2Dialog title={tr("删除商单")} onClose={() => setDelFor(null)}>
            <p style={{ lineHeight: 1.7 }}>
              {tr("确定删除「")}<b>{delFor.title}</b>{tr("」？匹配记录会一并删除，且不可恢复。")}</p>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setDelFor(null)}>{tr("取消")}</button>
              <button className="btn btn-danger-ghost" onClick={() => del(delFor)}>{tr("确认删除")}</button>
            </div>
        </Phase2Dialog>
      )}

      {rawFor && (
        <Phase2Dialog variant="drawer" title={tr("📄 AI 原始返回")} onClose={() => setRawFor(null)}>
            <p className="muted small">{tr("匹配时间：")}{rawFor.matched_at ? `${fmtDate(rawFor.matched_at)} ${rawFor.matched_at.slice(11, 16)}` : '—'}</p>
            <pre className="match-raw">{rawFor.match_raw || tr("（空）")}</pre>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setRawFor(null)}>{tr("关闭")}</button>
              <button
                className="btn btn-primary"
                onClick={() => {
                  const o = rawFor
                  setRawFor(null)
                  rematch(o)
                }}
              >
                {tr("↻ 重匹配")}</button>
            </div>
        </Phase2Dialog>
      )}
    </div>
  )
}
