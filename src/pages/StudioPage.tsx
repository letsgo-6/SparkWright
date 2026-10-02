// SPDX-License-Identifier: MPL-2.0
import { Phase2Dialog } from '../components/Phase2Dialog'
import { MotionTabs } from '../components/MotionTabs'
import { tr } from '../i18n/index'
import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import type { Idea, MediaStatus, User } from '../types'
import { MediaArchive } from './MediaPage'
import { fmtDate } from '../utils'

const ARCHIVE_STATUS: Record<MediaStatus, { label: string }> = {
  idea: { label: '选题idea' },
  scripting: { label: '写稿中' },
  making: { label: '拍摄/剪辑' },
  published: { label: '已发布' },
  reviewed: { label: '已复盘' },
}

export interface ToolOpt {
  name: string
  category: string
  pros: string
  cons: string
  fit: number
  reason: string
}

export interface StudioProject {
  id: number
  user_id: number
  source_idea_id: number | null
  title: string
  brief: string
  form: string
  synopsis: string
  characters: { name: string; desc: string }[]
  scenes: { name: string; desc: string }[]
  tools: ToolOpt[]
  tools_raw: string
  chosen_tool: string
  status: string
  created_at: string
  updated_at: string
  parseFailed?: boolean
}

interface StudioRow extends Record<string, unknown> {
  id: number
  title: string
  brief: string
  form: string
  synopsis: string
  characters: string
  scenes: string
  tools: string
  tools_raw: string
  chosen_tool: string
  status: string
  source_idea_id: number | null
  created_at: string
  updated_at: string
}

const parseRow = (r: StudioRow): StudioProject => {
  const parseArr = <T,>(s: string): T[] => {
    try {
      const v = JSON.parse(s || '[]')
      return Array.isArray(v) ? (v as T[]) : []
    } catch {
      return []
    }
  }
  return {
    id: r.id,
    user_id: 0,
    source_idea_id: r.source_idea_id,
    title: r.title,
    brief: r.brief,
    form: r.form,
    synopsis: r.synopsis,
    characters: parseArr(r.characters),
    scenes: parseArr(r.scenes),
    tools: parseArr(r.tools),
    tools_raw: r.tools_raw,
    chosen_tool: r.chosen_tool,
    status: r.status,
    created_at: r.created_at,
    updated_at: r.updated_at,
  }
}

const FORM_LABEL: Record<string, string> = { short: '短视频', graphic: '图文', mid: '中长视频' }

export function StudioPage({ user }: { user: User }) {
  const [searchParams, setSearchParams] = useSearchParams()
  const tab = searchParams.get('tab') === 'archive' ? 'archive' : 'workshop'

  const [projects, setProjects] = useState<StudioProject[]>([])
  const [loaded, setLoaded] = useState(false)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [ideas, setIdeas] = useState<Idea[]>([])

  const [brief, setBrief] = useState('')
  const [form, setForm] = useState('short')
  const [sourceIdeaId, setSourceIdeaId] = useState('')
  const [aiReady, setAiReady] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [genErr, setGenErr] = useState('')

  const [rawFor, setRawFor] = useState<StudioProject | null>(null)
  const [archiveFor, setArchiveFor] = useState<StudioProject | null>(null)
  const [archivePlatform, setArchivePlatform] = useState('抖音')
  const [archiveStatus, setArchiveStatus] = useState<MediaStatus>('idea')
  const [flash, setFlash] = useState('')

  const load = () =>
    api
      .get('/api/studio')
      .then((l) => {
        setProjects((l as unknown as StudioRow[]).map(parseRow))
      })
      .finally(() => setLoaded(true))

  useEffect(() => {
    load()
    api.get('/api/ideas').then((l) => setIdeas(l as Idea[])).catch(() => {})
    api.get('/api/settings').then((r: any) => setAiReady(r.keySource !== 'none'))
  }, [])

  const selected = useMemo(
    () => projects.find((p) => p.id === selectedId) || null,
    [projects, selectedId]
  )

  const generate = async () => {
    if (!brief.trim() || busy) return
    setBusy(true)
    setGenErr('')
    try {
      const r: any = await api.post('/api/studio/generate', {
        brief: brief.trim(),
        form,
        sourceIdeaId: sourceIdeaId || null,
      })
      const proj = parseRow(r.project)
      setProjects((prev) => [proj, ...prev])
      setSelectedId(proj.id)
      if (r.parseFailed) setGenErr('生成解析失败：AI 返回内容无法解析，点 [↻ 重新生成] 再试一次。')
      else setBrief('')
    } catch (e: any) {
      setGenErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  const regenerate = async (p: StudioProject) => {
    setBusy(true)
    setGenErr('')
    try {
      const r: any = await api.post(`/api/studio/${p.id}/regenerate`)
      setProjects((prev) => prev.map((x) => (x.id === p.id ? parseRow(r.project) : x)))
      if (r.parseFailed) setGenErr('生成解析失败：AI 返回内容无法解析，请再试一次。')
    } catch (e: any) {
      setGenErr(e.message)
    } finally {
      setBusy(false)
    }
  }

  const patch = async (id: number, body: Record<string, unknown>) => {
    await api.patch(`/api/studio/${id}`, body)
    load()
  }

  const archive = async () => {
    if (!archiveFor) return
    try {
      await api.post(`/api/studio/${archiveFor.id}/archive`, { platform: archivePlatform, status: archiveStatus })
      setArchiveFor(null)
      setFlash('已归档为作品 ✓ 已切到「作品档案」tab')
      setSearchParams({ tab: 'archive' }, { replace: true })
      setTimeout(() => setFlash(''), 3000)
    } catch (e: any) {
      alert(tr(e.message))
    }
  }

  const del = async (p: StudioProject) => {
    if (!window.confirm(tr("确定删除制作方案「{0}」？", [p.title || p.brief.slice(0, 16)]))) return
    await api.del(`/api/studio/${p.id}`)
    setSelectedId(null)
    load()
  }

  return (
    <div className="page studio-page">
      <div className="page-header">
        <div>
          <h1 className="page-title">{tr("🎬 自媒体制作")}</h1>
          <p className="page-sub">{tr("灵感驱动的 AIGC 创作工坊：一句灵感，生成完整制作方案。")}</p>
        </div>
        <div className="actions">
          <MotionTabs panelId="studio-content" label={tr('制作视图')} value={tab} onChange={next => setSearchParams(next === 'archive' ? {tab:'archive'} : {}, {replace:true})} items={[{value:'workshop',label:tr('制作工坊')},{value:'archive',label:tr('作品档案')}]} />
        </div>
      </div>

      {tr(flash) && <div className="save-flash" style={{ marginBottom: 10 }}>{tr(flash)}</div>}

      <div id="studio-content" role="tabpanel" aria-label={tr(tab==='archive'?'作品档案':'制作工坊')}>{tab === 'archive' ? (
        <MediaArchive user={user} />
      ) : (
        <div className="studio-workspace">
          <div className="panel studio-input">
            <div className="panel-head">
              <h2>{tr("给灵感")}</h2>
              {aiReady === false && (
                <Link className="link small" to="/settings">{tr("未配置 AI Key，去设置 →")}</Link>
              )}
            </div>
            <div className="form-field">
              <label>{tr("关联灵感（可留空）")}</label>
              <select value={sourceIdeaId} onChange={(e) => setSourceIdeaId(e.target.value)}>
                <option value="">{tr("不关联")}</option>
                {ideas.map((i) => (
                  <option key={i.id} value={i.id}>{i.title}</option>
                ))}
              </select>
            </div>
            <div className="form-field">
              <label>{tr("剧情/场景灵感")}</label>
              <textarea
                rows={3}
                placeholder={tr("如「雨夜外卖员与流浪猫互相救赎，结尾留一点暖…」")}
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
              />
            </div>
            <div className="form-inline" style={{ alignItems: 'center' }}>
              <div className="form-field">
                <label>{tr("目标形态")}</label>
                <div className="form-inline">
                  <label className="radio-label">
                    <input type="radio" checked={form === 'short'} onChange={() => setForm('short')} /> {tr("短视频")}</label>
                  <label className="radio-label">
                    <input type="radio" checked={form === 'graphic'} onChange={() => setForm('graphic')} /> {tr("图文")}</label>
                  <label className="radio-label">
                    <input type="radio" checked={form === 'mid'} onChange={() => setForm('mid')} /> {tr("中长视频")}</label>
                </div>
              </div>
            </div>
            <div className="panel-actions">
              <button className="btn btn-primary" onClick={generate} disabled={busy || !brief.trim() || aiReady === false}>
                {busy ? tr("生成中…") : tr("🤖 生成制作方案")}
              </button>
              {tr(genErr) && <span className="error-text">{tr(genErr)}</span>}
            </div>
          </div>

          <div className="studio-output">{selected && <StudioDetail key={selected.id} project={selected} user={user} onReload={load} onDel={del} onRegenerate={regenerate} onRaw={setRawFor} onArchive={setArchiveFor} busy={busy} />}</div>

          <div className="panel studio-history">
            <div className="panel-head"><h2>{tr("🗂 历史方案")}</h2><span className="muted small">{projects.length} {tr("个")}</span></div>
            {loaded && projects.length === 0 ? (
              <p className="muted small">{tr("还没有制作方案。在上面给一段灵感，AI 帮你生成完整方案。")}</p>
            ) : (
              <div className="idea-grid">
                {projects
                  .filter((p) => p.id !== selected?.id)
                  .map((p) => (
                    <button key={p.id} className="idea-card" onClick={() => setSelectedId(p.id)}>
                      <div className="idea-card-top">
                        <h3>{p.title || p.brief.slice(0, 18)}</h3>
                        <span className="status-pill st-incubating">{tr(FORM_LABEL[p.form]) || p.form}</span>
                      </div>
                      <p className="idea-preview">{p.synopsis || p.brief}</p>
                      <div className="card-foot">
                        <span className="muted small">{p.chosen_tool ? tr("已选: {0}", [p.chosen_tool]) : tr("未选工具")}</span>
                        <span className="muted small">{fmtDate(p.updated_at)}</span>
                      </div>
                    </button>
                  ))}
              </div>
            )}
          </div>
        </div>
      )}</div>

      {rawFor && (
        <Phase2Dialog variant="drawer" title={tr("📄 AI 原始返回")} onClose={() => setRawFor(null)}>
            <p className="muted small">{tr("生成时间：")}{fmtDate(rawFor.updated_at)} {rawFor.updated_at.slice(11, 16)}</p>
            <pre className="match-raw">{rawFor.tools_raw || tr("（空）")}</pre>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setRawFor(null)}>{tr("关闭")}</button>
              <button className="btn btn-primary" onClick={() => { const p = rawFor; setRawFor(null); regenerate(p) }}>{tr("↻ 重新生成")}</button>
            </div>
        </Phase2Dialog>
      )}

      {archiveFor && (
        <Phase2Dialog variant="drawer" title={tr("🗄 归档为作品")} onClose={() => setArchiveFor(null)}>
            <p className="muted small" style={{ marginBottom: 12 }}>{tr("方案「")}{archiveFor.title || archiveFor.brief.slice(0, 16)}{tr("」将进入作品档案（状态：选题idea）。")}</p>
            <div className="form-field">
              <label>{tr("平台")}</label>
              <select value={archivePlatform} onChange={(e) => setArchivePlatform(e.target.value)}>
                {['抖音', '小红书', 'B站', '视频号', '其他'].map((p) => <option key={p} value={p}>{tr(p)}</option>)}
              </select>
            </div>
            <div className="form-field">
              <label>{tr("状态")}</label>
              <select value={archiveStatus} onChange={(e) => setArchiveStatus(e.target.value as MediaStatus)}>
                {(Object.entries(ARCHIVE_STATUS) as [MediaStatus, { label: string }][]).map(([k, v]) => (
                  <option key={k} value={k}>{tr(v.label)}</option>
                ))}
              </select>
            </div>
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setArchiveFor(null)}>{tr("取消")}</button>
              <button className="btn btn-primary" onClick={archive}>{tr("确认归档")}</button>
            </div>
        </Phase2Dialog>
      )}
    </div>
  )
}

function StudioDetail({ project: p, user, onReload, onDel, onRegenerate, onRaw, onArchive, busy }: {
  project: StudioProject
  user: User
  onReload: () => void
  onDel: (p: StudioProject) => void
  onRegenerate: (p: StudioProject) => void
  onRaw: (p: StudioProject) => void
  onArchive: (p: StudioProject) => void
  busy: boolean
}) {
  const [title, setTitle] = useState(p.title)
  const [synopsis, setSynopsis] = useState(p.synopsis)
  const [chars, setChars] = useState(p.characters)
  const [scenes, setScenes] = useState(p.scenes)
  const [savedFlash, setSavedFlash] = useState(false)

  useEffect(() => {
    setTitle(p.title)
    setSynopsis(p.synopsis)
    setChars(p.characters)
    setScenes(p.scenes)
  }, [p.id])

  const save = async (body: Record<string, unknown>) => {
    await api.patch(`/api/studio/${p.id}`, body)
    onReload()
    setSavedFlash(true)
    setTimeout(() => setSavedFlash(false), 1600)
  }

  const saveSynopsis = () => save({ synopsis })

  return (
    <>
      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h2>{tr("② 制作方案")}{p.title && `《${p.title}》`}</h2>
          <span className="plaza-card-tags">
            <span className="plat-chip">{tr(FORM_LABEL[p.form]) || p.form}</span>
            {p.status === 'draft' && <span className="error-text">{tr("生成解析失败")}</span>}
            {savedFlash && <span className="save-flash">{tr("已保存 ✓")}</span>}
          </span>
        </div>
        <div className="form-field">
          <label>{tr("作品标题")}</label>
          <input value={title} maxLength={20} onChange={(e) => setTitle(e.target.value)} onBlur={() => title !== p.title && save({ title })} />
        </div>
        <div className="form-field">
          <label>{tr("剧情（三幕）")}</label>
          <textarea rows={5} value={synopsis} onChange={(e) => setSynopsis(e.target.value)} onBlur={() => synopsis !== p.synopsis && save({ synopsis })} />
        </div>
        <div className="form-field">
          <label>{tr("人物")}</label>
          {chars.map((c, i) => (
            <div key={i} className="form-inline" style={{ marginBottom: 6 }}>
              <input placeholder={tr("名字")} value={c.name} onChange={(e) => setChars(chars.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} onBlur={() => save({ characters: JSON.stringify(chars) })} />
              <input placeholder={tr("外貌/性格/服装")} value={c.desc} onChange={(e) => setChars(chars.map((x, j) => (j === i ? { ...x, desc: e.target.value } : x)))} onBlur={() => save({ characters: JSON.stringify(chars) })} />
              <button className="step-del" onClick={() => { setChars(chars.filter((_, j) => j !== i)); save({ characters: JSON.stringify(chars.filter((_, j) => j !== i)) }) }}>×</button>
            </div>
          ))}
          <button className="btn btn-ghost btn-sm" onClick={() => setChars([...chars, { name: '', desc: '' }])}>{tr("＋ 加人物")}</button>
        </div>
        <div className="form-field">
          <label>{tr("场景")}</label>
          {scenes.map((sc, i) => (
            <div key={i} className="form-inline" style={{ marginBottom: 6 }}>
              <input placeholder={tr("场N 场景名")} value={sc.name} onChange={(e) => setScenes(scenes.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} onBlur={() => save({ scenes: JSON.stringify(scenes) })} />
              <input placeholder={tr("画面+光线+构图+运镜")} value={sc.desc} onChange={(e) => setScenes(scenes.map((x, j) => (j === i ? { ...x, desc: e.target.value } : x)))} onBlur={() => save({ scenes: JSON.stringify(scenes) })} />
              <button className="step-del" onClick={() => { setScenes(scenes.filter((_, j) => j !== i)); save({ scenes: JSON.stringify(scenes.filter((_, j) => j !== i)) }) }}>×</button>
            </div>
          ))}
          <button className="btn btn-ghost btn-sm" onClick={() => setScenes([...scenes, { name: '', desc: '' }])}>{tr("＋ 加场景")}</button>
        </div>
        <div className="panel-actions">
          <button className="btn btn-primary" onClick={() => save({ synopsis, characters: JSON.stringify(chars), scenes: JSON.stringify(scenes) })}>{tr("保存修改")}</button>
          <button className="btn btn-ghost btn-sm" onClick={() => onRegenerate(p)} disabled={busy}>{tr("↻ 重新生成")}</button>
          <button className="btn btn-ghost btn-sm" onClick={() => onRaw(p)}>{tr("📄 查看AI原文")}</button>
          <button className="btn btn-ghost btn-sm" onClick={() => onArchive(p)}>{tr("🗄 归档为作品")}</button>
          <button className="btn btn-danger-ghost btn-sm" onClick={() => onDel(p)}>{tr("删除")}</button>
        </div>
        <p className="muted small">{tr("操作人：")}{user.name} {tr("· 以下均可编辑保存")}</p>
      </div>

      <div className="panel" style={{ marginTop: 16 }}>
        <div className="panel-head">
          <h2>{tr("③ AIGC 工具推荐（选一个）")}</h2>
          {p.chosen_tool && <span className="save-flash">{tr("已选:")}{p.chosen_tool}</span>}
        </div>
        {p.tools.length === 0 ? (
          <p className="muted small">{p.status === 'draft' ? tr("上次生成解析失败，点上方 [↻ 重新生成] 重试。") : tr("暂无工具推荐。")}</p>
        ) : (
          <div className="tool-grid">
            {p.tools.map((t) => (
              <div key={t.name} className={`tool-card ${p.chosen_tool === t.name ? 'chosen' : ''}`}>
                <div className="tool-name"><b>{t.name}</b><span className="plat-chip">{t.category}</span></div>
                <div className="tool-fit">
                  <span className="progress"><span className="progress-bar" style={{ width: `${t.fit}%` }} /></span>
                  <b>{t.fit}</b>
                </div>
                <div className="muted small">{tr("优：")}{t.pros}</div>
                <div className="muted small">{tr("缺：")}{t.cons}</div>
                {t.reason && <div className="muted small">“{t.reason}”</div>}
                <button className={`btn btn-sm ${p.chosen_tool === t.name ? 'btn-primary' : 'btn-ghost'}`} onClick={() => save({ chosenTool: t.name })}>
                  {p.chosen_tool === t.name ? tr("已选 ✓") : tr("选此工具")}
                </button>
              </div>
            ))}
          </div>
        )}
        {p.tools.length > 0 && (
          <div className="panel-actions">
            <button className="btn btn-primary btn-sm" onClick={() => onArchive(p)}>{tr("🗄 归档为作品")}</button>
          </div>
        )}
      </div>
    </>
  )
}
