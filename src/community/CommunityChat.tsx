// SPDX-License-Identifier: MPL-2.0
import { useEffect, useRef, useState } from 'react'
import { tr } from '../i18n'
import { community, ct, socketUrl } from './client'
type Message={id:number;user_id:number;author:string;content:string;created_at:string}
export function CommunityChat(){
  const [messages,setMessages]=useState<Message[]>([]),[content,setContent]=useState(''),[error,setError]=useState(''),[online,setOnline]=useState(0),[state,setState]=useState('connecting'),[older,setOlder]=useState(false),[busy,setBusy]=useState(false),[unread,setUnread]=useState(0)
  const list=useRef<HTMLDivElement>(null),atBottom=useRef(true),latest=useRef(0),request=useRef<{id:string;content:string}|null>(null)
  const merge=(items:Message[])=>{setMessages(prev=>{const all=new Map([...prev,...items].map(m=>[m.id,m]));return [...all.values()].sort((a,b)=>a.id-b.id).slice(-300)});latest.current=Math.max(latest.current,...items.map(m=>m.id));if(!atBottom.current)setUnread(n=>n+items.length)}
  useEffect(()=>{
    let active=true,socket:WebSocket|undefined,timer:number|undefined,attempt=0
    const abort=new AbortController()
    const recover=async()=>{let more=true;while(active&&more){const r=await community.get(`/api/community/history${latest.current?`?after=${latest.current}`:''}`,abort.signal);if(!active)return;merge(r.items);more=latest.current>0&&r.hasMore;if(!latest.current)setOlder(r.hasMore);if(!r.items.length)break}}
    const connect=()=>{
      if(!active)return;setState('connecting');socket=new WebSocket(socketUrl())
      socket.onmessage=e=>{try{const r=JSON.parse(e.data);if(r.v!==1)return;if(r.type==='ready'){attempt=0;setState('online');setOnline(r.online_count);void recover().catch(e=>{if(active)setError((e as Error).message)})}if(r.type==='presence')setOnline(r.online_count);if(r.type==='message')merge([r.message])}catch{}}
      socket.onclose=e=>{if(!active)return;setState('offline');setOnline(0);if(e.code===1008){setError(ct('会话或发言权限已变化，请重新登录社区。','Session or posting permission changed. Sign in again.'));return}const delay=Math.min(30000,1000*2**Math.min(attempt++,5))*(.8+Math.random()*.4);timer=window.setTimeout(connect,delay)}
      socket.onerror=()=>socket?.close()
    }
    void community.get('/api/community/history',abort.signal).then(r=>{if(active){merge(r.items);setOlder(r.hasMore);connect()}}).catch(e=>{if(active){setError((e as Error).message);connect()}})
    return()=>{active=false;abort.abort();clearTimeout(timer);socket?.close()}
  },[])
  useEffect(()=>{if(atBottom.current&&list.current)list.current.scrollTop=list.current.scrollHeight},[messages])
  return <section className="community-chat"><div className="panel-head"><h2>{ct('公共聊天室','Public chat')}</h2><span className="muted" role="status">{state==='online'?ct('已连接','Connected'):state==='offline'?ct('连接中断，正在重连','Disconnected, reconnecting'):ct('正在连接','Connecting')} · {online} {ct('人在线（近实时）','online (approximate)')}</span></div>
    {error&&<p role="alert" className="error-text">{tr(error)}</p>}
    <div className="community-messages" ref={list} role="log" aria-label={ct('聊天消息','Chat messages')} onScroll={()=>{const node=list.current;if(node){atBottom.current=node.scrollHeight-node.scrollTop-node.clientHeight<80;if(atBottom.current)setUnread(0)}}}>
      {older&&messages[0]&&<button className="btn btn-ghost" disabled={busy} onClick={async()=>{setBusy(true);atBottom.current=false;const node=list.current,previous=node?.scrollHeight||0;try{const r=await community.get(`/api/community/history?before=${messages[0].id}`);setMessages(prev=>[...r.items,...prev].slice(0,300));setOlder(r.hasMore);requestAnimationFrame(()=>{if(node)node.scrollTop=node.scrollHeight-previous})}catch(e){setError((e as Error).message)}finally{setBusy(false)}}}>{ct('加载更早的消息','Load older messages')}</button>}
      {!messages.length&&<p className="muted">{ct('这里还很安静，来打个招呼吧。','It is quiet here. Say hello.')}</p>}
      {messages.map(m=><article className="community-message" key={m.id}><header><b>{m.author}</b><small className="muted">#{m.user_id} · <time dateTime={m.created_at}>{new Date(m.created_at).toLocaleTimeString()}</time></small></header><p>{m.content}</p></article>)}
    </div>
    {unread>0&&<button className="link-btn" onClick={()=>{atBottom.current=true;setUnread(0);if(list.current)list.current.scrollTop=list.current.scrollHeight}}>{unread} {ct('条新消息，跳到最新','new messages · jump to latest')}</button>}
    <form className="community-compose" onSubmit={async e=>{e.preventDefault();if(busy||!content.trim())return;setBusy(true);setError('');if(!request.current||request.current.content!==content.trim())request.current={id:crypto.randomUUID(),content:content.trim()};try{const m=await community.post('/api/community/messages',{request_id:request.current.id,content:request.current.content});merge([m]);setContent('');request.current=null;atBottom.current=true}catch(e){setError((e as Error).message)}finally{setBusy(false)}}}>
      <label className="sr-only" htmlFor="community-message">{ct('消息','Message')}</label><textarea id="community-message" maxLength={2000} rows={2} value={content} onChange={e=>setContent(e.target.value)} placeholder={ct('说说你的想法…','Share a thought…')}/><button className="btn btn-primary" disabled={busy||!content.trim()}>{busy?ct('发送中…','Sending…'):ct('发送','Send')}</button>
    </form><p className="small muted">{ct('消息由所有社区成员可见；请勿发送私人信息。','Messages are visible to community members. Keep private information out of chat.')}</p>
  </section>
}
