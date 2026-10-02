// SPDX-License-Identifier: MPL-2.0
import { Phase2Dialog } from '../components/Phase2Dialog'
import { tr } from '../i18n/index'
import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api'
import { isOwner, type Channel, type ChatMessage, type User } from '../types'
import { fmtDate, fmtTime } from '../utils'
import { ONLINE_NOTE } from '../lib/phase2'
import { useChannelPresence } from '../hooks/useChannelPresence'
import { usePlazaPermission } from '../hooks/usePlazaPermission'

export function ChatPage({ user }: { user: User }) {
  const [chooser, setChooser] = useState(false)
  const { channelId } = useParams()
  useEffect(()=>setChooser(false),[channelId])
  const [channels, setChannels] = useState<Channel[]>([])
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false), [loading, setLoading] = useState(true)
  const [listError, setListError] = useState(''), [messageError, setMessageError] = useState('')
  const [revision, setRevision] = useState(0)
  const threadRef = useRef<HTMLDivElement>(null)
  const lastId = useRef(0), sending = useRef(false)
  const permission = usePlazaPermission()
  const activeId = channelId ? Number(channelId) : channels.find((c) => c.type === 'public')?.id
  const currentChannel = useRef(activeId); currentChannel.current = activeId
  const active = channels.find((c) => c.id === activeId)
  const presence = useChannelPresence(activeId, !!active)

  useEffect(() => {
    const controller = new AbortController()
    let pending = false
    const load = async () => {
      if (document.hidden || pending) return
      pending = true
      try {
        const list = await api.get('/api/channels', controller.signal)
        if (!controller.signal.aborted) { setChannels(list); setListError('') }
      } catch (err) { if (!controller.signal.aborted) { setListError(err instanceof Error ? err.message : '频道读取失败'); setChannels([]) } }
      finally { pending = false; if (!controller.signal.aborted) setLoading(false) }
    }
    setLoading(true); void load()
    const timer = setInterval(() => { void load(); if (!document.hidden) void permission.refresh(controller.signal) }, 25000)
    const visible = () => { if (!document.hidden) void load() }
    document.addEventListener('visibilitychange', visible)
    return () => { controller.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', visible) }
  }, [revision, permission.refresh])

  useEffect(() => {
    lastId.current = 0; setMessages([]); setMessageError('')
    if (!active) return
    const id = active.id, controller = new AbortController()
    let pending = false
    const tick = async () => {
      if (document.hidden || pending) return
      pending = true
      try {
        const list = await api.get(`/api/channels/${id}/messages?after=${lastId.current}`, controller.signal) as ChatMessage[]
        if (controller.signal.aborted) return
        setMessageError('')
        if (list.length) { lastId.current = list.at(-1)!.id; setMessages((prev) => [...prev, ...list.filter((m) => !prev.some((p) => p.id === m.id))].sort((a, b) => a.id - b.id)) }
      } catch (err) {
        if (!controller.signal.aborted) {
          setMessageError(err instanceof Error ? err.message : '消息读取失败')
          if ([403, 404].includes((err as { status: number }).status)) { setMessages([]); setRevision((v) => v + 1) }
        }
      } finally { pending = false }
    }
    void tick()
    const timer = setInterval(() => void tick(), 2500)
    return () => { controller.abort(); clearInterval(timer) }
  }, [active?.id])

  useEffect(() => { threadRef.current?.scrollTo({ top: 1e9 }) }, [messages.length, activeId])
  const send = async () => {
    const content = input.trim()
    if (!content || sending.current || !active || !permission.ready || permission.muted) return
    sending.current = true; setBusy(true); setMessageError('')
    try {
      const message = await api.post(`/api/channels/${active.id}/messages`, { content }) as ChatMessage
      if (currentChannel.current === message.channel_id) { setInput(''); setMessages((prev) => prev.some((m) => m.id === message.id) ? prev : [...prev, message].sort((a, b) => a.id - b.id)) }
    } catch (err) { permission.denied(err); if (currentChannel.current === active.id) setMessageError(err instanceof Error ? err.message : '发送失败') }
    finally { sending.current = false; setBusy(false) }
  }
  const channelList = <>
      {loading && <p className="muted small" role="status">{tr("频道加载中…")}</p>}
      {tr(listError) && <p className="error-text" role="alert">{tr(listError)} <button className="link-btn" onClick={() => setRevision((v) => v + 1)}>{tr("重试")}</button></p>}
      {(['public', 'idea'] as const).map((type) => <section key={type}><div className="channel-section">{type === 'public' ? tr("公共频道") : tr("灵感专属频道")}</div>
        {channels.filter((c) => c.type === type).map((channel) => <Link key={channel.id} to={`/channels/${channel.id}`} className={`channel-item ${channel.id === activeId ? 'active' : ''}`}>
          # {channel.name}{channel.idea_title && <span className="channel-sub">{channel.idea_title}</span>}<span className="channel-sub" title={tr(ONLINE_NOTE)}>{tr('在线约 {0} 人', [(channel.id === activeId ? presence.count : null) ?? channel.online_count ?? '—'])}</span>
        </Link>)}
      </section>)}
      {!loading && !tr(listError) && !channels.length && <p className="muted small">{tr("没有可访问的频道。")}</p>}
      {isOwner(user) && <Link className="link phase2-channel-manage" to={`/admin?tab=channels&type=${active?.type === 'idea' ? 'idea' : 'public'}`}>{tr("管理频道 →")}</Link>}
      <p className="muted small online-note">{tr(ONLINE_NOTE)}</p>
</>

  return <div className="chat-layout phase2-chat">
    <aside className="channel-side">{channelList}</aside>
    {chooser&&<Phase2Dialog variant="drawer" title={tr('选择频道')} onClose={()=>setChooser(false)}>{channelList}</Phase2Dialog>}
    <div className="chat-main">
      <div className="chat-head"><button className="btn btn-ghost channel-chooser" onClick={()=>setChooser(true)}>{tr('选择频道')}</button><b># {active?.name || (loading ? tr('加载中…') : tr('频道不可访问'))}</b>
        {active && <span className="muted small" title={tr(ONLINE_NOTE)}>{presence.error ? tr("在线人数暂不可用") : presence.count === null ? tr("在线人数加载中…") : tr("在线约 {0} 人", [presence.count])}</span>}
        {active?.idea_id && <Link className="link" to={`${active.idea_owner_id === user.id ? '/ideas' : '/plaza'}/${active.idea_id}`}>{tr("→ 查看这个灵感")}</Link>}
      </div>
      {!loading && !active && <p className="hint-banner">{tr("频道已归档、已删除或你无权访问，请从列表选择其他频道。")}</p>}
      {tr(messageError) && <p className="error-text phase2-chat-feedback" role="alert">{tr(messageError)}</p>}
      <div className="chat-thread" ref={threadRef}>
        {active && !messages.length && !tr(messageError) && <div className="chat-empty"><div className="empty-emoji">💬</div><p>{tr("还没有消息，来聊聊你的灵感吧～")}</p></div>}
        {messages.map((message) => <div key={message.id} className={`chat-msg ${message.user_id === user.id ? 'own' : ''}`}><div className="msg-meta">{message.user_id === user.id ? tr("我") : message.author} · {fmtDate(message.created_at)} {fmtTime(message.created_at)}</div><div className="msg-bubble">{message.content}</div></div>)}
      </div>
      {(permission.muted || permission.error) && <p className="error-text phase2-chat-feedback" role="alert">{permission.muted ? tr("账号已被禁言，暂不能发送消息。{0}", [permission.reason || '']) : tr(permission.error)}<button className="link-btn" onClick={() => void permission.refresh()}>{tr("刷新发言权限")}</button></p>}
      <form className="chat-input-row" onSubmit={(event) => { event.preventDefault(); void send() }}><input aria-label={tr("频道消息")} placeholder={permission.muted ? tr("账号已被禁言") : tr("在「{0}」里发言…", [active?.name || ''])} value={input} maxLength={2000} disabled={!active || !permission.ready || permission.muted || busy} onChange={(event) => setInput(event.target.value)} />
        <button className="btn btn-primary" disabled={busy || !active || !permission.ready || permission.muted || !input.trim()}>{busy ? tr("发送中…") : tr("发送")}</button></form>
    </div>
  </div>
}
