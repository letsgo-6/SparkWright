// SPDX-License-Identifier: MPL-2.0
import type { FastifyInstance } from 'fastify'
import websocket from '@fastify/websocket'
import WebSocket from 'ws'
import { randomUUID, createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { request } from 'undici'
import { db } from './db'
import { readCookie } from './auth'
import { permissionError } from './permissions'
import { communityRoute } from '../shared/community-routes'

export function communityOrigin(value = process.env.COMMUNITY_URL || 'https://community.sparkwright.asia'): string {
  const url = new URL(value)
  if (url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
    (url.protocol !== 'https:' && !(process.env.NODE_ENV !== 'production' && url.protocol === 'http:' && ['localhost','127.0.0.1'].includes(url.hostname)))) throw new Error('COMMUNITY_URL 必须是 HTTPS 来源；本地开发允许 loopback HTTP')
  return url.origin
}
type Session = { cookie: string; expires: number; sockets: Set<WebSocket> }
export async function registerCommunityBridge(app: FastifyInstance): Promise<void> {
  const origin = communityOrigin(), sessions = new Map<string, Session>()
  if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='community_idea_links'").get()) {
    mkdirSync(path.join(process.cwd(),'backups'),{recursive:true})
    await db.backup(path.join(process.cwd(),'backups',`before-community-${Date.now()}.db`))
  }
  db.exec(`CREATE TABLE IF NOT EXISTS community_idea_links (
    instance_id TEXT NOT NULL, remote_user_id INTEGER NOT NULL, local_idea_id INTEGER NOT NULL REFERENCES ideas(id),
    remote_idea_id INTEGER NOT NULL, content_hash TEXT NOT NULL, state TEXT NOT NULL, updated_at TEXT NOT NULL,
    PRIMARY KEY(instance_id,remote_user_id,local_idea_id));`)
  await app.register(websocket, { options: { maxPayload: 16384 } })
  const clear = (key: string) => { const session = sessions.get(key); if (session) for (const socket of session.sockets) socket.close(1008, 'signed out'); sessions.delete(key) }
  const timer = setInterval(() => { for (const [key,session] of sessions) if (session.expires < Date.now()) clear(key) }, 60000); timer.unref()
  app.addHook('onClose', async () => { clearInterval(timer); for (const key of sessions.keys()) clear(key) })
  const remote = async (method: string, pathname: string, cookie: string, body?: unknown) => {
    try {
      const scoring = /^\/api\/ideas\/\d+\/ai\/score(?:\?|$)/.test(pathname)
      const result = await request(origin + pathname, { method: method as any, headersTimeout: scoring ? 0 : 15000, bodyTimeout: scoring ? 0 : 15000,
        headers: { origin, ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body) })
      const chunks: Buffer[]=[];let size=0
      for await(const chunk of result.body){size+=chunk.length;if(size>4*1024*1024){result.body.destroy();throw new Error('oversize')}chunks.push(Buffer.from(chunk))}
      const raw = Buffer.concat(chunks).toString('utf8')
      return { status: result.statusCode, data: JSON.parse(raw), cookie: result.headers['set-cookie'] }
    } catch { throw permissionError(503, 'community_unavailable', '社区暂时无法连接；本地个人功能仍可使用') }
  }
  app.get('/api/community/connection', async () => ({ origin, persistence: 'memory_until_exit' }))
  app.route({ method: ['GET','POST','PUT','PATCH','DELETE'], url: '/api/community/remote/*', bodyLimit: 65536, handler: async (req,reply) => {
    const pathname = req.url.slice('/api/community/remote'.length), clean = pathname.split('?')[0]
    if (!communityRoute(req.method, clean)) throw permissionError(404, 'route_unavailable', '社区接口不可用')
    const key = readCookie(req,'sparkwright_community') || '', session = sessions.get(key)
    const login = ['/api/community/auth/login','/api/community/auth/register'].includes(clean)
    if (!login && clean !== '/api/community/auth/me' && (!session || session.expires < Date.now())) throw permissionError(401,'community_unauthorized','请先登录社区')
    if (clean === '/api/community/auth/logout') {
      clear(key);reply.header('set-cookie','sparkwright_community=; Path=/api/community; HttpOnly; SameSite=Strict; Max-Age=0')
      try { const result=await remote('POST',clean,session!.cookie);return reply.code(result.status).send(result.data) }
      catch { return {ok:true,remote_revocation:'unavailable_local_session_cleared'} }
    }
    const result = await remote(req.method, pathname, session?.cookie || '', req.body)
    if (login && result.status < 300) {
      if (key) clear(key)
      for (const [id,s] of sessions) if (s.expires < Date.now()) clear(id)
      if (sessions.size >= 20) throw permissionError(429,'community_sessions_full','本机社区会话过多')
      const cookies = [result.cookie].flat().filter((x): x is string => typeof x === 'string')
      const credential = cookies.find(x => x.startsWith('ideabox_session='))?.split(';')[0]
      if (!credential) throw permissionError(502,'community_session_missing','社区登录未返回会话')
      const id = randomUUID(); sessions.set(id,{ cookie: credential, expires: Date.now()+7*86400000, sockets:new Set() })
      reply.header('set-cookie',`sparkwright_community=${id}; Path=/api/community; HttpOnly; SameSite=Strict; Max-Age=604800`)
    }
    if (clean === '/api/community/auth/logout' || result.status === 401) { clear(key); reply.header('set-cookie','sparkwright_community=; Path=/api/community; HttpOnly; SameSite=Strict; Max-Age=0') }
    return reply.code(result.status).header('Cache-Control','no-store').send(result.data)
  } })
  app.get('/api/community/links', async () => db.prepare('SELECT * FROM community_idea_links ORDER BY updated_at DESC LIMIT 200').all())
  app.post<{Body:{ local_idea_id: number; confirm: boolean; request_id: string }}>('/api/community/upload', async (req,reply) => {
    if (req.body?.confirm !== true || !Number.isSafeInteger(req.body.local_idea_id) || Object.keys(req.body).some(k => !['local_idea_id','confirm','request_id'].includes(k))) throw permissionError(400,'confirmation_required','请确认仅上传选定灵感的正文')
    const session = sessions.get(readCookie(req,'sparkwright_community') || '')
    if (!session || session.expires < Date.now()) throw permissionError(401,'community_unauthorized','请先登录社区')
    const idea = db.prepare('SELECT id,title,content FROM ideas WHERE id=? AND user_id=?').get(req.body.local_idea_id,req.authUser!.id) as {id:number;title:string;content:string}|undefined
    if (!idea) throw permissionError(404,'idea_not_found','灵感不存在')
    const identity = await remote('GET','/api/community/auth/me',session.cookie), info = await remote('GET','/api/community/info',session.cookie)
    if (!identity.data.user || info.status !== 200) throw permissionError(401,'community_unauthorized','社区身份已失效')
    const hash = createHash('sha256').update(JSON.stringify([idea.title,idea.content])).digest('hex')
    const result = await remote('POST','/api/community/submissions',session.cookie,{ title:idea.title, content:idea.content, request_id:req.body.request_id, source_key:`${info.data.instance_id}:${identity.data.user.id}:${idea.id}` })
    if (result.status < 300) db.prepare(`INSERT INTO community_idea_links VALUES (?,?,?,?,?,'draft',?) ON CONFLICT(instance_id,remote_user_id,local_idea_id) DO UPDATE SET remote_idea_id=excluded.remote_idea_id,content_hash=excluded.content_hash,state=excluded.state,updated_at=excluded.updated_at`).run(info.data.instance_id,identity.data.user.id,idea.id,result.data.id,hash,new Date().toISOString())
    return reply.code(result.status).send(result.data)
  })
  app.get('/api/community/ws', { websocket: true, preValidation: async(req) => {
    if (!req.headers.origin || new URL(req.headers.origin).host !== req.headers.host) throw permissionError(403,'invalid_origin','来源不受信任')
    const session = sessions.get(readCookie(req,'sparkwright_community') || '')
    if (!session || session.expires < Date.now()) throw permissionError(401,'community_unauthorized','请先登录社区')
    if (session.sockets.size >= 4) throw permissionError(429,'too_many_connections','连接过多')
  } }, (socket,req) => {
    const session = sessions.get(readCookie(req,'sparkwright_community') || '')!
    const upstream = new WebSocket(origin.replace(/^http/,'ws')+'/api/community/ws',{ headers:{ cookie:session.cookie, origin }, maxPayload:16384, handshakeTimeout:15000 })
    session.sockets.add(socket)
    upstream.on('message',data => { if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount < 65536) socket.send(data.toString()); else socket.close(1013) })
    socket.on('message',data => { if (upstream.readyState === WebSocket.OPEN && Buffer.byteLength(data.toString()) <= 1024) upstream.send(data.toString()) })
    const close = () => { session.sockets.delete(socket); socket.close(); upstream.close() }
    upstream.on('error',close); upstream.on('close',close); socket.on('error',close); socket.on('close',close)
  })
}
