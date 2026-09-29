/**
 * 迁移单测：老库（v1）必须能补上后加的列。
 * CREATE TABLE IF NOT EXISTS 对已存在的表是空操作 —— 只靠它的话，
 * 升级后的代码会对着 v1 的表查不存在的字段，Core 直接抛异常起不来。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { applySchema, SCHEMA_VERSION } from "./schema.ts";
import { NOTIFICATION_RESOLUTIONS, WAIT_RESOLUTIONS } from "../core/events.ts";

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

test("v1 老库升级：补上 token_exp_granted / needs_input_* / subagent_* 且数据不丢", () => {
  const db = new Database(":memory:");
  db.exec(V1_SESSIONS);
  db.prepare("INSERT INTO sessions(agent, agent_session_id, project_id) VALUES('claude_code','old','/p')").run();

  assert.equal(applySchema(db), SCHEMA_VERSION);

  const cols = (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((c) => c.name);
  for (const col of [
    "token_exp_granted", "needs_input_since", "needs_input_kind", "ready_since",
    "subagent_count", "subagent_since",
  ]) {
    assert.ok(cols.includes(col), `缺少列 ${col}`);
  }
  // NOT NULL DEFAULT 0 的列补到老表上必须有值 —— 否则老 session 的计数是 NULL，
  // 而 `NULL >= 2` 在 SQLite 里既不真也不假，subagent 判定会静默整场失效
  const counted = db.prepare("SELECT subagent_count FROM sessions").get() as { subagent_count: number };
  assert.equal(counted.subagent_count, 0);
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

/** v4 及以前的 notifications：只有 status，说不出一条通知是怎么结束的 */
const V1_NOTIFICATIONS = `
CREATE TABLE notifications (
  id INTEGER PRIMARY KEY,
  event_id TEXT,
  agent TEXT NOT NULL,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'shown' CHECK (status IN ('shown','dismissed','actioned','muted')),
  shown_at TEXT NOT NULL DEFAULT (datetime('now')),
  actioned_at TEXT
);`;

type NotifRow = { id: number; title: string; status: string; resolution: string | null; resolved_at: string | null };

test("老库 notifications 补上 resolution / resolved_at：按 status 回填，数据不丢", () => {
  const db = new Database(":memory:");
  db.exec(V1_NOTIFICATIONS);
  const insert = db.prepare(
    `INSERT INTO notifications(agent, session_id, type, title, body, status, shown_at, actioned_at)
     VALUES('claude_code','s1','decision',?, 'b', ?, '2026-09-01T10:00:00.000Z', ?)`,
  );
  insert.run("shown", "shown", null);
  insert.run("actioned", "actioned", "2026-09-01T10:05:00.000Z");
  insert.run("actioned-no-time", "actioned", null);
  insert.run("dismissed", "dismissed", null);
  insert.run("muted", "muted", null);

  applySchema(db);

  const rows = db.prepare("SELECT id, title, status, resolution, resolved_at FROM notifications ORDER BY id").all() as NotifRow[];
  assert.equal(rows.length, 5, "老数据一行都不能丢");
  const by = Object.fromEntries(rows.map((r) => [r.title, r]));
  assert.equal(by.shown!.resolution, null, "还挂着的气泡不能被回填成已结束");
  assert.equal(by.shown!.resolved_at, null);
  assert.equal(by.actioned!.resolution, "user_actioned");
  assert.equal(by.actioned!.resolved_at, "2026-09-01T10:05:00.000Z");
  assert.equal(by["actioned-no-time"]!.resolution, "user_actioned");
  assert.equal(by["actioned-no-time"]!.resolved_at, "2026-09-01T10:00:00.000Z", "没有 actioned_at 的老行退回 shown_at，不留 NULL");
  assert.equal(by.dismissed!.resolution, "dismissed");
  assert.equal(by.dismissed!.resolved_at, null, "不知道什么时候叉的，就别编一个时间");
  assert.equal(by.muted!.resolution, "muted");
  assert.equal(by.muted!.resolved_at, "2026-09-01T10:00:00.000Z");
  for (const r of rows) assert.equal(r.status, r.title.replace("-no-time", ""), "status 原样保留");
});

test("applySchema 跑第二遍对 notifications 是空操作：不重复加列，也不再回填", () => {
  const db = new Database(":memory:");
  db.exec(V1_NOTIFICATIONS);
  applySchema(db);
  // 补列之后才出现的行：回填只属于那一次迁移，不该在每次启动时重跑
  db.prepare(
    `INSERT INTO notifications(agent, session_id, type, title, body, status)
     VALUES('claude_code','s1','decision','t','b','dismissed')`,
  ).run();
  applySchema(db);
  const cols = (db.prepare("PRAGMA table_info(notifications)").all() as Array<{ name: string }>).map((c) => c.name);
  assert.equal(cols.filter((c) => c === "resolution").length, 1);
  assert.equal(cols.filter((c) => c === "resolved_at").length, 1);
  const row = db.prepare("SELECT resolution FROM notifications").get() as { resolution: string | null };
  assert.equal(row.resolution, null);
});

test("resolution 的 CHECK 与 events.ts 的 NOTIFICATION_RESOLUTIONS 是同一份清单", () => {
  const db = new Database(":memory:");
  applySchema(db);
  const insert = db.prepare(
    `INSERT INTO notifications(agent, session_id, type, title, body, resolution)
     VALUES('claude_code','s1','decision','t','b',?)`,
  );
  for (const r of [...NOTIFICATION_RESOLUTIONS, null]) insert.run(r);
  assert.throws(() => insert.run("expired"), /CHECK/);
});

test("老库 sessions 补上分段 / 峰值 / 重复编辑 / 权限模式：按老列回填，数据不丢", () => {
  const db = new Database(":memory:");
  db.exec(V1_SESSIONS);
  db.prepare(
    `INSERT INTO sessions(agent, agent_session_id, project_id, context_pct, started_at, last_event_at)
     VALUES('claude_code','hot','/p', 88, '2026-09-01T10:00:00.000Z', '2026-09-01T11:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO sessions(agent, agent_session_id, project_id, context_pct, started_at)
     VALUES('claude_code','cold','/p', 0, '2026-09-02T10:00:00.000Z')`,
  ).run();
  applySchema(db);
  const rows = db
    .prepare(
      `SELECT agent_session_id AS id, segment, segment_started_at, context_peak, context_reported_at,
              repeat_edit_count, permission_mode FROM sessions ORDER BY id`,
    )
    .all() as Array<Record<string, unknown>>;
  const hot = rows.find((r) => r.id === "hot")!;
  const cold = rows.find((r) => r.id === "cold")!;
  assert.equal(hot.segment, 1);
  assert.equal(hot.segment_started_at, "2026-09-01T10:00:00.000Z", "第一段从 session 开始算起");
  assert.equal(hot.context_peak, 88, "最后一个值是峰值的下界");
  assert.equal(hot.context_reported_at, "2026-09-01T11:00:00.000Z");
  assert.equal(cold.context_peak, 0);
  assert.equal(cold.context_reported_at, null, "0% 分不清「很健康」和「没报过」，留作不知道");
  assert.equal(hot.repeat_edit_count, 0);
  assert.equal(hot.permission_mode, null);
});

test("applySchema 跑第二遍不再回填：已经涨上去的峰值不会被 context_pct 拉回来", () => {
  const db = new Database(":memory:");
  db.exec(V1_SESSIONS);
  db.prepare("INSERT INTO sessions(agent, agent_session_id, project_id, context_pct) VALUES('claude_code','s','/p', 40)").run();
  applySchema(db);
  db.prepare("UPDATE sessions SET context_peak = 97, context_pct = 10, segment_started_at = 'kept'").run();
  applySchema(db);
  const r = db.prepare("SELECT context_peak, segment_started_at FROM sessions").get() as Record<string, unknown>;
  assert.equal(r.context_peak, 97);
  assert.equal(r.segment_started_at, "kept");
  const cols = (db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>).map((c) => c.name);
  assert.equal(cols.filter((c) => c === "context_peak").length, 1);
});

test("老库升级后有 needs_input_waits 表；resolution 的 CHECK 与 events.ts 的 WAIT_RESOLUTIONS 是同一份清单", () => {
  const db = new Database(":memory:");
  db.exec(V1_SESSIONS);
  applySchema(db);
  const cols = (db.prepare("PRAGMA table_info(needs_input_waits)").all() as Array<{ name: string }>).map((c) => c.name);
  for (const c of ["agent", "session_id", "segment", "started_at", "received_at", "cleared_at", "resolution", "muted_ms", "slept_ms"]) {
    assert.ok(cols.includes(c), `缺少列 ${c}`);
  }
  const insert = db.prepare(
    `INSERT INTO needs_input_waits(agent, session_id, started_at, received_at, resolution)
     VALUES('claude_code','s1','t','t',?)`,
  );
  for (const r of [...WAIT_RESOLUTIONS, null]) insert.run(r);
  assert.throws(() => insert.run("user_actioned"), /CHECK/);
  const w = db.prepare("SELECT muted_ms, slept_ms, segment FROM needs_input_waits LIMIT 1").get() as Record<string, number>;
  assert.deepEqual(w, { muted_ms: 0, slept_ms: 0, segment: 1 });
});
