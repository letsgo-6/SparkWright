// SPDX-License-Identifier: MPL-2.0
import {useEffect,useRef,useState} from 'react'
import {NavLink,useNavigate} from 'react-router-dom'
import {tr,locale} from '../i18n/index'
import {api} from '../api'
import {useFeatureData} from '../lib/useFeatureData'
import {FeaturePagination} from '../components/FeaturePagination'
import type {FeaturePage,LeaderboardItem} from '../../shared/new-round-types'
export function LeaderboardNav(){
  const {data}=useFeatureData<{enabled:boolean}>('/api/plaza/leaderboard/status')
  return data?.enabled?<NavLink to="/leaderboard">{tr('🏆 评分排行榜')}</NavLink>:null
}
export function LeaderboardPage(){
  const [page,setPage]=useState(1),[openError,setOpenError]=useState(''),navigate=useNavigate()
  const list=useFeatureData<FeaturePage<LeaderboardItem>&{generated_at:string;engine:string;standard_version:string}>(`/api/plaza/leaderboard?page=${page}&pageSize=20`)
  const controller=useRef<AbortController|null>(null)
  useEffect(()=>{const request=new AbortController();controller.current=request;return()=>request.abort()},[])
  const refresh=()=>{setPage(1);list.reload();setOpenError('')}
  const open=async(id:number)=>{const signal=controller.current?.signal;if(!signal||signal.aborted)return;try{await api.get(`/api/plaza/${id}`,signal);if(!signal.aborted)navigate(`/plaza/${id}`)}catch(e){if(!signal.aborted){refresh();setOpenError(e instanceof Error?e.message:'操作失败')}}}
  return <div className="page leaderboard-page"><div className="page-header"><div><h1 className="page-title">{tr('灵感评分排行榜')}</h1><p className="page-sub">{tr('仅收录作者主动参榜、已公开灵感和评分的当前 V5 最新有效分数。')}</p></div><button className="btn btn-ghost" disabled={list.loading} onClick={refresh}>{tr('刷新榜单')}</button></div>
    <section className="settings-card"><details className="context-details"><summary>{tr('排行榜规则')}</summary><p className="muted small">{tr('榜单按整数千分值排序；同分并列并跳号，以评分记录编号、灵感编号稳定排列。')}</p><p className="muted small">{tr('先计算固定子指标，再取总分上限的最低值；不重复扣分，不使用历史最高分。')}</p><p className="muted small">{tr('V5 从未舍入维度值计算总分，最终保留一位小数；同分允许并列。')}</p>
      <p className="muted small">{tr('评分超过 60 秒或综合分为 100.0 时不参与排行榜；重新评分符合条件后可参榜。')}</p>
      {list.data&&<p className="muted small">{tr('活动评分标准：')}{list.data.standard_version} · {tr('仅标题与正文')}</p>}
      </details>
      {(list.error||openError)&&<p className="error-text" role="alert">{tr(list.error||openError)}</p>}{list.loading&&!list.data&&<p role="status">{tr('正在加载…')}</p>}{list.data?.items.length===0&&<p className="muted">{tr('暂无主动参榜的有效 V5 灵感')}</p>}
      {list.data&&<><div className="feature-table-wrap"><table className="feature-table leaderboard-table"><thead><tr><th>{tr('名次')}</th><th>{tr('灵感')}</th><th>{tr('综合评分')}</th><th>{tr('评分信息')}</th></tr></thead><tbody>{list.data.items.map(item=><tr key={item.idea_id}><td><strong>#{item.rank}</strong></td><td><button className="link-btn leaderboard-title" onClick={()=>void open(item.idea_id)}>{item.title}</button><p>{item.public_summary}</p><small className="muted">{item.author} · {item.tags}</small></td><td data-label={tr('综合评分')}><strong className="leaderboard-score">{item.score_display}</strong></td><td><small>{item.standard_version} · {tr('标准角度')}<br/>{item.model}<br/>{new Date(item.scored_at).toLocaleString(locale())}</small></td></tr>)}</tbody></table></div><p className="muted small">{tr('最近更新：')}{new Date(list.data.generated_at).toLocaleString(locale())}</p></>}
      <FeaturePagination page={page} total={list.data?.total||0} onPage={setPage} disabled={list.loading}/>
    </section>
  </div>
}
