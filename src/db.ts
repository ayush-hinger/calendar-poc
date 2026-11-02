import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH ?? path.join(here, '..', 'data', 'calendar-poc.db');

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id         TEXT PRIMARY KEY,
  role       TEXT NOT NULL CHECK (role IN ('teacher','student')),
  name       TEXT NOT NULL,
  email      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS connections (
  id                 TEXT PRIMARY KEY,
  user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider           TEXT NOT NULL CHECK (provider IN ('google','microsoft','apple','log')),
  account_email      TEXT,
  access_token_enc   TEXT,
  refresh_token_enc  TEXT,
  expires_at         INTEGER,
  caldav_base_url    TEXT,
  caldav_calendar_url TEXT,
  status             TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','needs_reauth','revoked')),
  last_error         TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_connections_user ON connections(user_id);

CREATE TABLE IF NOT EXISTS class_events (
  id          TEXT PRIMARY KEY,
  teacher_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  description TEXT,
  location    TEXT,
  starts_at   TEXT NOT NULL,
  ends_at     TEXT NOT NULL,
  timezone    TEXT NOT NULL DEFAULT 'UTC',
  status      TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','cancelled')),
  version     INTEGER NOT NULL DEFAULT 1,
  ical_uid    TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS enrollments (
  event_id   TEXT NOT NULL REFERENCES class_events(id) ON DELETE CASCADE,
  student_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (event_id, student_id)
);

-- One row per (class event x student calendar connection).
-- The whole sync engine is driven by: synced_version < desired version => work pending.
CREATE TABLE IF NOT EXISTS sync_targets (
  id                TEXT PRIMARY KEY,
  event_id          TEXT NOT NULL REFERENCES class_events(id) ON DELETE CASCADE,
  connection_id     TEXT NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  external_event_id TEXT,
  external_etag     TEXT,
  synced_version    INTEGER NOT NULL DEFAULT 0,
  state             TEXT NOT NULL DEFAULT 'pending'
                      CHECK (state IN ('pending','synced','failed','dead','removed')),
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   INTEGER NOT NULL DEFAULT 0,
  last_error        TEXT,
  updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (event_id, connection_id)
);
CREATE INDEX IF NOT EXISTS idx_targets_event ON sync_targets(event_id);
CREATE INDEX IF NOT EXISTS idx_targets_state ON sync_targets(state, next_attempt_at);

CREATE TABLE IF NOT EXISTS sync_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  target_id TEXT NOT NULL,
  at        TEXT NOT NULL DEFAULT (datetime('now')),
  action    TEXT NOT NULL,
  ok        INTEGER NOT NULL,
  detail    TEXT
);
CREATE INDEX IF NOT EXISTS idx_synclog_target ON sync_log(target_id, id DESC);
`);

export function logSync(
  targetId: string,
  action: string,
  ok: boolean,
  detail?: string,
): void {
  db.prepare(
    'INSERT INTO sync_log (target_id, action, ok, detail) VALUES (?, ?, ?, ?)',
  ).run(targetId, action, ok ? 1 : 0, detail ?? null);
}
