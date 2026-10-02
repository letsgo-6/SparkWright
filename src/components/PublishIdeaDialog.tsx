// SPDX-License-Identifier: MPL-2.0
import { useState } from 'react'
import type { Idea } from '../types'
import { api } from '../api'
import { tr } from '../i18n/index'
import { usePlazaPermission } from '../hooks/usePlazaPermission'
import { Phase2Dialog } from './Phase2Dialog'

export function PublishIdeaDialog({idea,joinLeaderboard=false,onClose,onPublished}:{idea:Idea;joinLeaderboard?:boolean;onClose:()=>void;onPublished:()=>Promise<void>}) {
  const permission=usePlazaPermission()
  const [form,setForm]=useState({summary:idea.public_summary||(idea.content||idea.title).slice(0,100),tags:idea.tags||'',scorePublic:true})
  const [busy,setBusy]=useState(false),[error,setError]=useState('')
  const publish=async()=>{
    if(busy||!permission.ready||permission.muted||(joinLeaderboard&&!form.scorePublic))return
    setBusy(true);setError('')
    try {
      await api.post(`/api/plaza/${idea.id}/publish`,form)
      await onPublished()
      if(joinLeaderboard) { await api.put(`/api/ideas/${idea.id}/leaderboard`,{enabled:true});await onPublished() }
      onClose()
    } catch(err:any) {permission.denied(err);setError(err.message)}
    finally {setBusy(false)}
  }
  return <Phase2Dialog title={tr('🌐 发布灵感到广场')} onClose={()=>{if(!busy)onClose()}}>
    <p className="muted small">{tr('灵感：')}{idea.title}（#{idea.id}）</p>
    <p className="hint-banner">{tr(joinLeaderboard?'参榜需要公开灵感与评分。确认后会公开标题、正文、摘要及评分，并主动加入排行榜。':'发布后其他用户可查看标题、正文和摘要；发布不会自动参加排行榜。')}</p>
    <div className="form-field"><label>{tr('公开摘要（默认正文前 100 字，可改）')}</label><textarea rows={3} value={form.summary} maxLength={200} onChange={e=>setForm({...form,summary:e.target.value})}/></div>
    <div className="form-field"><label>{tr('话题标签（逗号分隔，如 AI副业,学生党）')}</label><input value={form.tags} onChange={e=>setForm({...form,tags:e.target.value})}/></div>
    <div className="form-field"><label>{tr('公开 AI 评分？')}</label><div className="form-inline">
      <label><input type="radio" name="publish-score" checked={form.scorePublic} onChange={()=>setForm({...form,scorePublic:true})}/> {tr('公开')}</label>
      <label><input type="radio" name="publish-score" checked={!form.scorePublic} onChange={()=>setForm({...form,scorePublic:false})}/> {tr('隐藏')}</label>
    </div></div>
    {joinLeaderboard&&!form.scorePublic&&<p className="error-text">{tr('隐藏评分时不能参加排行榜。')}</p>}
    {error&&<p className="error-text" role="alert">{tr(error)}</p>}
    <div className="modal-actions"><button className="btn btn-ghost" disabled={busy} onClick={onClose}>{tr('取消')}</button><button className="btn btn-primary" disabled={busy||!permission.ready||permission.muted||(joinLeaderboard&&!form.scorePublic)} onClick={()=>void publish()}>{busy?tr('处理中…'):tr(joinLeaderboard?'公开并参加排行榜':'确认发布')}</button></div>
  </Phase2Dialog>
}
