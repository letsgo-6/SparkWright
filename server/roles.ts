// SPDX-License-Identifier: MPL-2.0
import type Database from 'better-sqlite3'

export type UserRole = 'owner' | 'admin' | 'user'
export const isRole = (value: unknown): value is UserRole => value === 'owner' || value === 'admin' || value === 'user'

/** Only add a missing column; incompatible existing roles require an explicit migration. */
export function migrateUserRoles(db: Database.Database): void {
  db.transaction(() => {
    const columns = db.pragma('table_info(users)') as { name: string; type: string; notnull: number; dflt_value: string | null }[]
    const role = columns.find((column) => column.name === 'role')
    if (!role) {
      db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('owner', 'admin', 'user'))")
      return
    }
    const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get() as { sql: string }).sql
    const checks = [...sql.matchAll(/\bCHECK\s*\(\s*(?:role|"role"|\[role\]|`role`)\s+IN\s*\(([^()]+)\)\s*\)/gi)]
    const hasWhitelist = checks.some((match) => {
      const values = match[1].split(',').map((value) => value.trim())
      return values.length === 3 && ["'owner'", "'admin'", "'user'"].every((value) => values.includes(value))
    })
    const invalid = db.prepare("SELECT count(*) AS n FROM users WHERE role IS NULL OR role NOT IN ('owner', 'admin', 'user')").get() as { n: number }
    if (role.type.toUpperCase() !== 'TEXT' || role.notnull !== 1 || role.dflt_value !== "'user'" || !hasWhitelist || invalid.n > 0) {
      throw new Error('users.role 迁移冲突：已有字段约束或角色数据不兼容；未覆盖角色，请先人工核验数据库副本')
    }
  }).immediate()
}
