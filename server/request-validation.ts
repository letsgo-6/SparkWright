// SPDX-License-Identifier: MPL-2.0
import type { FastifyRequest } from 'fastify'
import { permissionError } from './permissions'

function configuredOrigin(value: string): string {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('APP_ORIGIN / DEV_ORIGIN 必须是完整的 HTTP(S) 来源，不含路径或凭证')
  }
  return url.origin
}

export function createOriginGuard(): (req: FastifyRequest) => void {
  const origins = new Set<string>()
  if (process.env.APP_ORIGIN) origins.add(configuredOrigin(process.env.APP_ORIGIN))
  else for (const host of ['127.0.0.1', 'localhost']) origins.add(configuredOrigin(`http://${host}:${process.env.PORT || 5318}`))
  if (process.env.DEV_ORIGIN) origins.add(configuredOrigin(process.env.DEV_ORIGIN))
  else if (process.env.NODE_ENV !== 'production') {
    for (const host of ['127.0.0.1', 'localhost']) origins.add(configuredOrigin(`http://${host}:${process.env.WEB_PORT || 5310}`))
  }
  return (req) => {
    if (typeof req.headers.origin !== 'string' || !origins.has(req.headers.origin)) {
      throw permissionError(403, 'invalid_origin', '请求来源不受信任，请从 SparkWright 页面执行管理操作')
    }
  }
}

export function positiveInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | null {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) return null
  const number = Number(value)
  return Number.isSafeInteger(number) && number <= maximum ? number : null
}

export function pagination(query: Record<string, unknown>, defaultSize = 20): { page: number; pageSize: number; offset: number } {
  const page = query.page === undefined ? 1 : positiveInteger(query.page, 1_000_000)
  const pageSize = query.pageSize === undefined ? defaultSize : positiveInteger(query.pageSize, 100)
  if (!page || !pageSize || Object.keys(query).some((key) => key !== 'page' && key !== 'pageSize')) {
    throw permissionError(400, 'invalid_pagination', 'page 必须为 1–1000000 的整数，pageSize 必须为 1–100 的整数')
  }
  return { page, pageSize, offset: (page - 1) * pageSize }
}

export function requireId(value: string): number {
  const id = positiveInteger(value)
  if (!id) throw permissionError(400, 'invalid_id', 'ID 必须是正整数')
  return id
}

export function requireEmptyBody(body: unknown): void {
  if (body !== undefined && (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length)) {
    throw permissionError(400, 'invalid_body', '此操作不接受额外字段')
  }
}

export function featurePagination(query: Record<string, unknown>, allowed: string[] = []) {
  const page = query.page === undefined ? 1 : positiveInteger(query.page, 1000)
  const pageSize = query.pageSize === undefined ? 20 : positiveInteger(query.pageSize, 50)
  if (!page || !pageSize || Object.keys(query).some((key) => !['page', 'pageSize', ...allowed].includes(key)))
    throw permissionError(400, 'invalid_pagination', '分页参数不合法')
  return { page, pageSize, offset: (page - 1) * pageSize }
}
