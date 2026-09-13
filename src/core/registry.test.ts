/**
 * Session Registry 单测：source 生命周期（startup/resume/fork/clear/compact）+ 聚合。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema.ts";
import { SessionRegistry, projectShortName } from "./registry.ts";
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
  const notif = db.prepare("SELECT status FROM notifications").get() as { status: string };
  assert.equal(notif.status, "actioned", "error 通知应被标成已处理");
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
