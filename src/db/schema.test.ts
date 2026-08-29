/**
 * 迁移单测：老库（v1）必须能补上后加的列。
 * CREATE TABLE IF NOT EXISTS 对已存在的表是空操作 —— 只靠它的话，
 * 升级后的代码会对着 v1 的表查不存在的字段，Core 直接抛异常起不来。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { applySchema, SCHEMA_VERSION } from "./schema.ts";

const V1_SESSIONS = `
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY,
  agent TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  title TEXT,
  goal TEXT,
  budget_tokens INTEGER,
  token_used INTEGER NOT NULL DEFAULT 0,
  context_pct REAL NOT NULL DEFAULT 0,
  correction_count INTEGER NOT NULL DEFAULT 0,
  parent_id INTEGER REFERENCES sessions(id),
  branch TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  last_event_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  outcome TEXT,
  UNIQUE (agent, agent_session_id)
);`;

test("v1 老库升级：补上 token_exp_granted / needs_input_* 且数据不丢", () => {
  const db = new Database(":memory:");
  db.exec(V1_SESSIONS);
  db.prepare("INSERT INTO sessions(agent, agent_session_id, project_id) VALUES('claude_code','old','/p')").run();

  assert.equal(applySchema(db), SCHEMA_VERSION);

  const cols = (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((c) => c.name);
  for (const col of ["token_exp_granted", "needs_input_since", "needs_input_kind", "ready_since"]) {
    assert.ok(cols.includes(col), `缺少列 ${col}`);
  }
  const row = db.prepare("SELECT agent_session_id, token_exp_granted FROM sessions").get() as {
    agent_session_id: string;
    token_exp_granted: number;
  };
  assert.equal(row.agent_session_id, "old", "老数据必须还在");
  assert.equal(row.token_exp_granted, 0);
});

test("applySchema 幂等：重复执行不报错、不重复加列", () => {
  const db = new Database(":memory:");
  applySchema(db);
  applySchema(db);
  const cols = (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((c) => c.name);
  assert.equal(cols.filter((c) => c === "needs_input_since").length, 1);
});
