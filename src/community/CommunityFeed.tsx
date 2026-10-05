// SPDX-License-Identifier: MPL-2.0
import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { tr } from '../i18n'
import { community, ct, cloudEdition } from './client'
type Row=Record<string,any>
export function CommunityFeed({kind}:{kind:'leaderboard'|'plaza'|'mine'}){
  const [page,setPage]=useState(1),[data,setData]=useState<Row|null>(null),[detail,setDetail]=useState<Row|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[version,setVersion]=useState(0)
  useEffect(()=>{const controller=new AbortController();setBusy(true);setError('');setData(null);setDetail(null);void community.get(kind==='mine'?'/api/community/mine':`/api/plaza${kind==='leaderboard'?'/leaderboard':''}?page=${page}&pageSize=20`,controller.signal).then(r=>{if(!controller.signal.aborted)setData(kind==='mine'?{items:r,total:r.length}:r)}).catch(e=>{if(!controller.signal.aborted)setError((e as Error).message)}).finally(()=>{if(!controller.signal.aborted)setBusy(false)});return()=>controller.abort()},[page,kind,version])
  useEffect(()=>{if(kind==='leaderboard')void community.post('/api/community/activity',{action:'leaderboard'}).catch(()=>{})},[kind,page])
  const change=async(action:()=>Promise<unknown>)=>{setBusy(true);setError('');try{await action();setVersion(n=>n+1)}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
  const heading=kind==='leaderboard'?ct('灵感评分排行榜','Idea leaderboard'):kind==='plaza'?ct('公开灵感','Public ideas'):ct('我的社区投稿','My community submissions')
  return <section><div className="panel-head"><h2>{heading}</h2><button className="btn btn-ghost" disabled={busy} onClick={()=>{setVersion(n=>n+1);if(kind==='leaderboard')void community.post('/api/community/activity',{action:'leaderboard'}).catch(()=>{})}}>{ct('刷新','Refresh')}</button></div>
    {kind==='leaderboard'&&<p className="muted small">{ct('V5 云端评分，同分并列；100分或原评分超过60秒不能参榜。','V5 cloud scores, with tied ranks. 100-point scores and scores taking over 60 seconds are excluded.')}</p>}
    {kind==='mine'&&<p className="muted">{ct('先对指定正文在社区评分，再公开并自主参榜；模型费用由你的供应商账号承担。','Score the submitted text in the community, then publish and opt in. Your model-provider account pays for calls.')}</p>}
    {busy&&!data&&<p role="status">{ct('正在加载…','Loading…')}</p>}{error&&<p className="error-text" role="alert">{tr(error)}</p>}
    {data&&!data.items?.length&&<p className="community-empty">{ct('还没有内容。','Nothing here yet.')}</p>}
    <div className="community-feed">{data?.items?.map((r:Row)=><article key={r.idea_id||r.id}>
      <div className="panel-head"><h3>{r.rank&&<span className="community-rank">#{r.rank} </span>}{r.title}</h3>{(r.score_display||r.score?.score_display)&&<strong className="community-score">{r.score_display||r.score?.score_display}</strong>}</div>
      <p>{r.public_summary||r.content?.slice(0,160)}</p><p className="muted small">{r.author||ct('我的投稿','My submission')} · {r.model||r.score?.model||'—'}</p>
      {kind==='mine'?<div className="feature-toolbar">
        <button className="btn" disabled={busy} onClick={()=>void change(()=>community.post(`/api/ideas/${r.id}/ai/score`,{request_id:crypto.randomUUID(),response_mode:'compact'}))}>{ct('云端评分','Score in community')}</button>
        <button className="btn btn-ghost" disabled={busy} onClick={()=>void change(()=>community.post(`/api/plaza/${r.id}/${r.is_public?'unpublish':'publish'}`,r.is_public?undefined:{scorePublic:true,summary:r.content.slice(0,160)}))}>{r.is_public?ct('撤回公开','Unpublish'):ct('公开正文与评分','Publish text and score')}</button>
        <button className="btn btn-ghost" disabled={busy} onClick={()=>void change(()=>community.put(`/api/ideas/${r.id}/leaderboard`,{enabled:!r.leaderboard_opt_in}))}>{r.leaderboard_opt_in?ct('退出排行榜','Leave leaderboard'):ct('自主参榜','Join leaderboard')}</button>
        <small className="muted">{r.is_public?ct('已公开','Published'):ct('未公开','Unpublished')} · {r.leaderboard_opt_in?ct('已参榜','Opted in'):ct('未参榜','Not opted in')}</small>
      </div>:<button className="link-btn" onClick={async()=>{try{const result=await community.get(`/api/plaza/${r.idea_id||r.id}`);setDetail(result);void community.post('/api/community/activity',{action:'public_detail'}).catch(()=>{})}catch(e){setError((e as Error).message)}}}>{ct('查看公开正文','Read public text')}</button>}
    </article>)}</div>
    {kind!=='mine'&&<div className="feature-toolbar"><button className="btn btn-ghost" disabled={busy||page===1} onClick={()=>setPage(p=>p-1)}>{ct('上一页','Previous')}</button><span>{page} · {data?.total??'—'}</span><button className="btn btn-ghost" disabled={busy||!data?.hasMore} onClick={()=>setPage(p=>p+1)}>{ct('下一页','Next')}</button></div>}
    {detail&&<section className="community-detail"><div className="panel-head"><h3>{detail.idea.title}</h3><button className="btn btn-ghost" onClick={()=>setDetail(null)}>{ct('收起正文','Close text')}</button></div><p className="community-plain">{detail.idea.content}</p><p className="muted">{detail.idea.author} · {detail.score??'—'}</p></section>}
  </section>
}
export function CommunitySubmission(){
  const [local,setLocal]=useState<Row[]>([]),[selected,setSelected]=useState(''),[confirmed,setConfirmed]=useState(false),[error,setError]=useState(''),[busy,setBusy]=useState(false),[result,setResult]=useState(''),[version,setVersion]=useState(0)
  const [settings,setSettings]=useState({baseUrl:'https://api.openai.com/v1',apiKey:'',model:''}),[hasKey,setHasKey]=useState(false)
  const pending=useRef<{id:string;idea:string}|null>(null)
  useEffect(()=>{if(!cloudEdition)void api.get('/api/ideas').then(setLocal).catch(e=>setError(e.message));void community.get('/api/settings').then(r=>{setSettings({baseUrl:r.base_url||'https://api.openai.com/v1',apiKey:'',model:r.model||''});setHasKey(r.hasKey)}).catch(e=>setError(e.message))},[])
  const idea=local.find(r=>String(r.id)===selected)
  return <section>
    {!cloudEdition&&<div className="community-upload"><h2>{ct('从本地选择一条灵感','Choose one local idea')}</h2><select aria-label={ct('选择本地灵感','Select local idea')} value={selected} onChange={e=>{setSelected(e.target.value);setConfirmed(false);setResult('')}}><option value="">{ct('请选择','Choose an idea')}</option>{local.map(r=><option key={r.id} value={r.id}>{r.title}</option>)}</select>
      {idea&&<><h3>{idea.title}</h3><p className="community-plain community-preview">{idea.content}</p><label className="community-confirm"><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>{ct('确认仅上传上述标题、正文。私人评分、项目和 API Key 不随投稿上传。','Upload only this title and text. Local scores, projects and API Keys are excluded.')}</label></>}
      <button className="btn btn-primary" disabled={busy||!confirmed||!idea} onClick={async()=>{setBusy(true);setError('');if(!pending.current||pending.current.idea!==selected)pending.current={id:crypto.randomUUID(),idea:selected};try{await community.localPost('/api/community/upload',{local_idea_id:Number(selected),confirm:true,request_id:pending.current.id});pending.current=null;setResult(ct('已上传为社区草稿，请在下方评分、公开并参榜。','Uploaded as a community draft. Score, publish and opt in below.'));setVersion(n=>n+1)}catch(e){setError((e as Error).message)}finally{setBusy(false)}}}>{ct('上传选定内容','Upload selected text')}</button>
    </div>}
    <details className="community-ai"><summary>{ct('社区专用 AI 配置','Community-only AI settings')}</summary><p className="muted">{ct('单独填写你自己的 Key；服务端保存，仅用于你的社区评分。不会自动读取本地 Key。','Enter your own Key separately. The server stores it for your community scoring; local Keys are never read automatically.')}</p>
      <form onSubmit={async e=>{e.preventDefault();setBusy(true);setError('');try{const r=await community.put('/api/settings',{...settings,...(!settings.apiKey?{apiKey:undefined}: {})});setHasKey(r.hasKey);setSettings(s=>({...s,apiKey:''}));setResult(ct('社区配置已保存。','Community settings saved.'))}catch(e){setError((e as Error).message)}finally{setBusy(false)}}}>{(['baseUrl','model','apiKey'] as const).map(key=><div className="form-field" key={key}><label htmlFor={`community-${key}`}>{key==='apiKey'?`API Key (${hasKey?ct('已配置','configured'):ct('未配置','not configured')})`:key==='baseUrl'?'Base URL':ct('模型','Model')}</label><input id={`community-${key}`} type={key==='apiKey'?'password':'text'} autoComplete="off" required={key!=='apiKey'} value={settings[key]} onChange={e=>setSettings(s=>({...s,[key]:e.target.value}))}/></div>)}<button className="btn" disabled={busy}>{ct('保存社区配置','Save community settings')}</button><button type="button" className="btn btn-ghost" disabled={busy} onClick={async()=>{setBusy(true);setError('');try{await community.put('/api/settings',{clearKey:true});setHasKey(false);setSettings(s=>({...s,apiKey:''}))}catch(e){setError((e as Error).message)}finally{setBusy(false)}}}>{ct('删除社区 Key','Remove community Key')}</button></form>
    </details>
    {error&&<p role="alert" className="error-text">{tr(error)}</p>}{result&&<p role="status">{result}</p>}<CommunityFeed kind="mine" key={version}/>
  </section>
}
