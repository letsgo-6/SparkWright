// SPDX-License-Identifier: MPL-2.0
import Database from 'better-sqlite3'
import type { FastifyInstance } from 'fastify'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { db } from './db'
import { permissionError, requireOwner } from './permissions'
import { createOriginGuard, pagination, requireEmptyBody } from './request-validation'

const dataDir = path.dirname(db.name)
const backupDir = path.join(dataDir, 'backups')
const ID_PATTERN = /^\d{8}T\d{9}Z-[a-f0-9]{32}$/
let creating = false

function createdAt(id: string): string | null {
  if (!ID_PATTERN.test(id)) return null
  const date = `${id.slice(0, 4)}-${id.slice(4, 6)}-${id.slice(6, 8)}T${id.slice(9, 11)}:${id.slice(11, 13)}:${id.slice(13, 15)}.${id.slice(15, 18)}Z`
  const time = new Date(date)
  return Number.isNaN(time.getTime()) || time.toISOString() !== date ? null : date
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

async function managedRoot(): Promise<string> {
  const data = await lstat(dataDir)
  if (!data.isDirectory() || data.isSymbolicLink() || path.relative(dataDir, await realpath(dataDir)) !== '') throw new Error('unsafe_data_directory')
  await mkdir(backupDir, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error })
  const directory = await lstat(backupDir)
  const root = await realpath(backupDir)
  if (!directory.isDirectory() || directory.isSymbolicLink() || path.relative(backupDir, root) !== '' || !inside(dataDir, root)) throw new Error('unsafe_backup_directory')
  return root
}

async function managedFile(root: string, id: string) {
  const date = createdAt(id)
  if (!date) throw permissionError(400, 'invalid_backup_id', '备份 ID 格式不正确')
  const fileName = `${id}.db`
  const filename = path.resolve(root, fileName)
  if (!inside(root, filename)) throw permissionError(400, 'invalid_backup_id', '备份 ID 格式不正确')
  const stat = await lstat(filename).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw permissionError(404, 'backup_not_found', '备份不存在或不可下载')
    throw error
  })
  if (!stat.isFile() || stat.isSymbolicLink() || !stat.size || !inside(root, await realpath(filename))) throw permissionError(404, 'backup_not_found', '备份不存在或不可下载')
  return { filename, stat, metadata: { id, file_name: fileName, size_bytes: stat.size, created_at: date } }
}

async function cleanupTemporary(filename: string): Promise<void> {
  const root = await managedRoot()
  if (path.dirname(filename) !== root || !inside(root, filename)) throw new Error('unsafe_cleanup_path')
  for (const suffix of ['', '-wal', '-shm', '-journal']) await rm(filename + suffix, { force: true, maxRetries: 5, retryDelay: 100 })
}

function diagnose(operation: string, error: unknown): void {
  // Never log a filesystem path, SQL, database content, or credential.
  console.error(`[backup] ${operation} failed`, error instanceof Error ? (error as NodeJS.ErrnoException).code || error.name : 'unknown')
}

export function registerBackupRoutes(app: FastifyInstance): void {
  const requireOrigin = createOriginGuard()
  app.post('/api/admin/backups', async (req, reply) => {
    requireOwner(req); requireOrigin(req); requireEmptyBody(req.body)
    if (Object.keys(req.query as object).length) throw permissionError(400, 'invalid_backup_request', '备份创建不接受路径或其他参数')
    if (creating) throw permissionError(409, 'backup_in_progress', '正在创建备份，请稍后重试')
    creating = true
    let temporary: string | undefined
    try {
      const root = await managedRoot()
      const id = `${new Date().toISOString().replace(/[-:.]/g, '')}-${randomBytes(16).toString('hex')}`
      const candidate = path.join(root, `${id}.part`)
      const reserved = await open(candidate, 'wx', 0o600)
      temporary = candidate
      await reserved.close()
      await db.backup(temporary)
      const stat = await lstat(temporary)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 16 || path.relative(temporary, await realpath(temporary)) !== '') throw new Error('invalid_backup_file')
      const verify = new Database(temporary, { readonly: true, fileMustExist: true })
      try { if (verify.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('backup_integrity_failed') }
      finally { verify.close() }
      for (const suffix of ['-wal', '-shm', '-journal']) await rm(temporary + suffix, { force: true })
      if (await managedRoot() !== root) throw new Error('backup_directory_changed')
      requireOwner(req) // A role change while awaiting backup must not return a privileged result.
      const final = path.join(root, `${id}.db`)
      await rename(temporary, final)
      temporary = undefined
      return (await managedFile(root, id)).metadata
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode && (error as { statusCode: number }).statusCode < 500) throw error
      diagnose('create', error)
      reply.code(500)
      return { error: { code: 'backup_failed', message: '备份创建失败，请检查存储空间与目录权限后重试' } }
    } finally {
      try { if (temporary) await cleanupTemporary(temporary) }
      catch (error) { diagnose('temporary cleanup', error) }
      finally { creating = false }
    }
  })

  app.get<{ Querystring: Record<string, unknown> }>('/api/admin/backups', async (req, reply) => {
    requireOwner(req)
    const { page, pageSize, offset } = pagination(req.query)
    try {
      const root = await managedRoot()
      const files = (await readdir(root)).filter((name) => name.endsWith('.db') && createdAt(name.slice(0, -3))).sort().reverse()
      const valid = []
      for (const name of files) {
        try { valid.push((await managedFile(root, name.slice(0, -3))).metadata) }
        catch (error) { if ((error as { statusCode?: number }).statusCode !== 404) throw error }
      }
      requireOwner(req)
      return { items: valid.slice(offset, offset + pageSize), page, pageSize, total: valid.length }
    } catch (error) {
      if ((error as { statusCode?: number }).statusCode && (error as { statusCode: number }).statusCode < 500) throw error
      diagnose('list', error)
      return reply.code(500).send({ error: { code: 'backup_list_failed', message: '备份列表读取失败，请检查目录权限后重试' } })
    }
  })

  app.get<{ Params: { id: string } }>('/api/admin/backups/:id/download', async (req, reply) => {
    requireOwner(req)
    if (Object.keys(req.query as object).length || !createdAt(req.params.id)) throw permissionError(400, 'invalid_backup_id', '备份 ID 格式不正确')
    let handle
    try {
      const root = await managedRoot()
      const file = await managedFile(root, req.params.id)
      handle = await open(file.filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
      const stat = await handle.stat()
      if (!stat.isFile() || stat.ino !== file.stat.ino || stat.dev !== file.stat.dev || await managedRoot() !== root) throw permissionError(404, 'backup_not_found', '备份不存在或不可下载')
      requireOwner(req)
      const stream = handle.createReadStream({ autoClose: true })
      handle = undefined
      reply.raw.once('close', () => stream.destroy())
      return reply.header('Content-Type', 'application/vnd.sqlite3').header('Content-Disposition', `attachment; filename="${file.metadata.file_name}"`)
        .header('Cache-Control', 'no-store').header('Content-Length', stat.size).send(stream)
    } catch (error) {
      if (handle) await handle.close()
      if ((error as { statusCode?: number }).statusCode && (error as { statusCode: number }).statusCode < 500) throw error
      diagnose('download', error)
      return reply.code(500).send({ error: { code: 'backup_download_failed', message: '备份下载失败，请重试' } })
    }
  })
}
