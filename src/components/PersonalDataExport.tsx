// SPDX-License-Identifier: MPL-2.0
import { tr } from '../i18n/index'
import { useEffect, useRef, useState } from 'react'
import { downloadAttachment } from '../lib/download'

export function PersonalDataExport() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const controller = useRef<AbortController | null>(null)
  const pending = useRef(false)
  useEffect(() => {
    const request = new AbortController()
    controller.current = request
    return () => request.abort()
  }, [])
  const download = async () => {
    const request = controller.current
    if (!request || request.signal.aborted || pending.current) return
    pending.current = true; setBusy(true); setError(''); setNotice('')
    try {
      await downloadAttachment('/api/export/me', request.signal)
      if (!request.signal.aborted) setNotice('个人 JSON 已下载。')
    } catch (err) { if (!request.signal.aborted) setError(err instanceof Error ? err.message : '导出失败，请重试') }
    finally { pending.current = false; if (!request.signal.aborted) setBusy(false) }
  }
  return <section className="settings-card" aria-label={tr("个人数据导出")}>
    <h2>{tr("导出我的数据")}</h2>
    <p className="small">{tr("下载属于你的灵感、计划、工程、商单、制作记录与互动记录，格式为 JSON。排除密码、密钥、原始 AI 日志及他人数据，识别到的凭证会脱敏。")}</p>
    <p className="muted small">{tr("JSON 仍包含你的业务内容，请妥善保存。此文件用于查看与留存，目前不支持导入。")}</p>
    {tr(error) && <p className="error-text" role="alert">{tr(error)}</p>}
    {tr(notice) && <p className="save-flash" role="status">{tr(notice)}</p>}
    <button className="btn btn-primary" disabled={busy} onClick={() => void download()}>{busy ? tr("正在导出…") : tr("导出我的数据")}</button>
  </section>
}
