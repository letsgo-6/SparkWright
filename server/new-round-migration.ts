// SPDX-License-Identifier: MPL-2.0
import type Database from 'better-sqlite3'

export function migrateNewRound(db: Database.Database): void {
  const add = (table: string, column: string, definition: string) => {
    if (!(db.pragma(`table_info(${table})`) as { name: string }[]).some((item) => item.name === column))
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`)
  }
  db.transaction(() => {
    add('ideas', 'score_revision', 'INTEGER NOT NULL DEFAULT 0 CHECK(score_revision >= 0)')
    add('idea_scores', 'score_milli', 'INTEGER CHECK(score_milli IS NULL OR (typeof(score_milli) = \'integer\' AND score_milli BETWEEN 0 AND 100000))')
    add('idea_scores', 'precision_version', 'TEXT')
    add('idea_scores', 'idea_revision', 'INTEGER')
    db.exec(`UPDATE idea_scores SET score_milli = score * 1000, precision_version = 'legacy-int-v1'
      WHERE score_milli IS NULL AND typeof(score) = 'integer' AND score BETWEEN 0 AND 100;
      CREATE INDEX IF NOT EXISTS idx_idea_scores_representative
      ON idea_scores(idea_id, standard_version, angle, validity, idea_revision, id DESC);

      CREATE TRIGGER IF NOT EXISTS idea_scoring_revision AFTER UPDATE OF title, content, status, deadline ON ideas
      WHEN OLD.title IS NOT NEW.title OR OLD.content IS NOT NEW.content OR OLD.status IS NOT NEW.status OR OLD.deadline IS NOT NEW.deadline
      BEGIN UPDATE ideas SET score_revision = score_revision + 1 WHERE id = NEW.id; END;
      CREATE TRIGGER IF NOT EXISTS step_scoring_insert AFTER INSERT ON plan_steps
      BEGIN UPDATE ideas SET score_revision = score_revision + 1 WHERE id = NEW.idea_id; END;
      CREATE TRIGGER IF NOT EXISTS step_scoring_delete AFTER DELETE ON plan_steps
      BEGIN UPDATE ideas SET score_revision = score_revision + 1 WHERE id = OLD.idea_id; END;
      CREATE TRIGGER IF NOT EXISTS step_scoring_update AFTER UPDATE OF title, done, sort ON plan_steps
      WHEN OLD.title IS NOT NEW.title OR OLD.done IS NOT NEW.done OR OLD.sort IS NOT NEW.sort
      BEGIN UPDATE ideas SET score_revision = score_revision + 1 WHERE id = NEW.idea_id; END;

      CREATE TABLE IF NOT EXISTS user_activity_state (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        last_seen_at INTEGER NOT NULL CHECK(last_seen_at >= 0));
      CREATE INDEX IF NOT EXISTS idx_activity_state_seen ON user_activity_state(last_seen_at, user_id);
      CREATE TABLE IF NOT EXISTS user_activity_hours (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        hour_start INTEGER NOT NULL CHECK(hour_start >= 0 AND hour_start % 3600 = 0),
        first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
        PRIMARY KEY(user_id, hour_start),
        CHECK(first_seen_at >= hour_start AND first_seen_at < hour_start + 3600),
        CHECK(last_seen_at >= first_seen_at AND last_seen_at < hour_start + 3600));
      CREATE INDEX IF NOT EXISTS idx_activity_hours_chart ON user_activity_hours(hour_start, user_id, first_seen_at);
      CREATE TABLE IF NOT EXISTS activity_collection_meta (
        id INTEGER PRIMARY KEY CHECK(id = 1), collection_started_at INTEGER NOT NULL, last_cleanup_at INTEGER);

      CREATE TABLE IF NOT EXISTS user_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        category TEXT NOT NULL CHECK(category IN ('bug','suggestion','question')),
        title TEXT NOT NULL, content TEXT NOT NULL, page_path TEXT,
        status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','in_progress','resolved','closed')),
        version INTEGER NOT NULL DEFAULT 1 CHECK(version >= 1), request_id TEXT NOT NULL,
        content_hash TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT,
        UNIQUE(user_id, request_id));
      CREATE INDEX IF NOT EXISTS idx_feedback_owner_created ON user_feedback(user_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_feedback_status_updated ON user_feedback(status, updated_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_feedback_updated ON user_feedback(updated_at DESC, id DESC);
      CREATE TABLE IF NOT EXISTS feedback_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, feedback_id INTEGER NOT NULL REFERENCES user_feedback(id) ON DELETE CASCADE,
        actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
        kind TEXT NOT NULL CHECK(kind IN ('status','internal_note','public_reply')),
        content TEXT NOT NULL DEFAULT '', from_status TEXT, to_status TEXT,
        request_id TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(feedback_id, request_id));
      CREATE INDEX IF NOT EXISTS idx_feedback_events_thread ON feedback_events(feedback_id, id);
      CREATE INDEX IF NOT EXISTS idx_feedback_events_actor_time ON feedback_events(actor_id, created_at);
      CREATE TRIGGER IF NOT EXISTS feedback_notice_demotion AFTER UPDATE OF role ON users
      WHEN NEW.role = 'user'
      BEGIN DELETE FROM notifications WHERE user_id = NEW.id AND type = 'feedback_new'; END;`)
  }).immediate()
}
