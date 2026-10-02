// SPDX-License-Identifier: MPL-2.0
import { ScoreAssessment } from './ScoreAssessment'
import { formatIdeaScore } from '../../shared/idea-score'
import { STANDARD_VERSION } from '../../shared/scoring-standard'
import { tr } from '../i18n/index'
import { useEffect,useState } from 'react'
import { api } from '../api'
import type { ScoreRecord } from '../types'
import { comparableScores,dimensionChange,SCORE_ANGLES,dimensionLabel } from '../lib/phase2'
import { fmtDate,fmtTime } from '../utils'
import { Phase2Dialog } from './Phase2Dialog'
const statusLabels:Record<string,string>={current:'当前代表分',archived:'旧版只读归档',stale:'正文已修改，评分过期',history:'历史个人评分'}
export function ScoreHistory({ideaId,publicOnly=false,version=0}:{ideaId:number;publicOnly?:boolean;version?:number}){
 const [open,setOpen]=useState(false)
 useEffect(()=>setOpen(false),[ideaId,publicOnly])
 return <span className="score-history-trigger" onClick={event=>event.stopPropagation()}><button className="link-btn" onClick={()=>setOpen(true)}>{tr('查看评分历史')}</button>{open&&<Phase2Dialog variant="drawer" title={tr('评分历史')} onClose={()=>setOpen(false)}><ScoreRecords ideaId={ideaId} publicOnly={publicOnly} version={version}/></Phase2Dialog>}</span>
}
function ScoreRecords({ideaId,publicOnly,version}:{ideaId:number;publicOnly:boolean;version:number}){
 const [records,setRecords]=useState<ScoreRecord[]>([]),[selected,setSelected]=useState<ScoreRecord|null>(null),[loading,setLoading]=useState(true),[error,setError]=useState(''),[retry,setRetry]=useState(0),[compare,setCompare]=useState(false),[page,setPage]=useState(1),[hasMore,setHasMore]=useState(false)
 useEffect(()=>{setPage(1)},[ideaId,publicOnly,version])
 useEffect(()=>{const visible=()=>{if(!document.hidden)setRetry(v=>v+1)};document.addEventListener('visibilitychange',visible);return()=>document.removeEventListener('visibilitychange',visible)},[])
 useEffect(()=>{
  const c=new AbortController();setLoading(true);setError('');setRecords([]);setSelected(null);setCompare(false)
  api.get('/api/'+(publicOnly?'plaza':'ideas')+'/'+ideaId+'/scores?page='+page+'&pageSize=20',c.signal).then(result=>{if(!c.signal.aborted){setRecords(result.items);setHasMore(result.hasMore)}}).catch(e=>{if(!c.signal.aborted)setError(e.message)}).finally(()=>{if(!c.signal.aborted)setLoading(false)})
  return()=>c.abort()
 },[ideaId,publicOnly,version,retry,page])
 return <div className="score-records" aria-label={tr('评分历史')} onClick={e=>e.stopPropagation()}>
  {loading?<span role="status">{tr('评分记录加载中…')}</span>:error?<span className="error-text" role="alert">{tr(error)} <button className="link-btn" onClick={()=>setRetry(v=>v+1)}>{tr('重试评分记录')}</button></span>:
   records.length?<><span className="muted small">{tr('评分记录')}</span>{records.map(r=><button key={r.id} className="score-record-chip" onClick={()=>setSelected(r)}>
    <b>{formatIdeaScore(r.score)} {tr('分')}</b><time>{fmtDate(r.created_at)} {fmtTime(r.created_at)}</time><small>{r.standard_version===STANDARD_VERSION?'V5':tr('历史')} · {tr(statusLabels[r.comparison_status||'archived'])}</small>
   </button>)}{records.length>1&&<button className="link-btn" onClick={()=>setCompare(true)}>{tr('历史对比')}</button>}</>:<span className="muted small">{tr('暂无评分记录')}</span>}
  {(page>1||hasMore)&&<div className="sw-notice-pagination"><button className="chip" disabled={loading||page===1} onClick={()=>setPage(v=>v-1)}>{tr('上一页')}</button><span>{page}</span><button className="chip" disabled={loading||!hasMore} onClick={()=>setPage(v=>v+1)}>{tr('下一页')}</button></div>}
  {selected&&<Phase2Dialog title={tr('评分记录详情')} onClose={()=>setSelected(null)}>
   <p className="score-detail-total"><b>{formatIdeaScore(selected.score)} {tr('分')}</b> · {selected.summary}</p>
   <p className="muted small">{selected.standard_version} · {tr(statusLabels[selected.comparison_status||'archived'])} · {selected.model||tr('未记录')} · {selected.angle?tr(SCORE_ANGLES[selected.angle]):tr('未记录')}</p>
   <div className="score-dimensions">{selected.dimensions.map(d=><div className="dim-row" key={d.name}><span>{dimensionLabel(d.name)}</span><b>{formatIdeaScore(d.score)} {tr('分')}</b><small>{tr(d.comment)}</small></div>)}</div>
   {publicOnly?<p className="muted small">{tr('公开记录只包含分数、维度及总评；私有判定依据不公开。')}</p>:selected.standard_version===STANDARD_VERSION&&selected.assessment?<ScoreAssessment value={selected.assessment}/>:<><p className="hint-banner">{tr('旧版只读归档')}</p>{selected.analysis&&<pre className="sw-plain-text">{JSON.stringify(selected.analysis,null,2)}</pre>}</>}
  </Phase2Dialog>}
  {compare&&<Phase2Dialog title={tr('评分历史对比')} onClose={()=>setCompare(false)}><ScoreComparison records={[...records].reverse()}/></Phase2Dialog>}
 </div>
}
export function ScoreComparison({records}:{records:ScoreRecord[]}){
 const previous=records.at(-2),latest=records.at(-1);if(!previous||!latest)return <p className="muted">{tr('至少需要两条评分记录。')}</p>
 const names=[...new Set([...previous.dimensions.map(d=>d.name),...latest.dimensions.map(d=>d.name)])],x=(i:number)=>24+i*272/(records.length-1),y=(n:number)=>96-n*.72
 return <div className="score-history"><p className="muted small">{tr('仅连接同版本、引擎、提示、范围、模型和比较组的记录；缺少身份时不可比较。')}</p>
 {previous.idea_revision!==latest.idea_revision&&<p className="muted small">{tr('内容与评分同时变化，不能据此证明模型稳定性。')}</p>}
 <svg viewBox="0 0 320 120" className="score-curve" role="img" aria-label={tr('综合评分历史，同标准同角度记录之间连接')}>
  <line x1={24} y1={96} x2={296} y2={96} className="curve-axis"/>{records.map((r,i)=><g key={r.id}>
   {i>0&&comparableScores(records[i-1],r)&&<line x1={x(i-1)} y1={y(records[i-1].score)} x2={x(i)} y2={y(r.score)} className="curve-line"/>}
   <circle cx={x(i)} cy={y(r.score)} r={4} className="curve-dot"><title>{fmtDate(r.created_at)+' · '+formatIdeaScore(r.score)}</title></circle>
  </g>)}</svg>
 <div className="admin-table-wrap"><table className="dim-table"><thead><tr><th>{tr('维度')}</th><th>{tr('上次')}</th><th>{tr('最新')}</th><th>{tr('变化')}</th></tr></thead><tbody>{names.map(name=>{const change=dimensionChange(previous,latest,name);return <tr key={name}><td>{dimensionLabel(name)}</td><td>{formatIdeaScore(previous.dimensions.find(d=>d.name===name)?.score)}</td><td>{formatIdeaScore(latest.dimensions.find(d=>d.name===name)?.score)}</td><td>{change===null?tr('不可比较'):formatIdeaScore(change)}</td></tr>})}</tbody></table></div></div>
}
