// SPDX-License-Identifier: MPL-2.0
import { apiError, responseError, safeClientError } from '../api'
export async function downloadAttachment(url: string, signal: AbortSignal): Promise<string> {
  const response = await fetch(url, { signal }).catch((error) => { if (signal.aborted) throw error; throw safeClientError(error) })
  if (!response.ok) {
    throw await responseError(response, url)
  }
  const fileName = /^attachment; filename="([a-zA-Z0-9._-]+)"$/.exec(response.headers.get('Content-Disposition') || '')?.[1]
  if (!fileName) throw apiError('download_invalid')
  const blob = await response.blob()
  if (signal.aborted) throw new DOMException('下载已取消', 'AbortError')
  const objectUrl = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = objectUrl; link.download = fileName
  document.body.append(link)
  try { link.click() } finally { link.remove(); URL.revokeObjectURL(objectUrl) }
  return fileName
}
