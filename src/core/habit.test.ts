/**
 * HabitEngine 单测：纯函数阈值 + 事件折叠 + backfill + recompute + cold-start + 衰减。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema.ts";
import { seedPetTypes } from "../db/seed.ts";
import {
  HabitEngine,
  classifyChronotype,
  classifyCadence,
  computePrecision,
  computeContextHygiene,
  computeResponsiveness,
  computeDepth,
  classifyOutcomeBias,
  topToolAffinity,
  decayWeight,
} from "./habit.ts";
import type { CoreEvent } from "./events.ts";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  seedPetTypes(db);
  return db;
}

function ev(partial: Partial<CoreEvent>): CoreEvent {
  return {
    event_id: partial.event_id ?? `h-${Math.random().toString(36).slice(2)}`,
    seq: 0,
    agent: "claude_code",
    session_id: "s1",
    project_id: "/Users/x/my-app",
    event_type: "agent_working",
    severity: "low",
    safe_summary: "x",
    timestamp: new Date().toISOString(),
    payload: {},
    ...partial,
  };
}

/** SQLite datetime 格式（UTC），与 events 的 received_at / occurred_at 口径一致 */
function sqliteUtc(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function insertEvent(
  db: Database.Database,
  eventId: string,
  agent: string,
  sessionId: string,
  type: string,
  payload: Record<string, unknown>,
  at: Date,
): void {
  db.prepare(
    `INSERT INTO events(event_id, seq, agent, session_id, event_type, severity, safe_summary, payload_json, received_at, occurred_at)
     VALUES(?, ?, ?, ?, ?, 'low', 'x', ?, ?, ?)`,
  ).run(eventId, 0, agent, sessionId, type, JSON.stringify(payload), sqliteUtc(at), sqliteUtc(at));
}

function todayRow(db: Database.Database, agent = "claude_code"): Record<string, number> {
  const day = new Date().toISOString().slice(0, 10);
  return (db.prepare("SELECT * FROM behavior_daily WHERE day=? AND agent=?").get(day, agent) ?? {}) as Record<
    string,
    number
  >;
}

/* ---------------- 纯函数 ---------------- */

test("classifyChronotype：night_owl / early_bird / day / 空", () => {
  const hours = new Array(24).fill(0);
  hours[23] = 6;
  hours[0] = 2;
  hours[12] = 1;
  assert.equal(classifyChronotype(hours), "night_owl");

  const early = new Array(24).fill(0);
  early[6] = 5;
  early[7] = 4;
  early[15] = 1;
  assert.equal(classifyChronotype(early), "early_bird");

  const day = new Array(24).fill(0);
  day[12] = 5;
  day[16] = 4;
  assert.equal(classifyChronotype(day), "day");

  assert.equal(classifyChronotype(new Array(24).fill(0)), null);
});

test("classifyCadence：burst / steady / sparse / null", () => {
  assert.equal(classifyCadence(8, 2, 80), "burst"); // 4/天，平均 10 分钟
  assert.equal(classifyCadence(8, 2, 200), "steady"); // 4/天但平均 25 分钟
  assert.equal(classifyCadence(2, 4, 60), "steady"); // 0.5/天
  assert.equal(classifyCadence(1, 4, 30), "sparse"); // 0.25/天
  assert.equal(classifyCadence(0, 0, 0), null);
});

test("连续分：precision / context_hygiene / responsiveness / depth", () => {
  assert.equal(computePrecision(10, 2), 0); // 1 - 10/2/5 = 0
  assert.equal(computePrecision(0, 3), 1);
  assert.equal(computeContextHygiene(2, 4), 0.5);
  assert.equal(computeResponsiveness(900_000, 1), 0.5);
  assert.equal(computeResponsiveness(0, 0), 0.5); // 无样本 = 中性（缺失不能当满分）
  // depth: mean=45 → lengthFactor 1，hygiene 0.5，precision 0.5 → 0.5+0.15+0.1
  assert.equal(computeDepth(45, 0.5, 0.5), 0.75);
});

test("classifyOutcomeBias：shipper / explorer / 数据不足", () => {
  assert.equal(classifyOutcomeBias(6, 1, 1), "shipper"); // 6/8 = 0.75
  assert.equal(classifyOutcomeBias(1, 1, 2), "explorer"); // (1+2)/4 = 0.75
  assert.equal(classifyOutcomeBias(1, 1, 0), null); // total 2 < 3
});

test("topToolAffinity：按频率取前 5，同频按名称", () => {
  const counts = { Bash: 5, Edit: 3, Read: 2, Grep: 1, Write: 1, Glob: 1 };
  assert.deepEqual(topToolAffinity(counts, 5), ["Bash", "Edit", "Read", "Glob", "Grep"]);
});

test("decayWeight：半衰期 14 天，越老越轻", () => {
  assert.equal(decayWeight(0), 1);
  assert.equal(decayWeight(14), 0.5);
  assert.equal(decayWeight(28), 0.25);
  assert.ok(decayWeight(7) > decayWeight(21));
});

/* ---------------- handle 折叠 ---------------- */

test("agent_working 按 tool_name 分桶（Edit/Bash/Read/Glob/Grep）", () => {
  const db = makeDb();
  const engine = new HabitEngine(db);
  for (const tool_name of ["Bash", "Edit", "Read", "Glob", "Grep", "Write"]) {
    engine.handle(ev({ event_type: "agent_working", payload: { tool_name } }));
  }
  const row = todayRow(db);
  assert.equal(row.shells, 1);
  assert.equal(row.edits, 1);
  assert.equal(row.reads, 3);
});

test("agent_working 分桶大小写不敏感（pi 报小写 bash/edit/read）", () => {
  const db = makeDb();
  const engine = new HabitEngine(db);
  engine.handle(ev({ event_type: "agent_working", payload: { tool_name: "bash" } }));
  engine.handle(ev({ event_type: "agent_working", payload: { tool_name: "edit" } }));
  engine.handle(ev({ event_type: "agent_working", payload: { tool_name: "read" } }));
  const row = todayRow(db);
  assert.equal(row.shells, 1);
  assert.equal(row.edits, 1);
  assert.equal(row.reads, 1);
});

test("context_update 只有 >85% 才计入 context_85", () => {
  const db = makeDb();
  const engine = new HabitEngine(db);
  engine.handle(ev({ event_type: "context_update", payload: { context_pct: 90 } }));
  engine.handle(ev({ event_type: "context_update", payload: { context_pct: 50 } }));
  assert.equal(todayRow(db).context_85, 1);
});

test("session_error / topic_drift_warning 计入 errors", () => {
  const db = makeDb();
  const engine = new HabitEngine(db);
  engine.handle(ev({ event_type: "session_error", payload: {} }));
  engine.handle(ev({ event_type: "topic_drift_warning", payload: {} }));
  assert.equal(todayRow(db).errors, 2);
});

test("阻塞等待：decision_required(question) → agent_working 结算 wait_count", () => {
  const db = makeDb();
  const engine = new HabitEngine(db);
  engine.handle(ev({ event_type: "decision_required", payload: { kind: "question" } }));
  engine.handle(ev({ event_type: "agent_working", payload: { tool_name: "Bash" } }));
  const row = todayRow(db);
  assert.equal(row.wait_count, 1);
  assert.ok((row.wait_ms ?? 0) >= 0);
});

test("非阻塞 decision_required(kind=Stop) 不产生等待", () => {
  const db = makeDb();
  const engine = new HabitEngine(db);
  engine.handle(ev({ event_type: "decision_required", payload: { kind: "Stop" } }));
  engine.handle(ev({ event_type: "agent_working", payload: { tool_name: "Bash" } }));
  assert.equal(todayRow(db).wait_count ?? 0, 0);
});

/* ---------------- cold start ---------------- */

test("冷启动：数据不足时 ready=false 且标签为 null", () => {
  const db = makeDb();
  const engine = new HabitEngine(db);
  const p = engine.getProfile();
  assert.equal(p.ready, false);
  assert.equal(p.chronotype, null);
  assert.equal(p.cadence, null);
  assert.equal(p.outcome_bias, null);
  assert.deepEqual(p.tool_affinity, []);
});

test("habit_enabled=0 时停止折叠，getProfile 返回中立", () => {
  const db = makeDb();
  db.prepare("INSERT INTO settings(key, value) VALUES('habit_enabled', '0')").run();
  const engine = new HabitEngine(db);
  engine.handle(ev({ event_type: "agent_working", payload: { tool_name: "Bash" } }));
  assert.equal(todayRow(db).shells ?? 0, 0, "关闭后不该再折叠事件");
  const p = engine.getProfile();
  assert.equal(p.ready, false);
  assert.equal(p.chronotype, null);
});

/* ---------------- recompute（衰减聚合） ---------------- */

test("recompute：合成 night_owl + burst + shipper 流", () => {
  const db = makeDb();
  // 1) 夜里活动的事件（chronotype 读 occurred_at 的**本地**小时直方图，与 wakeWindow 同口径）
  const now = new Date();
  const mk = (daysAgo: number, hour: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() - daysAgo);
    d.setHours(hour, 0, 0, 0);
    return d;
  };
  for (const [daysAgo, hour] of [[0, 23], [0, 0], [1, 23], [1, 0], [1, 1], [2, 22], [2, 12]] as const) {
    insertEvent(db, `night-${daysAgo}-${hour}`, "claude_code", "night-s", "agent_working", { tool_name: "Bash" }, mk(daysAgo, hour));
  }

  // 2) 两个活跃日、每天 4 个短 session、全 success → burst + shipper + ready
  const today = now.toISOString().slice(0, 10);
  const yesterday = new Date(now);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const yday = yesterday.toISOString().slice(0, 10);
  const insertDay = (day: string) =>
    db.prepare(
      `INSERT INTO behavior_daily(day, agent, sessions, active_min, success)
       VALUES(?, 'claude_code', 4, 40, 4)`,
    ).run(day);
  insertDay(today);
  insertDay(yday);

  const engine = new HabitEngine(db);
  engine.recompute();
  const p = engine.getProfile();

  assert.equal(p.ready, true);
  assert.equal(p.chronotype, "night_owl");
  assert.equal(p.cadence, "burst");
  assert.equal(p.outcome_bias, "shipper");
  assert.ok(p.tool_affinity.includes("bash"), "tool_affinity 应小写归一");
});

/* ---------------- backfill ---------------- */

test("backfill：从 events + sessions 回填，且幂等", () => {
  const db = makeDb();
  const now = new Date();
  const seedSession = (id: string, daysAgo: number, hour: number) => {
    const start = new Date(now);
    start.setUTCDate(start.getUTCDate() - daysAgo);
    start.setUTCHours(hour, 0, 0, 0);
    const end = new Date(start.getTime() + 10 * 60_000); // 10 分钟
    db.prepare(
      `INSERT INTO sessions(agent, agent_session_id, project_id, started_at, finished_at, token_used, correction_count, is_active, outcome)
       VALUES('claude_code', ?, '/Users/x/app', ?, ?, 10000, 0, 0, 'success')`,
    ).run(id, start.toISOString(), end.toISOString());
    insertEvent(db, `${id}-start`, "claude_code", id, "session_started", {}, start);
    insertEvent(db, `${id}-edit`, "claude_code", id, "agent_working", { tool_name: "Edit" }, start);
    insertEvent(db, `${id}-finish`, "claude_code", id, "session_finished", { outcome: "success" }, end);
  };

  for (let i = 0; i < 3; i++) seedSession(`s-a-${i}`, 0, 23);
  for (let i = 0; i < 3; i++) seedSession(`s-b-${i}`, 1, 23);

  const engine = new HabitEngine(db); // 构造即 backfill
  const before = (db.prepare("SELECT COUNT(*) AS c FROM behavior_daily").get() as { c: number }).c;
  assert.ok(before >= 2, "backfill 应产出至少两个活跃日的 rollup");

  engine.backfill(); // 幂等：不该再翻倍
  const after = (db.prepare("SELECT COUNT(*) AS c FROM behavior_daily").get() as { c: number }).c;
  assert.equal(after, before);
});
