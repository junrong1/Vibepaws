/**
 * EXP 引擎单测：公式纯函数 + token EXP/daily cap/升级/exp_logs。
 */
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema.ts";
import { seedPetTypes } from "../db/seed.ts";
import {
  ExpEngine,
  contextMultiplier,
  topicMultiplier,
  outcomeBonus,
  levelExpRequired,
  rarityWeight,
  TIRED_HEALTH_THRESHOLD,
  levelCurve,
  expSourceBreakdown,
  evolutionStatus,
  levelUps,
  growthView,
} from "./exp.ts";
import { recordFinish } from "./journal.ts";
import type { CoreEvent } from "./events.ts";

/** 「今天」的段贴着「现在」造：把时钟钉在今天本地正午，午夜刚过跑也不会把段挤到昨天 */
function atLocalNoon(t: TestContext): void {
  const noon = new Date();
  noon.setHours(12, 0, 0, 0);
  // 正午还没到就钉昨天正午：events.received_at 走 SQLite 的真时钟，被钉的时间不能跑到它前面
  if (noon.getTime() > Date.now()) noon.setDate(noon.getDate() - 1);
  t.mock.timers.enable({ apis: ["Date"], now: noon.getTime() });
}

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

test("Embercub 在健康使用下沿真实素材家族进化", () => {
  const db = makeDb();
  const exp = new ExpEngine(db);
  db.prepare("INSERT INTO sessions(agent, agent_session_id, project_id) VALUES('claude_code','s1','/Users/x/my-app')").run();
  db.prepare("UPDATE pets SET pet_type_id=20, level=4, exp=249").run();

  exp.handle(ev({ payload: { tokens: 1000 } }));
  assert.equal(exp.getPetSnapshot().pet_type_id, 30, "Lv5 应切换到 Cinderclaw 素材");
  assert.equal(exp.getPetSnapshot().species, "Cinderclaw");

  db.prepare("UPDATE pets SET level=9, exp=499").run();
  exp.handle(ev({ payload: { tokens: 2000 } }));
  assert.equal(exp.getPetSnapshot().pet_type_id, 31, "Lv10 应切换到 Infernomane 素材");
  assert.equal(exp.getPetSnapshot().species, "Infernomane");
});

test("一次跨过多段门槛会追上 Embercub 的最终进化形态", () => {
  const db = makeDb();
  const exp = new ExpEngine(db);
  db.prepare("INSERT INTO sessions(agent, agent_session_id, project_id) VALUES('claude_code','s1','/Users/x/my-app')").run();
  db.prepare("UPDATE settings SET value='3000' WHERE key='daily_exp_cap'").run();
  db.prepare("INSERT OR IGNORE INTO settings(key, value) VALUES('daily_exp_cap','3000')").run();
  db.prepare("UPDATE pets SET pet_type_id=20, level=4, exp=249").run();

  exp.handle(ev({ payload: { tokens: 2_001_000 } }));
  const pet = exp.getPetSnapshot();
  assert.equal(pet.level, 10);
  assert.equal(pet.pet_type_id, 31, "Lv10 的 Embercub 应一次追上 Infernomane");
  assert.equal(pet.species, "Infernomane");
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

/* ---------------- 健康分 = 今天的 Session Health（U3 / R11 / R31） ---------------- */

/** 往 sessions 里放一段已结算的段（本段列直接写，不走 registry） */
function settledSegment(
  db: Database.Database,
  id: string,
  seg: { endMsAgo: number; durationMs: number; peak: number; edits: number; outcome: string },
  opts: { journal?: boolean } = {},
): void {
  const end = new Date(Date.now() - seg.endMsAgo);
  const start = new Date(end.getTime() - seg.durationMs).toISOString();
  db.prepare(
    `INSERT INTO sessions(agent, agent_session_id, project_id, is_active, segment_started_at, finished_at, outcome,
       context_peak, context_reported_at, repeat_edit_count)
     VALUES('claude_code', ?, '/p', 0, ?, ?, ?, ?, ?, ?)`,
  ).run(id, start, end.toISOString(), seg.outcome, seg.peak, start, seg.edits);
  // 健康读的是日志行（U12）：收工那一刻 server 的事件链会记一笔，这里照做
  if (opts.journal ?? true) recordFinish(db, "claude_code", id);
}

function selfGrowthLogs(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM exp_logs WHERE category='self'").get() as { c: number }).c;
}

/** 让自成长的计时器看起来已经过了一小时（它是私有字段；只有测试这么做） */
function anHourPassed(exp: ExpEngine): void {
  (exp as unknown as { lastGrowthAt: number }).lastGrowthAt = Date.now() - 3_600_000;
}

test("今天一段都没结算 = 不知道：读作 1.0，自成长照常 —— 不知道不是生病", () => {
  const db = makeDb();
  const exp = new ExpEngine(db);
  assert.equal(exp.getPetSnapshot().health_score, 1);
  anHourPassed(exp);
  exp.handle(ev({ event_type: "agent_working", payload: {} }));
  assert.equal(selfGrowthLogs(db), 1);
});

test("升级后的第一个早上：昨天打得再差，今天还没收工就是「不知道」，不是失败的一天", (t) => {
  atLocalNoon(t);
  const db = makeDb();
  const exp = new ExpEngine(db);
  // 昨天（本地午夜之前）的一段极差的 session
  const sinceMidnight = Date.now() - new Date(new Date().setHours(0, 0, 0, 0)).getTime();
  settledSegment(db, "yesterday", { endMsAgo: sinceMidnight + 60 * 60_000, durationMs: 3 * 3_600_000, peak: 99, edits: 9, outcome: "abandoned" });
  assert.equal(exp.getPetSnapshot().health_score, 1);
  anHourPassed(exp);
  exp.handle(ev({ event_type: "agent_working", payload: {} }));
  assert.equal(selfGrowthLogs(db), 1);
});

test("今天打得很差：健康分掉到 0.7 以下，自成长暂停，pets.health_score 跟着写回", (t) => {
  atLocalNoon(t);
  const db = makeDb();
  const exp = new ExpEngine(db);
  settledSegment(db, "bad", { endMsAgo: 60_000, durationMs: 60_000, peak: 98, edits: 7, outcome: "abandoned" });
  const pet = exp.getPetSnapshot();
  assert.ok(pet.health_score < TIRED_HEALTH_THRESHOLD, `health=${pet.health_score}`);
  const stored = (db.prepare("SELECT health_score FROM pets").get() as { health_score: number }).health_score;
  assert.equal(stored, pet.health_score);
  anHourPassed(exp);
  exp.handle(ev({ event_type: "agent_working", payload: {} }));
  assert.equal(selfGrowthLogs(db), 0);
});

test("Response 不喂宠物：一段等了半小时才答、其余都好的 session，宠物照样满格", (t) => {
  atLocalNoon(t);
  const db = makeDb();
  const exp = new ExpEngine(db);
  // 等待要在「收工」之前就在账本里，日志行才带得上它 —— 所以先不记，插完等待再记
  settledSegment(db, "slow", { endMsAgo: 60_000, durationMs: 2 * 3_600_000, peak: 50, edits: 0, outcome: "success" }, { journal: false });
  const start = new Date(Date.now() - 2 * 3_600_000).toISOString();
  db.prepare(
    `INSERT INTO needs_input_waits(agent, session_id, segment, kind, started_at, received_at, cleared_at, resolution)
     VALUES('claude_code', 'slow', 1, 'permission', ?, ?, ?, 'inferred')`,
  ).run(start, start, new Date(Date.parse(start) + 40 * 60_000).toISOString());
  const entry = recordFinish(db, "claude_code", "slow")!;
  assert.equal(entry.factors!.response, 7, "Response 确实打得很低（40 分钟 → 7）");
  assert.equal(exp.getPetSnapshot().health_score, 1);
});

test("进化把满足门槛的健康分写进 pets.health_score（原来写死 1.0）", (t) => {
  atLocalNoon(t);
  const db = makeDb();
  const exp = new ExpEngine(db);
  db.prepare("INSERT INTO sessions(agent, agent_session_id, project_id) VALUES('claude_code','s1','/Users/x/my-app')").run();
  // 今天一段中等偏下的：峰值 90、重复编辑 3、partial → (12 + 14 + 12) / 75 = 50.7 → 映射后 0.85
  settledSegment(db, "meh", { endMsAgo: 60_000, durationMs: 60_000, peak: 90, edits: 3, outcome: "partial" });
  db.prepare("UPDATE pets SET pet_type_id=20, level=4, exp=249").run();
  exp.handle(ev({ payload: { tokens: 1000 } }));
  const row = db.prepare("SELECT pet_type_id, health_score FROM pets").get() as { pet_type_id: number; health_score: number };
  assert.equal(row.pet_type_id, 30, "0.85 ≥ 0.7：照样进化");
  assert.equal(row.health_score, 0.85);
});

/* ================= Growth（U13）：曲线、这周的来源、下一次进化 ================= */

test("等级曲线：就是 levelExpRequired；新宠物也画到 Lv10，老宠物画到当前 +5；total 是累计", () => {
  const fresh = levelCurve(1);
  assert.equal(fresh.length, 10);
  assert.deepEqual(fresh.slice(0, 3), [
    { level: 1, required: 100, total: 100 },
    { level: 2, required: 150, total: 250 },
    { level: 3, required: 200, total: 450 },
  ]);
  const old = levelCurve(12);
  assert.equal(old.at(-1)!.level, 17);
  for (const p of old) assert.equal(p.required, levelExpRequired(p.level));
  assert.equal(levelCurve(Number.NaN).length, 10, "认不出的等级按 Lv1 画，不抛");
});

test("这周的 EXP 来源：按本地日分桶、每天都列、level 标记与范围外的行不算", () => {
  const now = new Date(2026, 8, 29, 12, 0, 0); // 本地 9/29 中午
  const utc = (d: Date): string => d.toISOString().slice(0, 19).replace("T", " "); // SQLite datetime('now') 的写法
  const rows = [
    { amount: 12.5, category: "token", created_at: utc(new Date(2026, 8, 29, 9, 0)) },
    { amount: 20, category: "outcome", created_at: utc(new Date(2026, 8, 29, 10, 0)) },
    // 23:50 的一笔落在用户过的那一天（9/28），不是 UTC 的那一天
    { amount: 5, category: "care", created_at: utc(new Date(2026, 8, 28, 23, 50)) },
    { amount: 0.1, category: "self", created_at: utc(new Date(2026, 8, 27, 3, 0)) },
    { amount: 0, category: "level", created_at: utc(new Date(2026, 8, 29, 10, 0)) },
    { amount: 99, category: "token", created_at: utc(new Date(2026, 8, 20, 10, 0)) }, // 范围外
    { amount: 7, category: "mystery", created_at: utc(new Date(2026, 8, 29, 10, 0)) },
  ];
  const week = expSourceBreakdown(rows, { now, days: 7 });
  assert.equal(week.daily.length, 7);
  assert.equal(week.daily.at(-1)!.day, "2026-09-29");
  assert.equal(week.daily[0]!.day, "2026-09-23");
  assert.deepEqual(week.sources, { token: 12.5, outcome: 20, care: 5, self: 0.1 });
  assert.equal(week.total, 37.6);
  assert.equal(week.daily.find((d) => d.day === "2026-09-28")!.sources.care, 5);
  assert.equal(week.daily.find((d) => d.day === "2026-09-29")!.total, 32.5);
  assert.equal(expSourceBreakdown([], { now }).total, 0, "一笔都没有 = 0，不是 NaN");
});

test("下一次进化：等级没到 / 健康没过 / 都满足（下一次升级时）/ 最终形态", () => {
  const meta = [{ from_level: 5, conditions: ["health>=0.7"], to_stage: "30" }];
  const names = (id: number): string | null => (id === 30 ? "Cinderclaw" : null);
  const lvl = evolutionStatus(meta, 3, 1, names);
  assert.equal(lvl.state, "level");
  assert.ok(lvl.from_level === 5 && lvl.to_form === "Cinderclaw" && lvl.health_gate === 0.7);
  assert.equal(evolutionStatus(meta, 5, 0.6, names).state, "health");
  assert.equal(evolutionStatus(meta, 5, 0.7, names).state, "ready", "门槛是 ≥，和引擎一样");
  assert.equal(evolutionStatus(meta, 5, null, names).state, "ready", "今天还不知道 = 读作健康（R31），不挡进化");
  assert.equal(evolutionStatus([], 5, 1).state, "final");
  assert.equal(
    evolutionStatus([{ from_level: 5, conditions: ["mood>=1"], to_stage: "30" }], 9, 1).state,
    "final",
    "引擎只认带 health>=0.7 的规则 —— 这里说的必须和它做的一样",
  );
});

test("升级记录：从 level 标记里读出等级与时刻，从新到旧", () => {
  const ups = levelUps([
    { note: "level up to 2", created_at: "2026-09-27 10:00:00" },
    { note: "level up to 3", created_at: "2026-09-28 10:00:00" },
    { note: "garbage", created_at: "2026-09-28 11:00:00" },
  ]);
  assert.deepEqual(ups, [
    { level: 3, at: "2026-09-28T10:00:00.000Z" },
    { level: 2, at: "2026-09-27T10:00:00.000Z" },
  ]);
});

test("growthView：新宠物 = 空的一周、没有升级记录、第一条进化门槛；真的升过级之后都有了", () => {
  const db = makeDb();
  const exp = new ExpEngine(db);
  db.prepare("UPDATE pets SET pet_type_id=20, level=1, exp=0").run();
  const first = growthView(db, exp.getPetSnapshot());
  assert.equal(first.week.total, 0);
  assert.equal(first.level_ups.length, 0);
  assert.equal(first.pet.health, null, "今天还没有结算过的段");
  assert.equal(first.evolution.state, "level");
  assert.ok(first.evolution.to_form === "Cinderclaw");

  db.prepare("INSERT INTO sessions(agent, agent_session_id, project_id) VALUES('claude_code','s1','/Users/x/my-app')").run();
  exp.handle(ev({ payload: { tokens: 150_000 } })); // 150 EXP → Lv2
  const after = growthView(db, exp.getPetSnapshot());
  assert.equal(after.pet.level, 2);
  assert.ok(after.week.sources.token > 0);
  assert.equal(after.level_ups[0]!.level, 2);
  assert.ok(!JSON.stringify(after).includes("/Users/"), "Growth 里没有项目路径");
});
