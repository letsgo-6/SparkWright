// SPDX-License-Identifier: MPL-2.0
import { existsSync, readFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { createConnection } from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

process.chdir(fileURLToPath(new URL('..', import.meta.url)))
const cmd = process.env.ComSpec || 'cmd.exe'

async function main() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major < 22 || (major === 22 && minor < 12)) throw new Error('请安装 Node.js 22.12 或更高版本。')

  let configuredPort = process.env.PORT
  if (configuredPort === undefined && existsSync('.env')) {
    const match = readFileSync('.env', 'utf8').match(/^\s*PORT\s*=\s*(.*?)\s*$/m)
    if (match) configuredPort = match[1].replace(/^(["'])(.*)\1$/, '$2')
  }
  const port = Number(configuredPort || 5318)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是 1 至 65535 的端口号。')
  const url = `http://127.0.0.1:${port}`
  const ready = async () => {
    try {
      const response = await fetch(`${url}/api/auth/me`, { signal: AbortSignal.timeout(1000) })
      return response.ok && (await response.json()).personalEdition === true
    } catch { return false }
  }
  const openBrowser = async () => {
    console.log(`打开个人版：${url}`)
    const opener = spawn('powershell.exe', ['-NoProfile', '-Command', `Start-Process '${url}'`], { windowsHide: true, stdio: 'inherit' })
    await new Promise(resolve => {
      opener.on('error', () => { console.log('请在浏览器中手动打开上方网址。'); resolve() })
      opener.on('exit', code => { if (code !== 0) console.log('请在浏览器中手动打开上方网址。'); resolve() })
    })
  }
  const occupied = await new Promise(resolve => {
    const socket = createConnection({ host: '127.0.0.1', port })
    const finish = value => { socket.destroy(); resolve(value) }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(1000, () => finish(false))
  })
  if (occupied) {
    if (!await ready()) throw new Error(`端口 ${port} 已被其他服务占用。请关闭占用程序，或修改 .env 中的 PORT。`)
    console.log('个人版已经启动，无需重复启动。')
    await openBrowser()
    return
  }

  if (!existsSync('node_modules/.package-lock.json')) {
    console.log('首次启动：正在安装依赖，请保持联网并等待完成。')
    const install = spawnSync(cmd, ['/d', '/c', 'npm.cmd ci'], { stdio: 'inherit', windowsHide: true })
    if (install.status !== 0) throw new Error('依赖安装失败，请检查上方错误信息和网络连接。')
  }
  console.log('正在启动 SparkWright；就绪后自动打开浏览器。请保持此窗口打开，按 Ctrl+C 停止服务。')
  const server = spawn(cmd, ['/d', '/c', 'npm.cmd start'], { stdio: 'inherit', windowsHide: true })
  let exitCode
  const stopped = new Promise(resolve => {
    server.once('error', error => { console.error(error.message); exitCode = 1; resolve(1) })
    server.once('exit', code => { exitCode = code ?? 1; resolve(exitCode) })
  })
  while (exitCode === undefined) {
    if (await ready()) {
      await openBrowser()
      process.exitCode = await stopped
      return
    }
    await Promise.race([delay(750), stopped])
  }
  throw new Error('服务未能启动，请检查上方错误信息。')
}

main().catch(error => { console.error(error.message); process.exitCode = 1 })
