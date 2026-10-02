// SPDX-License-Identifier: MPL-2.0
import { Phase2Dialog } from '../components/Phase2Dialog'
import {useEffect,useRef,useState} from 'react'
import {Link,useNavigate,useParams} from 'react-router-dom'
import {api,ApiError} from '../api'
import {tr,locale} from '../i18n/index'
import type {Feedback,FeedbackCategory,FeaturePage} from '../../shared/new-round-types'
import {useFeatureData} from '../lib/useFeatureData'
import {FeedbackDetail,feedbackStatuses,feedbackCategories} from '../components/FeedbackDetail'
import {FeaturePagination} from '../components/FeaturePagination'
export function FeedbackPage(){
  const {id}=useParams()
  return <div className="page feedback-page"><div className="page-header"><div><h1 className="page-title">{tr('用户反馈')}</h1><p className="page-sub">{tr('提交 Bug、建议或问题，管理员将在这里处理。')}</p></div>{id&&<Link className="btn btn-ghost" to="/feedback">{tr('我的反馈')}</Link>}</div>
    {id?<FeedbackDetail key={id} id={Number(id)}/>:<FeedbackHome/>}
  </div>
}
function FeedbackHome(){
  const [creating,setCreating]=useState(false)
  const navigate=useNavigate(),[page,setPage]=useState(1),list=useFeatureData<FeaturePage<Feedback>>(`/api/feedback?page=${page}&pageSize=20`)
  const [category,setCategory]=useState<FeedbackCategory>('bug'),[title,setTitle]=useState(''),[content,setContent]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[existing,setExisting]=useState<number|null>(null),[retry,setRetry]=useState(0)
  const controller=useRef<AbortController|null>(null),request=useRef({key:'',id:''})
  useEffect(()=>{const c=new AbortController();controller.current=c;return()=>c.abort()},[])
  useEffect(()=>{if(!retry)return;const timer=window.setInterval(()=>setRetry(v=>Math.max(0,v-1)),1000);return()=>clearInterval(timer)},[retry>0])
  const submit=async()=>{
    const signal=controller.current?.signal;if(busy||retry||!signal||signal.aborted)return
    const body={category,title,content},key=JSON.stringify(body);if(request.current.key!==key)request.current={key,id:crypto.randomUUID()}
    setBusy(true);setError('');setExisting(null)
    try {const result=await api.post('/api/feedback',{...body,request_id:request.current.id},signal);if(!signal.aborted)navigate(`/feedback/${result.feedback.id}`)}
    catch(e){if(!signal.aborted){setError(e instanceof Error?e.message:'操作失败');if(e instanceof ApiError){setExisting(e.feedbackId||null);setRetry(e.retryAfter||0)}}}
    finally{if(!signal.aborted)setBusy(false)}
  }
  return <>
    <div className="feedback-compose-action"><button className="btn btn-primary" onClick={()=>setCreating(true)}>{tr('提交反馈')}</button></div>
    {creating&&<Phase2Dialog title={tr('提交反馈')} onClose={()=>{if(!busy)setCreating(false)}}><section><p className="muted small">{tr('请勿填写密码、API Key 或其他敏感信息。每分钟最多1条，每24小时最多10条。')}</p>
      <form className="feedback-form" onSubmit={e=>{e.preventDefault();void submit()}}>
        <label>{tr('反馈类型')}<select value={category} onChange={e=>setCategory(e.target.value as FeedbackCategory)}>{Object.entries(feedbackCategories).map(([key,label])=><option key={key} value={key}>{tr(label)}</option>)}</select></label>
        <label>{tr('标题')}<input required value={title} maxLength={160} onChange={e=>setTitle(e.target.value)}/></label>
        <label>{tr('问题描述')}<textarea required rows={6} value={content} maxLength={10000} onChange={e=>setContent(e.target.value)}/></label><small className="muted">{[...title.trim()].length}/80 · {[...content.trim()].length}/5000</small>
        {error&&<p className="error-text" role="alert">{tr(error)} {existing&&<Link to={`/feedback/${existing}`}>{tr('查看已有反馈')}</Link>}</p>}
        {retry>0&&<p role="status">{tr('请 {0} 秒后重试',[retry])}</p>}
        <button className="btn btn-primary" disabled={busy||retry>0||![...title.trim()].length||[...title.trim()].length>80||[...content.trim()].length<10||[...content.trim()].length>5000}>{busy?tr('提交中…'):tr('提交反馈')}</button>
      </form>
    </section></Phase2Dialog>}
    <section className="settings-card"><div className="panel-head"><h2>{tr('我的反馈')}</h2><button className="chip" disabled={list.loading} onClick={list.reload}>{tr('刷新状态')}</button></div>
      {list.error&&<p className="error-text" role="alert">{tr(list.error)}</p>}{list.loading&&!list.data&&<p role="status">{tr('正在加载…')}</p>}
      {list.data?.items.length===0&&<p className="muted">{tr('暂无反馈')}</p>}
      {list.data?.items.map(item=><Link className="feedback-row" key={item.id} to={`/feedback/${item.id}`}><strong>#{item.id} {item.title}</strong><small>{tr(feedbackStatuses[item.status])} · {new Date(item.updated_at).toLocaleString(locale())}</small></Link>)}
      <FeaturePagination page={page} total={list.data?.total||0} onPage={setPage} disabled={list.loading}/>
    </section>
  </>
}
