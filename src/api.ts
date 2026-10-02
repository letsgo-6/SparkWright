// SPDX-License-Identifier: MPL-2.0
import { ERROR_MESSAGES } from '../shared/error-messages'
import { uiText } from './i18n/index'

export class ApiError extends Error {
  constructor(public code: string, public status = 0, public retryAfter?: number, public feedbackId?: number) { super(uiText(`error.${code}`)) }
}
export function apiError(code: unknown, status = 0, retryAfter?: number): ApiError {
  const known = typeof code === 'string' && Object.hasOwn(ERROR_MESSAGES, code)
  if (!known && import.meta.env?.DEV) console.warn('[api] unknown error code', typeof code === 'string' ? code.slice(0, 80) : 'missing')
  return new ApiError(known ? code as string : 'request_failed', status, retryAfter)
}
export function safeClientError(error: unknown): ApiError { return error instanceof ApiError ? error : apiError('network_error') }
export async function responseError(res: Response, url: string): Promise<ApiError> {
  const data = await res.json().catch(() => null)
  const retry = Number(res.headers.get('Retry-After'))
  const err = apiError(data?.error?.code, res.status, Number.isFinite(retry) && retry > 0 ? retry : undefined)
  if (err.code === 'feedback_duplicate' && Number.isSafeInteger(data?.error?.feedback_id) && data.error.feedback_id > 0) err.feedbackId = data.error.feedback_id
  const pathname = url.split('?')[0]
  if ((res.status === 401 && !pathname.startsWith('/api/auth/')) || (res.status === 403 && pathname.startsWith('/api/admin/'))) {
    window.dispatchEvent(new CustomEvent('sparkwright:auth-refresh', { detail: { message: err.message } }))
  }
  return err
}
async function request(url: string, init: RequestInit) {
  let res: Response
  try { res = await fetch(url, init) } catch (error) {
    if (init.signal?.aborted) throw error
    throw safeClientError(error)
  }
  if (!res.ok) throw await responseError(res, url)
  const data = await res.json().catch(() => null)
  if (init.signal?.aborted) throw new DOMException('Request cancelled', 'AbortError')
  if (data === null) throw apiError('request_failed', res.status)
  return data
}

const json = (method: string, body?: unknown): RequestInit => {
  const init: RequestInit = { method }
  // 只有真正带 body 的请求才设置 Content-Type，否则 Fastify 会对空 body 的 DELETE 报 400
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  return init
}

export const api = {
  get: (url: string, signal?: AbortSignal) => request(url, { signal }),
  post: (url: string, body?: unknown, signal?: AbortSignal) => request(url, { ...json('POST', body), signal }),
  put: (url: string, body?: unknown, signal?: AbortSignal) => request(url, { ...json('PUT', body), signal }),
  patch: (url: string, body?: unknown, signal?: AbortSignal) => request(url, { ...json('PATCH', body), signal }),
  del: (url: string) => request(url, json('DELETE')),
}
