/**
 * Session Registry 单测：source 生命周期（startup/resume/fork/clear/compact）+ 聚合。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema.ts";
import { seedPetTypes } from "../db/seed.ts";
import { SessionRegistry, projectShortName } from "./registry.ts";
import { ExpEngine } from "./exp.ts";
import { reclaimZombies } from "./reclaim.ts";
import { normalizeHook } from "../adapters/hook_agent.ts";
import { setSetting } from "./settings.ts";
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
    event_type: "session_started",
    severity: "low",
    safe_summary: "x",
    timestamp: new Date().toISOString(),
    payload: {},
    ...partial,
  };
}

test("startup 新建 session", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ payload: { source: "startup", cwd: "/Users/x/my-app" } }));
  const rows = reg.listSessions();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.title, "my-app");
  assert.equal(rows[0]!.is_active, true);
});

test("刚启动（仅 session_started）是 idle，不是 working", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ payload: { source: "startup" } }));
  const s = reg.listSessions()[0]!;
  assert.equal(s.state, "idle", "刚启动、还没干活的 session 不该是 working");
  assert.equal(reg.aggregatePetState(), "idle");
});

test("agent_working 后才转 working", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ payload: { source: "startup" } }));
  reg.handle(ev({ event_type: "agent_working", payload: { tool_name: "Bash" } }));
  const s = reg.listSessions()[0]!;
  assert.equal(s.state, "working", "真的干活了才是 working");
  assert.equal(reg.aggregatePetState(), "working");
});

test("token_update 也算工作活动（Claude statusline 通道）", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ payload: { source: "startup" } }));
  reg.handle(ev({ event_type: "token_update", payload: { tokens: 100 } }));
  assert.equal(reg.listSessions()[0]!.state, "working", "token 在涨说明在干活");
});

test("工作活动超过 15 分钟回落 idle（last_working_at 判定）", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ payload: { source: "startup" } }));
  reg.handle(ev({ event_type: "agent_working", payload: { tool_name: "Bash" } }));
  assert.equal(reg.listSessions()[0]!.state, "working");
  db.prepare("UPDATE sessions SET last_working_at = ?").run(
    new Date(Date.now() - 16 * 60_000).toISOString(),
  );
  assert.equal(reg.listSessions()[0]!.state, "idle", "超过 15 分钟无工作应回 idle");
});

test("resume 复用同一 session，不新建", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ payload: { source: "startup" } }));
  reg.handle(ev({ event_type: "session_finished", payload: { reason: "completion", outcome: "success" } }));
  reg.handle(ev({ payload: { source: "resume" } }));
  const rows = reg.listSessions();
  assert.equal(rows.length, 1, "resume 应复用同一 session");
  assert.equal(rows[0]!.is_active, true);
});

test("fork 新建 session 且 parent 指向原 session", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ event_id: "a", session_id: "orig", payload: { source: "startup" } }));
  reg.handle(
    ev({
      event_id: "b",
      session_id: "forked",
      payload: { source: "fork", parent_session_id: "orig" },
    }),
  );
  const rows = reg.listSessions();
  assert.equal(rows.length, 2);
  const forked = rows.find((r) => r.session_id === "forked")!;
  const orig = rows.find((r) => r.session_id === "orig")!;
  // forked 是第二条插入，parent_id 指向第一条（orig）的 id=1
  assert.equal(forked.parent_id, 1);
  assert.equal(orig.outcome, null);
});

test("clear 重置 context/token，不新建", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ payload: { source: "startup" } }));
  reg.handle(ev({ event_type: "token_update", payload: { tokens: 5000 } }));
  reg.handle(ev({ event_type: "context_update", payload: { context_pct: 88 } }));
  reg.handle(ev({ payload: { source: "clear" } }));
  const rows = reg.listSessions();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.token_used, 0);
  assert.equal(rows[0]!.context_pct, 0);
});

test("compact 不新建 session", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ payload: { source: "startup" } }));
  reg.handle(ev({ payload: { source: "compact" } }));
  assert.equal(reg.listSessions().length, 1);
});

test("projectShortName 取最后一段", () => {
  assert.equal(projectShortName("/Users/x/my-app/"), "my-app");
  assert.equal(projectShortName("C:\\dev\\proj"), "proj");
});

test("decision_required 置位「等你」，只有 agent_working 才清除（token_update 不清）", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ payload: { source: "startup" } }));
  reg.handle(ev({ event_type: "decision_required", payload: { kind: "question" } }));
  assert.equal(reg.listSessions()[0]!.state, "needs-you");
  assert.ok(reg.listSessions()[0]!.needs_input_since);

  // B1 回归：statusline 的 token_update 不该清除「等你」
  reg.handle(ev({ event_type: "token_update", payload: { tokens: 100 } }));
  assert.equal(reg.listSessions()[0]!.state, "needs-you", "token_update 不该清除「等你」");

  // 真正清除「等你」的是 agent_working（用户已作答）
  reg.handle(ev({ event_type: "agent_working", payload: { tool_name: "Bash" } }));
  assert.equal(reg.listSessions()[0]!.needs_input_since, null, "agent_working 后才该停止告警");
  assert.notEqual(reg.listSessions()[0]!.state, "needs-you");
});

test("decision_required kind=Stop → ready（非阻塞，不是 needs-you）", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ payload: { source: "startup" } }));
  reg.handle(ev({ event_type: "decision_required", payload: { kind: "Stop" } }));
  const s = reg.listSessions()[0]!;
  assert.equal(s.state, "ready", "Stop 是一轮结束，不该 needs-you");
  assert.ok(s.ready_since, "ready_since 应被置位");
  assert.equal(s.needs_input_since, null, "Stop 不应置 needs_input_since");
  assert.equal(reg.aggregatePetState(), "ready");
});

test("decision_required kind=question → needs-you（阻塞）", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ payload: { source: "startup" } }));
  reg.handle(ev({ event_type: "decision_required", payload: { kind: "question" } }));
  const s = reg.listSessions()[0]!;
  assert.equal(s.state, "needs-you");
  assert.equal(s.ready_since, null, "question 不应置 ready_since");
});

test("agent_working 清除 ready", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ payload: { source: "startup" } }));
  reg.handle(ev({ event_type: "decision_required", payload: { kind: "Stop" } }));
  assert.equal(reg.listSessions()[0]!.state, "ready");
  reg.handle(ev({ event_type: "agent_working", payload: { tool_name: "Bash" } }));
  assert.equal(reg.listSessions()[0]!.ready_since, null, "agent_working 后应清 ready");
  assert.notEqual(reg.listSessions()[0]!.state, "ready");
});

test("session_finished 清掉 ready 标记（避免 resume 后带着旧一轮的待命复活）", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ payload: { source: "startup" } }));
  reg.handle(ev({ event_type: "decision_required", payload: { kind: "Stop" } }));
  assert.equal(reg.listSessions()[0]!.state, "ready");
  reg.handle(ev({ event_type: "session_finished", payload: { outcome: "success" } }));
  const s = reg.listSessions()[0]!;
  assert.equal(s.ready_since, null, "session 结束后 ready_since 应清掉");
  assert.equal(s.state, "finished");
});

test("session_started(resume) 清掉上一轮的 ready 标记", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ payload: { source: "startup" } }));
  reg.handle(ev({ event_type: "decision_required", payload: { kind: "Stop" } }));
  assert.equal(reg.listSessions()[0]!.state, "ready");
  reg.handle(ev({ payload: { source: "resume" } }));
  assert.equal(reg.listSessions()[0]!.ready_since, null, "resume 后 ready_since 应清掉");
});

test("B2 复活：被回收（timeout）的 session 收到 agent_working 后复活", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ payload: { source: "startup" } }));
  db.prepare(
    "UPDATE sessions SET is_active=0, outcome='timeout', finished_at=? WHERE agent=? AND agent_session_id=?",
  ).run(new Date().toISOString(), "claude_code", "s1");
  const before = reg.listSessions()[0]!;
  assert.equal(before.is_active, false);
  assert.equal(before.state, "idle", "被回收的僵尸不是 finished");

  reg.handle(ev({ event_type: "agent_working", payload: { tool_name: "Bash" } }));
  const after = reg.listSessions()[0]!;
  assert.equal(after.is_active, true, "agent_working 应复活被回收的 session");
  assert.equal(after.outcome, null);
  assert.equal(after.finished_at, null);
  assert.equal(after.state, "working");
});

test("B3 解除：agent_working 把 shown error/drift 通知标 actioned，warning 回落", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ payload: { source: "startup" } }));
  db.prepare(
    `INSERT INTO notifications(agent, session_id, type, title, body, status, shown_at)
     VALUES('claude_code', 's1', 'error', 't', 'b', 'shown', ?)`,
  ).run(new Date().toISOString());
  assert.equal(reg.listSessions()[0]!.state, "warning");

  reg.handle(ev({ event_type: "agent_working", payload: { tool_name: "Bash" } }));
  assert.notEqual(reg.listSessions()[0]!.state, "warning", "agent 恢复后 warning 应解除");
  const notif = db.prepare("SELECT status, resolution, resolved_at FROM notifications").get() as {
    status: string;
    resolution: string | null;
    resolved_at: string | null;
  };
  assert.equal(notif.status, "actioned", "error 通知应被标成已处理");
  assert.equal(notif.resolution, "inferred", "不是用户点的：记成 inferred，而不是永远 NULL");
  assert.ok(notif.resolved_at);
});

test("「等你」超过安全阀（30min）后不再告警", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ payload: { source: "startup" } }));
  reg.handle(ev({ event_type: "permission_required", payload: { tool_name: "Bash" } }));
  // 必须写 ISO（带 Z）：datetime('now') 是无时区的 'YYYY-MM-DD HH:MM:SS'，
  // JS 会按**本地**时间解析它，于是这个测试在 UTC 以西的时区会假失败。
  db.prepare("UPDATE sessions SET needs_input_since = ?").run(new Date(Date.now() - 2 * 3600_000).toISOString());
  assert.notEqual(reg.listSessions()[0]!.state, "needs-you");
});

test("aggregatePetState：needs-you 优先于 working", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ session_id: "busy", payload: { source: "startup" } }));
  reg.handle(ev({ session_id: "asking", payload: { source: "startup" } }));
  reg.handle(ev({ session_id: "asking", event_type: "decision_required", payload: { kind: "question" } }));
  assert.equal(reg.aggregatePetState(), "needs-you");
  // 传入已算好的列表时结论必须一致（server 走的是这条路，避免重复查询）
  assert.equal(reg.aggregatePetState(undefined, reg.listSessions()), "needs-you");
  // level-up 这类覆盖态优先
  assert.equal(reg.aggregatePetState("level-up"), "level-up");
});

test("clear 同时重置 token EXP 结算游标", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ payload: { source: "startup" } }));
  db.prepare("UPDATE sessions SET token_exp_granted = 50000").run();
  reg.handle(ev({ payload: { source: "clear" } }));
  const row = db.prepare("SELECT token_exp_granted FROM sessions").get() as { token_exp_granted: number };
  assert.equal(row.token_exp_granted, 0);
});

test("warning 只看最近 120 秒，不是「今天一整天」", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ payload: { source: "startup" } }));
  // shown_at 落库是 ISO（带 T/Z），datetime('now') 是空格分隔 —— 直接字符串比较时
  // 'T' > ' '，今天任何一条通知都会被算成「最近 120 秒」，宠物橙一整天。
  db.prepare(
    `INSERT INTO notifications(agent, session_id, type, title, body, status, shown_at)
     VALUES('claude_code','s1','context','t','b','shown', ?)`,
  ).run(new Date(Date.now() - 3 * 3600_000).toISOString());
  assert.notEqual(reg.listSessions()[0]!.state, "warning", "3 小时前的 context 警告不该还让宠物报警");

  db.prepare("UPDATE notifications SET shown_at = ?").run(new Date().toISOString());
  assert.equal(reg.listSessions()[0]!.state, "warning", "刚刚的警告应该生效");
});

test("坏时间戳不会把宠物永久钉在 needs-you", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ payload: { source: "startup" } }));
  reg.handle(ev({ event_type: "decision_required", payload: { kind: "question" } }));
  db.prepare("UPDATE sessions SET needs_input_since = 'pending'").run();
  assert.notEqual(reg.listSessions()[0]!.state, "needs-you", "解析不出的时间戳应当按「不在等」处理");
});

/* ---------------- 僵尸回收之后的视图（G10） ---------------- */

test("被回收的僵尸显示成 idle，不是 finished —— 崩溃不发打勾", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ payload: { source: "startup" } }));
  reg.handle(ev({ event_type: "decision_required", payload: { kind: "question" } }));
  assert.equal(reg.listSessions()[0]!.state, "needs-you");

  // reclaimZombies 写的就是这几列
  db.prepare(
    `UPDATE sessions SET is_active=0, outcome='orphaned', finished_at=?,
       needs_input_since=NULL, needs_input_kind=NULL`,
  ).run(new Date().toISOString());

  const view = reg.listSessions()[0]!;
  assert.equal(view.state, "idle");
  assert.equal(view.is_active, false);
  // 宠物既不该继续被钉住，也不该为一次崩溃播庆祝动画
  assert.equal(reg.aggregatePetState(), "idle");
  assert.deepEqual(reg.needsAttention(), []);
});

test("正常收工仍然庆祝（回收的排除逻辑没有误伤 session_finished）", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ payload: { source: "startup" } }));
  reg.handle(ev({ event_type: "session_finished", payload: { outcome: "success" } }));
  assert.equal(reg.listSessions()[0]!.state, "finished");
  assert.equal(reg.aggregatePetState(), "finished");
});

test("pid 随事件记录：同一个 pid 来两次才确认（探活的输入）", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ payload: { source: "startup", pid: 9090 } }));
  const read = () =>
    db.prepare("SELECT agent_pid, agent_pid_confirmed FROM sessions").get() as {
      agent_pid: number | null;
      agent_pid_confirmed: number;
    };
  assert.deepEqual(read(), { agent_pid: 9090, agent_pid_confirmed: 0 });

  reg.handle(ev({ event_type: "agent_working", payload: { tool_name: "Bash", pid: 9090 } }));
  assert.deepEqual(read(), { agent_pid: 9090, agent_pid_confirmed: 1 });

  // 不带 pid 的通道（statusline / bridge 补发）不该把结论擦掉
  reg.handle(ev({ event_type: "token_update", payload: { tokens: 100 } }));
  assert.deepEqual(read(), { agent_pid: 9090, agent_pid_confirmed: 1 });
});

/* ---------------- subagent 两档（landscape 0.11 / clawd #214 #862） ---------------- */

/** 让这个 session 处于「在干活」：subagent 态是 working 的细分，不干活就没有它 */
function working(reg: SessionRegistry): void {
  reg.handle(ev({ event_type: "agent_working", payload: { tool_name: "Read" } }));
}

test("subagent 计数：0 → working，1 → delegating，2+ → juggling", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ payload: { source: "startup" } }));
  working(reg);
  assert.equal(reg.listSessions()[0]!.state, "working");

  reg.handle(ev({ event_type: "subagent_started", payload: {} }));
  assert.equal(reg.listSessions()[0]!.state, "delegating");
  assert.equal(reg.aggregatePetState(), "delegating");

  // 1 → 2 必须升档（clawd #862：没升上去就是这个 bug）
  reg.handle(ev({ event_type: "subagent_started", payload: {} }));
  const two = reg.listSessions()[0]!;
  assert.equal(two.state, "juggling");
  assert.equal(two.subagent_count, 2);
  assert.equal(reg.aggregatePetState(), "juggling");

  // 收回一个 → 退回 delegating，再收回 → working
  reg.handle(ev({ event_type: "subagent_stopped", payload: {} }));
  assert.equal(reg.listSessions()[0]!.state, "delegating");
  reg.handle(ev({ event_type: "subagent_stopped", payload: {} }));
  const back = reg.listSessions()[0]!;
  assert.equal(back.state, "working");
  assert.equal(back.subagent_count, 0);
  assert.equal(back.subagent_since, null);
});

test("subagent 收工不是任务收工：既不 finished 也不 ready（clawd #214）", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ payload: { source: "startup" } }));
  working(reg);
  reg.handle(ev({ event_type: "subagent_started", payload: {} }));
  reg.handle(ev({ event_type: "subagent_stopped", payload: {} }));

  const s = reg.listSessions()[0]!;
  assert.equal(s.state, "working", "分身回来了 ≠ 这一轮结束了");
  assert.equal(s.is_active, true, "分身回来了 ≠ session 结束了");
  assert.equal(s.ready_since, null, "subagent_stopped 不该写「待命」标记");
  assert.equal(s.finished_at, null, "subagent_stopped 不该写 finished_at");
  assert.equal(reg.aggregatePetState(), "working", "宠物不该在这一刻庆祝");
});

test("subagent 在跑时不显示「待命」：ready 标记让位给 juggling（clawd #214）", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ payload: { source: "startup" } }));
  working(reg);
  reg.handle(ev({ event_type: "subagent_started", payload: {} }));
  reg.handle(ev({ event_type: "subagent_started", payload: {} }));
  // 一条非阻塞的「一轮结束」混进来（漏收的 stop，或把分身收工当成主任务收工）
  reg.handle(ev({ event_type: "decision_required", payload: { kind: "Stop" } }));

  assert.equal(reg.listSessions()[0]!.state, "juggling", "还有 2 个分身在跑，不能说「待命」");
  assert.equal(reg.aggregatePetState(), "juggling");

  // 分身回来后那条可疑的「待命」不能原地复活 —— 否则宠物正好在最后一个分身返回的
  // 那一秒说「干完了」，只是把 #214 延后了一个事件
  reg.handle(ev({ event_type: "subagent_stopped", payload: {} }));
  reg.handle(ev({ event_type: "subagent_stopped", payload: {} }));
  const drained = reg.listSessions()[0]!;
  assert.equal(drained.ready_since, null, "分身在跑时到达的 ready 标记已被判定可疑，不该留着");
  assert.equal(drained.state, "working");
});

test("等你 > subagent：分身在跑也挡不住「需要你」", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ payload: { source: "startup" } }));
  working(reg);
  reg.handle(ev({ event_type: "subagent_started", payload: {} }));
  reg.handle(ev({ event_type: "permission_required", payload: { tool_name: "Bash" } }));
  assert.equal(reg.listSessions()[0]!.state, "needs-you");
  assert.equal(reg.aggregatePetState(), "needs-you");
});

test("跨 session 升档：两个 session 各派 1 个 → 宠物 juggling（clawd #862）", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  for (const id of ["a", "b"]) {
    reg.handle(ev({ session_id: id, payload: { source: "startup" } }));
    reg.handle(ev({ session_id: id, event_type: "agent_working", payload: { tool_name: "Read" } }));
    reg.handle(ev({ session_id: id, event_type: "subagent_started", payload: {} }));
  }
  const list = reg.listSessions();
  assert.deepEqual(list.map((s) => s.state).sort(), ["delegating", "delegating"]);
  assert.equal(reg.aggregatePetState(), "juggling", "桌面上同时跑着 2 个分身");
});

test("计数不会减成负数：多出来的 subagent_stopped 夹在 0", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ payload: { source: "startup" } }));
  working(reg);
  reg.handle(ev({ event_type: "subagent_stopped", payload: {} }));
  reg.handle(ev({ event_type: "subagent_stopped", payload: {} }));
  assert.equal(reg.listSessions()[0]!.subagent_count, 0);
  // 负数会让后面真正的 subagent_started 升不到 delegating —— 那才是这条断言守的东西
  reg.handle(ev({ event_type: "subagent_started", payload: {} }));
  assert.equal(reg.listSessions()[0]!.state, "delegating");
});

test("session 生命周期归零计数：收工与重启都不留下没收回的分身", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  const count = () =>
    (db.prepare("SELECT subagent_count AS c FROM sessions").get() as { c: number }).c;

  reg.handle(ev({ payload: { source: "startup" } }));
  working(reg);
  reg.handle(ev({ event_type: "subagent_started", payload: {} }));
  reg.handle(ev({ event_type: "session_finished", payload: { outcome: "success" } }));
  assert.equal(count(), 0, "收工后不该还挂着分身");

  // 漏收 stop 的那条路：重新开一轮（resume/compact）就把计数冲掉
  reg.handle(ev({ event_type: "subagent_started", payload: {} }));
  assert.equal(count(), 1);
  reg.handle(ev({ payload: { source: "resume" } }));
  assert.equal(count(), 0, "新的一轮手上没有上一轮的分身");
});

test("不干活的 session 不显示 subagent 态：漏收的计数最多挂 15 分钟", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ payload: { source: "startup" } }));
  working(reg);
  reg.handle(ev({ event_type: "subagent_started", payload: {} }));
  assert.equal(reg.listSessions()[0]!.state, "delegating");

  // 20 分钟没有任何动静：计数还挂着 1，但这个 session 早就不在干活了
  const old = new Date(Date.now() - 20 * 60_000).toISOString();
  db.prepare("UPDATE sessions SET last_working_at=?, last_event_at=?").run(old, old);
  assert.equal(reg.listSessions()[0]!.state, "idle", "没在干活就没有 subagent 态");
  assert.equal(reg.aggregatePetState(), "idle");
});


/* ================= U2：本段测量列（context_peak / repeat_edit_count / segment / permission_mode） ================= */

/** 固定起点 + 偏移秒数：窗口判定按事件时间算，测试不必真的等 */
const T0 = Date.parse("2026-09-29T10:00:00.000Z");
const at = (sec: number): string => new Date(T0 + sec * 1000).toISOString();

function col(db: Database.Database, c: string, sessionId = "s1"): unknown {
  return (db.prepare(`SELECT ${c} AS v FROM sessions WHERE agent_session_id=?`).get(sessionId) as { v: unknown }).v;
}

test("context_peak：40% → 96% → 12% 读作 96，实时值是 12", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ payload: { source: "startup" } }));
  for (const pct of [40, 96, 12]) reg.handle(ev({ event_type: "context_update", payload: { context_pct: pct } }));
  const s = reg.listSessions()[0]!;
  assert.equal(s.context_peak, 96);
  assert.equal(s.context_pct, 12);
});

test("不带百分比的 context_update（压缩）既不拉低峰值、也不把实时值清零", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ payload: { source: "startup" } }));
  reg.handle(ev({ event_type: "context_update", payload: { context_pct: 91 } }));
  reg.handle(ev({ event_type: "context_update", payload: {} })); // PreCompact
  reg.handle(ev({ event_type: "context_update", payload: {} })); // PostCompact
  const s = reg.listSessions()[0]!;
  assert.equal(s.context_peak, 91);
  assert.equal(s.context_pct, 91, "不知道就是不知道：不是 0%");
});

test("context_reported_at：只有带百分比的 context_update 才算「报过 context」（KTD3 的省略判据）", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ payload: { source: "startup" } }));
  reg.handle(ev({ event_type: "context_update", payload: {} }));
  assert.equal(col(db, "context_reported_at"), null, "一条压缩标记不是一次读数");
  reg.handle(ev({ event_type: "context_update", timestamp: at(5), payload: { context_pct: 0 } }));
  assert.equal(col(db, "context_reported_at"), at(5), "真的报了 0% 也是报过");
});

test("source=clear：实时值归 0、新一段峰值从 0 开始；上一段的峰值在它收工那一刻原样可取", () => {
  const db = makeDb();
  // 日志（U12）的取数点：session_finished 处理完的那一刻
  const atFinish: Array<Record<string, unknown>> = [];
  let last = "";
  const reg = new SessionRegistry({
    db,
    onUpdate: () => {
      if (last === "session_finished") {
        atFinish.push(db.prepare("SELECT segment, context_peak, outcome, finished_at FROM sessions").get() as Record<string, unknown>);
      }
    },
  });
  const send = (e: CoreEvent): void => {
    last = e.event_type;
    reg.handle(e);
  };
  send(ev({ payload: { source: "startup" } }));
  send(ev({ event_type: "context_update", payload: { context_pct: 96 } }));
  send(ev({ event_type: "session_finished", payload: { reason: "clear", outcome: "success" } }));
  send(ev({ payload: { source: "clear" } }));
  send(ev({ event_type: "context_update", payload: { context_pct: 20 } }));
  assert.equal(atFinish.length, 1);
  assert.equal(atFinish[0]!.segment, 1);
  assert.equal(atFinish[0]!.context_peak, 96, "第一段的峰值在收工时还在");
  assert.equal(atFinish[0]!.outcome, "success");
  const s = reg.listSessions()[0]!;
  assert.equal(s.segment, 2);
  assert.equal(s.context_peak, 20, "第二段不继承第一段的 96");
});

test("clear 之后、第二段还没报 context 时：context_pct 归 0，峰值与 reported_at 都清空", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ payload: { source: "startup" } }));
  reg.handle(ev({ event_type: "context_update", payload: { context_pct: 88 } }));
  reg.handle(ev({ payload: { source: "clear" } }));
  const s = reg.listSessions()[0]!;
  assert.equal(s.context_pct, 0);
  assert.equal(s.context_peak, 0);
  assert.equal(col(db, "context_reported_at"), null);
});

test("分段：clear / resume / 收工后再 startup 各开一段；compact 与没收工时的 startup 不开", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ timestamp: at(0), payload: { source: "startup" } }));
  assert.equal(col(db, "segment"), 1);
  assert.equal(col(db, "segment_started_at"), at(0));
  reg.handle(ev({ timestamp: at(1), payload: { source: "compact" } }));
  reg.handle(ev({ timestamp: at(2), payload: { source: "startup" } }));
  assert.equal(col(db, "segment"), 1, "同一段在继续");
  reg.handle(ev({ timestamp: at(3), payload: { source: "clear" } }));
  assert.equal(col(db, "segment"), 2);
  assert.equal(col(db, "segment_started_at"), at(3));
  reg.handle(ev({ timestamp: at(4), payload: { source: "resume" } }));
  assert.equal(col(db, "segment"), 3);
  reg.handle(ev({ timestamp: at(5), event_type: "session_finished", payload: { outcome: "success" } }));
  // Claude Code 的 hook 把 --resume 也报成 startup：收工之后的任何 start 都是新的一段
  reg.handle(ev({ timestamp: at(6), payload: { source: "startup" } }));
  assert.equal(col(db, "segment"), 4);
});

test("新一段开始时 finished_at / outcome 置空：一段在跑的 session 不再顶着上一段的结算", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ payload: { source: "startup" } }));
  reg.handle(ev({ event_type: "session_finished", payload: { outcome: "partial" } }));
  assert.equal(col(db, "outcome"), "partial");
  reg.handle(ev({ payload: { source: "resume" } }));
  const s = reg.listSessions()[0]!;
  assert.equal(s.finished_at, null);
  assert.equal(s.outcome ?? null, null);
  assert.equal(s.is_active, true);
});

test("重复编辑（加宽）：同一文件两次 Write 相隔 5s → repeat_edit_count+1；相隔 60s → 不算", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ agent: "claude_code", payload: { source: "startup" } }));
  const write = (sec: number, file = "a.ts"): void =>
    reg.handle(ev({ event_type: "agent_working", timestamp: at(sec), payload: { tool_name: "Write", file } }));
  write(0);
  write(5);
  assert.equal(col(db, "repeat_edit_count"), 1);
  write(65);
  assert.equal(col(db, "repeat_edit_count"), 1, "60s 之后再改不是重复");
  write(66, "b.ts");
  assert.equal(col(db, "repeat_edit_count"), 1, "换了文件不是重复");
  assert.equal(col(db, "correction_count"), 0, "老计数不跟着动（EXP 经济不变）");
});

test("MultiEdit / NotebookEdit / apply_patch 的重复都计入（回归：以前只认 Edit）", () => {
  for (const tool of ["MultiEdit", "NotebookEdit", "apply_patch"]) {
    const db = makeDb();
    const reg = new SessionRegistry({ db });
    reg.handle(ev({ payload: { source: "startup" } }));
    reg.handle(ev({ event_type: "agent_working", timestamp: at(0), payload: { tool_name: tool, file: "x.ts" } }));
    reg.handle(ev({ event_type: "agent_working", timestamp: at(3), payload: { tool_name: tool, file: "x.ts" } }));
    assert.equal(col(db, "repeat_edit_count"), 1, tool);
  }
});

test("非编辑工具带着 file 也不算重复编辑；没带 file 的编辑也不算", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ payload: { source: "startup" } }));
  for (const sec of [0, 1]) reg.handle(ev({ event_type: "agent_working", timestamp: at(sec), payload: { tool_name: "Read", file: "a.ts" } }));
  for (const sec of [2, 3]) reg.handle(ev({ event_type: "agent_working", timestamp: at(sec), payload: { tool_name: "Edit" } }));
  assert.equal(col(db, "repeat_edit_count"), 0);
});

test("离线补发：按事件时间判窗口 —— 一小时前的两次编辑同一秒到达，也不算重复", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ payload: { source: "startup" } }));
  reg.handle(ev({ event_type: "agent_working", timestamp: at(0), payload: { tool_name: "Edit", file: "a.ts" } }));
  reg.handle(ev({ event_type: "agent_working", timestamp: at(3600), payload: { tool_name: "Edit", file: "a.ts" } }));
  assert.equal(col(db, "repeat_edit_count"), 0);
});

test("新一段把重复编辑清零，且上一段最后一次编辑不会和下一段第一次凑成「重复」", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ payload: { source: "startup" } }));
  reg.handle(ev({ event_type: "agent_working", timestamp: at(0), payload: { tool_name: "Edit", file: "a.ts" } }));
  reg.handle(ev({ event_type: "agent_working", timestamp: at(2), payload: { tool_name: "Edit", file: "a.ts" } }));
  assert.equal(col(db, "repeat_edit_count"), 1);
  reg.handle(ev({ timestamp: at(3), payload: { source: "clear" } }));
  assert.equal(col(db, "repeat_edit_count"), 0);
  reg.handle(ev({ event_type: "agent_working", timestamp: at(4), payload: { tool_name: "Edit", file: "a.ts" } }));
  assert.equal(col(db, "repeat_edit_count"), 0);
});

test("老的 correction_count 规则原样保留：pi 的同文件 Edit 重复照旧计数", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ agent: "pi", payload: { source: "startup" } }));
  reg.handle(ev({ agent: "pi", event_type: "agent_working", payload: { tool_name: "Edit", file: "a.ts" } }));
  reg.handle(ev({ agent: "pi", event_type: "agent_working", payload: { tool_name: "Edit", file: "a.ts" } }));
  assert.equal(col(db, "correction_count"), 1);
  assert.equal(col(db, "repeat_edit_count"), 1);
});

test("EXP 经济不变：Claude Code 真实 hook 输入里 6 次同文件编辑，token EXP 与一次都没改过的 session 相同", () => {
  // 走真实的 adapter 归一化：U2 让它开始报 file 了，这正是会不会偷偷改动 topicMultiplier 的那条路
  const run = (edits: number): { exp: number; corrections: number; repeats: number } => {
    const db = makeDb();
    seedPetTypes(db);
    const reg = new SessionRegistry({ db });
    const exp = new ExpEngine(db);
    const feed = (e: CoreEvent): void => {
      reg.handle(e);
      exp.handle(e);
    };
    feed(normalizeHook({ hook_event_name: "SessionStart", session_id: "fx", cwd: "/Users/x/app" }, "claude_code")!);
    for (let i = 0; i < edits; i++) {
      for (const tool_name of ["Edit", "MultiEdit"]) {
        feed(
          normalizeHook(
            {
              hook_event_name: "PreToolUse",
              session_id: "fx",
              cwd: "/Users/x/app",
              tool_name,
              tool_input: { file_path: "/Users/x/app/src/parser.ts" },
            },
            "claude_code",
          )!,
        );
      }
    }
    const tokens = ev({ agent: "claude_code", session_id: "fx", event_type: "token_update", payload: { tokens: 10000 } });
    feed(tokens);
    const token = db.prepare("SELECT COALESCE(SUM(amount),0) AS a FROM exp_logs WHERE category='token'").get() as { a: number };
    return { exp: token.a, corrections: col(db, "correction_count", "fx") as number, repeats: col(db, "repeat_edit_count", "fx") as number };
  };
  const control = run(0);
  const loop = run(6);
  assert.ok(loop.repeats >= 5, `加宽的计数看得见这个循环（${loop.repeats}）`);
  assert.equal(loop.corrections, 0);
  assert.equal(loop.exp, control.exp, "每 token 的 EXP 没有被重新调价");
});

test("permission_mode 记在 session 上并出现在视图里；没报过是 null，不认识的形状不写", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ payload: { source: "startup" } }));
  assert.equal(reg.listSessions()[0]!.permission_mode, null);
  reg.handle(ev({ event_type: "agent_working", payload: { tool_name: "Bash", permission_mode: "bypassPermissions" } }));
  assert.equal(reg.listSessions()[0]!.permission_mode, "bypassPermissions");
  reg.handle(ev({ event_type: "agent_working", payload: { tool_name: "Bash" } }));
  assert.equal(reg.listSessions()[0]!.permission_mode, "bypassPermissions", "没带的事件不擦掉");
  reg.handle(ev({ event_type: "agent_working", payload: { permission_mode: "not a mode" } }));
  assert.equal(reg.sessionView("claude_code", "s1")!.permission_mode, "bypassPermissions");
});

/* ================= U2：等待账本（needs_input_waits） ================= */

function waits(db: Database.Database): Array<Record<string, unknown>> {
  return db.prepare("SELECT * FROM needs_input_waits ORDER BY id").all() as Array<Record<string, unknown>>;
}

test("进入 needs-you 开恰好一行；agent_working 清掉时记下 cleared_at 与 resolution=inferred", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ timestamp: at(0), payload: { source: "startup" } }));
  reg.handle(ev({ event_type: "permission_required", timestamp: at(10), payload: { tool_name: "Bash" } }));
  let rows = waits(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.started_at, at(10));
  assert.equal(rows[0]!.cleared_at, null);
  assert.equal(rows[0]!.kind, "permission");
  assert.equal(rows[0]!.session_id, "s1");
  assert.equal(rows[0]!.segment, 1);
  reg.handle(ev({ event_type: "agent_working", timestamp: at(40), payload: { tool_name: "Bash" } }));
  rows = waits(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.cleared_at, at(40));
  assert.equal(rows[0]!.resolution, "inferred");
  assert.equal(rows[0]!.muted_ms, 0);
  assert.equal(rows[0]!.slept_ms, 0);
});

test("没清就又进一次 needs-you：不开第二行重叠的等待", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ payload: { source: "startup" } }));
  reg.handle(ev({ event_type: "permission_required", timestamp: at(0), payload: { tool_name: "Bash" } }));
  reg.handle(ev({ event_type: "decision_required", timestamp: at(5), payload: { kind: "question" } }));
  reg.handle(ev({ event_type: "token_update", timestamp: at(6), payload: { tokens: 10 } })); // 不是进展
  reg.handle(ev({ event_type: "permission_required", timestamp: at(8), payload: { tool_name: "Edit" } }));
  const rows = waits(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.started_at, at(0), "起点是第一次进入");
});

test("每一处清列都关账并记下是哪一处：turn_ended / finished / restarted", () => {
  const cases: Array<[string, Partial<CoreEvent>]> = [
    ["turn_ended", { event_type: "decision_required", payload: { kind: "Stop" } }],
    ["finished", { event_type: "session_finished", payload: { outcome: "success" } }],
    ["restarted", { event_type: "session_started", payload: { source: "clear" } }],
    ["restarted", { event_type: "session_started", payload: { source: "compact" } }],
  ];
  for (const [want, clear] of cases) {
    const db = makeDb();
    const reg = new SessionRegistry({ db });
    reg.handle(ev({ payload: { source: "startup" } }));
    reg.handle(ev({ event_type: "decision_required", timestamp: at(0), payload: { kind: "question" } }));
    reg.handle(ev({ ...clear, timestamp: at(30) }));
    const rows = waits(db);
    assert.equal(rows.length, 1, want);
    assert.equal(rows[0]!.resolution, want, JSON.stringify(clear.payload));
    assert.equal(rows[0]!.cleared_at, at(30));
    assert.equal(col(db, "needs_input_since"), null, "标记列与账本一起清");
  }
});

test("回收（reclaim）关掉的等待记成 timeout —— 走开了的那种不能被悄悄丢掉", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ timestamp: at(0), payload: { source: "startup" } }));
  reg.handle(ev({ event_type: "permission_required", timestamp: at(1), payload: { tool_name: "Bash" } }));
  reclaimZombies(db, { now: T0 + 3 * 3600_000, timeoutMs: 15 * 60_000, isAlive: () => true });
  const rows = waits(db);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.resolution, "timeout");
  assert.equal(rows[0]!.cleared_at, new Date(T0 + 3 * 3600_000).toISOString());
});

test("等待行记下所在的段：第二段的等待是 segment 2", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ payload: { source: "startup" } }));
  reg.handle(ev({ event_type: "permission_required", timestamp: at(0), payload: {} }));
  reg.handle(ev({ timestamp: at(5), payload: { source: "clear" } }));
  reg.handle(ev({ event_type: "permission_required", timestamp: at(6), payload: {} }));
  assert.deepEqual(waits(db).map((w) => [w.segment, w.resolution]), [[1, "restarted"], [2, null]]);
});

test("received_at 是 Core 的时钟：离线缓冲补发的等待，started_at 与 received_at 相差很远", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  const old = new Date(Date.now() - 6 * 3600_000).toISOString();
  reg.handle(ev({ timestamp: old, payload: { source: "startup" } }));
  reg.handle(ev({ event_type: "permission_required", timestamp: old, payload: {} }));
  const w = waits(db)[0]!;
  assert.equal(w.started_at, old);
  assert.ok(Date.parse(w.received_at as string) - Date.parse(old) > 5 * 3600_000);
});

test("静音：整段都在静音里 → muted_ms = 时长；静音中途到期 → 只算重叠的那一截；没静音 → 0", () => {
  const run = (muteUntil: number | null): number => {
    const db = makeDb();
    const reg = new SessionRegistry({ db });
    const now = Date.now();
    const iso = (ms: number): string => new Date(now + ms).toISOString();
    if (muteUntil !== null) setSetting(db, "mute.global", String(now + muteUntil));
    reg.handle(ev({ timestamp: iso(0), payload: { source: "startup" } }));
    reg.handle(ev({ event_type: "permission_required", timestamp: iso(0), payload: {} }));
    reg.handle(ev({ event_type: "agent_working", timestamp: iso(120_000), payload: {} }));
    return waits(db)[0]!.muted_ms as number;
  };
  assert.equal(run(null), 0);
  assert.equal(run(3600_000), 120_000, "wholly muted：U3 据此丢掉这条样本");
  const partial = run(30_000);
  assert.ok(partial > 25_000 && partial <= 30_000, `部分静音 ≈ 30s，got ${partial}`);
});

test("项目静音同样计入 muted_ms（与通知引擎同一套判据）", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  const now = Date.now();
  setSetting(db, "mute.project./Users/x/my-app", String(now + 3600_000));
  reg.handle(ev({ timestamp: new Date(now).toISOString(), payload: { source: "startup" } }));
  reg.handle(ev({ event_type: "permission_required", timestamp: new Date(now).toISOString(), payload: {} }));
  reg.handle(ev({ event_type: "agent_working", timestamp: new Date(now + 10_000).toISOString(), payload: {} }));
  assert.equal(waits(db)[0]!.muted_ms, 10_000);
});

test("时钟不一致（清掉的时间戳早于开始）：时长与 muted_ms 夹在 0，不出现负数", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  setSetting(db, "mute.global", String(Date.now() + 3600_000));
  reg.handle(ev({ payload: { source: "startup" } }));
  reg.handle(ev({ event_type: "permission_required", timestamp: new Date().toISOString(), payload: {} }));
  reg.handle(ev({ event_type: "agent_working", timestamp: new Date(Date.now() - 60_000).toISOString(), payload: {} }));
  assert.equal(waits(db)[0]!.muted_ms, 0);
});

test("验收：一个 session 阻塞两次、压缩一次 → 账本两行都已关闭，context_peak 是压缩前的最大值", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  const hook = (h: Record<string, unknown>): void =>
    reg.handle(normalizeHook({ session_id: "v1", cwd: "/Users/x/app", ...h }, "claude_code")!);
  hook({ hook_event_name: "SessionStart" });
  reg.handle(ev({ session_id: "v1", event_type: "context_update", payload: { context_pct: 64 } }));
  hook({ hook_event_name: "PermissionRequest", tool_name: "Bash" });
  hook({ hook_event_name: "PreToolUse", tool_name: "Bash" });
  reg.handle(ev({ session_id: "v1", event_type: "context_update", payload: { context_pct: 93 } }));
  hook({ hook_event_name: "PreCompact" });
  hook({ hook_event_name: "PostCompact" });
  reg.handle(ev({ session_id: "v1", event_type: "context_update", payload: { context_pct: 31 } }));
  hook({ hook_event_name: "PreToolUse", tool_name: "AskUserQuestion" });
  hook({ hook_event_name: "PostToolUse", tool_name: "AskUserQuestion" });
  const rows = waits(db);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((w) => w.cleared_at !== null && w.resolution === "inferred"));
  assert.equal(col(db, "context_peak", "v1"), 93);
  assert.equal(col(db, "context_pct", "v1"), 31);
});
