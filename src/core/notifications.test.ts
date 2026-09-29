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
  assert.equal(other?.type, "ready", "其他 session 不受影响");
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

test("context 阈值闩锁：同一档不复读，跨到更高档才出声", () => {
  const db = makeDb();
  // dedupMs=0：这里要验证的是闩锁本身，不是 60s 去重窗口
  const n = new NotificationEngine(db, { dedupMs: 0 });
  const ctx = (pct: number) => n.getForEvent(ev({ event_type: "context_update", payload: { context_pct: pct } }));

  assert.ok(ctx(72), "首次跨过 70% 应提醒");
  assert.equal(ctx(75), null, "还在 70 这一档 —— 复读只会把用户逼去点「全部安静」");
  assert.equal(ctx(84), null);
  assert.ok(ctx(88), "跨到 85 这一档要提醒");
  assert.equal(ctx(90), null);
  assert.ok(ctx(97), "跨到 95 这一档要提醒");
  assert.equal(ctx(99), null);
  // compact / clear 之后 context 回落 → 重新武装
  assert.equal(ctx(20), null);
  assert.ok(ctx(75), "回落之后再涨上来应该重新提醒");
});

test("context 96% 报的是最高档（critical），不是 70 那一档", () => {
  const db = makeDb();
  const n = new NotificationEngine(db, { dedupMs: 0 });
  const r = n.getForEvent(ev({ event_type: "context_update", payload: { context_pct: 96 } }));
  assert.equal(r?.i18n?.body.key, "notif.context.body.critical");
});

test("token 里程碑同样闩锁（25% 之后不再每分钟复读）", () => {
  const db = makeDb();
  const n = new NotificationEngine(db, { dedupMs: 0 });
  db.prepare(
    "INSERT INTO sessions(agent, agent_session_id, project_id, budget_tokens) VALUES('claude_code','s1','/Users/x/my-app', 100000)",
  ).run();
  const tok = (tokens: number) => n.getForEvent(ev({ event_type: "token_update", payload: { tokens } }));
  assert.ok(tok(26000));
  assert.equal(tok(30000), null);
  assert.equal(tok(49000), null);
  assert.ok(tok(52000), "跨到 50% 要提醒");
  assert.ok(tok(91000), "跨到 90% 要提醒");
});

test("muteStatus 反映当前静音，unmute 立刻恢复出声", () => {
  const db = makeDb();
  const n = new NotificationEngine(db);
  assert.equal(n.muteStatus().global_until, null);
  n.muteGlobal(30);
  assert.ok((n.muteStatus().global_until ?? 0) > Date.now());
  n.unmuteGlobal();
  assert.equal(n.muteStatus().global_until, null);
  assert.ok(n.getForEvent(ev({ event_id: "after-unmute", payload: { kind: "Stop" } })), "解除后应重新出气泡");
});

test("脏的静音值算已过期（否则一个坏值就永久静音）", () => {
  const db = makeDb();
  const n = new NotificationEngine(db);
  db.prepare("INSERT INTO settings(key, value) VALUES('mute.global','forever')").run();
  assert.ok(n.getForEvent(ev({ event_id: "dirty", payload: { kind: "Stop" } })), "解析不出时间的静音不该生效");
  assert.equal(n.muteStatus().global_until, null);
});

test("被 mute 吞掉的档位不会被记成「已经报过」（解除静音后仍会提醒）", () => {
  const db = makeDb();
  const n = new NotificationEngine(db, { dedupMs: 0 });
  const ctx = (pct: number) => n.getForEvent(ev({ event_type: "context_update", payload: { context_pct: pct } }));
  n.muteGlobal(30);
  assert.equal(ctx(96), null, "静音期间不出气泡");
  n.unmuteGlobal();
  const after = ctx(97);
  assert.ok(after, "解除静音后 95% 这一档必须还能出声（闩锁不该在静音期间就记账）");
  assert.equal(after.i18n?.body.key, "notif.context.body.critical");
});

test("升档不被去重窗口吞掉，同档仍然只说一次", () => {
  const db = makeDb();
  // 生产的 60s 去重窗口
  const n = new NotificationEngine(db);
  const ctx = (pct: number) => n.getForEvent(ev({ event_type: "context_update", payload: { context_pct: pct } }));
  assert.ok(ctx(72), "首次 70 档");
  const high = ctx(88);
  assert.ok(high, "72%→88% 是另一件事，不该被 60s 去重窗口合并掉");
  assert.equal(high.i18n?.body.key, "notif.context.body.high");
  const critical = ctx(96);
  assert.ok(critical, "88%→96% 同理");
  assert.equal(critical.i18n?.body.key, "notif.context.body.critical");
  assert.equal(ctx(97), null, "同一档只说一次");
  assert.equal(ctx(99), null);
});

test("不带 tokens 的 token_update 不会清掉里程碑闩锁", () => {
  const db = makeDb();
  const n = new NotificationEngine(db, { dedupMs: 0 });
  db.prepare(
    "INSERT INTO sessions(agent, agent_session_id, project_id, budget_tokens) VALUES('claude_code','s1','/Users/x/my-app', 100000)",
  ).run();
  assert.ok(n.getForEvent(ev({ event_type: "token_update", payload: { tokens: 26000 } })));
  // Claude Code 的 PostToolUse 多数不带 tokens
  assert.equal(n.getForEvent(ev({ event_type: "token_update", payload: { tool_name: "Edit" } })), null);
  assert.equal(
    n.getForEvent(ev({ event_type: "token_update", payload: { tokens: 27000 } })),
    null,
    "同一档不该因为中间来了几条没读数的事件而复读",
  );
});

test("session_finished 之后清掉该 session 的去重/闩锁记录", () => {
  const db = makeDb();
  const n = new NotificationEngine(db);
  n.getForEvent(ev({ event_id: "d1", payload: { kind: "Stop" } }));
  assert.equal(n.getForEvent(ev({ event_id: "d2", payload: { kind: "Stop" } })), null, "60s 内去重");
  n.getForEvent(ev({ event_id: "fin", event_type: "session_finished", payload: { outcome: "success" } }));
  assert.ok(
    n.getForEvent(ev({ event_id: "d3", payload: { kind: "Stop" } })),
    "新一轮（resume 同一 session_id）不该被上一轮的去重记录压住",
  );
});

test("muteStatus 记住用户选的时长（界面据此点亮对应按钮）", () => {
  const db = makeDb();
  const n = new NotificationEngine(db);
  n.muteGlobal(120);
  assert.equal(n.muteStatus().global_minutes, 120, "剩余时间反推会在最后半小时点错按钮");
  n.muteGlobal(30);
  assert.equal(n.muteStatus().global_minutes, 30, "换时长要覆盖");
  n.unmuteGlobal();
  assert.equal(n.muteStatus().global_minutes, null);
  // 过期的静音连时长一起清掉
  n.muteGlobal(30);
  db.prepare("UPDATE settings SET value=? WHERE key='mute.global'").run(String(Date.now() - 1000));
  assert.deepEqual(
    [n.muteStatus().global_until, n.muteStatus().global_minutes],
    [null, null],
  );
});

test("decision_required kind=question → decision 通知（需要你）", () => {
  const db = makeDb();
  const n = new NotificationEngine(db);
  const r = n.getForEvent(ev({ payload: { kind: "question" } }));
  assert.equal(r?.type, "decision");
  assert.equal(r?.i18n?.title.key, "notif.decision.title");
  assert.equal(r?.i18n?.body.key, "notif.decision.body_question");
});

test("decision_required kind=Stop → ready 通知（待命，不是需要你）", () => {
  const db = makeDb();
  const n = new NotificationEngine(db);
  const r = n.getForEvent(ev({ payload: { kind: "Stop" } }));
  assert.equal(r?.type, "ready");
  assert.equal(r?.i18n?.title.key, "notif.ready.title");
  assert.equal(r?.i18n?.body.key, "notif.ready.body");
});

test("decision_required 无 kind → ready（非阻塞的安全默认）", () => {
  const db = makeDb();
  const n = new NotificationEngine(db);
  const r = n.getForEvent(ev({ payload: {} }));
  assert.equal(r?.type, "ready");
});

/* ---------------- 通知身份与结束方式（R1 / R2） ---------------- */

type Row = { id: number; status: string; resolution: string | null; resolved_at: string | null; actioned_at: string | null };
const rowOf = (db: Database.Database, id: number): Row =>
  db.prepare("SELECT id, status, resolution, resolved_at, actioned_at FROM notifications WHERE id=?").get(id) as Row;

test("persist 带回行 id；去重窗口内第二条返回 null，表里不多一行", () => {
  const db = makeDb();
  const n = new NotificationEngine(db);
  const first = n.getForEvent(ev({ event_id: "a", payload: { kind: "question" } }));
  assert.ok(first, "第一条应当发出去");
  assert.equal(typeof first.id, "number");
  assert.ok(Number.isInteger(first.id));
  const row = db.prepare("SELECT id, event_id FROM notifications").get() as { id: number; event_id: string };
  assert.equal(first.id, row.id, "返回的 id 必须就是刚写进去的那一行");
  assert.equal(row.event_id, "a");
  assert.equal(rowOf(db, row.id).resolution, null, "刚发出去的气泡还挂着");

  assert.equal(n.getForEvent(ev({ event_id: "b", payload: { kind: "question" } })), null);
  const c = db.prepare("SELECT COUNT(*) c FROM notifications").get() as { c: number };
  assert.equal(c.c, 1);
});

test("每条发出去的通知 id 各不相同（不同 session 各一条）", () => {
  const db = makeDb();
  const n = new NotificationEngine(db);
  const a = n.getForEvent(ev({ session_id: "s1", payload: { kind: "question" } }));
  const b = n.getForEvent(ev({ session_id: "s2", payload: { kind: "question" } }));
  assert.ok(a?.id && b?.id);
  assert.notEqual(a.id, b.id);
});

test("被静音吞掉的通知落库即结束：resolution=muted，resolved_at=shown_at", () => {
  const db = makeDb();
  const n = new NotificationEngine(db);
  n.muteGlobal(30);
  assert.equal(n.getForEvent(ev({ payload: { kind: "question" } })), null);
  const row = db.prepare("SELECT status, resolution, resolved_at, shown_at FROM notifications").get() as {
    status: string; resolution: string; resolved_at: string; shown_at: string;
  };
  assert.equal(row.status, "muted");
  assert.equal(row.resolution, "muted");
  assert.equal(row.resolved_at, row.shown_at);
});

test("dismiss → resolution=dismissed；actioned → user_actioned 且记下时间", () => {
  const db = makeDb();
  const n = new NotificationEngine(db);
  const a = n.getForEvent(ev({ session_id: "s1", payload: { kind: "question" } }))!;
  const b = n.getForEvent(ev({ session_id: "s2", payload: { kind: "question" } }))!;

  const d = n.dismiss(a.id!);
  assert.equal(d?.id, a.id);
  assert.equal(d?.resolution, "dismissed");
  assert.equal(d?.session_id, "s1");
  assert.equal(d?.type, "decision");
  assert.equal(rowOf(db, a.id!).status, "dismissed");
  assert.ok(rowOf(db, a.id!).resolved_at);

  const act = n.actioned(b.id!);
  assert.equal(act?.resolution, "user_actioned");
  const r = rowOf(db, b.id!);
  assert.equal(r.status, "actioned");
  assert.equal(r.resolution, "user_actioned");
  assert.ok(r.actioned_at);
  assert.equal(r.resolved_at, r.actioned_at);
});

test("只记第一次结束：叉掉之后再点「已处理」不改写，也不返回", () => {
  const db = makeDb();
  const n = new NotificationEngine(db);
  const a = n.getForEvent(ev({ payload: { kind: "question" } }))!;
  n.dismiss(a.id!);
  const before = rowOf(db, a.id!);
  assert.equal(n.actioned(a.id!), null);
  assert.equal(n.dismiss(a.id!), null, "重复叉一次也不是新的一次结束");
  assert.deepEqual(rowOf(db, a.id!), before);
});

test("不存在的 id：dismiss / actioned 返回 null，不抛", () => {
  const db = makeDb();
  const n = new NotificationEngine(db);
  assert.equal(n.dismiss(9999), null);
  assert.equal(n.actioned(9999), null);
});

test("resolveInferred 只收这个 session 还挂着的 decision / permission 气泡", () => {
  const db = makeDb();
  const n = new NotificationEngine(db, { dedupMs: 0 });
  const decision = n.getForEvent(ev({ session_id: "s1", payload: { kind: "question" } }))!;
  const permission = n.getForEvent(ev({ session_id: "s1", event_type: "permission_required", payload: { tool_name: "Bash" } }))!;
  const context = n.getForEvent(ev({ session_id: "s1", event_type: "context_update", payload: { context_pct: 90 } }))!;
  const answered = n.getForEvent(ev({ session_id: "s1", event_type: "permission_required", payload: {} }))!;
  n.actioned(answered.id!);
  const other = n.getForEvent(ev({ session_id: "s2", payload: { kind: "question" } }))!;

  const resolved = n.resolveInferred("claude_code", "s1");
  assert.deepEqual(resolved.map((r) => r.id).sort(), [decision.id, permission.id].sort());
  assert.ok(resolved.every((r) => r.resolution === "inferred" && r.resolved_at));
  assert.equal(rowOf(db, decision.id!).status, "dismissed");
  assert.equal(rowOf(db, context.id!).resolution, null, "context 提醒不因为 agent 继续干活就算答过了");
  assert.equal(rowOf(db, answered.id!).resolution, "user_actioned", "用户点过的那条不被改写成 inferred");
  assert.equal(rowOf(db, other.id!).resolution, null, "别的 session 不连坐");
  assert.deepEqual(n.resolveInferred("claude_code", "s1"), [], "第二次什么都不剩");
});
