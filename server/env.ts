// SPDX-License-Identifier: MPL-2.0
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

// 极简 .env 加载：只填充尚未存在的环境变量
export function loadEnvFile(): void {
  const file = path.join(process.cwd(), '.env')
  if (!existsSync(file)) return
  for (const line of readFileSync(file, 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!m) continue
    let value = m[2]
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!(m[1] in process.env)) process.env[m[1]] = value
  }
}
