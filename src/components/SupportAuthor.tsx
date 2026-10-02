// SPDX-License-Identifier: MPL-2.0
import { tr } from '../i18n/index'
import { useState } from 'react'
import { SUPPORT } from '../config/support'
import { externalHttps } from '../lib/phase2'
import { safeActionUrl } from '../../shared/links'
import { Phase2Dialog } from './Phase2Dialog'

export function SupportAuthor() {
  const [open, setOpen] = useState(false)
  const url = externalHttps(SUPPORT.url), qr = safeActionUrl(SUPPORT.qrImage)
  return <><button className="sw-icon-button" onClick={() => setOpen(true)}>{tr("♡ 支持作者")}</button>
    {open && <Phase2Dialog title={tr(SUPPORT.title || "支持作者 / 打赏")} onClose={() => setOpen(false)}>
      <p className="sw-plain-text">{tr(SUPPORT.description || "谢谢你使用 SparkWright。打赏信息尚未填写。")}</p>
      {!url && !qr && <p className="muted">{tr("打赏信息尚未填写")}</p>}
      {qr && <figure className="support-qr-figure">
        <a href={qr} target="_blank" rel="noopener noreferrer" aria-label={tr("查看微信赞赏码原图")}>
          <img className="support-qr" src={qr} alt={tr("微信赞赏码")} />
        </a>
        <figcaption className="muted small">{tr("使用微信扫码赞赏；点击图片可查看原图。")}</figcaption>
      </figure>}
      {url && <a className="btn btn-primary" href={url} target="_blank" rel="noopener noreferrer">{tr("前往爱发电支持 ↗")}</a>}
      <div className="modal-actions"><button className="btn btn-ghost" onClick={() => setOpen(false)}>{tr("关闭")}</button></div>
    </Phase2Dialog>}
  </>
}
