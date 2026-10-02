// SPDX-License-Identifier: MPL-2.0
import { Phase2Dialog } from '../components/Phase2Dialog'
import { tr, locale } from '../i18n/index'
import { useEffect, useState } from 'react'
import { api } from '../api'
import type { ConsultItem, ConsultStatus, User } from '../types'
import { fmtDate } from '../utils'

const COLS: { key: ConsultStatus; label: string }[] = [
  { key: 'talking', label: '💬 洽谈中' },
  { key: 'doing', label: '🔧 进行中' },
  { key: 'delivered', label: '📦 已交付' },
  { key: 'settled', label: '💰 已结款' },
  { key: 'lost', label: '💨 流失' },
]

const todayStr = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function ConsultPage({ user }: { user: User }) {
  const [items, setItems] = useState<ConsultItem[]>([])
  const [stateFilter,setStateFilter]=useState<ConsultStatus>('talking')
  const [loaded, setLoaded] = useState(false)
  const [showNew, setShowNew] = useState(false)
  const [form, setForm] = useState({ client: '', project: '', deliverable: '', amount: '' })
  const [settleFor, setSettleFor] = useState<ConsultItem | null>(null)
  const [settleAmount, setSettleAmount] = useState('')

  const load = () => api.get('/api/consult').then((l) => setItems(l as ConsultItem[]))

  useEffect(() => {
    load()
    setLoaded(true)
  }, [])

  const overdue = (c: ConsultItem) =>
    c.next_follow_up && c.status !== 'settled' && c.status !== 'lost' && c.next_follow_up < todayStr()

  const summary = {
    hours: Math.round(items.reduce((s, i) => s + i.hours, 0) * 10) / 10,
    pending: items.filter((i) => i.status !== 'settled' && i.status !== 'lost').reduce((s, i) => s + (i.amount - i.settled_amount), 0),
    settled: items.reduce((s, i) => s + i.settled_amount, 0),
    totalHours: items.reduce((s, i) => s + i.hours, 0),
  }
  const avgRate = summary.totalHours ? Math.round((summary.settled / summary.totalHours) * 10) / 10 : 0

  const patch = async (id: number, body: Record<string, unknown>) => {
    await api.patch(`/api/consult/${id}`, body)
    load()
  }

  const addHours = async (c: ConsultItem, delta: number) => {
    await api.post(`/api/consult/${c.id}/hours`, { delta })
    load()
  }

  const del = async (c: ConsultItem) => {
    if (!window.confirm(tr("确定删除接单「{0}」？", [c.client]))) return
    await api.del(`/api/consult/${c.id}`)
    load()
  }

  const submitNew = async () => {
    if (!form.client.trim()) return
    await api.post('/api/consult', { ...form, amount: form.amount || 0 })
    setForm({ client: '', project: '', deliverable: '', amount: '' })
    setShowNew(false)
    load()
  }

  const confirmSettle = async () => {
    if (!settleFor) return
    const amt = Number(settleAmount) || 0
    await api.patch(`/api/consult/${settleFor.id}`, { settledAmount: settleFor.settled_amount + amt, status: 'settled' })
    setSettleFor(null)
    load()
  }

  const actionBtn = (c: ConsultItem) => {
    switch (c.status) {
      case 'talking':
        return (
          <>
            <button className="btn btn-ghost btn-sm" onClick={() => patch(c.id, { status: 'doing' })}>{tr("接单 → 进行中")}</button>
            <button className="btn btn-danger-ghost btn-sm" onClick={() => patch(c.id, { status: 'lost' })}>{tr("标记流失")}</button>
          </>
        )
      case 'doing':
        return <button className="btn btn-ghost btn-sm" onClick={() => patch(c.id, { status: 'delivered' })}>{tr("标记已交付")}</button>
      case 'delivered':
        return (
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setSettleFor(c)
              setSettleAmount(String(Math.max(0, c.amount - c.settled_amount)))
            }}
          >
            {tr("确认结款 ¥")}{Math.max(0, c.amount - c.settled_amount)}
          </button>
        )
      default:
        return null
    }
  }

  const followupReminders = items.filter(overdue)

  return (
    <div className="page consult-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{tr("咨询接单管道")}</h1>
          <p className="page-sub">{tr("洽谈 → 交付 → 结款，一屏看清每一单。")}</p>
        </div>
        <div className="actions">
          <button className="btn btn-primary" onClick={() => setShowNew(true)}>{tr("＋ 新单")}</button>
        </div>
      </div>

      <div className="incentive-bar">
        <span>{tr("总工时")}<b>{summary.hours}h</b></span>
        <span>{tr("待结款")}<b>¥{summary.pending.toLocaleString(locale())}</b></span>
        <span>{tr("已结款")}<b>¥{summary.settled.toLocaleString(locale())}</b></span>
        <span>{tr("平均时薪")}<b>{avgRate ? `¥${avgRate}` : '—'}</b></span>
      </div>

      {followupReminders.length > 0 && (
        <div className="hint-banner">
          {tr("⏰ 跟进提醒：")}{followupReminders.map((c) => (
            <span key={c.id} className="followup-chip">
              「{c.client}{c.project ? `·${c.project}` : ''}{tr("」应")}{fmtDate(c.next_follow_up)} {tr("跟进")}<button className="link-btn" onClick={() => patch(c.id, { nextFollowUp: todayStr() })}>{tr("今天跟进")}</button>
            </span>
          ))}
        </div>
      )}

      <label className="mobile-state-filter">{tr('接单状态')}<select value={stateFilter} onChange={event=>setStateFilter(event.target.value as ConsultStatus)}>{COLS.map(col=><option key={col.key} value={col.key}>{tr(col.label)} · {items.filter(item=>item.status===col.key).length}</option>)}</select></label>
      {loaded && items.length === 0 ? (
        <div className="empty">
          <div className="empty-emoji">💼</div>
          <p>{tr("还没有接单记录。接到咨询就建一单，跟进不遗漏。")}</p>
          <button className="btn btn-primary" onClick={() => setShowNew(true)}>{tr("＋ 新单")}</button>
        </div>
      ) : (
        <div className="media-kanban">
          {COLS.map((col) => {
            const list = items.filter((i) => i.status === col.key)
            return (
              <div key={col.key} data-selected={stateFilter===col.key} className="kanban-col media-col">
                <div className="kanban-col-title"><span>{tr(col.label)}</span><span>{list.length}</span></div>
                {list.map((c) => {
                  const late = overdue(c)
                  return (
                    <div key={c.id} className={`task-card ${late ? 'task-overdue' : ''}`}>
                      <div className="task-title">{c.client}</div>
                      {c.project && <div className="muted small">{c.project}</div>}
                      {c.deliverable && <div className="muted small">{tr("交付：")}{c.deliverable}</div>}
                      <div className="media-card-meta">
                        {c.next_follow_up && (
                          <span className={`deadline-chip ${late ? 'dl-overdue' : 'dl-ok'}`}>
                            {late ? tr("⚠ 逾期") : tr("跟进")} {fmtDate(c.next_follow_up)}
                          </span>
                        )}
                      </div>
                      <input
                        type="date"
                        className="inline-date"
                        value={(c.next_follow_up || '').slice(0, 10)}
                        onChange={(e) => patch(c.id, { nextFollowUp: e.target.value || null })}
                        title={tr("改下次跟进日期即消警")}
                      />
                      <div className="consult-line">
                        <span className="muted small">{tr("工时")}{c.hours}h</span>
                        <button className="chip" onClick={() => addHours(c, 1)}>+1h</button>
                        {c.amount > 0 && <span className="muted small">¥{c.amount}</span>}
                      </div>
                      <div className="task-foot">
                        <span className="task-actions">
                          <button title={tr("删除")} onClick={() => del(c)}>×</button>
                        </span>
                        {actionBtn(c)}
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          })}
        </div>
      )}

      <div className="hint-banner" style={{ marginBottom: 16 }}>
        {tr("入口已归并：本页已撤出侧边栏导航，但数据完整保留，仍可正常查看与使用。")}</div>
      {showNew && (
        <Phase2Dialog variant="drawer" title={tr("＋ 新单")} onClose={() => setShowNew(false)}>
            <div className="form-field">
              <label>{tr("客户 *")}</label>
              <input autoFocus placeholder={tr("比如：王同学")} value={form.client} maxLength={30} onChange={(e) => setForm({ ...form, client: e.target.value })} />
            </div>
            <div className="form-field">
              <label>{tr("项目内容")}</label>
              <input placeholder={tr("比如：简历优化")} value={form.project} maxLength={40} onChange={(e) => setForm({ ...form, project: e.target.value })} />
            </div>
            <div className="form-field">
              <label>{tr("交付物")}</label>
              <input placeholder={tr("比如：简历 + 面试稿")} value={form.deliverable} maxLength={40} onChange={(e) => setForm({ ...form, deliverable: e.target.value })} />
            </div>
            <div className="form-field">
              <label>{tr("报价金额 ¥（可选）")}</label>
              <input type="number" min={0} placeholder="300" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
            </div>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setShowNew(false)}>{tr("取消")}</button>
              <button className="btn btn-primary" onClick={submitNew}>{tr("创建")}</button>
            </div>
        </Phase2Dialog>
      )}

      {settleFor && (
        <Phase2Dialog variant="drawer" title={tr("💰 确认结款 ·")} onClose={() => setSettleFor(null)}>
            <div className="form-field">
              <label>{tr("本次结款金额 ¥")}</label>
              <input type="number" min={0} value={settleAmount} onChange={(e) => setSettleAmount(e.target.value)} />
            </div>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setSettleFor(null)}>{tr("取消")}</button>
              <button className="btn btn-primary" onClick={confirmSettle}>{tr("确认入账")}</button>
            </div>
        </Phase2Dialog>
      )}
    </div>
  )
}
