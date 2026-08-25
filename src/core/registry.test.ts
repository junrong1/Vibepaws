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

test("decision_required 置位「等你」，后续进展事件清除", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ payload: { source: "startup" } }));
  reg.handle(ev({ event_type: "decision_required", payload: { kind: "question" } }));
  assert.equal(reg.listSessions()[0]!.state, "needs-you");
  assert.ok(reg.listSessions()[0]!.needs_input_since);

  reg.handle(ev({ event_type: "token_update", payload: { tokens: 100 } }));
  assert.equal(reg.listSessions()[0]!.needs_input_since, null, "用户回答后不该继续告警");
  assert.notEqual(reg.listSessions()[0]!.state, "needs-you");
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
