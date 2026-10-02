// SPDX-License-Identifier: MPL-2.0
import { Phase2Dialog } from '../components/Phase2Dialog'
import { tr, locale } from '../i18n/index'
import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import type { DevProject, DevStatus, DevTask, OrderLead, Priority, TaskStatus, User } from '../types'
import { deadlineInfo, fmtDate, fmtTime } from '../utils'

const DEV_STATUS: Record<DevStatus, { label: string; cls: string }> = {
  planning: { label: '规划中', cls: 'st-incubating' },
  active: { label: '开发中', cls: 'st-inprogress' },
  paused: { label: '已暂停', cls: 'st-shelved' },
  released: { label: '已发布', cls: 'st-done' },
  archived: { label: '已归档', cls: 'st-shelved' },
}

const PRIO_META: Record<Priority, { label: string; cls: string }> = {
  high: { label: '高', cls: 'prio-high' },
  mid: { label: '中', cls: 'prio-mid' },
  low: { label: '低', cls: 'prio-low' },
}

const KANBAN_COLS: { key: TaskStatus; label: string }[] = [
  { key: 'todo', label: '📥 待办' },
  { key: 'doing', label: '🔧 进行中' },
  { key: 'done', label: '✅ 已完成' },
]

interface ProjectForm {
  name: string
  description: string
  techStack: string
  repoUrl: string
  deadline: string
  priority: Priority
}

const EMPTY_FORM: ProjectForm = { name: '', description: '', techStack: '', repoUrl: '', deadline: '', priority: 'mid' }

export function DevPage({ user }: { user: User }) {
  const [projects, setProjects] = useState<DevProject[]>([])
  const [loaded, setLoaded] = useState(false)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [searchParams] = useSearchParams()

  const [showForm, setShowForm] = useState(false)
  const [editing, setEditing] = useState<DevProject | null>(null)
  const [form, setForm] = useState<ProjectForm>(EMPTY_FORM)
  const [busy, setBusy] = useState(false)
  const [confirmDel, setConfirmDel] = useState<DevProject | null>(null)

  const load = () =>
    api
      .get('/api/dev')
      .then((l) => setProjects(l as DevProject[]))
      .finally(() => setLoaded(true))

  useEffect(() => {
    load()
  }, [])

  // 支持 /dev?project=ID 直接定位某个项目（从灵感详情跳转过来）
  useEffect(() => {
    const pid = Number(searchParams.get('project'))
    if (pid) setSelectedId(pid)
  }, [searchParams])

  const selected = projects.find((p) => p.id === selectedId) || projects[0] || null

  const stats = useMemo(() => {
    const all = projects.flatMap((p) => p.tasks)
    return {
      active: projects.filter((p) => p.status === 'planning' || p.status === 'active').length,
      total: all.length,
      doing: all.filter((t) => t.status === 'doing').length,
      done: all.filter((t) => t.status === 'done').length,
    }
  }, [projects])

  const openCreate = () => {
    setEditing(null)
    setForm(EMPTY_FORM)
    setShowForm(true)
  }

  const openEdit = (p: DevProject) => {
    setEditing(p)
    setForm({
      name: p.name,
      description: p.description,
      techStack: p.tech_stack || '',
      repoUrl: p.repo_url || '',
      deadline: p.deadline ? p.deadline.slice(0, 10) : '',
      priority: p.priority,
    })
    setShowForm(true)
  }

  const submitForm = async () => {
    if (!form.name.trim() || busy) return
    setBusy(true)
    try {
      if (editing) {
        await api.patch(`/api/dev/${editing.id}`, { ...form, deadline: form.deadline || null })
      } else {
        const created: any = await api.post('/api/dev', { ...form, deadline: form.deadline || null })
        setSelectedId(created.id)
      }
      setShowForm(false)
      await load()
    } catch (e: any) {
      alert(tr(e.message))
    } finally {
      setBusy(false)
    }
  }

  const patchProject = async (id: number, body: Record<string, unknown>) => {
    await api.patch(`/api/dev/${id}`, body)
    load()
  }

  const delProject = async (p: DevProject) => {
    setConfirmDel(null)
    try {
      await api.del(`/api/dev/${p.id}`)
      setSelectedId(null)
      load()
    } catch (e: any) {
      alert(tr("删除失败：{0}", [e.message]))
    }
  }

  return (
    <div className="page dev-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{tr("开发工程")}</h1>
          <p className="page-sub">{tr("项目、任务看板、里程碑、开发日志——把灵感推进成作品。")}</p>
        </div>
        <div className="actions">
          <button className="btn btn-primary" onClick={openCreate}>
            {tr("＋ 新建项目")}</button>
        </div>
      </div>

      <div className="collection-summary"><span>{tr('进行中项目')} <b>{stats.active}</b></span><span>{tr('全部任务')} <b>{stats.total}</b></span><span>{tr('进行中任务')} <b>{stats.doing}</b></span><span>{tr('已完成任务')} <b>{stats.done}</b></span></div>
      <label className="mobile-project-filter">{tr('当前项目')}<select value={selected?.id||''} onChange={event=>setSelectedId(Number(event.target.value))}>{projects.map(project=><option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      {loaded && projects.length === 0 ? (
        <div className="empty">
          <div className="empty-emoji">🛠️</div>
          <p>{tr("还没有开发项目。新建一个，或到「我的灵感」用一键导入把执行计划变成项目。")}</p>
          <button className="btn btn-primary" onClick={openCreate}>{tr("＋ 新建项目")}</button>
        </div>
      ) : (
        <div className="dev-layout">
          <aside className="dev-list">
            {projects.map((p) => {
              const done = p.tasks.filter((t) => t.status === 'done').length
              const pct = p.tasks.length ? Math.round((done / p.tasks.length) * 100) : null
              const dl = deadlineInfo(p.deadline)
              return (
                <button
                  key={p.id}
                  className={`dev-proj-card ${selected?.id === p.id ? 'active' : ''}`}
                  onClick={() => setSelectedId(p.id)}
                >
                  <div className="dev-proj-top">
                    <b>{p.name}</b>
                    <span className={`status-pill ${DEV_STATUS[p.status]?.cls || 'st-inprogress'}`}>
                      {tr(DEV_STATUS[p.status]?.label) || p.status}
                    </span>
                  </div>
                  {pct !== null && (
                    <div className="progress">
                      <div className="progress-bar" style={{ width: `${pct}%` }} />
                    </div>
                  )}
                  <div className="card-foot">
                    <span className="muted small">
                      {p.tasks.length ? tr("{0}/{1} 任务", [done, p.tasks.length]) : tr("暂无任务")}
                    </span>
                    {dl && <span className={`deadline-chip ${dl.cls}`}>{tr(dl.label)}</span>}
                  </div>
                </button>
              )
            })}
          </aside>

          {selected && (
            <DevDetail
              key={selected.id}
              project={selected}
              user={user}
              onPatch={patchProject}
              onDelete={(pp) => setConfirmDel(pp)}
              onEdit={openEdit}
              onChanged={load}
            />
          )}
        </div>
      )}

      {confirmDel && (
        <Phase2Dialog title={tr("删除项目")} onClose={() => setConfirmDel(null)}>
            <p style={{ lineHeight: 1.7 }}>
              {tr("确定删除「")}<b>{confirmDel.name}</b>{tr("」？任务、里程碑和日志会一并删除，且不可恢复。")}</p>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setConfirmDel(null)}>{tr("取消")}</button>
              <button className="btn btn-danger-ghost" onClick={() => delProject(confirmDel)}>{tr("确认删除")}</button>
            </div>
        </Phase2Dialog>
      )}

      {showForm && (
        <Phase2Dialog variant="drawer" title={tr("编辑项目")} onClose={() => setShowForm(false)}>
            <div className="form-field">
              <label>{tr("项目名称 *")}</label>
              <input
                autoFocus
                placeholder={tr("比如：SparkWright 移动端 App")}
                value={form.name}
                maxLength={40}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </div>
            <div className="form-field">
              <label>{tr("项目简介")}</label>
              <textarea rows={3} placeholder={tr("一句话说清楚要做什么…")} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
            </div>
            <div className="form-field">
              <label>{tr("技术栈（用逗号分隔，如 React, Fastify）")}</label>
              <input placeholder="React, TypeScript, SQLite" value={form.techStack} onChange={(e) => setForm({ ...form, techStack: e.target.value })} />
            </div>
            <div className="form-field">
              <label>{tr("仓库 / 链接地址（可选）")}</label>
              <input placeholder="https://github.com/…" value={form.repoUrl} onChange={(e) => setForm({ ...form, repoUrl: e.target.value })} />
            </div>
            <div className="form-inline">
              <div className="form-field">
                <label>{tr("目标发布时间")}</label>
                <input type="date" value={form.deadline} onChange={(e) => setForm({ ...form, deadline: e.target.value })} />
              </div>
              <div className="form-field">
                <label>{tr("优先级")}</label>
                <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as Priority })}>
                  <option value="high">{tr("高")}</option>
                  <option value="mid">{tr("中")}</option>
                  <option value="low">{tr("低")}</option>
                </select>
              </div>
            </div>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setShowForm(false)}>{tr("取消")}</button>
              <button className="btn btn-primary" onClick={submitForm} disabled={busy}>
                {busy ? tr("保存中…") : tr("保存")}
              </button>
            </div>
        </Phase2Dialog>
      )}
    </div>
  )
}

function DevDetail({ project: p, user, onPatch, onDelete, onEdit, onChanged }: {
  project: DevProject
  user: User
  onPatch: (id: number, body: Record<string, unknown>) => void
  onDelete: (p: DevProject) => void
  onEdit: (p: DevProject) => void
  onChanged: () => void
}) {
  const [taskTitle, setTaskTitle] = useState('')
  const [taskPriority, setTaskPriority] = useState<Priority>('mid')
  const [msTitle, setMsTitle] = useState('')
  const [msDate, setMsDate] = useState('')
  const [logText, setLogText] = useState('')
  const [leads, setLeads] = useState<OrderLead[] | null>(null)
  const [leadsOpen, setLeadsOpen] = useState(false)

  const loadLeads = () => api.get(`/api/dev/${p.id}/leads`).then((l) => setLeads(l as OrderLead[])).catch(() => setLeads([]))
  useEffect(() => {
    loadLeads()
  }, [p.id])

  const addTask = async () => {
    const t = taskTitle.trim()
    if (!t) return
    setTaskTitle('')
    await api.post(`/api/dev/${p.id}/tasks`, { title: t, priority: taskPriority })
    onChanged()
  }

  const moveTask = async (t: DevTask, dir: -1 | 1) => {
    const order: TaskStatus[] = ['todo', 'doing', 'done']
    const next = order[order.indexOf(t.status) + dir]
    if (!next) return
    await api.patch(`/api/dev/tasks/${t.id}`, { status: next })
    onChanged()
  }

  const delTask = async (t: DevTask) => {
    try {
      await api.del(`/api/dev/tasks/${t.id}`)
      onChanged()
    } catch (e: any) {
      alert(tr("删除失败：{0}", [e.message]))
    }
  }

  const addMilestone = async () => {
    const t = msTitle.trim()
    if (!t) return
    setMsTitle('')
    await api.post(`/api/dev/${p.id}/milestones`, { title: t, targetDate: msDate || null })
    setMsDate('')
    onChanged()
  }

  const toggleMilestone = async (id: number, cur: number) => {
    await api.patch(`/api/dev/milestones/${id}`, { done: !cur })
    onChanged()
  }

  const delMilestone = async (id: number) => {
    await api.del(`/api/dev/milestones/${id}`)
    onChanged()
  }

  const addLog = async () => {
    const c = logText.trim()
    if (!c) return
    setLogText('')
    await api.post(`/api/dev/${p.id}/logs`, { content: c })
    onChanged()
  }

  const delLog = async (id: number) => {
    try {
      await api.del(`/api/dev/logs/${id}`)
      onChanged()
    } catch (e: any) {
      alert(tr("删除失败：{0}", [e.message]))
    }
  }

  const techTags = (p.tech_stack || '').split(/[,，、]/).map((s) => s.trim()).filter(Boolean)
  const dl = deadlineInfo(p.deadline)
  const doneCount = p.tasks.filter((t) => t.status === 'done').length

  return (
    <div className="dev-detail">
      <div className="panel">
        <div className="dev-head">
          <div>
            <div className="dev-head-title">
              <h2>{p.name}</h2>
              <span className={`status-pill ${DEV_STATUS[p.status]?.cls || 'st-inprogress'}`}>
                {tr(DEV_STATUS[p.status]?.label) || p.status}
              </span>
              <span className={`prio ${PRIO_META[p.priority].cls}`}>{tr(PRIO_META[p.priority].label)}</span>
              {dl && <span className={`deadline-chip ${dl.cls}`}>{tr(dl.label)}</span>}
            </div>
            {p.description && <p className="muted small" style={{ marginTop: 6 }}>{p.description}</p>}
            <div className="dev-head-meta">
              {techTags.map((t) => (
                <span key={t} className="plat-chip">{t}</span>
              ))}
              {p.repo_url && (
                <a className="link" href={p.repo_url} target="_blank" rel="noreferrer">
                  {tr("🔗 仓库地址")}</a>
              )}
              {p.source_idea_id && (
                <Link className="link" to={`/ideas/${p.source_idea_id}`}>
                  {tr("💡 来自灵感 #")}{p.source_idea_id}
                </Link>
              )}
              {p.source_lead_id && (
                <Link className="link" to="/orders">
                  {tr("💰 来自商单 #")}{p.source_lead_id}
                </Link>
              )}
              <span className="muted small">{tr("建于")}{fmtDate(p.created_at)}</span>
            </div>
          </div>
          <div className="media-actions">
            <button className="chip" onClick={() => { setLeadsOpen(!leadsOpen); loadLeads() }}>
              {tr("💰 关联商单")}{leads?.length ?? 0}
            </button>
            <select value={p.status} onChange={(e) => onPatch(p.id, { status: e.target.value })}>
              {(Object.entries(DEV_STATUS) as [DevStatus, { label: string }][]).map(([k, v]) => (
                <option key={k} value={k}>{tr(v.label)}</option>
              ))}
            </select>
            <button className="btn btn-ghost btn-sm" onClick={() => onEdit(p)}>{tr("编辑")}</button>
            <button className="btn btn-danger-ghost btn-sm" onClick={() => onDelete(p)}>{tr("删除")}</button>
          </div>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>{tr("📋 任务看板")}</h2>
          <span className="muted small">
            {p.tasks.length ? tr("{0}/{1} 已完成", [doneCount, p.tasks.length]) : tr("还没有任务")}
          </span>
        </div>
        <div className="kanban">
          {KANBAN_COLS.map((col) => {
            const tasks = p.tasks.filter((t) => t.status === col.key)
            return (
              <div key={col.key} className="kanban-col">
                <div className="kanban-col-title">
                  <span>{tr(col.label)}</span>
                  <span>{tasks.length}</span>
                </div>
                {col.key === 'todo' && (
                  <div className="kanban-add">
                    <input
                      placeholder={tr("新任务，回车添加")}
                      value={taskTitle}
                      onChange={(e) => setTaskTitle(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && addTask()}
                    />
                    <div className="kanban-add-row">
                      <select value={taskPriority} onChange={(e) => setTaskPriority(e.target.value as Priority)}>
                        <option value="high">{tr("高")}</option>
                        <option value="mid">{tr("中")}</option>
                        <option value="low">{tr("低")}</option>
                      </select>
                      <button className="btn btn-ghost btn-sm" onClick={addTask}>{tr("添加")}</button>
                    </div>
                  </div>
                )}
                {tasks.map((t) => (
                  <div key={t.id} className={`task-card prio-${t.priority}`}>
                    <div className="task-title">{t.title}</div>
                    <div className="task-foot">
                      <span className={`prio ${PRIO_META[t.priority].cls}`}>{tr(PRIO_META[t.priority].label)}</span>
                      <span className="task-actions">
                        {t.status !== 'todo' && (
                          <button title={tr("上一步")} onClick={() => moveTask(t, -1)}>←</button>
                        )}
                        {t.status !== 'done' && (
                          <button title={tr("推进")} onClick={() => moveTask(t, 1)}>→</button>
                        )}
                        <button title={tr("删除")} onClick={() => delTask(t)}>×</button>
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )
          })}
        </div>
      </div>

      <details className="panel context-details"><summary>{tr("🎯 里程碑")}</summary>
        <div className="panel-head">
          <h2>{tr("🎯 里程碑")}</h2>
          <span className="muted small">
            {p.milestones.length ? tr("{0}/{1} 达成", [p.milestones.filter((m) => m.done).length, p.milestones.length]) : ''}
          </span>
        </div>
        {p.milestones.length === 0 && <p className="muted small">{tr("还没有里程碑。给它定几个阶段性目标。")}</p>}
        <ul className="steps-list">
          {p.milestones.map((m) => {
            const mdl = m.target_date && !m.done ? deadlineInfo(m.target_date) : null
            return (
              <li key={m.id} className="step-item">
                <label>
                  <input type="checkbox" checked={!!m.done} onChange={() => toggleMilestone(m.id, m.done)} />
                  <span className={`step-title ${m.done ? 'done' : ''}`}>{m.title}</span>
                </label>
                <span className="plan-meta">
                  {m.target_date && (
                    <span className={`deadline-chip ${m.done ? 'dl-ok' : mdl ? mdl.cls : 'dl-ok'}`}>
                      {m.done ? tr("已达成") : tr("目标 {0}", [m.target_date])}
                    </span>
                  )}
                  <button className="step-del" onClick={() => delMilestone(m.id)}>×</button>
                </span>
              </li>
            )
          })}
        </ul>
        <div className="add-plan-row">
          <input
            className="plan-title-input"
            placeholder={tr("下一个里程碑，如：MVP 上线")}
            value={msTitle}
            onChange={(e) => setMsTitle(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addMilestone()}
          />
          <input type="date" value={msDate} onChange={(e) => setMsDate(e.target.value)} title={tr("目标日期")} />
          <button className="btn btn-ghost" onClick={addMilestone}>{tr("添加")}</button>
        </div>
      </details>

      <details className="panel context-details"><summary>{tr("📜 开发日志")}</summary>
        <div className="panel-head">
          <h2>{tr("📜 开发日志")}</h2>
          <span className="muted small">{p.logs.length ? tr("最近 {0} 条", [p.logs.length]) : ''}</span>
        </div>
        {p.logs.length === 0 ? (
          <p className="muted small">{tr("还没有日志。每推进一步都可以记一笔。")}</p>
        ) : (
          <div className="log-timeline">
            {p.logs.map((l) => (
              <div key={l.id} className="log-entry">
                <span className="log-dot" />
                <div className="log-entry-body">
                  <span className="muted small">
                    {fmtDate(l.created_at)} {fmtTime(l.created_at)}
                  </span>
                  <span className="log-text">{l.content}</span>
                </div>
                <button className="step-del" title={tr("删除日志")} onClick={() => delLog(l.id)}>
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="add-step-row">
          <input
            placeholder={tr("记一笔开发日志…（做了什么 / 踩了什么坑 / 下一步）")}
            value={logText}
            onChange={(e) => setLogText(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addLog()}
          />
          <button className="btn btn-ghost" onClick={addLog}>{tr("记录")}</button>
        </div>
        <p className="muted small" style={{ marginTop: 6 }}>
          {tr("操作人：")}{user.name} {tr("· 共")}{p.tasks.filter((t) => t.status === 'done').length} {tr("个任务完成")}</p>
      </details>

      {leadsOpen && (
        <Phase2Dialog variant="drawer" title={tr("💰 关联商单（")} onClose={() => setLeadsOpen(false)}>
            {!leads?.length && <p className="muted small">{tr("还没有匹配到商单。去「需求商单」页录入商单并做 AI 匹配。")}</p>}
            {leads?.map((o) => (
              <div key={o.id} className="due-item">
                <span className="due-title">{o.title}</span>
                <span className="muted small">¥{o.amount.toLocaleString(locale())}</span>
                {o.match_score != null && (
                  <span className={`deadline-chip ${o.match_score >= 60 ? 'dl-ok' : 'dl-soon'}`}>{tr("匹配")}{o.match_score}</span>
                )}
                {o.match_hit_terms && (
                  <span className="media-card-meta">
                    {o.match_hit_terms.split(',').filter(Boolean).slice(0, 4).map((t) => (
                      <span key={t} className="plat-chip">{t}</span>
                    ))}
                  </span>
                )}
                <Link className="link small" to="/orders">{tr("跳商单↗")}</Link>
                {o.matched_project_id === p.id && (
                  <button
                    className="link-btn"
                    onClick={async () => {
                      await api.post(`/api/orders/${o.id}/detach`)
                      loadLeads()
                      onChanged()
                    }}
                  >
                    {tr("解除关联")}</button>
                )}
              </div>
            ))}
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setLeadsOpen(false)}>{tr("关闭")}</button>
            </div>
        </Phase2Dialog>
      )}
    </div>
  )
}
