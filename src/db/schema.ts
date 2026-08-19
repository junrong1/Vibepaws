/**
 * Vibepaws SQLite schema — 对应 docs/mvp_architecture.md §4
 * 9 张表：pet_types / pets / agents / sessions / events / notifications /
 *         exp_logs / memories / settings
 * 隐私：events 仅存 safe_summary + 白名单 payload（第二道隐私闸在写入前）。
 */

export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS pet_types (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  rarity        TEXT NOT NULL DEFAULT 'common' CHECK (rarity IN ('common','uncommon','rare','legendary')),
  sprite_pack   TEXT NOT NULL,
  evolution_meta TEXT NOT NULL DEFAULT '[]',  -- JSON: [{from_level, conditions, to_stage}]
  starter       INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pets (
  id            INTEGER PRIMARY KEY,
  pet_type_id   INTEGER NOT NULL REFERENCES pet_types(id),
  name          TEXT,
  level         INTEGER NOT NULL DEFAULT 1,
  exp           REAL NOT NULL DEFAULT 0,
  state         TEXT NOT NULL DEFAULT 'idle',
  health_score  REAL NOT NULL DEFAULT 1.0,
  daily_exp     REAL NOT NULL DEFAULT 0,
  daily_reset_at TEXT NOT NULL DEFAULT (datetime('now')),
  assigned_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agents (
  agent         TEXT PRIMARY KEY,           -- claude_code | codex | generic | pi
  adapter_version TEXT,
  capabilities  TEXT NOT NULL DEFAULT '[]', -- JSON 数组：能力声明
  connected_at  TEXT,
  last_event_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id            INTEGER PRIMARY KEY,
  agent         TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  project_id    TEXT NOT NULL,
  title         TEXT,
  goal          TEXT,
  budget_tokens INTEGER,
  token_used    INTEGER NOT NULL DEFAULT 0,
  context_pct   REAL NOT NULL DEFAULT 0,
  correction_count INTEGER NOT NULL DEFAULT 0,
  parent_id     INTEGER REFERENCES sessions(id),
  branch        TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1,
  last_event_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at   TEXT,
  outcome       TEXT,
  UNIQUE (agent, agent_session_id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(is_active);

CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY,
  event_id      TEXT UNIQUE,
  seq           INTEGER NOT NULL DEFAULT 0,
  agent         TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  severity      TEXT NOT NULL DEFAULT 'low' CHECK (severity IN ('low','medium','high')),
  safe_summary  TEXT NOT NULL,
  payload_json  TEXT NOT NULL DEFAULT '{}', -- 仅白名单字段
  received_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(agent, session_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type, received_at);

CREATE TABLE IF NOT EXISTS notifications (
  id            INTEGER PRIMARY KEY,
  event_id      TEXT,
  agent         TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  type          TEXT NOT NULL,             -- decision | permission | context | error | drift | milestone
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'shown' CHECK (status IN ('shown','dismissed','actioned','muted')),
  shown_at      TEXT NOT NULL DEFAULT (datetime('now')),
  actioned_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status, shown_at);

CREATE TABLE IF NOT EXISTS exp_logs (
  id            INTEGER PRIMARY KEY,
  session_id    INTEGER REFERENCES sessions(id),
  amount        REAL NOT NULL,
  category      TEXT NOT NULL,             -- token | context | topic | outcome | care | self
  note          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_exp_logs_session ON exp_logs(session_id);

CREATE TABLE IF NOT EXISTS memories (
  id            INTEGER PRIMARY KEY,
  session_id    INTEGER REFERENCES sessions(id),
  kind          TEXT NOT NULL,             -- session_finish | achievement | milestone
  safe_summary  TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL
);
`;

/** 建表（幂等）。返回当前 schema 版本。 */
export function applySchema(db: { exec(sql: string): void }): number {
  db.exec(SCHEMA_SQL);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return SCHEMA_VERSION;
}
