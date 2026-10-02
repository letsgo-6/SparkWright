// SPDX-License-Identifier: MPL-2.0
import { uiText, uiParam, tr } from '../i18n/index'
import { useEffect, useRef, useState } from 'react'
import { api } from '../api'
import { isOwner, type ModerationUser, type Paged, type User, type UserRole } from '../types'
import { fmtDate, fmtTime } from '../utils'
import { Phase2Dialog } from './Phase2Dialog'

export function UserManager({ user, onSelfRoleChanged }: { user: User; onSelfRoleChanged: () => void }) {
  const [items, setItems] = useState<User[]>([])
  const [roles, setRoles] = useState<Record<number, UserRole>>({})
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<number | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [moderation, setModeration] = useState<Record<number, ModerationUser>>({})
  const [muteTarget, setMuteTarget] = useState<User | null>(null)
  const [reason, setReason] = useState('')
  const pending = useRef(false)
  const controller = useRef<AbortController | null>(null)
  const load = async (request = controller.current) => {
    if (!request || request.signal.aborted) return
    setLoading(true); setError(''); setItems([]); setRoles({})
    try {
      const [result, states] = await Promise.all([
        api.get(`/api/admin/users?page=${page}&pageSize=10`, request.signal) as Promise<Paged<User>>,
        isOwner(user) ? api.get(`/api/admin/moderation/users?page=${page}&pageSize=10`, request.signal) as Promise<Paged<ModerationUser>> : Promise.resolve(null),
      ])
      if (!request.signal.aborted) { setItems(result.items); setTotal(result.total); setModeration(Object.fromEntries((states?.items || []).map((row) => [row.id, row]))) }
    } catch (err) { if (!request.signal.aborted) setError(err instanceof Error ? err.message : '账号列表读取失败') }
    finally { if (!request.signal.aborted) setLoading(false) }
  }
  useEffect(() => {
    const request = new AbortController(); controller.current = request
    void load(request)
    return () => request.abort()
  }, [page])
  const save = async (target: User) => {
    const request = controller.current, role = roles[target.id] || target.role
    if (!request || request.signal.aborted || pending.current || role === target.role) return
    pending.current = true; setBusy(target.id); setError(''); setNotice('')
    try {
      await api.patch(`/api/admin/users/${target.id}/role`, { role }, request.signal)
      if (request.signal.aborted) return
      if (target.id === user.id) { onSelfRoleChanged(); return }
      setNotice(uiText("账号 #{0} 的角色已更新为 {1}。", [target.id, role]))
      await load(request)
    } catch (err) { if (!request.signal.aborted) setError(err instanceof Error ? err.message : '角色修改失败') }
    finally { pending.current = false; if (!request.signal.aborted) setBusy(null) }
  }
  const saveMute = async () => {
    if (!muteTarget || pending.current) return
    pending.current = true; setBusy(muteTarget.id); setError(''); setNotice('')
    try {
      const muted = !moderation[muteTarget.id]?.plaza_muted_at
      await api.patch(`/api/admin/users/${muteTarget.id}/mute`, { muted, reason: reason.trim() })
      setNotice(uiText("账号 #{0} 已{1}。", [muteTarget.id, uiParam(muted ? '禁言' : '解除禁言')]))
      setMuteTarget(null); await load()
    } catch (err) { setError(err instanceof Error ? err.message : '禁言操作失败') }
    finally { pending.current = false; setBusy(null) }
  }
  return <section className="settings-card" aria-label={tr("用户管理")}>
    <div className="panel-head"><h2>{tr("用户管理")}</h2><button className="chip" disabled={loading || busy !== null} onClick={() => void load()}>{tr("刷新列表")}</button></div>
    <p className="muted small">{tr("仅展示基本账号信息。")}{isOwner(user) ? tr("角色修改立即生效；降低自己的权限会退出对应管理区，最后一个 owner 不能降权。") : tr("角色修改仅 owner 可用。")}</p>
    {tr(error) && <p className="error-text" role="alert">{tr(error)} <button className="link-btn" disabled={loading || busy !== null} onClick={() => void load()}>{tr("重试列表")}</button></p>}
    {tr(notice) && <p className="save-flash" role="status">{tr(notice)}</p>}
    {loading ? <p className="muted" role="status">{tr("账号加载中…")}</p> : !items.length ? <p className="muted">{tr("本页没有账号。")}</p> : <div className="admin-table-wrap" tabIndex={0} aria-label={tr("账号列表，可横向滚动")}>
      <table className="admin-users"><thead><tr><th scope="col">ID</th><th scope="col">{tr("昵称")}</th><th scope="col">{tr("邮箱")}</th><th scope="col">{tr("角色")}</th><th scope="col">{tr("创建时间")}</th>{isOwner(user) && <><th scope="col">{tr("修改角色")}</th><th scope="col">{tr("发言权限")}</th></>}</tr></thead>
        <tbody>{items.map((item) => <tr key={item.id}><td>{item.id}</td><td>{item.name}{item.id === user.id && <span className="muted small">{tr("（本人）")}</span>}</td><td>{item.email || tr("未设置")}</td><td>{item.role}</td><td>{fmtDate(item.created_at)} {fmtTime(item.created_at)}</td>
          {isOwner(user) && <td><div className="admin-role-actions"><select aria-label={tr("账号 {0} 的角色", [item.id])} value={roles[item.id] || item.role} disabled={busy !== null}
            onChange={(event) => setRoles({ ...roles, [item.id]: event.target.value as UserRole })}>
            {(['user', 'admin', 'owner'] as const).map((role) => <option key={role} value={role}>{role}</option>)}
          </select><button className="chip" disabled={busy !== null || (roles[item.id] || item.role) === item.role} onClick={() => void save(item)}>{busy === item.id ? tr("保存中…") : tr("保存角色")}</button></div></td>}
          {isOwner(user) && <td><p>{moderation[item.id]?.plaza_muted_at ? tr("已禁言") : tr("正常")}</p>{moderation[item.id]?.plaza_mute_reason && <p className="muted small moderation-reason">{moderation[item.id].plaza_mute_reason}</p>}
            <button className="chip" disabled={busy !== null || item.role === 'owner' || !moderation[item.id]} onClick={() => { setMuteTarget(item); setReason(''); setError('') }}>{moderation[item.id]?.plaza_muted_at ? tr("解除禁言") : tr("禁言")}</button></td>}
        </tr>)}</tbody></table>
    </div>}
    {total > 10 && <div className="sw-notice-pagination"><button className="chip" disabled={page === 1 || busy !== null || loading} onClick={() => setPage((value) => value - 1)}>{tr("上一页")}</button><span>{page} / {Math.ceil(total / 10)}</span><button className="chip" disabled={page * 10 >= total || busy !== null || loading} onClick={() => setPage((value) => value + 1)}>{tr("下一页")}</button></div>}
    {muteTarget && <Phase2Dialog title={moderation[muteTarget.id]?.plaza_muted_at ? tr("确认解除禁言") : tr("确认禁言")} onClose={() => { if (busy === null) setMuteTarget(null) }}>
      <p className="sw-plain-text">{muteTarget.name}（#{muteTarget.id}{tr("）。禁言影响公开发布、公开灵感编辑、评论和频道发言，私人灵感仍可编辑。")}</p>
      {!moderation[muteTarget.id]?.plaza_muted_at && <label className="form-field">{tr("原因（可选）")}<textarea rows={3} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} /></label>}
      {tr(error) && <p className="error-text" role="alert">{tr(error)}</p>}<div className="modal-actions"><button className="btn btn-ghost" disabled={busy !== null} onClick={() => setMuteTarget(null)}>{tr("取消")}</button><button className="btn btn-primary" disabled={busy !== null} onClick={() => void saveMute()}>{busy !== null ? tr("提交中…") : tr("确认操作")}</button></div>
    </Phase2Dialog>}
  </section>
}
