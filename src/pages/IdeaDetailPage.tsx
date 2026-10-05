// SPDX-License-Identifier: MPL-2.0
import { Phase2Dialog } from '../components/Phase2Dialog'
import { STANDARD_VERSION } from '../../shared/scoring-standard'
import { ScoreAssessment } from '../components/ScoreAssessment'
import { formatIdeaScore } from '../../shared/idea-score'
import { dimensionLabel } from '../lib/phase2'
import { tr, locale } from '../i18n/index'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { api, apiError, responseError, safeClientError } from '../api'
import type { IdeaDetail, IdeaOrderScore, IdeaStatus, PlanStep, Priority, RawLog, User } from '../types'
import { STATUS_META, deadlineInfo, fmtDate, fmtTime } from '../utils'
import { ScoreHistory } from '../components/ScoreHistory'
import { SynthesisSource } from '../components/SynthesisSource'
import { usePlazaPermission } from '../hooks/usePlazaPermission'
import { ct } from '../community/client'

const PRIO_ORDER: Priority[] = ['high', 'mid', 'low']

export function IdeaDetailPage({ user }: { user: User }) {
  const permission = usePlazaPermission()
  const { id } = useParams()
  const nav = useNavigate()
  const [data, setData] = useState<IdeaDetail | null>(null)
  const [notFound, setNotFound] = useState(false)

  const [title, setTitle] = useState('')
  const [content, setContent] = useState('')
  const [deadline, setDeadline] = useState('')
  const [status, setStatus] = useState<IdeaStatus>('incubating')
  const [tags, setTags] = useState<string[]>([])
  const [tagInput, setTagInput] = useState('')
  const [savedFlash, setSavedFlash] = useState(false)

  const [stepTitle, setStepTitle] = useState('')

  const [aiInput, setAiInput] = useState('')
  const [aiBusy, setAiBusy] = useState(false)
  const [aiErr, setAiErr] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [streamText, setStreamText] = useState('')
  const abortRef = useRef<AbortController | null>(null)

  const scoreRequest=useRef<AbortController|null>(null),scoreRequestId=useRef<string|null>(null)
  const [scoreElapsed,setScoreElapsed]=useState(0)
  const [scoreClientTotal,setScoreClientTotal]=useState<number|null>(null)
  useEffect(()=>()=>scoreRequest.current?.abort(),[])
  const [scoreBusy, setScoreBusy] = useState(false)
  const [scoreErr, setScoreErr] = useState('')
  const [scoreRevision, setScoreRevision] = useState(0)

  const [planAngle, setPlanAngle] = useState('')

  const [importBusy, setImportBusy] = useState(false)
  const [orderScores, setOrderScores] = useState<IdeaOrderScore[]>([])
  const [orderScoreBusy, setOrderScoreBusy] = useState(false)
  const [orderScoreErr, setOrderScoreErr] = useState('')

  const [rawOpen, setRawOpen] = useState(false)
  const [rawLogs, setRawLogs] = useState<RawLog[]>([])

  const threadRef = useRef<HTMLDivElement>(null)

  const load = async (init = false) => {
    try {
      const d = (await api.get(`/api/ideas/${id}`)) as IdeaDetail
      setData(d)
      if (init) {
        setTitle(d.idea.title)
        setContent(d.idea.content)
        setDeadline(d.idea.deadline ? d.idea.deadline.slice(0, 10) : '')
        setStatus(d.idea.status)
        setTags((d.idea.tags || '').split(',').map((t) => t.trim()).filter(Boolean))
      }
    } catch {
      setNotFound(true)
    }
  }

  const loadScores = () => setScoreRevision((version) => version + 1)

  const loadRawLogs = () =>
    api.get(`/api/ideas/${id}/raw-logs`).then((r: any) => setRawLogs(r as RawLog[])).catch(() => {})

  useEffect(() => {
    document.querySelector('.main')?.scrollTo({ top: 0 }); window.scrollTo({ top: 0 })
    load(true)
    loadScores()
    setOrderScores([])
    api.get(`/api/ideas/${id}/score-orders`).then((r: any) => setOrderScores(r.rows)).catch(() => {})
  }, [id])

  useEffect(() => {
    threadRef.current?.scrollTo({ top: 1e9 })
  }, [data?.aiMessages.length, streaming])

  if (notFound) {
    return (
      <div className="page">
        <div className="empty">
          <p>{tr("灵感不存在或已被删除。")}</p>
          <button className="btn btn-ghost" onClick={() => nav('/ideas')}>{tr("返回列表")}</button>
        </div>
      </div>
    )
  }
  if (!data) return <div className="page muted">{tr("加载中…")}</div>

  const idea = data.idea
  const steps = data.steps
  const aiMessages = data.aiMessages
  const channel = data.channel
  const score = data.score
  const scoreCount = data.scoreCount
  const devProject = data.devProject
  const dl = deadlineInfo(idea.deadline)
  const doneCount = steps.filter((s) => s.done).length
  const pct = steps.length ? Math.round((doneCount / steps.length) * 100) : null

  const save = async () => {
    try {
      await api.patch(`/api/ideas/${idea.id}`, { title, content, deadline: deadline || null, status, tags: tags.join(',') })
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 1600)
      load()
    } catch (e: any) {
      permission.denied(e)
      alert(tr(e.message))
    }
  }

  const removeIdea = async () => {
    if (!window.confirm(tr("确定删除灵感「{0}」？相关的计划、AI 对话和讨论频道都会一并删除。", [idea.title]))) return
    await api.del(`/api/ideas/${idea.id}`)
    nav('/ideas')
  }

  const addStep = async () => {
    const t = stepTitle.trim()
    if (!t) return
    setStepTitle('')
    await api.post(`/api/ideas/${idea.id}/steps`, { title: t })
    load()
  }

  const toggleStep = async (s: PlanStep) => {
    await api.patch(`/api/steps/${s.id}`, { done: !s.done })
    load()
  }

  const delStep = async (s: PlanStep) => {
    await api.del(`/api/steps/${s.id}`)
    load()
  }

  // 流式对话（Phase A Step1）
  const sendChat = async (text?: string) => {
    const message = (text ?? aiInput).trim()
    if (!message || streaming) return
    setAiErr('')
    setAiInput('')
    setStreaming(true)
    setStreamText('')
    const controller = new AbortController()
    abortRef.current = controller
    try {
      const res = await fetch(`/api/ideas/${idea.id}/ai/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
        signal: controller.signal,
      })
      if (!res.ok) {
        throw await responseError(res, `/api/ideas/${idea.id}/ai/chat`)
      }
      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const frames = buf.split('\n\n')
        buf = frames.pop() || ''
        for (const frame of frames) {
          const line = frame.split('\n').find((l) => l.startsWith('data:'))
          if (!line) continue
          const payload = line.slice(5).trim()
          if (payload === '[DONE]') continue
          try {
            const j = JSON.parse(payload)
            if (j.error) throw apiError(j.code, 500)
            if (j.delta) setStreamText((prev) => (prev || '') + j.delta)
          } catch (e) {
            if (!(e instanceof SyntaxError)) throw e
          }
        }
      }
      load() // 完整落库后刷新真实消息
      loadRawLogs()
    } catch (e: any) {
      setAiErr(e.name === 'AbortError' ? '已停止生成（半截内容未保存）' : safeClientError(e).message)
      load() // 半截内容不落库，恢复服务端真实状态
    } finally {
      setStreaming(false)
      setStreamText('')
      abortRef.current = null
    }
  }

  const stopChat = () => abortRef.current?.abort()

  const generatePlan = async (angle = planAngle) => {
    if (aiBusy) return
    if (steps.length && !window.confirm(tr('已有执行计划，重新生成将覆盖现有步骤，继续？'))) return
    setAiBusy(true)
    setAiErr('')
    try {
      const r: any = await api.post(`/api/ideas/${idea.id}/ai/plan`, { overwrite: steps.length > 0, angle })
      setData((d) => (d ? { ...d, steps: r.steps, aiMessages: r.aiMessages } : d))
      loadRawLogs()
    } catch (e: any) {
      setAiErr(e.message)
    } finally {
      setAiBusy(false)
    }
  }

  const reviewPrompt = () => {
    const dl2 = deadlineInfo(idea.deadline, new Date(), 'zh-CN')
    sendChat(
      `帮我复盘一下进展：执行计划共 ${steps.length} 步，已完成 ${doneCount} 步${dl2 ? `，截止时间${tr(dl2.label, [], 'zh-CN')}` : ''}。进度健康吗？接下来最该优先做哪一步？`
    )
  }

  const doScore = async (force=false) => {
    if (scoreBusy) return
    const controller=new AbortController();scoreRequest.current=controller
    if(!scoreRequestId.current)scoreRequestId.current=crypto.randomUUID()
    const started=performance.now(),timer=window.setInterval(()=>setScoreElapsed(Math.floor((performance.now()-started)/1000)),500)
    setScoreElapsed(0);setScoreBusy(true);setScoreErr('')
    try {
      const r=await api.post(`/api/ideas/${idea.id}/ai/score`,{request_id:scoreRequestId.current,force,response_mode:'compact'},controller.signal)
      setScoreClientTotal(performance.now()-started)
      setData(d=>d?{...d,score:r.representative_score,personal_score:r.score,representative_status:r.representative_status,scoring_meta:r.scoring_meta,
        scoreCount:d.scoreCount+(r.cached?0:1),aiMessages:r.ai_message&&!d.aiMessages.some(m=>m.id===r.ai_message.id)?[...d.aiMessages,r.ai_message]:d.aiMessages}:d)
      scoreRequestId.current=null;loadScores();loadRawLogs()
    } catch(e:any) {setScoreErr(controller.signal.aborted?tr('已取消等待；已发生的上游费用不保证撤销。'):e.message)}
    finally {window.clearInterval(timer);setScoreElapsed(Math.floor((performance.now()-started)/1000));setScoreBusy(false)}
  }

  const openRawLogs = () => {
    loadRawLogs()
    setRawOpen(true)
  }

  const importToDev = async () => {
    if (importBusy) return
    setImportBusy(true)
    try {
      const r: any = await api.post(`/api/ideas/${idea.id}/import-to-dev`, {})
      setData((d) => (d ? { ...d, devProject: r.project } : d))
    } catch (e: any) {
      setOrderScoreErr(e.message)
    } finally {
      setImportBusy(false)
    }
  }

  const matchOrders = async () => {
    if (orderScoreBusy) return
    setOrderScoreBusy(true)
    setOrderScoreErr('')
    try {
      const r: any = await api.post(`/api/ideas/${idea.id}/score-orders`)
      setOrderScores(r.rows)
    } catch (e: any) {
      setOrderScoreErr(e.message)
    } finally {
      setOrderScoreBusy(false)
    }
  }

  const addTag = () => {
    const t = tagInput.trim().slice(0, 12)
    if (!t || tags.includes(t) || tags.length >= 8) return
    setTags([...tags, t])
    setTagInput('')
  }

  const createChannel = async () => {
    try {
      const c: any = await api.post('/api/channels', { name: `灵感讨论：${idea.title.slice(0, 24)}`, ideaId: idea.id })
      setData((d) => (d ? { ...d, channel: c } : d))
    } catch (e: any) {
      alert(tr(e.message))
    }
  }

  return (
    <div className="page idea-detail-page">
      <div className="page-header">
        <div>
          <button className="link-btn" onClick={() => nav('/ideas')}>{tr("← 返回列表")}</button>
          <h1 className="page-title">{idea.title}</h1>
          <p className="page-sub">
            <span className={`status-pill ${STATUS_META[idea.status].cls}`}>{tr(STATUS_META[idea.status].label)}</span>
            {dl && <span className={`deadline-chip ${dl.cls}`}>{tr(dl.label)}</span>}
            <span className="muted small"> {tr("记录于")}{fmtDate(idea.created_at)}</span>
          </p>
        </div>
        <div className="actions">
          <button className="btn btn-primary" disabled={!!idea.is_public && (!permission.ready || permission.muted)} onClick={save}>{tr("保存修改")}</button>
          <details className="page-tools"><summary>{tr('更多操作')}</summary><button className="btn btn-danger-ghost" onClick={removeIdea}>{tr('删除')}</button></details>
          <Link className="btn btn-ghost" to={`/synthesis?a=${idea.id}`}>{tr("与另一条灵感合成")}</Link>
        </div>
      </div>

      <div className="idea-topic-scores">{tags.map((tag) => <span className="plat-chip" key={tag}>#{tag}</span>)}<ScoreHistory ideaId={idea.id} version={scoreRevision} /></div>
      {idea.source_parent_ids && <SynthesisSource ids={idea.source_parent_ids} />}
      {!!idea.is_public && permission.muted && <p className="error-text" role="alert">{tr("账号已被禁言，公开灵感暂不能编辑；私人灵感仍可编辑。")}</p>}

      <div className="detail-layout">
        <div className="detail-left">
          <div className="panel">
            <div className="panel-head">
              <h2>{tr("灵感内容")}</h2>
              {savedFlash && <span className="save-flash">{tr("已保存 ✓")}</span>}
            </div>
            <div className="form-field">
              <label>{tr("标题")}</label>
              <input value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="form-field">
              <label>{tr("灵感描述")}</label>
              <textarea rows={5} value={content} placeholder={tr("趁热写下来，越具体越好…")} onChange={(e) => setContent(e.target.value)} />
            </div>
            <div className="form-field">
              <label>{tr("标签（回车添加，最多 8 个，每个 ≤12 字）")}</label>
              <div className="tag-editor">
                {tags.map((t) => (
                  <span key={t} className="plat-chip tag-chip">
                    {t}
                    <button className="tag-x" onClick={() => setTags(tags.filter((x) => x !== t))}>×</button>
                  </span>
                ))}
                <input
                  className="tag-input"
                  placeholder={tags.length >= 8 ? tr("标签已满") : tr("输入后回车")}
                  disabled={tags.length >= 8}
                  value={tagInput}
                  maxLength={12}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ',') {
                      e.preventDefault()
                      addTag()
                    }
                  }}
                  onBlur={addTag}
                />
              </div>
            </div>
            <div className="form-inline">
              <div className="form-field">
                <label>{tr("目标实现时间")}</label>
                <input type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)} />
              </div>
              <div className="form-field">
                <label>{tr("状态")}</label>
                <select value={status} onChange={(e) => setStatus(e.target.value as IdeaStatus)}>
                  {Object.entries(STATUS_META).map(([k, v]) => (
                    <option key={k} value={k}>{tr(v.label)}</option>
                  ))}
                </select>
              </div>
            </div>
            <div className="panel-actions">
              <button className="btn btn-ghost" disabled={!!idea.is_public && (!permission.ready || permission.muted)} onClick={save}>{tr("保存修改")}</button>
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <h2>{tr("执行计划")}</h2>
              {pct !== null && (
                <span className="muted small">
                  {doneCount}/{steps.length} {tr("步 ·")}{pct}%
                </span>
              )}
            </div>
            <div className="import-row">
              {devProject ? (
                <span className="small">
                  {tr("✅ 已导入开发工程「")}{devProject.name}」
                  <Link className="link" to={`/dev?project=${devProject.id}`}>{tr("→ 打开项目")}</Link>
                </span>
              ) : (
                <button className="btn btn-ghost btn-sm" onClick={importToDev} disabled={importBusy}>
                  {importBusy ? tr("导入中…") : tr("📥 一键导入到开发工程")}
                </button>
              )}
            </div>
            {pct !== null && (
              <div className="progress progress-lg"><div className="progress-bar" style={{ width: `${pct}%` }} /></div>
            )}
            <ul className="steps-list">
              {steps.map((s) => (
                <li key={s.id} className="step-item">
                  <label>
                    <input type="checkbox" checked={!!s.done} onChange={() => toggleStep(s)} />
                    <span className={`step-title ${s.done ? 'done' : ''}`}>{s.title}</span>
                  </label>
                  <button className="step-del" onClick={() => delStep(s)}>×</button>
                </li>
              ))}
            </ul>
            <div className="add-step-row">
              <input
                placeholder={tr("添加一个步骤，回车确认")}
                value={stepTitle}
                onChange={(e) => setStepTitle(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addStep()}
              />
              <button className="btn btn-ghost" onClick={addStep}>{tr("添加")}</button>
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <h2>{tr("讨论频道")}</h2>
            </div>
            {channel?.archived_at ? <p className="muted small">{tr("讨论频道已归档，请联系 Owner 恢复。")}</p> : channel ? (
              <p className="small">
                {tr("这个灵感有专属频道「")}{channel.name}」
                <Link className="link" to={`/channels/${channel.id}`}>{tr("→ 打开频道")}</Link>
              </p>
            ) : (
              <div>
                <p className="muted small">{tr("创建一个专属频道，让其他用户来围观和讨论这个灵感。")}</p>
                <button className="btn btn-ghost" onClick={createChannel}>{tr("💬 创建讨论频道")}</button>
              </div>
            )}
          </div>
        </div>

        <div className="detail-tools">
          <div className="panel">
            <div className="panel-head">
              <h2>{tr("🎯 AI 综合评分")}</h2>
              {score && <span className="muted small">{tr("已评")}{scoreCount} {tr("次")}</span>}
            </div>
            {tr(scoreErr) && (
              <div className="ai-banner">
                {tr(scoreErr)}
                {scoreErr === apiError('no_ai_config').message && <Link className="link" to="/settings">{tr("→ 去设置")}</Link>}
              </div>
            )}
            {!data.score&&<p className="hint-banner">{tr('当前标准待评分')}</p>}
            {!score && !tr(scoreErr) && (
              <p className="muted small">{tr('V5 使用四维 12 项五级判断，只评价标题与正文；服务端固定计算分数。')}</p>
            )}
            {score && (
              <div className="score-box">
                <p className="muted small">{tr('AI 内容原文为中文。')}</p>
                <div className="score-head">
                  <b className={score.score >= 80 ? 'score-good' : score.score >= 60 ? 'score-mid' : 'score-bad'}>{formatIdeaScore(score.score)}</b>
                  <span className="muted">{tr("分")}</span>
                  <p className="score-summary">{score.summary}</p>
                </div>
                {score.dimensions.map((d) => (
                  <div key={d.name} className="dim-row">
                    <span className="dim-name">{dimensionLabel(d.name)}</span>
                    <div className="dim-track"><div className="dim-fill" style={{ width: `${d.score}%` }} /></div>
                    <span className="dim-score">{formatIdeaScore(d.score)}</span>
                    {d.comment && <small className="dim-comment">{tr(d.comment)}</small>}
                  </div>
                ))}
                <p className="muted small">{tr("评分时间")}{fmtDate(score.created_at)} {new Date(score.created_at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })}</p>
                {score.standard_version===STANDARD_VERSION&&score.assessment&&<details><summary>{tr('查看12项等级、引用与规则')}</summary><ScoreAssessment value={score.assessment}/></details>}
                <p className="muted small">{score.validity === 'valid' ? score.assessment?tr("标准版本：{0}。固定子指标计算后按规则封顶。",[score.standard_version]):tr("标准版本：{0}。综合分为四维等权平均。", [score.standard_version]) : tr("旧版评分，维度不可直接比较。")} {tr("所有历史记录可在主题标签旁查看。")}</p>

              </div>
            )}
            <p className="muted small">{tr('评分超过 60 秒或综合分为 100.0 时不参与排行榜；重新评分符合条件后可参榜。')}</p>
            <div className="panel-actions">
              <button className="btn btn-primary" onClick={() => doScore()} disabled={scoreBusy}>
                {scoreBusy ? tr("评分中…") : tr("开始评分 / 检查缓存")}
              </button>
              <Link className="btn btn-ghost" to="/community/submit">{ct('上传选定灵感到社区参榜','Submit an idea to the community')}</Link>
              <p className="muted small">{ct('本地评分保存在电脑；社区需单独评分、公开并自主参榜。','Local scores stay on your computer. Community participation requires a separate score, publication and opt-in.')}</p>
              {scoreClientTotal!==null&&<span className="muted small">{tr('本次客户端等待：')}{(scoreClientTotal/1000).toFixed(3)}s</span>}
              <button className="btn btn-ghost" onClick={()=>{scoreRequestId.current=null;void doScore(true)}} disabled={scoreBusy}>{tr('强制重新评分')}</button>
              {scoreBusy&&<><span className="muted small" role="status">{tr('请求已发送，已等待 {0} 秒；不设时长限制',[scoreElapsed])}</span><button className="btn btn-ghost" onClick={()=>scoreRequest.current?.abort()}>{tr('取消等待')}</button></>}
            </div>
          </div>

          <div className="panel">
            <div className="panel-head">
              <h2>{tr("💼 商单匹配度")}</h2>
              {orderScores.length > 0 && <span className="muted small">{tr("已评")}{orderScores.length} {tr("单")}</span>}
            </div>
            {tr(orderScoreErr) && (
              <div className="ai-banner">
                {tr(orderScoreErr)}
                {orderScoreErr === apiError('no_ai_config').message && <Link className="link" to="/settings">{tr("→ 去设置")}</Link>}
              </div>
            )}
            {!orderScores.length && !tr(orderScoreErr) && (
              <p className="muted small">{tr("让 AI 评估这条灵感与你在池商单的匹配度——高分商单就是它潜在的变现机会。")}</p>
            )}
            {orderScores.length > 0 && (
              <div className="order-match-list">
                {orderScores.map((s) => (
                  <div key={s.order_id} className="order-match-row">
                    <span className="order-match-name">
                      {s.order_title} <span className="muted small">¥{s.amount.toLocaleString(locale())}</span>
                    </span>
                    <span className="order-match-bar">
                      <span className="progress"><span className="progress-bar" style={{ width: `${s.score}%` }} /></span>
                    </span>
                    <b className="order-match-score">{s.score}</b>
                    <small className="order-match-reason">“{s.reasons}”</small>
                  </div>
                ))}
              </div>
            )}
            <div className="panel-actions">
              <button className="btn btn-primary" onClick={matchOrders} disabled={orderScoreBusy}>
                {orderScoreBusy ? tr("匹配中…") : orderScores.length ? tr("重新匹配") : tr("开始匹配")}
              </button>
              {orderScores.length > 0 && <Link className="link small" to="/orders">{tr("→ 商单池")}</Link>}
            </div>
          </div>

        <div className="panel ai-panel">
          <div className="panel-head">
            <h2>{tr("✨ AI 创意伙伴")}</h2>
            <button className="link-btn" onClick={openRawLogs}>{tr("🗄 原始")}</button>
          </div>
          {tr(aiErr) && (
            <div className="ai-banner">
              {tr(aiErr)}
              {aiErr === apiError('no_ai_config').message && <Link className="link" to="/settings">{tr("→ 去设置")}</Link>}
            </div>
          )}
          <div className="ai-thread" ref={threadRef}>
            {aiMessages.length === 0 && !streaming && (
              <div className="ai-empty">
                <p>{tr("聊聊这个灵感吧！可以让 AI：")}</p>
                <div className="ai-quick">
                  <button className="chip" onClick={() => sendChat('请评估这个灵感的可行性：值不值得做、最大难点在哪、有没有更轻的起步方式？')}>{tr("🤔 评估可行性")}</button>
                  <button className="chip" onClick={() => generatePlan('')}>{tr("✨ 生成执行计划")}</button>
                </div>
              </div>
            )}
            {aiMessages.map((m) => (
              <div key={m.id} className={`ai-msg ${m.role}`}>
                <div className="ai-meta">{m.role === 'user' ? user.name : tr("AI 伙伴")}</div>
                <div className="ai-bubble">{m.content}</div>
              </div>
            ))}
            {streaming && (
              <div className="ai-msg assistant">
                <div className="ai-meta">{tr("AI 伙伴")}</div>
                <div className="ai-bubble streaming">{streamText || '…'}<span className="stream-cursor" /></div>
              </div>
            )}
          </div>
          <div className="ai-quick ai-quick-bottom">
            <select className="sort-select" value={planAngle} onChange={(e) => setPlanAngle(e.target.value)} title={tr("换角度拆解")}>
              <option value="">{tr("🎲 标准拆解")}</option>
              <option value="timeline">{tr("🎲 按时间线")}</option>
              <option value="role">{tr("🎲 按角色分工")}</option>
              <option value="risk">{tr("🎲 按风险依赖")}</option>
            </select>
            <button className="chip" onClick={() => generatePlan()} disabled={aiBusy}>{tr("✨ 生成执行计划")}</button>
            <button className="chip" onClick={() => sendChat('请评估这个灵感的可行性：值不值得做、最大难点在哪、有没有更轻的起步方式？')} disabled={aiBusy}>{tr("🤔 评估可行性")}</button>
            <button className="chip" onClick={reviewPrompt} disabled={aiBusy || !steps.length}>{tr("📋 复盘进展")}</button>
          </div>
          <div className="ai-input-row">
            <input
              placeholder={tr("向 AI 描述你的困惑或灵感…")}
              value={aiInput}
              onChange={(e) => setAiInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && sendChat()}
            />
            {streaming ? (
              <button className="btn btn-ghost" onClick={stopChat}>{tr("⏹ 停止")}</button>
            ) : (
              <button className="btn btn-primary" onClick={() => sendChat()} disabled={!aiInput.trim()}>{tr("发送")}</button>
            )}
          </div>
        </div>
        </div>
      </div>

      {rawOpen && (
        <Phase2Dialog variant="drawer" title={tr("🗄 AI 原始记录")} onClose={() => setRawOpen(false)}>
            {rawLogs.length === 0 && <p className="muted small">{tr("还没有 AI 调用记录。")}</p>}
            {rawLogs.map((log) => (
              <div key={log.id} className={`raw-log-item ${log.parsed_ok ? '' : 'parse-failed'}`}>
                <div className="raw-log-head">
                  <span className="plat-chip">{log.kind === 'chat' ? tr("对话") : log.kind === 'plan' ? tr("拆解") : tr("评分")}</span>
                  <span className="muted small">{fmtDate(log.created_at)} {new Date(log.created_at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })}</span>
                  {log.parsed_ok ? (
                    <span className="save-flash">{tr("解析成功")}</span>
                  ) : (
                    <>
                      <span className="error-text">{tr("解析失败")}</span>
                      {log.kind === 'score' && <button className="link-btn" onClick={() => doScore()}>{tr("重试评分")}</button>}
                      {log.kind === 'plan' && <button className="link-btn" onClick={() => generatePlan('')}>{tr("重试拆解")}</button>}
                    </>
                  )}
                </div>
                <details>
                  <summary className="muted small">request_prompt</summary>
                  <pre className="match-raw">{log.request_prompt}</pre>
                </details>
                <details>
                  <summary className="muted small">raw_response</summary>
                  <pre className="match-raw">{log.raw_response}</pre>
                </details>
              </div>
            ))}
            <div className="modal-actions">
              <button className="btn btn-ghost" onClick={() => setRawOpen(false)}>{tr("关闭")}</button>
            </div>
        </Phase2Dialog>
      )}
    </div>
  )
}


