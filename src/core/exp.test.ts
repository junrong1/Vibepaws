/**
 * EXP 引擎单测：公式纯函数 + token EXP/daily cap/升级/exp_logs。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema.ts";
import { seedPetTypes } from "../db/seed.ts";
import { ExpEngine, contextMultiplier, topicMultiplier, outcomeBonus, levelExpRequired } from "./exp.ts";
import type { CoreEvent } from "./events.ts";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  seedPetTypes(db);
  return db;
}

function ev(partial: Partial<CoreEvent>): CoreEvent {
  return {
    event_id: partial.event_id ?? `e-${Math.random().toString(36).slice(2)}`,
    seq: 0,
    agent: "claude_code",
    session_id: "s1",
    project_id: "/Users/x/my-app",
    event_type: "token_update",
    severity: "low",
    safe_summary: "x",
    timestamp: new Date().toISOString(),
    payload: {},
    ...partial,
  };
}

test("纯函数：contextMultiplier 阈值", () => {
  assert.equal(contextMultiplier(0), 1.0); // 未知中性
  assert.equal(contextMultiplier(50), 1.1);
  assert.equal(contextMultiplier(70), 1.0);
  assert.equal(contextMultiplier(85), 1.0); // 70–85 → 1.0
  assert.equal(contextMultiplier(86), 0.75);
  assert.equal(contextMultiplier(96), 0.5);
});

test("纯函数：topicMultiplier（correction loop 0.8 / goal 1.1）", () => {
  assert.equal(topicMultiplier(5, false), 0.8);
  assert.equal(topicMultiplier(3, true), 1.1);
  assert.equal(topicMultiplier(2, false), 1.0);
});

test("纯函数：outcomeBonus", () => {
  assert.equal(outcomeBonus("success"), 20);
  assert.equal(outcomeBonus("partial"), 5);
  assert.equal(outcomeBonus("abandoned"), 0);
});

test("token EXP：1000 tokens=1 EXP × context 1.0 × topic 1.0", () => {
  const db = makeDb();
  const exp = new ExpEngine(db);
  db.prepare("INSERT INTO sessions(agent, agent_session_id, project_id) VALUES('claude_code','s1','/Users/x/my-app')").run();
  exp.handle(ev({ payload: { tokens: 10000 } }));
  const pet = exp.getPetSnapshot();
  assert.equal(pet.exp, 10, `expected 10 EXP for 10k tokens, got ${pet.exp}`);
});

test("token EXP 受 context 倍率影响（88% → 0.75）", () => {
  const db = makeDb();
  const exp = new ExpEngine(db);
  db.prepare("INSERT INTO sessions(agent, agent_session_id, project_id, context_pct) VALUES('claude_code','s1','/Users/x/my-app', 88)").run();
  exp.handle(ev({ payload: { tokens: 10000 } }));
  const pet = exp.getPetSnapshot();
  assert.equal(pet.exp, 7.5, `10 × 0.75 = 7.5, got ${pet.exp}`);
});

test("correction loop 倍率 0.8", () => {
  const db = makeDb();
  const exp = new ExpEngine(db);
  db.prepare("INSERT INTO sessions(agent, agent_session_id, project_id, correction_count) VALUES('claude_code','s1','/Users/x/my-app', 6)").run();
  exp.handle(ev({ payload: { tokens: 10000 } }));
  assert.equal(exp.getPetSnapshot().exp, 8); // 10 × 0.8
});

test("outcome bonus +20", () => {
  const db = makeDb();
  const exp = new ExpEngine(db);
  db.prepare("INSERT INTO sessions(agent, agent_session_id, project_id) VALUES('claude_code','s1','/Users/x/my-app')").run();
  exp.handle(ev({ event_type: "session_finished", payload: { reason: "completion", outcome: "success" } }));
  assert.equal(exp.getPetSnapshot().exp, 20);
});

test("升级：100 EXP → Lv2", () => {
  const db = makeDb();
  const exp = new ExpEngine(db);
  db.prepare("INSERT INTO sessions(agent, agent_session_id, project_id) VALUES('claude_code','s1','/Users/x/my-app')").run();
  exp.handle(ev({ payload: { tokens: 100000 } })); // 100 EXP
  const pet = exp.getPetSnapshot();
  assert.equal(pet.level, 2, `expected Lv2, got Lv${pet.level}`);
  assert.equal(levelExpRequired(1), 100);
});

test("daily cap：token EXP 不超过 200/天", () => {
  const db = makeDb();
  const exp = new ExpEngine(db);
  db.prepare("INSERT INTO sessions(agent, agent_session_id, project_id) VALUES('claude_code','s1','/Users/x/my-app')").run();
  exp.handle(ev({ payload: { tokens: 500000 } })); // 500 EXP 意图
  const pet = exp.getPetSnapshot();
  assert.ok(pet.daily_exp <= 200, `daily cap 200, got ${pet.daily_exp}`);
  assert.ok(pet.daily_exp >= 150);
});

test("exp_logs 有明细（category/amount/note）", () => {
  const db = makeDb();
  const exp = new ExpEngine(db);
  db.prepare("INSERT INTO sessions(agent, agent_session_id, project_id) VALUES('claude_code','s1','/Users/x/my-app')").run();
  exp.handle(ev({ payload: { tokens: 5000 } }));
  const logs = exp.expLogs();
  assert.ok(logs.length >= 1);
  const tokenLog = logs.find((l) => l.category === "token") as { amount: number; note: string };
  assert.ok(tokenLog);
  assert.equal(tokenLog.amount, 5);
  assert.match(tokenLog.note, /ctx=1/);
});
