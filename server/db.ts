// SPDX-License-Identifier: MPL-2.0
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { migrateUserRoles } from './roles'
import { migrateEmailVerification } from './email-identity'
import { migrateNewRound } from './new-round-migration'
import { migrateScoringV3 } from './scoring-v3-migration'
import { migrateScoringV5 } from './scoring-v5-migration'

const dataDir = path.join(process.cwd(), 'data')
mkdirSync(dataDir, { recursive: true })

export const db = new Database(path.join(dataDir, 'ideabox.db'))
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('owner', 'admin', 'user')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ideas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  deadline TEXT,
  status TEXT NOT NULL DEFAULT 'incubating',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS plan_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idea_id INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL DEFAULT 'public',
  idea_id INTEGER REFERENCES ideas(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ai_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idea_id INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS user_settings (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  base_url TEXT,
  api_key TEXT,
  model TEXT,
  updated_at TEXT
);
`)

migrateUserRoles(db)

db.exec(`
CREATE TABLE IF NOT EXISTS daily_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan_date TEXT NOT NULL,
  title TEXT NOT NULL,
  plan_time TEXT,
  priority TEXT NOT NULL DEFAULT 'mid',
  done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS daily_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  review_date TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  updated_at TEXT,
  UNIQUE(user_id, review_date)
);

CREATE TABLE IF NOT EXISTS media_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  topic TEXT NOT NULL DEFAULT '',
  platform TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'idea',
  publish_date TEXT,
  views INTEGER NOT NULL DEFAULT 0,
  likes INTEGER NOT NULL DEFAULT 0,
  comments INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dev_projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  milestone TEXT,
  priority TEXT NOT NULL DEFAULT 'mid',
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS dev_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES dev_projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  sort INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS dev_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES dev_projects(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS consult_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client TEXT NOT NULL,
  project TEXT NOT NULL DEFAULT '',
  deliverable TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'talking',
  next_follow_up TEXT,
  hours REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS idea_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idea_id INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  score INTEGER NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  dimensions TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`)

// 数据迁移（2026-09-28）：应用更名 想法盒 → 灵感盒，同步旧频道名
db.prepare("UPDATE channels SET name = '灵感广场' WHERE name = '想法广场'").run()
db.prepare("UPDATE channels SET name = replace(name, '想法讨论：', '灵感讨论：') WHERE type = 'idea' AND name LIKE '想法讨论：%'").run()

// 数据迁移（2026-09-28 二期）：开发工程模块扩展
function addColumnIfMissing(table: string, column: string, def: string): void {
  const cols = db.pragma(`table_info(${table})`) as any[]
  if (!cols.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${def}`)
}

addColumnIfMissing('dev_projects', 'repo_url', 'TEXT')
addColumnIfMissing('dev_projects', 'tech_stack', 'TEXT')
addColumnIfMissing('dev_projects', 'deadline', 'TEXT')
addColumnIfMissing('dev_projects', 'source_idea_id', 'INTEGER')
addColumnIfMissing('dev_tasks', 'status', "TEXT NOT NULL DEFAULT 'todo'")
addColumnIfMissing('dev_tasks', 'priority', "TEXT NOT NULL DEFAULT 'mid'")
db.exec("UPDATE dev_tasks SET status = 'done' WHERE done = 1 AND status = 'todo'")

// 数据迁移（2026-09-28 三期）：邮箱密码登录（移植「起念」登录模块）
// 旧昵称账号 email 为 NULL，不允许通过注册同昵称认领数据
addColumnIfMissing('users', 'email', 'TEXT')
addColumnIfMissing('users', 'password_hash', 'TEXT')
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL')
migrateEmailVerification(db)

// 数据迁移（2026-09-28 v0.2）：广场化 + 僵尸表激活（按 v0.2 功能线框 §5）
addColumnIfMissing('ideas', 'is_public', 'INTEGER NOT NULL DEFAULT 0')
addColumnIfMissing('ideas', 'public_summary', "TEXT NOT NULL DEFAULT ''")
addColumnIfMissing('ideas', 'tags', "TEXT NOT NULL DEFAULT ''")
addColumnIfMissing('ideas', 'score_public', 'INTEGER NOT NULL DEFAULT 1')
addColumnIfMissing('users', 'plaza_muted_at', 'TEXT')
addColumnIfMissing('users', 'plaza_mute_reason', 'TEXT')
addColumnIfMissing('ideas', 'plaza_removed_at', 'TEXT')
addColumnIfMissing('ideas', 'plaza_removed_by', 'INTEGER')
addColumnIfMissing('ideas', 'plaza_remove_reason', 'TEXT')
addColumnIfMissing('ideas', 'source_parent_ids', 'TEXT')
addColumnIfMissing('ideas', 'synthesis_contract_ok', 'INTEGER')
addColumnIfMissing('channels', 'archived_at', 'TEXT')
addColumnIfMissing('user_settings', 'language', "TEXT NOT NULL DEFAULT 'zh-CN'")
addColumnIfMissing('idea_scores', 'model', 'TEXT')
addColumnIfMissing('idea_scores', 'angle', 'TEXT')
addColumnIfMissing('idea_scores', 'standard_version', 'TEXT')
addColumnIfMissing('idea_scores', 'analysis', 'TEXT')
addColumnIfMissing('idea_scores', 'validity', "TEXT NOT NULL DEFAULT 'legacy'")
addColumnIfMissing('daily_plans', 'source_step_id', 'INTEGER')
addColumnIfMissing('media_items', 'source_idea_id', 'INTEGER')
addColumnIfMissing('consult_items', 'amount', 'REAL NOT NULL DEFAULT 0')
addColumnIfMissing('consult_items', 'settled_amount', 'REAL NOT NULL DEFAULT 0')

db.exec(`
CREATE TABLE IF NOT EXISTS plaza_likes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idea_id INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, idea_id)
);

CREATE TABLE IF NOT EXISTS plaza_comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idea_id INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  parent_id INTEGER REFERENCES plaza_comments(id),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  ref_id INTEGER,
  actor_id INTEGER,
  content TEXT NOT NULL DEFAULT '',
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`)

db.exec(`
CREATE TABLE IF NOT EXISTS synthesis_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idea_a_id INTEGER REFERENCES ideas(id) ON DELETE SET NULL,
  idea_b_id INTEGER REFERENCES ideas(id) ON DELETE SET NULL,
  result_json TEXT NOT NULL,
  contract_ok INTEGER NOT NULL DEFAULT 0,
  imported_idea_id INTEGER REFERENCES ideas(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_synthesis_runs_user ON synthesis_runs(user_id, id DESC);
`)

// 数据迁移（2026-09-28 Phase C）：开发需求商单 + AI 供需匹配
db.exec(`
CREATE TABLE IF NOT EXISTS order_leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  requirement TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL,
  amount REAL NOT NULL DEFAULT 0,
  deadline TEXT,
  status TEXT NOT NULL DEFAULT 'pool',
  matched_project_id INTEGER REFERENCES dev_projects(id) ON DELETE SET NULL,
  match_raw TEXT NOT NULL DEFAULT '',
  matched_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS order_matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES order_leads(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES dev_projects(id) ON DELETE CASCADE,
  score INTEGER NOT NULL,
  reasons TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(lead_id, project_id)
);
`)

// 守卫式加列：开发工程 ← 商单溯源
addColumnIfMissing('dev_projects', 'source_lead_id', 'INTEGER')

// 守卫式加列（Phase D）：归档作品 ← 制作方案溯源
addColumnIfMissing('media_items', 'studio_id', 'INTEGER')

// 数据迁移（2026-09-28 Phase C 补丁 v1.1）：混合检索通道列 + 灵感↔商单匹配度
addColumnIfMissing('order_matches', 'kw_score', 'INTEGER NOT NULL DEFAULT 0')
addColumnIfMissing('order_matches', 'ai_score', 'INTEGER NOT NULL DEFAULT -1')
addColumnIfMissing('order_matches', 'hit_terms', "TEXT NOT NULL DEFAULT ''")

db.exec(`
CREATE TABLE IF NOT EXISTS idea_order_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idea_id INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id INTEGER NOT NULL REFERENCES order_leads(id) ON DELETE CASCADE,
  score INTEGER NOT NULL,
  reasons TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`)

// 数据迁移（2026-09-28 Phase A）：AI 原始记录存档
db.exec(`
CREATE TABLE IF NOT EXISTS ai_raw_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  idea_id INTEGER NOT NULL REFERENCES ideas(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  request_prompt TEXT NOT NULL,
  raw_response TEXT NOT NULL,
  parsed_ok INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`)

// 数据迁移（2026-09-28 Phase D）：自媒体制作工坊 + 心仪视频作品
addColumnIfMissing('ai_raw_logs', 'diagnostic', 'TEXT')
db.exec(`
CREATE TABLE IF NOT EXISTS studio_projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_idea_id INTEGER REFERENCES ideas(id) ON DELETE SET NULL,
  title TEXT NOT NULL DEFAULT '',
  brief TEXT NOT NULL,
  form TEXT NOT NULL DEFAULT 'short',
  synopsis TEXT NOT NULL DEFAULT '',
  characters TEXT NOT NULL DEFAULT '[]',
  scenes TEXT NOT NULL DEFAULT '[]',
  tools TEXT NOT NULL DEFAULT '[]',
  tools_raw TEXT NOT NULL DEFAULT '',
  chosen_tool TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'generated',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS video_wishes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  video_url TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  features TEXT NOT NULL DEFAULT '',
  art_style TEXT NOT NULL DEFAULT '',
  analysis_raw TEXT NOT NULL DEFAULT '',
  analysis_channel TEXT NOT NULL DEFAULT '',
  source_idea_id INTEGER REFERENCES ideas(id) ON DELETE SET NULL,
  adopted_studio_id INTEGER REFERENCES studio_projects(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS wish_matches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  wish_id INTEGER NOT NULL REFERENCES video_wishes(id) ON DELETE CASCADE,
  studio_id INTEGER NOT NULL REFERENCES studio_projects(id) ON DELETE CASCADE,
  score INTEGER NOT NULL,
  kw_score INTEGER NOT NULL DEFAULT 0,
  ai_score INTEGER NOT NULL DEFAULT -1,
  hit_terms TEXT NOT NULL DEFAULT '',
  reasons TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(wish_id, studio_id)
);
`)

db.exec(`
CREATE TABLE IF NOT EXISTS dev_milestones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES dev_projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  target_date TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`)

db.exec(`
CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, read);
CREATE TABLE IF NOT EXISTS announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  content TEXT NOT NULL CHECK (length(content) BETWEEN 1 AND 10000),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
  action_label TEXT,
  action_url TEXT,
  created_by INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT,
  CHECK ((action_label IS NULL AND action_url IS NULL) OR (action_label IS NOT NULL AND action_url IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_announcements_published ON announcements(status, published_at DESC, id DESC);
CREATE TABLE IF NOT EXISTS announcement_reads (
  announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  read_at TEXT NOT NULL,
  PRIMARY KEY (announcement_id, user_id)
);
`)

// 首次启动时预置两个公共频道
const publicCount = (db.prepare("SELECT COUNT(*) AS c FROM channels WHERE type = 'public'").get() as any).c
if (!publicCount) {
  const ins = db.prepare('INSERT INTO channels (type, idea_id, name) VALUES (?, NULL, ?)')
  ins.run('public', '想法广场')
  ins.run('public', '闲聊灌水')
}

migrateNewRound(db)
migrateScoringV3(db)
migrateScoringV5(db)


export const nowIso = (): string => new Date().toISOString()

export function touchIdea(ideaId: number): void {
  db.prepare("UPDATE ideas SET updated_at = ? WHERE id = ?").run(nowIso(), ideaId)
}
