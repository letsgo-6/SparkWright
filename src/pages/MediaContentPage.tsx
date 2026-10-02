// SPDX-License-Identifier: MPL-2.0
import { tr } from '../i18n/index'
import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api } from '../api'
import type { User } from '../types'

interface PlanState {
  studioId: number
  brief: string
  title: string
  synopsis: string
  characters: { name: string; desc: string }[]
  scenes: { name: string; desc: string }[]
  tools: { name: string; category: string; pros: string; cons: string; fit: number; reason: string }[]
}

interface ToolRow {
  name: string
  category: string
  pros: string
  cons: string
  fit: number
  reason: string
}

export function MediaContentPage({ user }: { user: User }) {
  const { mediaId } = useParams()
  const nav = useNavigate()
  const [workTitle, setWorkTitle] = useState('')
  const [plan, setPlan] = useState<PlanState | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [noPlan, setNoPlan] = useState(false)
  const [busy, setBusy] = useState(false)
  const [savedFlash, setSavedFlash] = useState(false)

  useEffect(() => {
    api
      .get('/api/media')
      .then((l: any) => {
        const m = (l as any[]).find((x) => x.id === Number(mediaId))
        if (!m) {
          setNotFound(true)
          return
        }
        setWorkTitle(m.title)
        if (!m.studio_id) {
          setNoPlan(true)
          return
        }
        return api.get(`/api/studio/${m.studio_id}`).then((s: any) => {
          let chars: { name: string; desc: string }[] = []
          let scns: { name: string; desc: string }[] = []
          let tls: ToolRow[] = []
          try {
            chars = JSON.parse(s.characters || '[]')
          } catch {}
          try {
            scns = JSON.parse(s.scenes || '[]')
          } catch {}
          try {
            tls = JSON.parse(s.tools || '[]')
          } catch {}
          setPlan({
            studioId: s.id,
            brief: String(s.brief || ''),
            title: String(s.title || ''),
            synopsis: String(s.synopsis || ''),
            characters: chars,
            scenes: scns,
            tools: tls,
          })
        })
      })
      .catch(() => setNotFound(true))
  }, [mediaId])

  const save = async () => {
    if (!plan || busy) return
    setBusy(true)
    try {
      await api.patch(`/api/studio/${plan.studioId}`, {
        title: plan.title,
        synopsis: plan.synopsis,
        characters: JSON.stringify(plan.characters),
        scenes: JSON.stringify(plan.scenes),
        tools: JSON.stringify(plan.tools),
      })
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 2000)
    } catch (e: any) {
      alert(tr(e.message))
    } finally {
      setBusy(false)
    }
  }

  if (notFound) {
    return (
      <div className="page">
        <div className="empty">
          <p>{tr("作品不存在。")}</p>
          <Link className="btn btn-ghost" to="/studio?tab=archive">{tr("返回作品档案")}</Link>
        </div>
      </div>
    )
  }

  if (noPlan) {
    return (
      <div className="page">
        <div className="empty">
          <div className="empty-emoji">🧩</div>
          <p>{tr("该作品没有关联制作方案（直接创建的作品不携带方案内容）。")}</p>
          <Link className="btn btn-ghost" to="/studio">{tr("去制作工坊生成方案")}</Link>
          <div style={{ marginTop: 12 }}>
            <Link className="link-btn" to="/studio?tab=archive">{tr("← 返回作品档案")}</Link>
          </div>
        </div>
      </div>
    )
  }

  if (!plan) return <div className="page muted">{tr("加载中…")}</div>

  return (
    <div className="page media-content-page">
      <div className="page-header">
        <div>
          <button className="link-btn" onClick={() => nav('/studio?tab=archive')}>{tr("← 返回作品档案")}</button>
          <h1 className="page-title">{tr("✎ 编辑内容")}</h1>
          <p className="page-sub">
            {tr("作品「")}{workTitle}{tr("」关联的制作方案与 AIGC 工具推荐 · 操作人")}{user.name}
          </p>
        </div>
        <div className="actions">
          {savedFlash && <span className="save-flash">{tr("已保存 ✓")}</span>}
          <button className="btn btn-primary" onClick={save} disabled={busy}>
            {busy ? tr("保存中…") : tr("保存")}
          </button>
        </div>
      </div>

      <div className="detail-layout">
        <div className="detail-left">
          <div className="panel">
            <div className="panel-head"><h2>{tr("方案标题")}</h2></div>
            <div className="form-field">
              <input value={plan.title} maxLength={20} onChange={(e) => setPlan({ ...plan, title: e.target.value })} />
            </div>
            <div className="form-field">
              <label>{tr("剧情（三幕）")}</label>
              <textarea rows={8} value={plan.synopsis} onChange={(e) => setPlan({ ...plan, synopsis: e.target.value })} />
            </div>
            <p className="muted small">{tr("灵感原文（只读）：")}{plan.brief}</p>
          </div>

          <div className="panel">
            <div className="panel-head">
              <h2>{tr("人物")}</h2>
              <button className="btn btn-ghost btn-sm" onClick={() => setPlan({ ...plan, characters: [...plan.characters, { name: '', desc: '' }] })}>
                {tr("＋ 加人物")}</button>
            </div>
            {plan.characters.length === 0 && <p className="muted small">{tr("还没有人物。")}</p>}
            {plan.characters.map((c, i) => (
              <div key={i} className="form-inline" style={{ marginBottom: 8 }}>
                <input placeholder={tr("名字")} value={c.name} maxLength={20} onChange={(e) => setPlan({ ...plan, characters: plan.characters.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                <input placeholder={tr("外貌/性格/服装")} value={c.desc} maxLength={60} onChange={(e) => setPlan({ ...plan, characters: plan.characters.map((x, j) => (j === i ? { ...x, desc: e.target.value } : x)) })} />
                <button className="step-del" onClick={() => setPlan({ ...plan, characters: plan.characters.filter((_, j) => j !== i) })}>×</button>
              </div>
            ))}
          </div>

          <div className="panel">
            <div className="panel-head">
              <h2>{tr("场景")}</h2>
              <button className="btn btn-ghost btn-sm" onClick={() => setPlan({ ...plan, scenes: [...plan.scenes, { name: '', desc: '' }] })}>
                {tr("＋ 加场景")}</button>
            </div>
            {plan.scenes.length === 0 && <p className="muted small">{tr("还没有场景。")}</p>}
            {plan.scenes.map((sc, i) => (
              <div key={i} className="form-inline" style={{ marginBottom: 8 }}>
                <input placeholder={tr("场N 场景名")} value={sc.name} maxLength={30} onChange={(e) => setPlan({ ...plan, scenes: plan.scenes.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                <input placeholder={tr("画面+光线+构图+运镜")} value={sc.desc} maxLength={80} onChange={(e) => setPlan({ ...plan, scenes: plan.scenes.map((x, j) => (j === i ? { ...x, desc: e.target.value } : x)) })} />
                <button className="step-del" onClick={() => setPlan({ ...plan, scenes: plan.scenes.filter((_, j) => j !== i) })}>×</button>
              </div>
            ))}
          </div>
        </div>

        <div className="detail-left">
          <div className="panel">
            <div className="panel-head">
              <h2>{tr("🤖 AIGC 工具推荐")}</h2>
              <button className="btn btn-ghost btn-sm" onClick={() => setPlan({ ...plan, tools: [...plan.tools, { name: '', category: 'video', pros: '', cons: '', fit: 60, reason: '' }] })}>
                {tr("＋ 加工具")}</button>
            </div>
            {plan.tools.length === 0 && <p className="muted small">{tr("还没有工具推荐。")}</p>}
            {plan.tools.map((t, i) => (
              <div key={i} className="tool-edit-card">
                <div className="form-inline">
                  <div className="form-field" style={{ flex: 2 }}>
                    <label>{tr("工具名")}</label>
                    <input value={t.name} maxLength={30} onChange={(e) => setPlan({ ...plan, tools: plan.tools.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                  </div>
                  <div className="form-field">
                    <label>{tr("适配度")}</label>
                    <input type="number" min={0} max={100} value={t.fit} onChange={(e) => setPlan({ ...plan, tools: plan.tools.map((x, j) => (j === i ? { ...x, fit: Number(e.target.value) } : x)) })} />
                  </div>
                  <button className="step-del" style={{ marginTop: 20 }} onClick={() => setPlan({ ...plan, tools: plan.tools.filter((_, j) => j !== i) })}>×</button>
                </div>
                <div className="form-inline">
                  <div className="form-field">
                    <label>{tr("优点")}</label>
                    <input value={t.pros} maxLength={40} onChange={(e) => setPlan({ ...plan, tools: plan.tools.map((x, j) => (j === i ? { ...x, pros: e.target.value } : x)) })} />
                  </div>
                  <div className="form-field">
                    <label>{tr("缺点")}</label>
                    <input value={t.cons} maxLength={40} onChange={(e) => setPlan({ ...plan, tools: plan.tools.map((x, j) => (j === i ? { ...x, cons: e.target.value } : x)) })} />
                  </div>
                </div>
              </div>
            ))}
          </div>

          <div className="panel">
            <div className="panel-head"><h2>{tr("💡 使用提示")}</h2></div>
            <p className="muted small" style={{ lineHeight: 1.8 }}>
              {tr("这里编辑的是作品关联的制作方案（剧情/人物/场景/工具推荐），保存后同步到「自媒体制作」工坊； 心仪视频作品的匹配评分也会按最新内容重新计算。")}</p>
          </div>
        </div>
      </div>
      <div className="editor-save"><button className="btn btn-primary" onClick={save} disabled={busy}>{tr(busy?"保存中…":"保存")}</button></div>
    </div>
  )
}
