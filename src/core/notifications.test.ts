/**
 * 通知引擎单测：去重 60s、mute 规则、context 阈值、历史。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema.ts";
import { NotificationEngine } from "./notifications.ts";
import type { CoreEvent } from "./events.ts";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function ev(partial: Partial<CoreEvent>): CoreEvent {
  return {
    event_id: partial.event_id ?? `e-${Math.random().toString(36).slice(2)}`,
    seq: 0,
    agent: "claude_code",
    session_id: "s1",
    project_id: "/Users/x/my-app",
    event_type: "decision_required",
    severity: "high",
    safe_summary: "x",
    timestamp: new Date().toISOString(),
    payload: {},
    ...partial,
  };
}

test("context 阈值 70/85/95 各触发一次，69 不触发", () => {
  const db = makeDb();
  const n = new NotificationEngine(db);
  assert.equal(n.getForEvent(ev({ session_id: "s69", event_type: "context_update", payload: { context_pct: 69 } })), null);
  const n70 = n.getForEvent(ev({ session_id: "s70", event_type: "context_update", payload: { context_pct: 70 } }));
  assert.equal(n70?.type, "context");
  const n85 = n.getForEvent(ev({ session_id: "s85", event_type: "context_update", payload: { context_pct: 85 } }));
  assert.equal(n85?.type, "context");
  const n96 = n.getForEvent(ev({ session_id: "s96", event_type: "context_update", payload: { context_pct: 96 } }));
  assert.equal(n96?.type, "context");
});

test("同 session 同类型 60s 内去重", () => {
  const db = makeDb();
  const n = new NotificationEngine(db);
  n.getForEvent(ev({ event_id: "a", payload: { kind: "Stop" } }));
  const second = n.getForEvent(ev({ event_id: "b", payload: { kind: "Stop" } }));
  assert.equal(second, null, "60s 内同类型应去重");
  const rows = db.prepare("SELECT COUNT(*) c FROM notifications").get() as { c: number };
  assert.equal(rows.c, 1);
});

test("全局 mute 30m 后不再出气泡（落库为 muted）", () => {
  const db = makeDb();
  const n = new NotificationEngine(db);
  n.muteGlobal(30);
  const r = n.getForEvent(ev({ event_id: "a", payload: { kind: "Stop" } }));
  assert.equal(r, null);
  const rows = db.prepare("SELECT status FROM notifications").all() as Array<{ status: string }>;
  assert.equal(rows[0]?.status, "muted");
});

test("按 session mute 只影响该 session", () => {
  const db = makeDb();
  const n = new NotificationEngine(db);
  n.muteSession("s1", 30);
  assert.equal(n.getForEvent(ev({ event_id: "a", session_id: "s1" })), null);
  const other = n.getForEvent(ev({ event_id: "b", session_id: "s2", payload: { kind: "Stop" } }));
  assert.equal(other?.type, "decision", "其他 session 不受影响");
});

test("dismiss 与 history", () => {
  const db = makeDb();
  const n = new NotificationEngine(db);
  n.getForEvent(ev({ event_id: "a", payload: { kind: "Stop" } }));
  const row = db.prepare("SELECT id FROM notifications ORDER BY id DESC LIMIT 1").get() as { id: number };
  n.dismiss(row.id);
  const h = n.history();
  assert.equal(h[0]?.status, "dismissed");
});

test("token milestone 25% 触发（budget 100k, tokens 25k）", () => {
  const db = makeDb();
  const n = new NotificationEngine(db);
  db.prepare("INSERT INTO sessions(agent, agent_session_id, project_id, budget_tokens) VALUES('claude_code','s1','/Users/x/my-app', 100000)").run();
  const r = n.getForEvent(ev({ event_type: "token_update", payload: { tokens: 25000 } }));
  assert.equal(r?.type, "milestone");
});
