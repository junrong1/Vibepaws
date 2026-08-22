/**
 * 本地数据重置单测（PRD 发布标准「用户可以删除本地宠物数据」）。
 *
 * 三件事必须成立，否则「删除」只是看起来删了：
 *   1. 两个 scope 的边界 —— 「换宠物」不该顺手清掉 session 与设置；
 *   2. api_token 活下来 —— 它一起没了的话，正在跑的 hook 会在下一次请求上 401，
 *      而用户刚才点的是「删除数据」，不是「把采集通道弄坏」；
 *   3. 删完还能继续用 —— 新宠物滚得出来，新事件进得去（外键、内存状态都没留后遗症）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../db/schema.ts";
import { seedPetTypes } from "../db/seed.ts";
import { VibepawsServer } from "./server.ts";
import { dataFootprint, resetLocalData } from "./reset.ts";
import { getSetting } from "./settings.ts";
import type { CoreEvent } from "./events.ts";

let seq = 0;
function ev(partial: Partial<CoreEvent> = {}): CoreEvent {
  seq += 1;
  return {
    event_id: `reset-${seq}`,
    seq,
    agent: "claude_code",
    session_id: "s1",
    project_id: "/Users/x/my-app",
    event_type: "session_started",
    severity: "low",
    safe_summary: "x",
    timestamp: new Date().toISOString(),
    payload: {},
    ...partial,
  };
}

/** 一台「用过一段时间」的机器：session、事件、通知、EXP 流水、设置都有内容 */
function usedServer(): VibepawsServer {
  const db = new Database(":memory:");
  applySchema(db);
  seedPetTypes(db);
  const server = new VibepawsServer({ db });
  server.handleEvent(ev({ payload: { source: "startup", cwd: "/Users/x/my-app" } }));
  server.handleEvent(ev({ event_type: "token_update", payload: { tokens: 40_000 } }));
  server.handleEvent(ev({ event_type: "decision_required", payload: { kind: "question" } }));
  server.handleEvent(ev({ event_type: "adapter_status", session_id: "adapter-claude_code", payload: { adapter_version: "0.1.0" } }));
  server.db.prepare("INSERT INTO settings(key, value) VALUES('budget_tokens', '200000')").run();
  return server;
}

test("足迹：按钮旁边说得出「会删掉多少东西」", () => {
  const server = usedServer();
  const footprint = dataFootprint(server.db);
  assert.ok(footprint.events > 0);
  assert.equal(footprint.sessions, 1);
  assert.ok(footprint.notifications > 0);
  assert.equal(footprint.agents, 1);
});

test("scope=pet：换一只新宠物，session / 事件 / 设置全都留着", () => {
  const server = usedServer();
  const before = server.stateSnapshot();
  assert.ok(before.pet.exp > 0, "先得真的有进度可清");

  server.resetLocalData("pet");

  const after = server.stateSnapshot();
  assert.equal(after.pet.level, 1);
  assert.equal(after.pet.exp, 0);
  assert.equal(after.sessions.length, 1, "session 列表属于「现在在跑什么」，不该被换宠物波及");
  assert.equal(getSetting(server.db, "budget_tokens"), "200000", "预算是用户的设置，不是宠物的历史");
  assert.equal((server.db.prepare("SELECT COUNT(*) c FROM exp_logs").get() as { c: number }).c, 0);
});

test("scope=data：回到首次启动的样子（连 session / 事件 / 设置一起）", () => {
  const server = usedServer();
  server.resetLocalData("data");

  const footprint = dataFootprint(server.db);
  assert.deepEqual(
    { ...footprint, db_bytes: null },
    { events: 0, sessions: 0, notifications: 0, exp_logs: 0, memories: 0, agents: 0, db_bytes: null },
  );
  assert.equal(getSetting(server.db, "budget_tokens"), null, "预算与阈值一起清掉 —— 这是「全部数据」");
  const snap = server.stateSnapshot();
  assert.equal(snap.sessions.length, 0);
  assert.deepEqual(snap.adapters, []);
  assert.equal(snap.pet.level, 1);
  assert.ok(snap.pet.pet_type_id > 0, "宠物要当场滚出来，而不是等下一次快照兜底");
});

test("api_token 活下来 —— 删数据不该顺手把采集通道弄坏", () => {
  const server = usedServer();
  const token = server.token;
  server.resetLocalData("data");
  assert.equal(getSetting(server.db, "api_token"), token);
  assert.equal(server.token, token, "正在跑的 hook 拿着的还是这一个 token");
});

test("删完还能继续用：新事件进得去，宠物照样长（外键与内存状态都没留后遗症）", () => {
  const server = usedServer();
  server.resetLocalData("data");

  const r = server.handleEvent(ev({ session_id: "fresh", payload: { source: "startup" } }));
  assert.equal(r.ok, true);
  server.handleEvent(ev({ session_id: "fresh", event_type: "token_update", payload: { tokens: 10_000 } }));
  const snap = server.stateSnapshot();
  assert.equal(snap.sessions.length, 1);
  assert.ok(snap.pet.exp > 0, "重置后的第一份 EXP 必须结算得出来");
});

test("父子 session 也删得掉（sessions 自引用，整表删除会撞外键）", () => {
  const server = usedServer();
  server.handleEvent(
    ev({ session_id: "child", payload: { source: "fork", parent_session_id: "s1" } }),
  );
  const parented = server.db.prepare("SELECT COUNT(*) c FROM sessions WHERE parent_id IS NOT NULL").get() as { c: number };
  assert.equal(parented.c, 1, "先得真的有一条带 parent_id 的行");
  server.resetLocalData("data");
  assert.equal((server.db.prepare("SELECT COUNT(*) c FROM sessions").get() as { c: number }).c, 0);
});

test("pet_types 是种子数据，不是用户数据 —— 清空后还得能抽宠物", () => {
  const server = usedServer();
  resetLocalData(server.db, "data");
  const types = server.db.prepare("SELECT COUNT(*) c FROM pet_types").get() as { c: number };
  assert.ok(types.c > 0);
});

test("通知引擎的去重窗口被一起清掉（否则重置后第一条通知会被当成复读吞掉）", () => {
  const server = usedServer();
  const decision = (): CoreEvent => ev({ session_id: "dedup-s", event_type: "decision_required", payload: {} });
  assert.ok(server.notifications.getForEvent(decision()), "第一条要出得来");
  assert.equal(server.notifications.getForEvent(decision()), null, "紧接着的同类通知本该被去重窗口吃掉");

  server.resetLocalData("data");
  // notifications 表已经空了，内存里那份「这条报过了」却还在 —— 不清的话，
  // 重置之后的第一批通知会静静消失，而用户以为自己刚刚回到了出厂状态
  assert.ok(server.notifications.getForEvent(decision()), "重置之后必须能再出一次");
});

/**
 * 磁盘真的被释放了 —— 只能在**文件**库上验证：内存库没有 WAL，而 WAL 恰好是
 * 这条最容易错的地方。第一版这里只有一句 VACUUM，它返回成功、`vacuumed: true`，
 * 而主库与 -wal 一个字节都没少（重建结果全写进了 WAL）：删掉的 session 标题
 * 原文仍然躺在文件里，界面却已经说「删完了」。
 */
test("scope=data：主库与 WAL 一起缩小（VACUUM 之后必须 checkpoint）", () => {
  const dir = mkdtempSync(join(tmpdir(), "vibepaws-vacuum-"));
  const path = join(dir, "vibepaws.db");
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  applySchema(db);
  seedPetTypes(db);

  // 塞到明显超过页大小：每行带 1KB padding，5000 行 ≈ 5MB
  const insert = db.prepare(
    "INSERT INTO events(event_id, agent, session_id, event_type, safe_summary, payload_json) VALUES(?,?,?,?,?,?)",
  );
  db.transaction(() => {
    for (let i = 0; i < 5000; i++) insert.run(`e-${i}`, "claude_code", "s1", "agent_working", "x", "y".repeat(1024));
  })();
  const onDisk = (): number => statSync(path).size + (existsSync(`${path}-wal`) ? statSync(`${path}-wal`).size : 0);
  const before = onDisk();
  assert.ok(before > 3_000_000, `先得真的把文件撑起来（现在 ${before} 字节）`);

  const result = resetLocalData(db, "data");
  assert.equal(result.vacuumed, true);
  const after = onDisk();
  assert.ok(after < before / 10, `占用必须真的降下来：${before} → ${after}`);
  // 收尾之后连接还能用（VACUUM + checkpoint 都不该把库关掉）
  db.prepare("INSERT INTO settings(key, value) VALUES('probe', '1')").run();
  assert.equal(dataFootprint(db).events, 0);
});
