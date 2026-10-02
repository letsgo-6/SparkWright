// SPDX-License-Identifier: MPL-2.0
import { loadEnvFile } from './env'

loadEnvFile()

const port = Number(process.env.PORT || 5318)

// 先验证认证配置，再加载会触发数据库迁移的应用模块。
import('./auth').then(() => import('./app')).then(({ buildApp }) => buildApp())
  .then((app) => app.listen({ host: '127.0.0.1', port }))
  .then(() => console.log(`[SparkWright] 服务已启动: http://127.0.0.1:${port}`))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
