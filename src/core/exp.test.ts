/**
 * EXP 引擎单测：公式纯函数 + token EXP/daily cap/升级/exp_logs。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema.ts";
import { seedPetTypes } from "../db/seed.ts";
import { ExpEngine, contextMultiplier, topicMultiplier, outcomeBonus, levelExpRequired, rarityWeight } from "./exp.ts";
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

test("token EXP 只按增量结算（累计值不该被重复计费）", () => {
  const db = makeDb();
  const exp = new ExpEngine(db);
  db.prepare("INSERT INTO sessions(agent, agent_session_id, project_id) VALUES('claude_code','s1','/Users/x/my-app')").run();
  exp.handle(ev({ payload: { tokens: 30000 } }));
  exp.handle(ev({ payload: { tokens: 60000 } })); // adapter 报的是累计值
  const pet = exp.getPetSnapshot();
  assert.equal(pet.exp, 60, `60k tokens 只该给 60 EXP，实际 ${pet.exp}（旧实现给 90）`);
});

test("token 计数器倒退（clear 后重新累计）不会漏发也不会重发", () => {
  const db = makeDb();
  const exp = new ExpEngine(db);
  db.prepare("INSERT INTO sessions(agent, agent_session_id, project_id) VALUES('claude_code','s1','/Users/x/my-app')").run();
  exp.handle(ev({ payload: { tokens: 20000 } }));
  db.prepare("UPDATE sessions SET token_used=0, token_exp_granted=0").run(); // registry 的 clear 分支
  exp.handle(ev({ payload: { tokens: 5000 } }));
  assert.equal(exp.getPetSnapshot().exp, 25);
});

test("一次大额 EXP 能连跳多级，余量不会卡在原地", () => {
  const db = makeDb();
  const exp = new ExpEngine(db);
  db.prepare("INSERT INTO sessions(agent, agent_session_id, project_id) VALUES('claude_code','s1','/Users/x/my-app')").run();
  db.prepare("UPDATE settings SET value='1000' WHERE key='daily_exp_cap'").run();
  db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES('daily_exp_cap','1000')").run();
  exp.handle(ev({ payload: { tokens: 300000 } })); // 300 EXP → Lv1(100) + Lv2(150) = 250，余 50
  const pet = exp.getPetSnapshot();
  assert.equal(pet.level, 3, `expected Lv3, got Lv${pet.level}`);
  assert.equal(pet.exp, 50);
});

test("用户给宠物起的名字优先于物种名", () => {
  const db = makeDb();
  const exp = new ExpEngine(db);
  db.prepare("UPDATE pets SET name='Mochi'").run();
  assert.equal(exp.getPetSnapshot().name, "Mochi");
});

/* ---------------- starter 抽取（稀有度加权） ---------------- */

test("稀有度权重：越稀有越低", () => {
  assert.ok(rarityWeight("common") > rarityWeight("uncommon"));
  assert.ok(rarityWeight("uncommon") > rarityWeight("rare"));
  assert.equal(rarityWeight("legendary"), rarityWeight("rare"));
  assert.equal(rarityWeight("没见过的稀有度"), 1); // 未知值不该抽到 0 概率
});

test("首次启动只会分配到可抽的宠物，且 common 明显更常见", () => {
  const db = makeDb();
  const starters = db
    .prepare("SELECT id, rarity FROM pet_types WHERE starter=1")
    .all() as Array<{ id: number; rarity: string }>;
  assert.ok(starters.length > 0, "starter 池是空的");
  const rarityOf = new Map(starters.map((r) => [r.id, r.rarity]));

  const counts = new Map<number, number>();
  for (let i = 0; i < 600; i++) {
    // ensurePet 只在 pets 为空时才抽 —— 清掉就能再抽一次，不必每轮重建库
    db.exec("DELETE FROM pets");
    new ExpEngine(db);
    const row = db.prepare("SELECT pet_type_id FROM pets").get() as { pet_type_id: number };
    assert.ok(rarityOf.has(row.pet_type_id),
      `抽到了不可抽的 pet_type ${row.pet_type_id}`);
    counts.set(row.pet_type_id, (counts.get(row.pet_type_id) ?? 0) + 1);
  }

  const byRarity = (want: string) =>
    [...counts.entries()].filter(([id]) => rarityOf.get(id) === want)
      .reduce((sum, [, n]) => sum + n, 0);
  // 权重是 common 6 / uncommon 3 / rare 1：600 次里 common 约 380、rare 约 30。
  // 断言留足余量，不让它变成偶发失败的测试。
  assert.ok(byRarity("common") > byRarity("rare") * 2,
    `加权没生效：common=${byRarity("common")} rare=${byRarity("rare")}`);
});
