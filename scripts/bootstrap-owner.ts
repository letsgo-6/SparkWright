// SPDX-License-Identifier: MPL-2.0
import { loadEnvFile } from '../server/env'

class BootstrapError extends Error {}

// The operator must verify account control; email alone is not evidence of ownership.
async function bootstrap(): Promise<void> {
  const args = process.argv.slice(2)
  const idArg = args.find((arg) => arg.startsWith('--user-id='))
  if (args.length !== 2 || !args.includes('--confirm-account-control') || !idArg || !/^--user-id=[1-9]\d*$/.test(idArg)) {
    throw new BootstrapError('先确认账号由你控制，再运行 npm run owner:bootstrap -- --user-id=<ID> --confirm-account-control')
  }
  const id = Number(idArg.slice('--user-id='.length))
  if (!Number.isSafeInteger(id)) throw new BootstrapError('用户 ID 必须为正整数')
  loadEnvFile()
  const { db } = await import('../server/db')
  try {
    db.transaction(() => {
      const owners = db.prepare("SELECT count(*) AS n FROM users WHERE role = 'owner'").get() as { n: number }
      if (owners.n !== 0) throw new BootstrapError('已有 owner，拒绝再次初始化；请由现有 owner 使用角色管理 API')
      const user = db.prepare('SELECT email, password_hash, role FROM users WHERE id = ?').get(id) as { email: string | null; password_hash: string | null; role: string } | undefined
      if (!user) throw new BootstrapError('目标用户不存在；请先正常注册并核验账号 ID')
      if (!user.email || !/^\S+@\S+\.\S+$/.test(user.email) || !user.password_hash || !/^\$2[aby]\$(0[4-9]|[12]\d|3[01])\$[./A-Za-z0-9]{53}$/.test(user.password_hash)) {
        throw new BootstrapError('目标账号缺少有效邮箱或密码哈希；不能认领不完整的历史账号')
      }
      if (user.role !== 'user' && user.role !== 'admin') throw new BootstrapError('目标角色不兼容，请先核验数据库副本')
      db.prepare("UPDATE users SET role = 'owner' WHERE id = ?").run(id)
    }).immediate()
    console.log('首次 owner 初始化成功。请启动服务并重新登录或刷新认证状态。')
  } finally { db.close() }
}

bootstrap().catch((error: unknown) => {
  // Print only known operator-facing messages; never raw SQL, paths or credentials.
  console.error(error instanceof BootstrapError ? error.message : '初始化失败，请先检查数据库副本、角色约束及本地运行环境；未输出内部错误')
  process.exitCode = 1
})
