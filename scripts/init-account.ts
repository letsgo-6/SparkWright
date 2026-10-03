// SPDX-License-Identifier: MPL-2.0
import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { loadEnvFile } from '../server/env'
import { normalizeEmail, validEmail } from '../server/email-identity'
import { PERSONAL_EDITION } from '../server/edition'

export async function initializeOwner(input: { email: string; name: string; password: string }): Promise<number> {
  const email = normalizeEmail(input.email), name = input.name.trim()
  if (!validEmail(email) || !name || name.length > 20 || input.password.length < 12 || Buffer.byteLength(input.password, 'utf8') > 72) {
    throw new Error('邮箱需有效，昵称为 1–20 字符，密码至少 12 字符且不超过 72 字节')
  }
  const { hashPassword } = await import('../server/auth')
  const { db } = await import('../server/db')
  return db.transaction(() => {
    if ((db.prepare('SELECT count(*) AS n FROM users').get() as { n: number }).n !== 0) {
      throw new Error('数据库已有账号，拒绝初始化或覆盖；请使用已有账号登录')
    }
    const now = new Date().toISOString()
    const result = db.prepare("INSERT INTO users (name,email,password_hash,role,created_at,email_verified_at) VALUES (?,?,?,'owner',?,?)")
      .run(name, email, hashPassword(input.password), now, now)
    return Number(result.lastInsertRowid)
  }).immediate()
}

async function main(): Promise<void> {
  if (PERSONAL_EDITION) {
    console.log('个人版无需设置登录账号。请运行 npm start，然后打开 http://127.0.0.1:5318。')
    return
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY || process.argv.length !== 2) {
    throw new Error('请在项目根目录的交互终端运行 npm run account:init；不要把密码写入命令参数')
  }
  loadEnvFile()
  let muted = false
  const output = new Writable({ write(chunk, encoding, callback) { if (!muted) process.stdout.write(chunk, encoding); callback() } })
  const terminal = createInterface({ input: process.stdin, output, terminal: true })
  try {
    const email = await terminal.question('登录邮箱（本地初始化无需邮件验证码）：')
    const name = await terminal.question('昵称（1–20 字符）：')
    async function password(prompt: string): Promise<string> {
      process.stdout.write(prompt)
      muted = true
      try { return await terminal.question('') } finally { muted = false; process.stdout.write('\n') }
    }
    const first = await password('新密码（至少 12 字符、至多 72 字节，输入不回显）：')
    if (first !== await password('再次输入密码：')) throw new Error('两次密码不一致，未创建账号')
    await initializeOwner({ email, name, password: first })
    console.log('账号初始化成功。请启动服务并使用刚才设置的邮箱与密码登录。')
  } finally {
    terminal.close()
    const { db } = await import('../server/db')
    db.close()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : '初始化失败'); process.exitCode = 1 })
}
