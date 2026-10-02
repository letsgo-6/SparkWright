// SPDX-License-Identifier: MPL-2.0
import { formatIdeaScore } from '../../shared/idea-score'
import { tr, locale } from '../i18n/index'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../api'
import type { ChannelMsg, PlazaComment, User } from '../types'
import { STATUS_META, fmtDate } from '../utils'
import { ScoreHistory } from '../components/ScoreHistory'
import { usePlazaPermission } from '../hooks/usePlazaPermission'
import { useChannelPresence } from '../hooks/useChannelPresence'
import { ONLINE_NOTE } from '../lib/phase2'

interface DetailData {
  idea: {
    id: number
    title: string
    content: string
    public_summary: string
    tags: string
    status: string
    score_public: number
    user_id: number
    author: string
    created_at: string
  }
  likeCount: number
  liked: boolean
  commentCount: number
  score: number | null
  channel: { id: number; name: string } | null
}

export function PlazaDetailPage({ user }: { user: User }) {
  const permission = usePlazaPermission()
  const { id } = useParams()
  const [data, setData] = useState<DetailData | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [comments, setComments] = useState<PlazaComment[]>([])
  const [content, setContent] = useState('')
  const [replyTo, setReplyTo] = useState<PlazaComment | null>(null)
  const [replyText, setReplyText] = useState('')
  const [members, setMembers] = useState<{ id: number; name: string }[]>([])
  const [mentionOpen, setMentionOpen] = useState(false)
  const [tab, setTab] = useState<'info' | 'chat'>('info')
  const [msgs, setMsgs] = useState<ChannelMsg[]>([])
  const [chatInput, setChatInput] = useState('')
  const [writeError, setWriteError] = useState(''), [loadError, setLoadError] = useState('')
  const [sending, setSending] = useState(false), [retry, setRetry] = useState(0)
  const [others, setOthers] = useState<{ id: number; title: string }[]>([])
  const lastMsgId = useRef(0)
  const commentEndRef = useRef<HTMLDivElement>(null)
  const presence = useChannelPresence(data?.channel?.id, tab === 'chat')

  useEffect(() => {
    const controller = new AbortController()
    setData(null); setComments([]); setNotFound(false); setLoadError(''); setWriteError('')
    api.get(`/api/plaza/${id}`, controller.signal).then((result) => { if (!controller.signal.aborted) setData(result) })
      .catch((err) => { if (!controller.signal.aborted) { if (err.status === 404) setNotFound(true); else setLoadError(err.message) } })
    api.get(`/api/plaza/${id}/comments`, controller.signal).then((result) => { if (!controller.signal.aborted) setComments(result) })
      .catch((err) => { if (!controller.signal.aborted) setLoadError(err.message) })
    api.get('/api/plaza/members', controller.signal).then((result) => { if (!controller.signal.aborted) setMembers(result) }).catch(() => {})
    return () => controller.abort()
  }, [id, retry])

  const authorOthers = useMemo(() => {
    if (!data) return []
    return others.filter((o) => o.id !== data.idea.id).slice(0, 5)
  }, [others, data])

  useEffect(() => {
    if (!data) return
    api.get(`/api/plaza?author=${data.idea.user_id}&sort=latest`).then((r: any) => setOthers(r.items)).catch(() => {})
  }, [data?.idea.user_id])

  // 灵感专属频道聊天（老频道收容进侧 tab）
  useEffect(() => {
    lastMsgId.current = 0; setMsgs([])
    if (!data?.channel || tab !== 'chat') return
    let stopped = false
    const tick = async () => {
      if (document.hidden) return
      try {
        const list = (await api.get(`/api/channels/${data.channel!.id}/messages?after=${lastMsgId.current}`)) as ChannelMsg[]
        if (stopped || !list.length) return
        const initial = lastMsgId.current === 0
        lastMsgId.current = list[list.length - 1].id
        setMsgs((prev) => (initial ? list : [...prev, ...list.filter((m) => !prev.some((p) => p.id === m.id))]))
      } catch (err) {
        if (!stopped) { setWriteError(err instanceof Error ? err.message : '频道读取失败'); setMsgs([]) }
      }
    }
    tick()
    const t = setInterval(tick, 3000)
    return () => {
      stopped = true
      clearInterval(t)
    }
  }, [data?.channel?.id, tab])

  useEffect(() => {
    commentEndRef.current?.scrollIntoView({ block: 'nearest' })
  }, [comments.length])

  if (notFound) {
    return (
      <div className="page">
        <div className="empty">
          <p>{tr("灵感不存在或未发布。")}</p>
          <Link className="btn btn-ghost" to="/plaza">{tr("回广场")}</Link>
        </div>
      </div>
    )
  }
  if (!data) return <div className="page muted">{tr(loadError) ? <p className="error-text" role="alert">{tr(loadError)} <button className="link-btn" onClick={() => setRetry((v) => v + 1)}>{tr("重试")}</button></p> : tr("加载中…")}</div>

  const idea = data.idea
  const parents = comments.filter((c) => !c.parent_id)
  const repliesOf = (pid: number) => comments.filter((c) => c.parent_id === pid)
  const tags = (idea.tags || '').split(',').map((t) => t.trim()).filter(Boolean)

  const sendComment = async (text: string, parentId: number | null) => {
    const c = text.trim()
    if (!c || sending || permission.muted || !permission.ready) return
    setSending(true); setWriteError('')
    try {
      await api.post(`/api/plaza/${idea.id}/comments`, { content: c, parentId })
      setContent('')
      setReplyTo(null)
      setReplyText('')
      const list = (await api.get(`/api/plaza/${idea.id}/comments`)) as PlazaComment[]
      setComments(list)
    } catch (e: any) {
      permission.denied(e); setWriteError(e.message)
    } finally { setSending(false) }
  }

  const onMainInput = (v: string) => {
    setContent(v)
    setMentionOpen(/@[^@\s]*$/.test(v))
  }

  const insertMention = (name: string) => {
    setContent(content.replace(/@[^@\s]*$/, `@${name} `))
    setMentionOpen(false)
  }

  const sendChat = async () => {
    const c = chatInput.trim()
    if (!c || !data.channel || sending || permission.muted || !permission.ready) return
    setSending(true); setWriteError('')
    try { await api.post(`/api/channels/${data.channel.id}/messages`, { content: c }); setChatInput('') }
    catch (err) { permission.denied(err); setWriteError(err instanceof Error ? err.message : '发送失败') }
    finally { setSending(false) }
  }

  const time = (iso: string) => {
    const d = new Date(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`)
    return `${fmtDate(iso)} ${d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })}`
  }

  return (
    <div className="page">
      <Link className="link-btn" to="/plaza">{tr("← 回广场")}</Link>
      {(permission.muted || permission.error || tr(writeError) || tr(loadError)) && <p className="error-text" role="alert">{permission.muted ? tr("账号已被禁言，暂不能评论或发言。{0}", [permission.reason || '']) : tr(writeError) || tr(loadError) || tr(permission.error)} <button className="link-btn" onClick={() => void permission.refresh()}>{tr("刷新发言权限")}</button></p>}
      <div className="detail-layout" style={{ marginTop: 14 }}>
        <div className="detail-left">
          <div className="panel">
            <div className="plaza-card-head">
              <span className="plaza-author">
                <span className="avatar small-avatar">{idea.author.slice(0, 1)}</span>
                <b>{idea.author}</b>
                <span className="muted small">· {fmtDate(idea.created_at)}</span>
              </span>
              <div className="plaza-card-tags">
                <span className={`status-pill ${STATUS_META[idea.status as keyof typeof STATUS_META]?.cls || 'st-incubating'}`}>
                  {tr(STATUS_META[idea.status as keyof typeof STATUS_META]?.label) || idea.status}
                </span>
                {tags.map((t) => <span key={t} className="plat-chip">#{t}</span>)}
                {!!idea.score_public&&<span className="muted small">{data.score==null?tr("当前标准待评分"):tr("当前代表分：")+formatIdeaScore(data.score)}</span>}
                {!!idea.score_public && <ScoreHistory ideaId={idea.id} publicOnly />}
              </div>
            </div>
            <h2 className="plaza-card-title">{idea.title}</h2>
            <p className="plaza-detail-content">{idea.content || idea.public_summary}</p>
          </div>

          <div className="panel">
            <div className="panel-head"><h2>{tr("💬 评论")}{comments.length}</h2></div>
            {comments.length === 0 && <p className="muted small">{tr("还没有评论，来抢一楼。")}</p>}
            {parents.map((c) => (
              <div key={c.id} className="comment-item">
                <div className="comment-head"><b>{c.author}</b><span className="muted small">{time(c.created_at)}</span></div>
                <div className="comment-content">{c.content}</div>
                <button className="link-btn" disabled={!permission.ready || permission.muted || sending} onClick={() => { setReplyTo(c); setReplyText(`@${c.author} `) }}>{tr("回复")}</button>
                {repliesOf(c.id).map((r) => (
                  <div key={r.id} className="comment-reply">
                    <div className="comment-head"><b>{r.author}</b><span className="muted small">{time(r.created_at)}</span></div>
                    <div className="comment-content">{r.content}</div>
                  </div>
                ))}
                {replyTo?.id === c.id && (
                  <div className="reply-box">
                    <input
                      autoFocus
                      disabled={!permission.ready || permission.muted || sending}
                      placeholder={tr("回复 @{0}…（回车发送）", [replyTo.author])}
                      value={replyText}
                      onChange={(e) => setReplyText(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && sendComment(replyText, c.id)}
                    />
                    <button className="btn btn-ghost btn-sm" disabled={!permission.ready || permission.muted || sending} onClick={() => sendComment(replyText, c.id)}>{tr("发送")}</button>
                  </div>
                )}
              </div>
            ))}
            <div ref={commentEndRef} />
            <div className="reply-box" style={{ marginTop: 10 }}>
              <div className="mention-wrap">
                <input
                  placeholder={tr("写评论… 输入 @ 可提及成员")}
                  disabled={!permission.ready || permission.muted || sending}
                  value={content}
                  onChange={(e) => onMainInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && sendComment(content, null)}
                />
                {mentionOpen && (
                  <div className="mention-list">
                    {members.filter((m) => m.id !== user.id).map((m) => (
                      <div key={m.id} className="due-item" onClick={() => insertMention(m.name)}>
                        <span className="due-title">@{m.name}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <button className="btn btn-primary btn-sm" disabled={!permission.ready || permission.muted || sending || !content.trim()} onClick={() => sendComment(content, null)}>{tr("发送")}</button>
            </div>
          </div>
        </div>

        <div className="detail-left">
          <div className="panel">
            <div className="panel-head"><h2>{tr("👤 作者")}</h2></div>
            <p><b>{idea.author}</b></p>
            <p className="muted small">{tr("公开灵感")}{others.length} {tr("篇")}</p>
            {authorOthers.length > 0 && (
              <div>
                {authorOthers.map((o) => (
                  <Link key={o.id} to={`/plaza/${o.id}`} className="due-item">
                    <span className="due-title">{o.title}</span>
                  </Link>
                ))}
              </div>
            )}
          </div>

          <div className="panel">
            <div className="panel-head">
              <div className="auth-tabs" style={{ margin: 0 }}>
                <button className={`auth-tab ${tab === 'info' ? 'active' : ''}`} onClick={() => setTab('info')}>{tr("🧭 相关")}</button>
                <button className={`auth-tab ${tab === 'chat' ? 'active' : ''}`} onClick={() => setTab('chat')}>{tr("💬 讨论区")}</button>
              </div>
            </div>
            {tab === 'info' && <p className="muted small">{tr("这条灵感的延伸信息会出现在这里（二期扩展位）。")}</p>}
            {tab === 'chat' && (
              data.channel ? (
                <div>
                  <p className="muted small" title={tr(ONLINE_NOTE)}>{presence.error ? tr("在线人数暂不可用") : presence.count === null ? tr("在线人数加载中…") : tr("在线约 {0} 人", [presence.count])}</p>
                  <p className="muted small online-note">{tr(ONLINE_NOTE)}</p>
                  <div className="chat-thread chat-embed">
                    {msgs.map((m) => (
                      <div key={m.id} className={`chat-msg ${m.user_id === user.id ? 'own' : ''}`}>
                        <div className="msg-meta">{m.user_id === user.id ? tr("我") : m.author} · {time(m.created_at)}</div>
                        <div className="msg-bubble">{m.content}</div>
                      </div>
                    ))}
                    {msgs.length === 0 && <p className="muted small" style={{ textAlign: 'center' }}>{tr("讨论区还没有消息。")}</p>}
                  </div>
                  <div className="chat-input-row" style={{ padding: '10px 0 0', borderTop: 'none' }}>
                    <input placeholder={permission.muted ? tr("账号已被禁言") : tr("在讨论区发言…")} disabled={!permission.ready || permission.muted || sending} value={chatInput} onChange={(e) => setChatInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && sendChat()} />
                    <button className="btn btn-primary btn-sm" disabled={!permission.ready || permission.muted || sending || !chatInput.trim()} onClick={sendChat}>{tr("发送")}</button>
                  </div>
                </div>
              ) : (
                <p className="muted small">{tr("作者还没有为这条灵感开启讨论区。")}</p>
              )
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
