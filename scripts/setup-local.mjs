// SPDX-License-Identifier: MPL-2.0
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

const file = '.env'
const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
const lines = []
if (!/^\s*AUTH_SECRET\s*=/m.test(current) && !process.env.AUTH_SECRET) lines.push(`AUTH_SECRET=${randomBytes(48).toString('hex')}`)
if (!/^\s*PORT\s*=/m.test(current) && !process.env.PORT) lines.push('PORT=5318')
if (!/^\s*WEB_PORT\s*=/m.test(current) && !process.env.WEB_PORT) lines.push('WEB_PORT=5310')
if (lines.length) writeFileSync(file, `${current}${current && !current.endsWith('\n') ? '\n' : ''}${lines.join('\n')}\n`, { mode: 0o600 })
console.log('SparkWright 本地配置已就绪（未输出密钥）。')
