// SPDX-License-Identifier: MPL-2.0
import {useState} from 'react'
import {Link,useSearchParams} from 'react-router-dom'
import {tr,locale} from '../i18n/index'
import type {Feedback,FeaturePage} from '../../shared/new-round-types'
import {useFeatureData} from '../lib/useFeatureData'
import {FeedbackDetail,feedbackStatuses,feedbackCategories} from './FeedbackDetail'
import {FeaturePagination} from './FeaturePagination'
export function FeedbackInbox(){
  const [params]=useSearchParams(), id=params.get('feedbackId')
  return id&&/^\d+$/.test(id)?<><Link className="btn btn-ghost" to="?tab=feedback">{tr('返回收件箱')}</Link><FeedbackDetail key={id} id={Number(id)} admin/></>:<InboxList/>
}
function InboxList(){
  const [page,setPage]=useState(1),[status,setStatus]=useState(''),[category,setCategory]=useState(''),[draft,setDraft]=useState(''),[userDraft,setUserDraft]=useState(''),[search,setSearch]=useState({q:'',userId:''})
  const query=new URLSearchParams({page:String(page),pageSize:'20'});if(status)query.set('status',status);if(category)query.set('category',category);if(search.q)query.set('q',search.q);if(search.userId)query.set('userId',search.userId)
  const list=useFeatureData<FeaturePage<Feedback>>(`/api/admin/feedback?${query}`)
  return <section className="settings-card"><div className="panel-head"><h2>{tr('反馈收件箱')} {list.data?.new_total!==undefined&&<small>{tr('{0} 条新反馈',[list.data.new_total])}</small>}</h2><button className="chip" disabled={list.loading} onClick={list.reload}>{tr('刷新状态')}</button></div>
    <form className="feature-toolbar feedback-filters" onSubmit={e=>{e.preventDefault();setPage(1);setSearch({q:draft.trim(),userId:userDraft})}}>
      <label>{tr('状态')}<select value={status} onChange={e=>{setStatus(e.target.value);setPage(1)}}><option value="">{tr('全部')}</option>{Object.entries(feedbackStatuses).map(([key,label])=><option key={key} value={key}>{tr(label)}</option>)}</select></label>
      <label>{tr('反馈类型')}<select value={category} onChange={e=>{setCategory(e.target.value);setPage(1)}}><option value="">{tr('全部')}</option>{Object.entries(feedbackCategories).map(([key,label])=><option key={key} value={key}>{tr(label)}</option>)}</select></label>
      <label>{tr('关键词')}<input value={draft} maxLength={100} onChange={e=>setDraft(e.target.value)}/></label><label>{tr('用户ID')}<input type="number" min="1" value={userDraft} onChange={e=>setUserDraft(e.target.value)}/></label><button className="btn btn-ghost">{tr('筛选')}</button>
    </form>
    {list.error&&<p className="error-text" role="alert">{tr(list.error)}</p>}{list.loading&&!list.data&&<p role="status">{tr('正在加载…')}</p>}{list.data?.items.length===0&&<p className="muted">{tr('暂无反馈')}</p>}
    {list.data?.items.map(item=><Link className="feedback-row" key={item.id} to={`?tab=feedback&feedbackId=${item.id}`}><strong>#{item.id} {item.title}</strong><small>{item.author} · {tr(feedbackCategories[item.category])} · {tr(feedbackStatuses[item.status])} · {new Date(item.updated_at).toLocaleString(locale())}</small></Link>)}
    <FeaturePagination page={page} total={list.data?.total||0} onPage={setPage} disabled={list.loading}/>
  </section>
}
