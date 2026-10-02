// SPDX-License-Identifier: MPL-2.0
import { tr } from '../i18n/index'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api } from '../api'
import type { DashboardData, User } from '../types'
import { STATUS_META, deadlineInfo, fmtDate } from '../utils'

export function DashboardPage({ user }: { user: User }) {
  const [data, setData] = useState<DashboardData | null>(null)
  const [quickTitle, setQuickTitle] = useState('')
  const [flash, setFlash] = useState('')

  useEffect(() => {
    api.get('/api/dashboard').then((d) => setData(d as DashboardData)).catch(() => {})
  }, [])

  const quickAdd = async () => {
    const title = quickTitle.trim()
    if (!title) return
    try {
      await api.post('/api/ideas', { title })
      setQuickTitle('')
      setFlash('已记录 ✓ 可到「我的灵感」补充细节')
      setTimeout(() => setFlash(''), 2400)
      api.get('/api/dashboard').then((d) => setData(d as DashboardData))
    } catch (e: any) {
      alert(tr(e.message))
    }
  }

  if (!data) return <div className="page muted">{tr("加载中…")}</div>

  const hour = new Date().getHours()
  const greet = hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好'

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{tr("首页总览")}</h1>
          <p className="page-sub">{tr(greet)}，{user.name}{tr("！今天也要抓住灵感。")}</p>
        </div>
      </div>

      <div className="stats-row">
        <div className="stat-card"><b>{data.ideaStats.total}</b><small>{tr("全部灵感")}</small></div>
        <div className="stat-card"><b>{data.ideaStats.active}</b><small>{tr("推进中")}</small></div>
        <div className="stat-card"><b>{data.ideaStats.done}</b><small>{tr("已实现")}</small></div>
        <div className="stat-card"><b>{data.ideaStats.dueSoon}</b><small>{tr("临近截止")}</small></div>
      </div>

      <div className="dash-grid">
        <div className="detail-left">
          <div className="panel">
            <div className="panel-head">
              <h2>{tr("🔥 今日重点")}</h2>
            </div>
            {data.dueSoon.length === 0 && (
              <p className="muted small">{tr("没有临近截止的灵感。享受或者创造点什么吧～")}</p>
            )}
            {data.followups.map((f) => (
              <Link key={`fu-${f.id}`} to="/consult" className="due-item">
                <span className="status-pill st-incubating">{tr("接单")}</span>
                <span className="due-title">「{f.client}{f.project ? `·${f.project}` : ''}{tr("」跟进逾期")}</span>
                <span className="deadline-chip dl-overdue">{tr("应")}{fmtDate(f.next_follow_up)} →</span>
              </Link>
            ))}
            {data.dueSoon.map((i) => {
              const dl = deadlineInfo(i.deadline)
              return (
                <Link key={`idea-${i.id}`} to={`/ideas/${i.id}`} className="due-item">
                  <span className={`status-pill ${STATUS_META[i.status].cls}`}>{tr(STATUS_META[i.status].label)}</span>
                  <span className="due-title">{i.title}</span>
                  {dl && <span className={`deadline-chip ${dl.cls}`}>{tr(dl.label)}</span>}
                </Link>
              )
            })}
          </div>

          <div className="panel">
            <div className="panel-head">
              <h2>{tr("⚡ 快速记录")}</h2>
            </div>
            <p className="muted small">{tr("灵感来了？一句话先记下来，细节以后再补。")}</p>
            <div className="add-step-row">
              <input
                placeholder={tr("比如：做一个周末市集探访 vlog")}
                value={quickTitle}
                maxLength={60}
                onChange={(e) => setQuickTitle(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && quickAdd()}
              />
              <button className="btn btn-primary" onClick={quickAdd}>{tr("记为灵感")}</button>
            </div>
            {tr(flash) && <p className="save-flash" style={{ marginTop: 8 }}>{tr(flash)}</p>}
          </div>

          <div className="panel">
            <div className="panel-head"><h2>{tr("🕘 最近灵感")}</h2></div>
            {data.recent.length === 0 ? (
              <p className="muted small">{tr("还没有灵感，从上面的快速记录开始吧。")}</p>
            ) : (
              data.recent.map((i) => (
                <Link key={i.id} to={`/ideas/${i.id}`} className="due-item">
                  <span className={`status-pill ${STATUS_META[i.status].cls}`}>{tr(STATUS_META[i.status].label)}</span>
                  <span className="due-title">{i.title}</span>
                  <span className="muted small">{fmtDate(i.updated_at)}</span>
                </Link>
              ))
            )}
          </div>
        </div>

        <div className="detail-left">
          <div className="panel">
            <div className="panel-head"><h2>{tr("🧩 模块摘要")}</h2></div>
            <Link to="/dev" className="module-row">
              <span className="module-icon">🛠️</span>
              <div className="module-text"><b>{tr("开发工程")}</b><small>{tr("进行中")}{data.dev.active} {tr("个项目 · 待办任务")}{data.dev.todo} {tr("个")}</small></div>
              <span className="module-arrow">→</span>
            </Link>
          </div>

          <div className="panel">
            <div className="panel-head"><h2>{tr("🚀 快捷操作")}</h2></div>
            <div className="quick-row">
              <Link className="btn btn-ghost" to="/ideas">{tr("📌 我的灵感")}</Link>
              <Link className="btn btn-ghost" to="/chat">{tr("💬 灵感广场")}</Link>
              <Link className="btn btn-ghost" to="/dev">{tr("🛠️ 开发工程")}</Link>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
