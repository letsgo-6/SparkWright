// SPDX-License-Identifier: MPL-2.0
import type Database from 'better-sqlite3'

export const normalizeEmail = (value: string): string => value.trim().toLowerCase()
export const validEmail = (value: string): boolean => value.length <= 254 && /^[^\s@<>,;:"\\]+@[^\s@<>,;:"\\]+\.[^\s@<>,;:"\\]+$/.test(value)

// Include noncanonical historical addresses without rewriting existing account data.
export function emailAccountId(db: Database.Database, normalized: string): number | null {
  const rows = db.prepare('SELECT id, email FROM users WHERE email IS NOT NULL').all() as { id: number; email: string }[]
  return rows.find((row) => normalizeEmail(row.email) === normalized)?.id ?? null
}

export function migrateEmailVerification(db: Database.Database): void {
  db.transaction(() => {
    const seen = new Set<string>()
    for (const row of db.prepare('SELECT email FROM users WHERE email IS NOT NULL').all() as { email: string }[]) {
      const email = normalizeEmail(row.email)
      if (seen.has(email)) throw new Error('旧账号邮箱规范化后存在冲突，请由维护者核验归属后处理；未改写账号')
      seen.add(email)
    }
    const columns = db.pragma('table_info(users)') as { name: string }[]
    if (!columns.some((column) => column.name === 'email_verified_at')) db.exec('ALTER TABLE users ADD COLUMN email_verified_at TEXT')
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_normalized ON users(lower(trim(email))) WHERE email IS NOT NULL;
      CREATE TABLE IF NOT EXISTS email_verification_codes (
        id TEXT PRIMARY KEY,
        email_normalized TEXT NOT NULL,
        code_hmac TEXT NOT NULL CHECK (length(code_hmac) = 64),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 5),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        sent_at TEXT,
        consumed_at TEXT,
        invalidated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_email_verification_window ON email_verification_codes(email_normalized, created_at);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_email_verification_active ON email_verification_codes(email_normalized)
        WHERE consumed_at IS NULL AND invalidated_at IS NULL;
    `)
  }).immediate()
}
