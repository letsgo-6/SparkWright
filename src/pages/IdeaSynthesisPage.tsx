// SPDX-License-Identifier: MPL-2.0
import { Phase2Dialog } from '../components/Phase2Dialog'
import { MotionTabs } from '../components/MotionTabs'
import { formatIdeaScore } from '../../shared/idea-score'
import { tr } from '../i18n/index'
import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api } from '../api'
import type { Idea, PlazaIdea, SynthesisParent, SynthesisRun } from '../types'
import { dimensionLabel } from '../lib/phase2'

type Choice = { id: number; title: string; source: 'own' | 'public' }
const failureLabels:Record<string,string>={
  gain_below_3:'提升不足 3.0 分',gain_below_5:'未达到旧版 5.0 分提升门槛',
  missing_mechanism_contribution:'双方机制未实际共同贡献',weakness_not_improved:'具体弱点未得到改善',new_core_flaw:'出现新的核心缺陷',
  no_targeted_baseline_improvement:'相对最高分父项没有实质改善所选指标',
  child_core_conflict:'候选存在核心硬伤',unsupported_existing_claim:'已有用户、授权或验证的声明缺少父项依据',
  unexplained_core_dependency:'新增核心依赖缺少获取路径',
  solution_or_feasibility_regression:'解决方案质量或可行性下降超过 5.0 分',
  model_identity_changed:'模型身份已变化',score_scope_changed:'评分版本、精度或输入口径已变化',
  invalid_contribution_mapping:'机制贡献或弱点处理映射无效',
}
export function IdeaSynthesisPage() {
  const [params] = useSearchParams(), navigate = useNavigate()
  useEffect(() => { document.querySelector('.main')?.scrollTo({ top: 0 }); window.scrollTo({ top: 0 }) }, [])
  const [own, setOwn] = useState<Idea[]>([]), [plaza, setPlaza] = useState<PlazaIdea[]>([])
  const [a, setA] = useState<Choice | null>(null), [b, setB] = useState<Choice | null>(null)
  const [selecting, setSelecting] = useState<'A'|'B'|null>(null)
  const [scope, setScope] = useState<'own' | 'public'>('own')
  const [searchA, setSearchA] = useState(''), [searchB, setSearchB] = useState(''), [query, setQuery] = useState('')
  const [ownPage, setOwnPage] = useState(1), [aPage, setAPage] = useState(1), [publicPage, setPublicPage] = useState(1)
  const [hasMore, setHasMore] = useState(false), [loading, setLoading] = useState(true), [publicLoading, setPublicLoading] = useState(false)
  const [error, setError] = useState(''), [listError, setListError] = useState(''), [publicError, setPublicError] = useState('')
  const [busy, setBusy] = useState(false), [importing, setImporting] = useState(false), [revision, setRevision] = useState(0)
  const [elapsed,setElapsed]=useState(0)
  const [result, setResult] = useState<SynthesisRun | null>(null)
  const pending = useRef(false), request = useRef<AbortController | null>(null)
  useEffect(() => () => request.current?.abort(), [])
  useEffect(() => {
    if (!result?.id) return
    const id = result.id, controller = new AbortController()
    const visible = async () => {
      if (document.hidden || pending.current) return
      try {
        const saved = await api.get(`/api/synthesis/${id}`, controller.signal) as SynthesisRun
        if (!controller.signal.aborted) { setResult(saved); if (!saved.idea_b_id) setB(null) }
      } catch (err) { if (!controller.signal.aborted) { setResult(null); setError(err instanceof Error ? err.message : '合成记录读取失败') } }
    }
    document.addEventListener('visibilitychange', visible)
    return () => { controller.abort(); document.removeEventListener('visibilitychange', visible) }
  }, [result?.id])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setListError('')
    api.get('/api/ideas', controller.signal).then((list: Idea[]) => {
      if (controller.signal.aborted) return
      setOwn(list)
      const initial = list.find((idea) => idea.id === Number(params.get('a')))
      if (initial) setA({ id: initial.id, title: initial.title, source: 'own' })
    }).catch((err) => { if (!controller.signal.aborted) setListError(err.message) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [revision, params.get('a')])
  useEffect(() => {
    if (selecting !== 'B' || scope !== 'public') return
    const controller = new AbortController()
    setPublicLoading(true); setPublicError(''); setPlaza([])
    api.get(`/api/plaza?page=${publicPage}&q=${encodeURIComponent(query)}`, controller.signal).then((response) => {
      if (!controller.signal.aborted) { setPlaza(response.items); setHasMore(response.hasMore) }
    }).catch((err) => { if (!controller.signal.aborted) setPublicError(err.message) })
      .finally(() => { if (!controller.signal.aborted) setPublicLoading(false) })
    return () => controller.abort()
  }, [selecting, scope, query, publicPage, revision])
  const freeSynthesis=result?.synthesis_version==='synthesis-v5.1.0'
  const filteredA = own.filter((idea) => `${idea.title} ${idea.content}`.toLowerCase().includes(searchA.toLowerCase()))
  const filteredB = own.filter((idea) => idea.id !== a?.id && `${idea.title} ${idea.content}`.toLowerCase().includes(searchB.toLowerCase()))
  const execute = async () => {
    if (!a || !b || a.id === b.id || pending.current) return
    pending.current = true; setBusy(true); setError(''); setResult(null)
    const controller = new AbortController(); request.current = controller
    const started=performance.now(),timer=window.setInterval(()=>setElapsed(Math.floor((performance.now()-started)/1000)),500);setElapsed(0)
    try {
      const run = await api.post('/api/ideas/synthesize', { idea_a_id: a.id, idea_b_id: b.id }, controller.signal) as SynthesisRun
      const saved = await api.get(`/api/synthesis/${run.id}`, controller.signal) as SynthesisRun
      if (!controller.signal.aborted) setResult({...saved,cached:run.cached,budget:run.budget})
    } catch (err) { setError(controller.signal.aborted?tr('已取消等待；已发生的上游费用不保证撤销。'):err instanceof Error ? err.message : '合成失败，请重试') }
    finally { window.clearInterval(timer);pending.current = false;setBusy(false) }
  }
  const importIdea = async () => {
    if (!result?.child_score || result.legacy_read_only || result.context_withdrawn || pending.current) return
    pending.current = true; setImporting(true); setError('')
    const controller = new AbortController(); request.current = controller
    try {
      const response = await api.post(`/api/synthesis/${result.id}/import`, undefined, controller.signal) as { idea: Idea; created: boolean }
      if (!controller.signal.aborted) navigate(`/ideas/${response.idea.id}`)
    } catch (err) { if (!controller.signal.aborted) setError(err instanceof Error ? err.message : '导入失败，请重试') }
    finally { pending.current = false; if (!controller.signal.aborted) setImporting(false) }
  }
  const chooseA = (idea: Idea) => { setA({ id: idea.id, title: idea.title, source: 'own' }); if (b?.id === idea.id) setB(null); setResult(null); setError(''); setSelecting(null) }
  const chooseB = (idea: Idea | PlazaIdea) => { setB({ id: idea.id, title: idea.title, source: scope }); setResult(null); setError(''); setSelecting(null) }
  return <div className="page synthesis-page"><div className="page-header"><div><h1 className="page-title">{tr("灵感合成")}</h1><p className="page-sub">{tr("以自己的灵感为 A，选择另一条自己的或公开灵感为 B。")}</p></div><Link className="btn btn-ghost" to="/ideas">{tr("我的灵感")}</Link></div>
    <p className="hint-banner">{tr("任选两条不同的可见灵感，结合优点、缺点或场景生成新方案。分数升降均可，每次点击生成新变体。")}</p>
    {tr(listError) && <p className="error-text" role="alert">{tr(listError)} <button className="link-btn" onClick={() => setRevision((v) => v + 1)}>{tr("重试列表")}</button></p>}
    <div className="synthesis-slots">
      <button className="synthesis-slot" disabled={busy||importing} onClick={()=>setSelecting('A')}><span>A · {tr('我的灵感')}</span><b>{a?.title||tr('选择灵感 A')}</b><small>{tr('点击选择或更换')}</small></button>
      <button className="synthesis-slot" disabled={!a||busy||importing} onClick={()=>setSelecting('B')}><span>B · {tr('可见灵感')}</span><b>{b?.title||tr('选择灵感 B')}</b><small>{tr('点击选择或更换')}</small></button>
    </div>
    {a&&b&&<svg className="synthesis-flow" viewBox="0 0 600 56" data-active={busy} role="img" aria-label={tr('两条灵感结合生成新方案')}><path d="M150 0 Q150 30 300 48 M450 0 Q450 30 300 48"/><circle cx="300" cy="48" r="5"/></svg>}
    {selecting&&<Phase2Dialog variant="drawer" title={tr(selecting==='A'?'选择灵感 A':'选择灵感 B')} onClose={()=>setSelecting(null)}>{selecting==='A'?<>
<section className="panel"><h2>{tr("1. 选择 A · 我的灵感")}</h2><input className="synthesis-search" aria-label={tr("搜索灵感A")} placeholder={tr("搜索自己的标题或正文")} disabled={busy || importing} value={searchA} onChange={(event) => { setSearchA(event.target.value); setAPage(1) }} />
      {loading ? <p role="status">{tr("加载中…")}</p> : !filteredA.length ? <p className="muted">{tr("没有匹配灵感，请先在“我的灵感”创建。")}</p> : <div className="synthesis-choice-list">{filteredA.slice((aPage - 1) * 10, aPage * 10).map((idea) => <button className={`synthesis-choice ${a?.id === idea.id ? 'selected' : ''}`} aria-pressed={a?.id === idea.id} key={idea.id} disabled={busy || importing} onClick={() => chooseA(idea)}><b>{idea.title}</b><small>#{idea.id} {tr("· 我的灵感")}</small></button>)}</div>}
      <Pager page={aPage} previous={aPage > 1} next={aPage * 10 < filteredA.length} disabled={busy || importing} change={setAPage} />
      <p className="synthesis-selected">{tr("已选 A：")}{a?.title || tr("尚未选择")}</p></section>
</>:<>
      <section className="panel"><h2>{tr("2. 选择 B · 可见灵感")}</h2><MotionTabs panelId="synthesis-source-content" label={tr('灵感来源')} value={scope} onChange={key => { setScope(key); setSearchB(''); setQuery(''); setOwnPage(1); setPublicPage(1) }} items={[{value:'own',label:tr('我的灵感'),disabled:busy||importing},{value:'public',label:tr('灵感广场'),disabled:busy||importing}]} />
        <div id="synthesis-source-content" role="tabpanel" aria-label={tr(scope==='own'?'我的灵感':'灵感广场')}>
        <form className="phase2-inline-form" onSubmit={(event) => { event.preventDefault(); setQuery(searchB.trim()); setPublicPage(1) }}><input aria-label={tr("搜索灵感B")} placeholder={scope === 'own' ? tr("搜索自己的标题或正文") : tr("搜索公开标题或摘要")} value={searchB} disabled={busy || importing} onChange={(event) => { setSearchB(event.target.value); setOwnPage(1) }} />{scope === 'public' && <button className="btn btn-ghost btn-sm" disabled={busy || importing}>{tr("搜索")}</button>}</form>
        {tr(publicError) && scope === 'public' && <p className="error-text" role="alert">{tr(publicError)} <button className="link-btn" onClick={() => setRevision((v) => v + 1)}>{tr("重试")}</button></p>}
        {scope === 'public' && publicLoading ? <p role="status">{tr("公开灵感加载中…")}</p> : <div className="synthesis-choice-list">{(scope === 'own' ? filteredB.slice((ownPage - 1) * 10, ownPage * 10) : plaza).map((idea) => <button className={`synthesis-choice ${b?.id === idea.id ? 'selected' : ''}`} aria-pressed={b?.id === idea.id} key={idea.id} disabled={busy || importing || !a || a.id === idea.id} onClick={() => chooseB(idea)}><b>{idea.title}</b><small>#{idea.id} · {scope === 'own' ? tr("我的灵感") : (idea as PlazaIdea).author} {a?.id === idea.id ? tr("（与 A 相同）") : ''}</small></button>)}
          {(scope === 'own' ? !filteredB.length : !plaza.length && !tr(publicError)) && <p className="muted">{tr("没有可选的另一条灵感。")}</p>}</div>}
        <Pager page={scope === 'own' ? ownPage : publicPage} previous={(scope === 'own' ? ownPage : publicPage) > 1} next={scope === 'own' ? ownPage * 10 < filteredB.length : hasMore} disabled={busy || importing || publicLoading} change={scope === 'own' ? setOwnPage : setPublicPage} />
        <p className="synthesis-selected">{tr("已选 B：")}{b?.title || tr("尚未选择")}</p></div></section>

</>}</Phase2Dialog>}
    {busy&&<p role="status">{tr('请求已发送，已等待 {0} 秒；不设时长限制',[elapsed])} <button className="btn btn-ghost" onClick={()=>request.current?.abort()}>{tr('取消等待')}</button></p>}
    <div className="synthesis-actionbar"><p className="muted small" id="synthesis-ready" aria-live="polite">{a && b ? tr('两条灵感已选好，可以开始合成。') : tr('先选择 A，再选择另一条灵感 B。')}</p><button className="btn btn-primary" aria-describedby="synthesis-ready" disabled={!a || !b || a.id === b.id || busy || importing} onClick={() => void execute()}>{busy ? tr("合成处理中…") : tr("开始合成")}</button></div>
    {busy && <p className="hint-banner" role="status">{tr("生成随机组合方案 → 使用现有规则批量评分；分差只作参考，不设提升门槛，可手动取消。")}</p>}
    {tr(error) && <p className="error-text" role="alert">{tr(error)} {!busy && <button className="link-btn" disabled={importing} onClick={() => void execute()}>{tr("重试合成")}</button>} <Link className="link" to="/settings">{tr("检查 AI 配置")}</Link></p>}
    {result && <section className="panel synthesis-result" aria-label={tr("合成结果")}>
      <p className="muted small">{tr('AI 内容原文为中文。')}</p>
      <h2>{result.legacy_read_only?tr('旧版只读归档'):freeSynthesis?tr('合成完成'):result.verdict==='not_synthesizable'?tr('不可合成'):result.contract_ok?tr('合成提升成功'):tr('提升不足')}</h2>
      {freeSynthesis?<p className="muted small">{tr('本次组合方向：')}{tr(result.variation)} · {tr('分数变化不影响保留和导入。')}</p>:<p className="muted small">{result.reason_code} · {result.outcome}</p>}
      <p className="muted small">{tr('父评分与候选评分均只读取标题正文。机制语义与真实性仍需人工评测。')}</p>

      {result.child&&<article className="synthesis-draft"><h3>{result.child.title}</h3><p className="sw-plain-text">{result.child.content}</p></article>}
      {result.budget&&<p className="muted small">{tr('上游调用：')}{result.budget.attempts}/{result.budget.max_attempts} · {tr('结构修复：')}{result.budget.repairs}/2</p>}
      {result.child_score&&<div><h3>{tr('统一批量评分 ·')}{formatIdeaScore(result.child_score.score)} {tr('分')}</h3><div className="synthesis-four-scores">{result.child_score.dimensions.map(d=><div key={d.name}><span>{dimensionLabel(d.name)}</span><b>{formatIdeaScore(d.score)}</b></div>)}</div></div>}
      {result.contract&&<><p>{tr('比较基线：')}{result.contract.baseline} · {tr(freeSynthesis?'分数变化：':'历史提升：')}{result.contract.gain_milli>0?'+':''}{formatIdeaScore(result.contract.gain_milli/1000)}</p>
        {!freeSynthesis&&<><p className="muted small">{tr('历史合成规则，当前生成不使用此门槛。')}</p>
        {result.contract.dimension_delta_milli&&<p className="small">{tr('维度变化：')}{result.contract.dimension_delta_milli.map(n=>formatIdeaScore(n/1000)).join(' · ')}</p>}
        {result.contract.targeted_improvements&&<p>{tr('针对性改善指标：')}{result.contract.targeted_improvements.join(', ')||'—'}</p>}
        <ul className="error-text">{(result.contract.failures||[]).map(reason=><li key={reason}>{tr(failureLabels[reason]||reason)}</li>)}</ul></>}</>}
      <details className="context-details"><summary>{tr('父灵感与评分依据')}</summary>
      <div className="synthesis-parent-grid">{(['A','B'] as const).map(key=><ParentFacts key={key} label={key} parent={(key==='A'?result.idea_a_id:result.idea_b_id)?result.parents?.[key]||null:null}/>)}</div>
      </details>
      {result.contributions&&<section><h3>{tr(freeSynthesis?'素材结合':'机制贡献')}</h3><p>A: {result.contributions.A}</p><p>B: {result.contributions.B}</p></section>}
      {result.improvement&&<p>{tr(freeSynthesis?'组合说明：':'弱点改善：')}{result.improvement.from} · {result.improvement.description}</p>}
      {!freeSynthesis&&!result.contract_ok&&!result.legacy_read_only&&<p className="hint-banner">{tr('提升不足仍可导入后修改；导入不代表合成提升成功，默认不参榜。')}</p>}
      <div className="panel-actions"><button className="btn btn-primary" hidden={!result.child_score||result.legacy_read_only||result.context_withdrawn} disabled={busy||importing} onClick={()=>void importIdea()}>{importing?tr('导入中…'):result.imported_idea_id?tr('打开已导入的灵感'):tr('导入我的灵感')}</button><button className="btn btn-ghost" disabled={busy||importing} onClick={()=>void execute()}>{tr('重新合成')}</button></div>
      <p className="muted small">{tr('只有明确点击导入才会创建私人灵感；重复导入返回同一条记录。')}</p>
    </section>}
  </div>
}

function Pager({ page, previous, next, disabled, change }: { page: number; previous: boolean; next: boolean; disabled: boolean; change: (page: number) => void }) {
  if (!previous && !next) return null
  return <div className="sw-notice-pagination"><button className="chip" disabled={disabled || !previous} onClick={() => change(page - 1)}>{tr("上一页")}</button><span>{tr("第")}{page} {tr("页")}</span><button className="chip" disabled={disabled || !next} onClick={() => change(page + 1)}>{tr("下一页")}</button></div>
}
function ParentFacts({label,parent}:{label:string;parent:SynthesisParent|null}){
 return <section className="synthesis-parent"><h3>{tr('父灵感')}{label}{parent?' · '+formatIdeaScore(parent.total):tr(' · 已不可访问')}</h3>{parent?<><p className="small">{parent.scores.map(d=>dimensionLabel(d.name)+' '+formatIdeaScore(d.score)).join(' · ')}</p>
  {parent.mechanism&&<p className="small">{tr('可复用机制：')}{parent.mechanism}</p>}{parent.weakness&&<p className="small">{tr('主要弱点：')}{parent.weakness}</p>}
  {parent.mechanisms?.map(f=><p className="small" key={f.id}>{f.id}: {f.quote}</p>)}
  {parent.weaknesses?.map(f=><p className="small" key={f.id}>{f.id}: {f.quote||tr('信息不足（unknown）')}</p>)}</>:<p className="muted small">{tr('父灵感已隐藏或删除，相关事实不再显示。')}</p>}</section>
}
