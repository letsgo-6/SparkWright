// SPDX-License-Identifier: MPL-2.0
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import Database from 'better-sqlite3'
import { migrateEmailVerification } from '../server/email-identity'
import { testSmtp } from '../scripts/test-smtp'
import { ERROR_MESSAGES } from '../shared/error-messages'

const previous = process.cwd(), temp = mkdtempSync(path.join(os.tmpdir(), 'sparkwright-email-tests-'))
process.chdir(temp)
process.env.AUTH_SECRET = randomBytes(48).toString('hex')
process.env.EMAIL_VERIFICATION_SECRET = randomBytes(32).toString('base64')
const { db } = await import('../server/db')
const { buildApp } = await import('../server/app')
const { codeDigest, verificationKey } = await import('../server/email-registration')
const { hashPassword } = await import('../server/auth')
const { smtpConfig, createRegistrationMailer } = await import('../server/email-mailer')
after(async () => { db.close(); process.chdir(previous); assert.ok(path.resolve(temp).startsWith(path.join(os.tmpdir(), 'sparkwright-email-tests-'))); await rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) })
let sequence = 0
async function fixture() {
  let time = Date.now(), fail = false, gate: Promise<void> | undefined
  const prefix = `emailcase${++sequence}`, email = `${prefix}@test.invalid`, codes = new Map<string, string>()
  const app = await buildApp({ enabled: true, now: () => time, mailer: { ready() {}, async send(target, code) { codes.set(target, code); if (gate) await gate; if (fail) throw new Error('fixture SMTP authorization/private failure') } } }, false)
  const request = async (url: string, body: unknown, expected = 200, ip = '127.50.0.1', headers: Record<string, string> = {}) => {
    const response = await app.inject({ method: 'POST', url, remoteAddress: ip, headers, payload: body as any })
    assert.equal(response.statusCode, expected, `Unexpected ${url} status`); return response
  }
  const send = (target = email, expected = 200, ip?: string) => request('/api/auth/register/send-code', { email: target }, expected, ip)
  const body = (id: string, code = codes.get(email)!, target = email) => ({ name: prefix, email: target, password: 'fixture-password-123', verificationId: id, code })
  const register = (id: string, code = codes.get(email)!, expected = 200, target = email, ip?: string) => request('/api/auth/register', body(id, code, target), expected, ip)
  const row = (id: string) => db.prepare('SELECT * FROM email_verification_codes WHERE id=?').get(id) as any
  return { app, email, prefix, codes, request, send, body, register, row, advance: (ms: number) => { time += ms }, now: () => time, fail: (value: boolean) => { fail = value }, hold: (value?: Promise<void>) => { gate = value } }
}
async function run(work: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) { const f = await fixture(); try { await work(f) } finally { await f.app.close() } }

test('email: sending creates HMAC-only record, no user or nickname; normalized binding and safe response', () => run(async (f) => {
  const count = (db.prepare('SELECT count(*) n FROM users').get() as any).n
  const sent = await f.send(` ${f.email.toUpperCase()} `), id = sent.json().verificationId
  assert.deepEqual(Object.keys(sent.json()).sort(), ['expiresIn', 'retryAfter', 'verificationId'])
  assert.equal(sent.json().expiresIn, 600); assert.equal(sent.json().retryAfter, 60)
  const row = f.row(id); assert.equal(row.email_normalized, f.email); assert.equal(row.code_hmac.length, 64); assert.ok(!('code' in row)); assert.ok(row.sent_at); assert.equal(row.consumed_at, null)
  assert.equal(row.code_hmac, codeDigest(verificationKey(), id, f.email, f.codes.get(f.email)!))
  assert.equal((db.prepare('SELECT count(*) n FROM users').get() as any).n, count)
  const registered = await f.register(id, undefined, 200, ` ${f.email.toUpperCase()} `)
  assert.equal(registered.json().role, 'user'); assert.match(String(registered.headers['set-cookie']), /HttpOnly/)
  assert.ok((db.prepare('SELECT email_verified_at FROM users WHERE id=?').get(registered.json().id) as any).email_verified_at); assert.ok(f.row(id).consumed_at)
}))
test('email: leading-zero six digit string verifies and numeric/missing fields are denied', () => run(async (f) => {
  for (const change of [{}, { verificationId: randomUUID() }, { code: '123456' }, { verificationId: randomUUID(), code: 123456 }, { verificationId: randomUUID(), code: '12345' }]) {
    await f.request('/api/auth/register', { name: f.prefix, email: f.email, password: 'fixture-password-123', ...change }, 400)
  }
  const id = randomUUID(), code = '012345', now = new Date(f.now()).toISOString()
  db.prepare('INSERT INTO email_verification_codes (id,email_normalized,code_hmac,created_at,expires_at,sent_at) VALUES (?,?,?,?,?,?)').run(id, f.email, codeDigest(verificationKey(), id, f.email, code), now, new Date(f.now()+600000).toISOString(), now)
  await f.register(id, code); assert.ok(f.row(id).consumed_at)
}))
test('email: five wrong attempts commit individually; correct code cannot revive the record', () => run(async (f) => {
  const id = (await f.send()).json().verificationId, code = f.codes.get(f.email)!, wrong = code === '000000' ? '000001' : '000000'
  for (let index = 1; index <= 5; index++) { await f.register(id, wrong, 400); assert.equal(f.row(id).attempt_count, index) }
  assert.ok(f.row(id).invalidated_at); await f.register(id, code, 400)
}))
test('email: concurrent wrong attempts do not lose increments or exceed five', () => run(async (f) => {
  const id = (await f.send()).json().verificationId, correct = f.codes.get(f.email)!, wrong = correct === '000000' ? '000001' : '000000'
  await Promise.all(Array.from({ length: 5 }, () => f.register(id, wrong, 400)))
  assert.equal(f.row(id).attempt_count, 5); assert.ok(f.row(id).invalidated_at); await f.register(id, correct, 400)
}))
test('email: exact expiry, wrong email, sent_at null and invalid HMAC are rejected', () => run(async (f) => {
  const id = (await f.send()).json().verificationId
  await f.register(id, undefined, 400, 'other@test.invalid')
  db.prepare('UPDATE email_verification_codes SET sent_at=NULL WHERE id=?').run(id); await f.register(id, undefined, 400)
  db.prepare('UPDATE email_verification_codes SET sent_at=created_at WHERE id=?').run(id)
  f.advance(600000); await f.register(id, undefined, 400); f.advance(1); await f.register(id, undefined, 400)
  assert.equal(db.prepare('SELECT id FROM users WHERE email=?').get(f.email), undefined)
}))
test('email: resend invalidates old code even when new SMTP send fails; failure retains cooldown', () => run(async (f) => {
  const old = (await f.send()).json().verificationId, oldCode = f.codes.get(f.email)!
  f.advance(60000); f.fail(true); await f.send(f.email, 503)
  assert.ok(f.row(old).invalidated_at); await f.register(old, oldCode, 400)
  const rows = db.prepare('SELECT sent_at,invalidated_at FROM email_verification_codes WHERE email_normalized=?').all(f.email) as any[]
  assert.equal(rows.length, 2); assert.equal(rows[1].sent_at, null); assert.ok(rows[1].invalidated_at)
  const rejected = await f.send(f.email, 429); assert.equal(rejected.headers['retry-after'], '60')
  f.advance(60000); f.fail(false); const current = (await f.send()).json().verificationId; await f.register(current)
}))
test('email: pending/late SMTP cannot register or reactivate old record, no network wait in write lock', () => run(async (f) => {
  let release!: () => void; f.hold(new Promise<void>((resolve) => { release = resolve }))
  const pending = f.send(f.email, 503)
  while (!f.codes.has(f.email)) await new Promise((resolve) => setTimeout(resolve, 1))
  const old = (db.prepare('SELECT id FROM email_verification_codes WHERE email_normalized=? AND invalidated_at IS NULL').get(f.email) as any).id, oldCode = f.codes.get(f.email)!
  await f.register(old, oldCode, 400)
  // Another write succeeds while SMTP is pending.
  db.prepare('INSERT INTO users (name) VALUES (?)').run(`pending-${sequence}`)
  f.advance(60000); f.hold(); const sent = await f.send(); release(); await pending
  assert.ok(f.row(old).invalidated_at); assert.equal(f.row(old).sent_at, null); await f.register(sent.json().verificationId)
}))
test('email: concurrent sends obey cooldown, expiry during SMTP never becomes usable', () => run(async (f) => {
  const sends = await Promise.all([f.app.inject({ method:'POST',url:'/api/auth/register/send-code',payload:{email:f.email} }), f.app.inject({ method:'POST',url:'/api/auth/register/send-code',payload:{email:f.email} })])
  assert.deepEqual(sends.map((response) => response.statusCode).sort(), [200,429])
  assert.equal((db.prepare('SELECT count(*) n FROM email_verification_codes WHERE email_normalized=? AND invalidated_at IS NULL AND consumed_at IS NULL').get(f.email) as any).n, 1)
  f.advance(60000); let release!: () => void; f.hold(new Promise<void>((resolve) => { release = resolve })); const request = f.send(f.email, 503)
  while ((db.prepare('SELECT count(*) n FROM email_verification_codes WHERE email_normalized=?').get(f.email) as any).n < 2) await new Promise((resolve) => setTimeout(resolve, 1))
  f.advance(600000); release(); await request
  assert.equal((db.prepare('SELECT count(*) n FROM email_verification_codes WHERE email_normalized=? AND invalidated_at IS NULL').get(f.email) as any).n, 0)
}))
test('email: same correct code registers exactly once and replay cannot create another user', () => run(async (f) => {
  const id = (await f.send()).json().verificationId, body = f.body(id)
  const results = await Promise.all([f.app.inject({ method:'POST',url:'/api/auth/register',payload:body }), f.app.inject({ method:'POST',url:'/api/auth/register',payload:body })])
  assert.deepEqual(results.map((result) => result.statusCode).sort(), [200,400]); assert.equal((db.prepare('SELECT count(*) n FROM users WHERE email=?').get(f.email) as any).n, 1)
  await f.register(id, undefined, 400)
}))
test('email: user-insert failure rolls back consumption and account, then permits retry', () => run(async (f) => {
  const id = (await f.send()).json().verificationId
  db.exec(`CREATE TEMP TRIGGER email_failure BEFORE INSERT ON users BEGIN SELECT RAISE(FAIL,'fixture private database path'); END`)
  try { const error = await f.register(id, undefined, 500); assert.equal(error.json().error.code, 'registration_failed'); assert.ok(!error.body.includes('fixture private')) } finally { db.exec('DROP TRIGGER email_failure') }
  assert.equal(f.row(id).consumed_at, null); assert.equal(db.prepare('SELECT id FROM users WHERE email=?').get(f.email), undefined); await f.register(id)
}))
test('email: persistent sending hour/cooldown limits include SMTP failures and survive app recreation', () => run(async (f) => {
  f.fail(true); await f.send(f.email,503); f.fail(false)
  for (let index=0;index<4;index++) { f.advance(60000); await f.send() }
  f.advance(60000); const limit=await f.send(f.email,429); assert.equal(Number(limit.headers['retry-after']),3300)
  const next=await buildApp({enabled:true,now:f.now,mailer:{ready(){},async send(){throw new Error('must not send')}}}, false)
  try { const rejected=await next.inject({method:'POST',url:'/api/auth/register/send-code',payload:{email:f.email}}); assert.equal(rejected.statusCode,429) } finally { await next.close() }
  f.advance(3300001); await f.send()
}))
test('email: IP send limit counts invalid requests and ignores spoofed X-Forwarded-For', () => run(async (f) => {
  for(let index=0;index<20;index++) await f.request('/api/auth/register/send-code',{email:'invalid'},400,'127.51.0.1',{'x-forwarded-for':`10.0.0.${index}`})
  const rejected=await f.request('/api/auth/register/send-code',{email:f.email},429,'127.51.0.1'); assert.equal(rejected.headers['retry-after'],'3600')
  assert.equal(db.prepare('SELECT id FROM email_verification_codes WHERE email_normalized=?').get(f.email),undefined)
}))
test('email: IP registration and normalized-email attempt limits include unknown IDs and missing codes', () => run(async (f) => {
  for(let index=0;index<30;index++) await f.request('/api/auth/register',{},400,'127.52.0.1')
  assert.equal((await f.request('/api/auth/register',{},429,'127.52.0.1')).headers['retry-after'],'900')
  for(let index=0;index<10;index++) await f.request('/api/auth/register',f.body(randomUUID(),'123456',` ${f.email.toUpperCase()} `),400,`127.53.0.${index+1}`)
  assert.equal((await f.request('/api/auth/register',f.body(randomUUID(),'123456'),429,'127.53.0.11')).headers['retry-after'],'900')
}))
test('email: nickname conflict cannot claim old empty-email account; normalized old address blocks new account', () => run(async (f) => {
  db.prepare('INSERT INTO users (name) VALUES (?)').run(f.prefix)
  const before=db.prepare('SELECT * FROM users WHERE name=?').get(f.prefix), id=(await f.send()).json().verificationId
  await f.register(id,undefined,409); assert.deepEqual(db.prepare('SELECT * FROM users WHERE name=?').get(f.prefix),before); assert.equal(f.row(id).consumed_at,null)
  const legacyMail=`OLD-${sequence}@test.invalid`; db.prepare('INSERT INTO users(name,email) VALUES (?,?)').run(`oldmail-${sequence}`,` ${legacyMail} `)
  await f.send(legacyMail.toLowerCase(),409)
}))
test('email: old owner/admin/user with null verification time retain login, session and permissions', () => run(async (f) => {
  for(const role of ['owner','admin','user']) {
    const name=`old-${role}-${sequence}`, email=`${name}@test.invalid`
    db.prepare('INSERT INTO users(name,email,password_hash,role) VALUES (?,?,?,?)').run(name,` ${email.toUpperCase()} `,hashPassword('fixture-password-123'),role)
    const login=await f.app.inject({method:'POST',url:'/api/auth/login',payload:{email,password:'fixture-password-123'}}); assert.equal(login.statusCode,200); assert.equal(login.json().role,role)
    const cookie=String(login.headers['set-cookie']).split(';')[0]
    assert.equal((await f.app.inject({method:'GET',url:'/api/auth/me',headers:{cookie}})).json().user.role,role)
    assert.equal((await f.app.inject({method:'GET',url:'/api/admin/system',headers:{cookie}})).statusCode,role==='user'?403:200)
    assert.equal((db.prepare('SELECT email_verified_at FROM users WHERE name=?').get(name) as any).email_verified_at,null)
  }
}))
test('email: missing/placeholder/short/reused HMAC key rejects flows while legacy login remains independent', () => run(async (f) => {
  const key=process.env.EMAIL_VERIFICATION_SECRET!, pass=process.env.EMAIL_SMTP_PASS, id=(await f.send()).json().verificationId
  process.env.EMAIL_SMTP_PASS=randomBytes(32).toString('base64')
  try {
    for(const invalid of ['', '<RANDOM_SECRET_BASE64>', 'a'.repeat(40), Buffer.alloc(32).toString('base64'), process.env.AUTH_SECRET!, Buffer.from(process.env.AUTH_SECRET!).toString('base64'), process.env.EMAIL_SMTP_PASS, Buffer.from(process.env.EMAIL_SMTP_PASS).toString('base64')]) {
      process.env.EMAIL_VERIFICATION_SECRET=invalid; await f.send(f.email,503); await f.register(id,undefined,503)
    }
  } finally { process.env.EMAIL_VERIFICATION_SECRET=key; if(pass===undefined) delete process.env.EMAIL_SMTP_PASS; else process.env.EMAIL_SMTP_PASS=pass }
}))
test('email: migration preserves old fields and roles, is idempotent and fails closed on normalized conflicts', () => {
  const old=new Database(':memory:')
  try {
    old.exec("CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT,email TEXT,role TEXT); INSERT INTO users VALUES(1,'old',' Case@Test.invalid ','owner')")
    const before=old.prepare('SELECT id,name,email,role FROM users').all(); migrateEmailVerification(old); migrateEmailVerification(old)
    assert.deepEqual(old.prepare('SELECT id,name,email,role FROM users').all(),before); assert.equal((old.prepare('SELECT email_verified_at FROM users').get() as any).email_verified_at,null)
    assert.throws(()=>old.exec("INSERT INTO users VALUES(2,'duplicate','case@test.invalid','user',NULL)"))
  } finally { old.close() }
  const conflict=new Database(':memory:')
  try { conflict.exec("CREATE TABLE users(id INTEGER,name TEXT,email TEXT); INSERT INTO users VALUES(1,'a','A@Test.invalid'),(2,'b','a@test.invalid')"); assert.throws(()=>migrateEmailVerification(conflict),/冲突/); assert.equal((conflict.pragma('table_info(users)') as any[]).length,3) } finally { conflict.close() }
})
test('email: real Nodemailer local SMTP wire accepts correct recipient/brand and rejects recipient safely', async () => {
  const smtp=await testSmtp(), keys=['EMAIL_SMTP_HOST','EMAIL_SMTP_PORT','EMAIL_SMTP_SECURE','EMAIL_SMTP_USER','EMAIL_SMTP_PASS','EMAIL_FROM']
  const prior=Object.fromEntries(keys.map((key)=>[key,process.env[key]]))
  Object.assign(process.env,{EMAIL_SMTP_HOST:'127.0.0.1',EMAIL_SMTP_PORT:String(smtp.port),EMAIL_SMTP_SECURE:'false',EMAIL_SMTP_USER:'sender@test.invalid',EMAIL_SMTP_PASS:'fixture-smtp-password',EMAIL_FROM:'SparkWright <sender@test.invalid>'})
  const app=await buildApp({enabled:true}, false)
  try {
    assert.equal(smtpConfig().secure,false); const send=await app.inject({method:'POST',url:'/api/auth/register/send-code',payload:{email:'wire@test.invalid'}}); assert.equal(send.statusCode,200)
    const message=smtp.messages.get('wire@test.invalid')!; assert.match(message.code,/^\d{6}$/); assert.equal(message.from,'sender@test.invalid'); assert.deepEqual(message.recipients,['wire@test.invalid']); assert.equal(message.subject,'SparkWright 注册验证码'); assert.match(message.text,/10 分钟/)
    smtp.behavior.reject=true; const rejected=await app.inject({method:'POST',url:'/api/auth/register/send-code',payload:{email:'reject@test.invalid'}}); assert.equal(rejected.statusCode,503); assert.ok(!rejected.body.includes('fixture-smtp-password')); assert.equal((db.prepare('SELECT sent_at FROM email_verification_codes WHERE email_normalized=?').get('reject@test.invalid') as any).sent_at,null)
    for(const email of ['a@test.invalid,b@test.invalid','a@test.invalid\r\nBcc: b@test.invalid','A <a@test.invalid>']) assert.equal((await app.inject({method:'POST',url:'/api/auth/register/send-code',payload:{email}})).statusCode,400)
    smtp.behavior.reject=false; await createRegistrationMailer().send('zero@test.invalid','012345'); assert.equal(smtp.messages.get('zero@test.invalid')!.code,'012345')
    const registered=await app.inject({method:'POST',url:'/api/auth/register',payload:{name:'wire-account',email:'wire@test.invalid',password:'fixture-password-123',verificationId:send.json().verificationId,code:message.code}}); assert.equal(registered.statusCode,200)
    smtp.behavior.holdGreeting=true; const start=Date.now()
    const timedOut=await app.inject({method:'POST',url:'/api/auth/register/send-code',payload:{email:'timeout@test.invalid'}})
    assert.equal(timedOut.statusCode,503); assert.ok(Date.now()-start<15000)
    const timeoutRow=db.prepare('SELECT sent_at,invalidated_at FROM email_verification_codes WHERE email_normalized=?').get('timeout@test.invalid') as any
    assert.equal(timeoutRow.sent_at,null); assert.ok(timeoutRow.invalidated_at)
    for(const [key,value] of [['EMAIL_SMTP_SECURE','maybe'],['EMAIL_SMTP_PORT','0'],['EMAIL_SMTP_PASS','<SMTP_AUTHORIZATION_CODE>'],['EMAIL_FROM','Other <sender@test.invalid>']]) {
      const saved=process.env[key]; process.env[key]=value; assert.throws(()=>smtpConfig()); process.env[key]=saved
    }
  } finally { await app.close(); await smtp.close(); for(const key of keys) if(prior[key]===undefined) delete process.env[key]; else process.env[key]=prior[key] }
})

test('email: delayed SMTP response reports actual remaining time', () => run(async (f) => {
  let release!: () => void; f.hold(new Promise<void>((resolve) => { release=resolve }))
  const pending=f.send(); while(!f.codes.has(f.email)) await new Promise((resolve)=>setTimeout(resolve,1))
  f.advance(12000); release(); const sent=await pending
  assert.equal(sent.json().expiresIn,588); assert.equal(sent.json().retryAfter,48); await f.register(sent.json().verificationId)
}))

test('email: invalid digest and key rotation fail safely without bypass', () => run(async (f) => {
  const id=(await f.send()).json().verificationId, key=process.env.EMAIL_VERIFICATION_SECRET!
  db.prepare('UPDATE email_verification_codes SET code_hmac=? WHERE id=?').run('Z'.repeat(64),id)
  await f.register(id,undefined,400); assert.equal(f.row(id).attempt_count,1)
  db.prepare('UPDATE email_verification_codes SET code_hmac=? WHERE id=?').run(codeDigest(verificationKey(),id,f.email,f.codes.get(f.email)!),id)
  try { process.env.EMAIL_VERIFICATION_SECRET=randomBytes(32).toString('base64'); await f.register(id,undefined,400) } finally { process.env.EMAIL_VERIFICATION_SECRET=key }
  assert.equal(f.row(id).attempt_count,2); await f.register(id)
}))

test('email: missing SMTP creates no code or user and old login remains available', async () => {
  const saved=process.env.EMAIL_SMTP_HOST; delete process.env.EMAIL_SMTP_HOST
  const app=await buildApp({enabled:true}, false)
  try {
    const count=(db.prepare('SELECT count(*) n FROM users').get() as any).n
    const result=await app.inject({method:'POST',url:'/api/auth/register/send-code',payload:{email:'missing-smtp@test.invalid'}})
    assert.equal(result.statusCode,503); assert.equal(result.json().error.code,'mail_unavailable'); assert.ok(ERROR_MESSAGES[result.json().error.code]); assert.equal(db.prepare('SELECT id FROM email_verification_codes WHERE email_normalized=?').get('missing-smtp@test.invalid'),undefined)
    assert.equal((db.prepare('SELECT count(*) n FROM users').get() as any).n,count)
    const login=await app.inject({method:'POST',url:'/api/auth/login',payload:{email:'wire@test.invalid',password:'fixture-password-123'}}); assert.equal(login.statusCode,200)
  } finally { await app.close(); if(saved!==undefined) process.env.EMAIL_SMTP_HOST=saved }
})
