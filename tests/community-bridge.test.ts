// SPDX-License-Identifier: MPL-2.0
import {test,after} from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import {mkdtempSync} from 'node:fs'
import {rm} from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {randomBytes,randomUUID} from 'node:crypto'
const previous=process.cwd(),temp=mkdtempSync(path.join(os.tmpdir(),'sparkwright-bridge-test-'));process.chdir(temp)
process.env.AUTH_SECRET=randomBytes(48).toString('hex');process.env.APP_ORIGIN='http://127.0.0.1:5318'
const mock=Fastify();await mock.register(websocket)
const requests:{url:string;body:any;cookie:string|undefined}[]=[]
mock.addHook('onRequest',async req=>{requests.push({url:req.url,body:undefined,cookie:req.headers.cookie})})
mock.post('/api/community/auth/login',async(_req,reply)=>{reply.header('set-cookie','ideabox_session=remote-only-credential; HttpOnly; SameSite=Lax');return {user:{id:42,name:'remote user',role:'user'}}})
mock.get('/api/community/auth/me',async req=>({user:req.headers.cookie?.includes('remote-only-credential')?{id:42,name:'remote user',role:'user'}:null}))
mock.get('/api/community/info',async()=>({instance_id:'cloud-instance-unique'}))
mock.get('/api/community/mine',async req=>{if(!req.headers.cookie)return {error:{code:'unauthorized'}};return []})
mock.post('/api/community/submissions',async req=>{requests[requests.length-1].body=req.body;return {id:91}})
mock.post('/api/community/auth/logout',async()=>({ok:true}))
await mock.listen({host:'127.0.0.1',port:0});process.env.COMMUNITY_URL=`http://127.0.0.1:${(mock.server.address() as any).port}`
const {buildApp}=await import('../server/app'),{db}=await import('../server/db'),{communityOrigin}=await import('../server/community-bridge')
const app=await buildApp();await app.ready()
const local=(await app.inject('/api/auth/me')).json().user
const ideaId=Number(db.prepare('INSERT INTO ideas(user_id,title,content) VALUES (?,?,?)').run(local.id,'selected idea','selected plain text').lastInsertRowid)
db.prepare('INSERT INTO user_settings(user_id,api_key,model) VALUES (?,?,?)').run(local.id,'private-local-key-never-upload','private-model')
after(async()=>{await app.close();await mock.close();db.close();process.chdir(previous);assert.ok(path.resolve(temp).startsWith(path.join(os.tmpdir(),'sparkwright-bridge-test-')));await rm(temp,{recursive:true,force:true,maxRetries:30,retryDelay:200})})
const call=async(method:string,url:string,payload?:unknown,cookie='',status=200)=>{const r=await app.inject({method:method as any,url,headers:{origin:process.env.APP_ORIGIN!,cookie,host:'127.0.0.1:5318'},payload:payload as any});assert.equal(r.statusCode,status,r.body);return r}
test('community bridge never proxies arbitrary endpoints or transfers local owner permissions',async()=>{
  await call('GET','/api/community/remote/api/admin/backups',undefined,'',404)
  await call('GET','/api/community/remote/api/community/mine',undefined,'',401)
  assert.equal((await call('GET','/api/ideas')).json()[0].id,ideaId)
  const result=await call('POST','/api/community/remote/api/community/auth/login',{email:'someone@test.invalid',password:'fixture-password'})
  const cookie=(result.headers['set-cookie'] as string).split(';')[0]
  assert.equal(result.json().user.role,'user');assert.ok(!cookie.includes('remote-only-credential'))
  await call('GET','/api/community/remote/api/community/auth/me',undefined,cookie)
  assert.equal(requests.at(-1)!.cookie,'ideabox_session=remote-only-credential')
  await call('POST','/api/community/upload',{local_idea_id:ideaId,confirm:false,request_id:randomUUID()},cookie,400)
  await call('POST','/api/community/upload',{local_idea_id:ideaId,confirm:true,request_id:randomUUID()},cookie)
  const submission=requests.find(r=>r.url==='/api/community/submissions')!
  assert.deepEqual(Object.keys(submission.body).sort(),['content','request_id','source_key','title'])
  assert.ok(!JSON.stringify(requests).includes('private-local-key'))
  const mapping=(await call('GET','/api/community/links')).json()[0];assert.equal(mapping.remote_user_id,42);assert.equal(mapping.remote_idea_id,91);assert.equal(mapping.local_idea_id,ideaId);assert.equal(mapping.instance_id,'cloud-instance-unique')
  await call('POST','/api/community/remote/api/community/auth/logout',undefined,cookie)
  await call('GET','/api/community/remote/api/community/mine',undefined,cookie,401)
  assert.equal((await call('GET','/api/ideas')).json()[0].content,'selected plain text')
  assert.equal((await call('GET','/api/auth/me')).json().user.role,'owner')
})
test('configured community origin rejects credentials, paths, insecure remote hosts and forged local origins',async()=>{
  for(const value of ['http://remote.invalid','https://user:pass@example.com','https://example.com/path','https://example.com?x=1'])assert.throws(()=>communityOrigin(value))
  const r=await app.inject({method:'POST',url:'/api/community/remote/api/community/auth/login',headers:{host:'evil.invalid',origin:'https://evil.invalid'},payload:{email:'a@b.invalid',password:'fixture'}});assert.equal(r.statusCode,403)
})
