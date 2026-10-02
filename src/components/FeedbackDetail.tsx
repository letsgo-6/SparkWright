// SPDX-License-Identifier: MPL-2.0
import {useEffect,useRef,useState} from 'react'
import {api,ApiError} from '../api'
import {tr,locale} from '../i18n/index'
import type {Feedback,FeedbackEvent,FeedbackStatus,FeaturePage} from '../../shared/new-round-types'
import {useFeatureData} from '../lib/useFeatureData'
import {FeaturePagination} from './FeaturePagination'
export const feedbackStatuses:Record<FeedbackStatus,string>={new:'新提交',in_progress:'处理中',resolved:'已解决',closed:'已关闭'}
export const feedbackCategories={bug:'Bug',suggestion:'建议',question:'问题'}
const transitions:Record<FeedbackStatus,FeedbackStatus[]>={new:['in_progress','closed'],in_progress:['resolved','closed'],resolved:['closed','in_progress'],closed:['in_progress']}
export function FeedbackDetail({id,admin=false}:{id:number;admin?:boolean}){
  const base=admin?'/api/admin/feedback':'/api/feedback'
  const detail=useFeatureData<Feedback>(`${base}/${id}`),[page,setPage]=useState(1)
  const events=useFeatureData<FeaturePage<FeedbackEvent>>(`${base}/${id}/events?page=${page}&pageSize=20`)
  const [mode,setMode]=useState<'notes'|'replies'>('notes'),[content,setContent]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('')
  const controller=useRef<AbortController|null>(null),request=useRef({key:'',id:''})
  useEffect(()=>{const c=new AbortController();controller.current=c;return()=>c.abort()},[])
  const write=async(kind:'status'|'notes'|'replies',status?:FeedbackStatus)=>{
    const signal=controller.current?.signal;if(busy||!detail.data||!signal||signal.aborted)return
    const body={version:detail.data.version,...(kind==='status'?{status}:{content})},key=JSON.stringify([kind,body])
    if(request.current.key!==key)request.current={key,id:crypto.randomUUID()}
    setBusy(true);setError('');setNotice('')
    try{
      const data={...body,request_id:request.current.id}
      if(kind==='status')await api.patch(`${base}/${id}/status`,data,signal);else await api.post(`${base}/${id}/${kind}`,data,signal)
      if(signal.aborted)return
      if(kind!=='status'){setContent('');setMode('notes')}request.current={key:'',id:''};setNotice('已保存');detail.reload();events.reload()
    }catch(e){if(!signal.aborted){setError(e instanceof Error?e.message:'操作失败');if(e instanceof ApiError&&e.code==='feedback_version_conflict'){detail.reload();events.reload()}}}
    finally{if(!signal.aborted)setBusy(false)}
  }
  return <section className="settings-card feedback-detail">
    <div className="panel-head"><h2>{tr('反馈详情')} #{id}</h2><button className="chip" disabled={busy||detail.loading} onClick={()=>{detail.reload();events.reload()}}>{tr('刷新状态')}</button></div>
    {(detail.error||events.error||error)&&<p className="error-text" role="alert">{tr(detail.error||events.error||error)}</p>}
    {notice&&<p role="status">{tr(notice)}</p>}
    {detail.loading&&!detail.data&&<p role="status">{tr('正在加载…')}</p>}
    {detail.data&&<>
      <h3>{detail.data.title}</h3><p className="muted">{tr(feedbackCategories[detail.data.category])} · {tr(feedbackStatuses[detail.data.status])} · {new Date(detail.data.created_at).toLocaleString(locale())}{admin&&` · ${detail.data.author}`}</p>
      <p className="feedback-text">{detail.data.content}</p>{detail.data.page_path&&<p className="muted">{tr('相关页面：')}{detail.data.page_path}</p>}
      {admin&&<>
        <div className="feature-toolbar">{transitions[detail.data.status].map(status=><button key={status} className="btn btn-ghost" disabled={busy} onClick={()=>void write('status',status)}>{tr(status==='in_progress'&&['resolved','closed'].includes(detail.data!.status)?'重新处理':feedbackStatuses[status])}</button>)}</div>
        <form onSubmit={e=>{e.preventDefault();void write(mode)}} className="feedback-form">
          <fieldset disabled={busy}><legend>{tr('处理记录')}</legend><label><input type="radio" name="feedback-mode" checked={mode==='notes'} onChange={()=>setMode('notes')}/>{tr('内部备注')}</label> <label><input type="radio" name="feedback-mode" checked={mode==='replies'} onChange={()=>setMode('replies')}/>{tr('公开回复')}</label></fieldset>
          <p className="muted small">{mode==='notes'?tr('内部备注仅管理员可见，不通知用户。'):tr('公开回复会发送给用户并产生通知。')}</p>
          <label>{tr('内容')}<textarea required rows={4} maxLength={4000} value={content} onChange={e=>setContent(e.target.value)} disabled={busy}/></label>
          <small className="muted">{[...content.trim()].length}/2000</small>
          <button className="btn btn-primary" disabled={busy||[...content.trim()].length<1||[...content.trim()].length>2000}>{busy?tr('提交中…'):tr(mode==='notes'?'保存备注':'发送回复')}</button>
        </form>
      </>}
      <h3>{tr('处理历史')}</h3>
      {events.data?.items.length===0&&<p className="muted">{tr('暂无处理记录')}</p>}
      {events.data?.items.map(event=><article className="feedback-event" key={event.id}>
        <small className="muted">{new Date(event.created_at).toLocaleString(locale())} · {tr(event.kind==='status'?'状态变更':event.kind==='internal_note'?'内部备注':'公开回复')}{admin&&` · ${event.actor||'—'}`}</small>
        {event.kind==='status'?<p>{tr(feedbackStatuses[event.from_status!])} → {tr(feedbackStatuses[event.to_status!])}</p>:<p className="feedback-text">{event.content}</p>}
      </article>)}
      <FeaturePagination page={page} total={events.data?.total||0} onPage={setPage} disabled={events.loading}/>
    </>}
  </section>
}
