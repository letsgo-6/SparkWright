// SPDX-License-Identifier: MPL-2.0
import {useState} from 'react'
import {tr,locale} from '../i18n/index'
import type {ActivityReport,ActivityView} from '../../shared/new-round-types'
import {useFeatureData} from '../lib/useFeatureData'
import {api} from '../api'
const labels:Record<ActivityView,string>={'24h':'过去24小时','7d':'过去7天','30d':'过去30天'}
export function ActivityAnalytics({endpoint='/api/admin/analytics/activity',get=api.get,description}:{endpoint?:string;get?:typeof api.get;description?:string}={}){
  const [view,setView]=useState<ActivityView>('24h'),[selected,setSelected]=useState<number|null>(null)
  const {data,error,loading,reload}=useFeatureData<ActivityReport>(`${endpoint}${endpoint.includes('?')?'&':'?'}view=${view}`,60000,get)
  const label=(start:string)=>new Intl.DateTimeFormat(locale(),{timeZone:'Asia/Shanghai',month:'short',day:'numeric',...(view==='24h'?{hour:'2-digit' as const}: {})}).format(new Date(start))
  const max=Math.max(1,...(data?.series.map(p=>p.value||0)||[])), x=(i:number)=>45+i*650/Math.max(1,(data?.series.length||2)-1), y=(n:number)=>190-n*150/max
  const segments:string[]=[];let segment=''
  data?.series.forEach((p,i)=>{if(p.value===null){if(segment)segments.push(segment);segment=''}else segment+=`${segment?' L':'M'} ${x(i)} ${y(p.value)}`});if(segment)segments.push(segment)
  return <section className="settings-card activity-panel">
    <div className="panel-head"><h2>{tr('活跃用户分析')}</h2><button className="chip" disabled={loading} onClick={reload}>{tr('刷新状态')}</button></div>
    <p className="muted">{description||tr('成功使用业务功能的普通账号，每个周期按账号去重。后台、登录和自动心跳不计入。')}</p>
    {error&&<p className="error-text" role="alert">{tr(error)} <button className="link-btn" onClick={reload}>{tr('重试')}</button></p>}
    {loading&&!data&&<p role="status">{tr('正在加载…')}</p>}
    {data&&<>
      <div className="activity-cards">{(Object.keys(labels) as ActivityView[]).map(key=><div key={key}><span>{tr(labels[key])}</span><strong>{data.summary[key].value.toLocaleString(locale())}</strong>{!data.summary[key].window_complete&&<small>{tr('采集时间不足完整周期')}</small>}</div>)}</div>
      <div className="feature-toolbar">{(Object.keys(labels) as ActivityView[]).map(key=><button key={key} className={`chip ${view===key?'active':''}`} aria-pressed={view===key} onClick={()=>{setView(key);setSelected(null)}}>{tr(labels[key])}</button>)}</div>
      <h3>{view==='24h'?tr('每小时活跃人数'):tr('每日活跃人数')}</h3>
      <svg className="activity-chart" viewBox="0 0 740 230" role="group" aria-label={tr('活跃人数变化折线图')}>
        <path d="M45 35V190H695" fill="none" stroke="currentColor" opacity=".25"/>
        {[0,max].map(n=><text key={n} x="35" y={y(n)+4} textAnchor="end" fill="currentColor" fontSize="12">{n}</text>)}
        {segments.map((path,i)=><path key={i} d={path} fill="none" stroke="var(--accent, #7678ed)" strokeWidth="3"/>)}
        {data.series.map((p,i)=>p.value===null?null:<circle key={p.start} cx={x(i)} cy={y(p.value)} r={selected===i?6:4} fill="var(--accent, #7678ed)" tabIndex={0} role="button" aria-label={`${label(p.start)}: ${p.value}`} onFocus={()=>setSelected(i)} onMouseEnter={()=>setSelected(i)} onClick={()=>setSelected(i)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();setSelected(i)}}}><title>{label(p.start)}: {p.value}</title></circle>)}
        <text x="45" y="220" fill="currentColor" fontSize="12">{label(data.series[0].start)}</text><text x="695" y="220" textAnchor="end" fill="currentColor" fontSize="12">{label(data.series.at(-1)!.start)}</text>
      </svg>
      <p className="small" aria-live="polite">{selected!==null&&data.series[selected]?`${label(data.series[selected].start)} · ${data.series[selected].value??'—'}`:tr('可聚焦图中数据点查看人数。')}</p>
      <p className="muted small">{tr('不同时间段可能包含同一账号，不能相加得到周期人数。未采集时间显示空缺；当天和首个采集区间可能不完整。')}</p>
      <p className="muted small">{tr('时区：上海；采样最多延迟60秒，页面每60秒更新。最近更新：')}{new Date(data.generated_at).toLocaleString(locale(),{timeZone:'Asia/Shanghai'})}</p>
      <p className="muted small">{tr('采集起始：')}{new Date(data.collection_started_at).toLocaleString(locale(),{timeZone:'Asia/Shanghai'})}</p>
      {data.collection_health==='degraded'&&<p className="error-text" role="alert">{tr('采集发生过异常，统计可能缺少数据，请检查服务日志。')}</p>}
      <details><summary>{tr('查看数据表')}</summary><div className="feature-table-wrap"><table className="feature-table"><thead><tr><th>{tr('时间')}</th><th>{tr('活跃人数')}</th><th>{tr('数据覆盖')}</th></tr></thead><tbody>{data.series.map(p=><tr key={p.start}><td>{label(p.start)}</td><td>{p.value??'—'}</td><td>{tr(p.coverage==='complete'?'完整':p.coverage==='partial'?'部分采集':'尚未采集')}</td></tr>)}</tbody></table></div></details>
    </>}
  </section>
}
