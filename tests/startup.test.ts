// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { randomBytes, createHmac } from 'node:crypto'
import { once } from 'node:events'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'
import bcrypt from 'bcryptjs'

const root = path.resolve(import.meta.dirname, '..')
async function freePort() {
  const socket = net.createServer()
  socket.listen(0, '127.0.0.1')
  await once(socket, 'listening')
  const port = (socket.address() as net.AddressInfo).port
  await new Promise<void>((resolve) => socket.close(() => resolve()))
  return port
}

for (const mode of ['env-file', 'process-env', 'missing'] as const) {
  test(`R02/R06: actual entrypoint handles ${mode} configuration and isolated startup`, async () => {
    const temp = mkdtempSync(path.join(os.tmpdir(), 'sparkwright-startup-'))
    const port = await freePort()
    const fileSecret = randomBytes(48).toString('hex')
    const processSecret = randomBytes(48).toString('hex')
    const env = { ...process.env, PORT: String(port) }
    delete env.AUTH_SECRET
    delete env.AI_API_KEY
    delete env.ZAI_API_KEY
    if (mode !== 'missing') writeFileSync(path.join(temp, '.env'), `AUTH_SECRET=${fileSecret}\n`)
    if (mode === 'process-env') env.AUTH_SECRET = processSecret
    // Synthetic old-schema fixture; never open the user's existing database.
    mkdirSync(path.join(temp, 'data'))
    const legacy = new Database(path.join(temp, 'data', 'ideabox.db'))
    legacy.exec("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL DEFAULT (datetime('now'))); INSERT INTO users (name) VALUES ('legacy-startup')")
    legacy.exec('ALTER TABLE users ADD COLUMN email TEXT; ALTER TABLE users ADD COLUMN password_hash TEXT')
    legacy.prepare('INSERT INTO users (name,email,password_hash) VALUES (?,?,?)').run('startup-fixture', 'startup@test.invalid', bcrypt.hashSync('fixture-password-123', 10))
    legacy.close()
    const child = spawn(process.execPath, ['--import', pathToFileURL(path.join(root, 'node_modules/tsx/dist/loader.mjs')).href, path.join(root, 'server/index.ts')], { cwd: temp, env, windowsHide: true })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    const exited = once(child, 'exit')
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(), 12000)
    try {
      if (mode === 'missing') {
        const [code] = await Promise.race([exited, new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('Startup did not fail closed'))))])
        assert.notEqual(code, 0)
        assert.match(output, /AUTH_SECRET/)
        const unchanged = new Database(path.join(temp,'data','ideabox.db'), { readonly:true })
        try { assert.equal((unchanged.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get() as any).n,1) }
        finally { unchanged.close() }
      } else {
        while (!output.includes('服务已启动')) {
          assert.equal(child.exitCode, null, 'Configured server exited before ready')
          if (controller.signal.aborted) throw new Error('Startup timeout')
          await new Promise((resolve) => setTimeout(resolve, 30))
        }
        const response = await fetch(`http://127.0.0.1:${port}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({email:'startup@test.invalid',password:'fixture-password-123'}), signal: controller.signal })
        assert.equal(response.status, 200)
        const token = response.headers.get('set-cookie')!.split(';')[0].split('=')[1]
        const parts = token.split('.')
        const expected = createHmac('sha256', mode === 'process-env' ? processSecret : fileSecret).update(`${parts[0]}.${parts[1]}`).digest('base64url')
        assert.equal(parts[2], expected, 'Actual server must sign with the supplied secret')
        const inspect = new Database(path.join(temp,'data','ideabox.db'), { readonly:true })
        try {
          assert.equal((inspect.pragma('integrity_check') as any)[0].integrity_check, 'ok')
          assert.equal((inspect.prepare("SELECT email FROM users WHERE name='legacy-startup'").get() as any).email,null)
          assert.equal((inspect.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get() as any).n,37)
          assert.equal((inspect.prepare("SELECT email_verified_at FROM users WHERE name='startup-fixture'").get() as any).email_verified_at, null)
        } finally { inspect.close() }
      }
    } finally {
      clearTimeout(deadline)
      if (child.exitCode === null) child.kill()
      await exited
      assert.ok(path.resolve(temp).startsWith(path.join(os.tmpdir(), 'sparkwright-startup-')))
      await rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100})
    }
  })
}
