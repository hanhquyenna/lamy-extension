-- Local SQLite schema for the Lamy worker.
-- The backend runs this file automatically on startup; no cloud database is used.

PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS lamy_users (
  id TEXT PRIMARY KEY,
  display_name TEXT,
  worker_token TEXT UNIQUE,
  linkedin_restricted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lamy_bank (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  claim TEXT NOT NULL,
  metric TEXT,
  tags TEXT NOT NULL DEFAULT '[]',
  state TEXT NOT NULL DEFAULT 'inferred' CHECK (state IN ('confirmed','inferred','stale')),
  source TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lamy_roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  company TEXT NOT NULL,
  archetype TEXT NOT NULL DEFAULT 'quantified_operator',
  must_haves TEXT NOT NULL DEFAULT '[]',
  jd TEXT,
  source_url TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lamy_asks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  question TEXT NOT NULL,
  unlocks TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','answered','skipped','never')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS lamy_applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  role_id INTEGER NOT NULL,
  bullets TEXT NOT NULL DEFAULT '[]',
  bank_ids TEXT NOT NULL DEFAULT '[]',
  fit_at_submit INTEGER,
  status TEXT NOT NULL DEFAULT 'prepared',
  submitted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lamy_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  detail TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lamy_outreach (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lamy_worker_queue (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','leased','done','failed')),
  leased_at TEXT,
  result TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS lamy_bank_user ON lamy_bank(user_id);
CREATE INDEX IF NOT EXISTS lamy_roles_user ON lamy_roles(user_id);
CREATE INDEX IF NOT EXISTS lamy_queue_user_status ON lamy_worker_queue(user_id, status, id);
CREATE INDEX IF NOT EXISTS lamy_outreach_user_at ON lamy_outreach(user_id, at);
