/**
 * Session Health 读库那一层（health_query.ts）的单测：哪些行属于「这一段」、「今天」从哪算起。
 * 打分规则本身在 health.test.ts。
 */
import { test as nodeTest, type TestContext } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema.ts";
import { seedPetTypes } from "../db/seed.ts";
import { SessionRegistry } from "./registry.ts";
import { scoreSegment } from "./health.ts";
import {
  loadHistorySegments,
  loadSegmentInput,
  localDayKey,
  localDayStart,
  todayHealth,
} from "./health_query.ts";
import { recordFinish } from "./journal.ts";
import { normalizeHook } from "../adapters/hook_agent.ts";
import type { CoreEvent } from "./events.ts";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  seedPetTypes(db);
  return db;
}

let seq = 0;
function ev(at: number, partial: Partial<CoreEvent>): CoreEvent {
  seq += 1;
  return {
    event_id: `hq-${seq}`,
    seq,
    agent: "claude_code",
    session_id: "s1",
    project_id: "/Users/x/my-app",
    event_type: "agent_working",
    severity: "low",
    safe_summary: "x",
    timestamp: new Date(at).toISOString(),
    payload: {},
    ...partial,
  };
}

const MIN = 60_000;

/**
 * 这里的段贴着「现在」造（Date.now() − 60 分钟之类），断言的是「今天」。午夜刚过跑的话，
 * 段的开始会落到昨天。每条测试都把时钟钉在今天的本地正午（只 mock Date；要时间往前走的用 t.mock.timers.tick）。
 */
const test = (name: string, fn: (t: TestContext) => void | Promise<void>): void => {
  nodeTest(name, (t) => {
    const noon = new Date();
    noon.setHours(12, 0, 0, 0);
    // 正午还没到就钉昨天正午：events.received_at 走 SQLite 的真时钟，被钉的时间不能跑到它前面
    if (noon.getTime() > Date.now()) noon.setDate(noon.getDate() - 1);
    t.mock.timers.enable({ apis: ["Date"], now: noon.getTime() });
    return fn(t);
  });
};

test("端到端：阻塞两分钟 → 答了 → 收工，读出来的这一段能手算出分数", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  // 等待的 received_at 是 Core 此刻的时钟：permission_required 的时间戳得贴着「现在」，
  // 否则这条会被当成离线缓冲的回放丢掉（那正是 SPOOL_REPLAY_GAP_MS 要做的事）
  const t0 = Date.now() - 2000;
  reg.handle(ev(t0, { event_type: "session_started", payload: { source: "startup" } }));
  reg.handle(ev(t0 + 1000, { event_type: "context_update", payload: { context_pct: 88 } }));
  reg.handle(ev(t0 + 2000, { event_type: "permission_required", payload: { tool_name: "Bash" } }));
  reg.handle(ev(t0 + 2000 + 2 * MIN, { event_type: "agent_working", payload: { tool_name: "Bash" } }));
  reg.handle(ev(t0 + 30 * MIN, { event_type: "session_finished", payload: { outcome: "success" } }));

  const input = loadSegmentInput(db, "claude_code", "s1")!;
  assert.equal(input.settled, true);
  assert.equal(input.contextPeak, 88);
  assert.equal(input.waits.length, 1);
  const r = scoreSegment(input)!;
  // 12（88%）+ 25（没重复编辑）+ 20（2 分钟）+ 25（success 无报错）
  assert.deepEqual(r.factors, { context: 12, focus: 25, response: 20, outcome: 25 });
  assert.equal(r.score, 82);
});

test("端到端（hook 输入 → 账本 → 打分）：PermissionRequest 后紧跟的 Notification 不吃掉 Response 样本", (t) => {
  // 时钟已经钉在正午（见上面的 test 包装）；hook 的时间戳取 Date.now()，用 tick 让它往前走
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  const hook = (raw: Record<string, unknown>): void => {
    const e = normalizeHook({ session_id: "cc-1", cwd: "/Users/x/my-app", ...raw }, "claude_code", {});
    assert.ok(e, `${String(raw.hook_event_name)} 应该映射出一条事件`);
    reg.handle(e);
  };
  hook({ hook_event_name: "SessionStart" });
  t.mock.timers.tick(1000);
  hook({ hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "npm test" } });
  t.mock.timers.tick(300);
  // Claude Code 真实的 Notification 输入：没有 matcher，只有 notification_type
  hook({ hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission" });
  t.mock.timers.tick(90_000);
  hook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "npm test" } });
  t.mock.timers.tick(5 * MIN);
  hook({ hook_event_name: "SessionEnd" });

  const waits = db.prepare("SELECT kind, resolution FROM needs_input_waits").all();
  assert.deepEqual(waits, [{ kind: "permission", resolution: "inferred" }], "一段等待，由 agent 继续干活收尾");
  const r = scoreSegment(loadSegmentInput(db, "claude_code", "cc-1")!)!;
  assert.equal(r.evidence.responseSamples, 1, "90 秒的真实等待必须是一条样本");
  assert.ok(!r.omitted.includes("response"));
  assert.equal(r.evidence.responseMedianMs, 90_300, "样本是真实的 90 秒，不是几百毫秒的伪影");
  assert.equal(typeof r.factors.response, "number");
});

test("还在跑的一段读出来是 unsettled；上一段的等待不算进这一段", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  const t0 = Date.now() - 60 * MIN;
  reg.handle(ev(t0, { event_type: "session_started", payload: { source: "startup" } }));
  reg.handle(ev(t0 + 1000, { event_type: "permission_required", payload: { tool_name: "Bash" } }));
  reg.handle(ev(t0 + 20 * MIN, { event_type: "agent_working", payload: { tool_name: "Bash" } }));
  reg.handle(ev(t0 + 21 * MIN, { event_type: "session_finished", payload: { outcome: "success" } }));
  // resume → 第二段
  reg.handle(ev(t0 + 30 * MIN, { event_type: "session_started", payload: { source: "resume" } }));

  const input = loadSegmentInput(db, "claude_code", "s1")!;
  assert.equal(input.settled, false);
  assert.equal(input.waits.length, 0, "第一段那 20 分钟的等待属于第一段");
  const r = scoreSegment(input)!;
  assert.equal(r.unsettled, true);
  assert.equal(r.factors.outcome, null);
  assert.deepEqual(r.omitted, ["context", "response"]);
});

test("本段时间窗里的 session_error 拆开 success 的两档；窗口外的不算", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  const t0 = Date.parse("2026-09-29T08:00:00.000Z");
  reg.handle(ev(t0, { event_type: "session_started", payload: { source: "startup" } }));
  reg.handle(ev(t0 + 10 * MIN, { event_type: "session_finished", payload: { outcome: "success" } }));
  const insert = db.prepare(
    "INSERT INTO events(event_id, agent, session_id, event_type, safe_summary, received_at) VALUES(?,?,?,?,?,?)",
  );
  insert.run("err-before", "claude_code", "s1", "session_error", "x", "2026-09-29 07:59:00");
  assert.equal(loadSegmentInput(db, "claude_code", "s1")!.errorCount, 0);
  insert.run("err-in", "claude_code", "s1", "session_error", "x", "2026-09-29 08:05:00");
  insert.run("err-other", "codex", "s1", "session_error", "x", "2026-09-29 08:05:00");
  const input = loadSegmentInput(db, "claude_code", "s1")!;
  assert.equal(input.errorCount, 1);
  assert.equal(scoreSegment(input)!.factors.outcome, 20);
});

// 当天聚合读的是日志行（U12），不是 sessions：直接摆 session 行之后要像 server 的事件链那样
// 在「收工」那一刻 recordFinish 一次 —— 没结算的、被回收的它根本不写（这正是要测的一部分）
test("today：只收今天结算的段；昨天的、还在跑的都不算；一段都没有是 null", () => {
  const db = makeDb();
  const now = new Date();
  assert.deepEqual(todayHealth(db, now), { mean: null, health: null, segments: 0 });

  const put = db.prepare(
    `INSERT INTO sessions(agent, agent_session_id, project_id, is_active, segment_started_at, finished_at, outcome,
       context_peak, context_reported_at, repeat_edit_count)
     VALUES('claude_code', ?, '/p', ?, ?, ?, ?, ?, ?, ?)`,
  );
  const dayStart = Date.parse(localDayStart(now));
  const yesterday = new Date(dayStart - 3 * 60 * MIN).toISOString();
  put.run("old", 0, yesterday, yesterday, "abandoned", 99, yesterday, 9);
  put.run("live", 1, now.toISOString(), null, null, 99, now.toISOString(), 9);
  assert.ok(recordFinish(db, "claude_code", "old"));
  assert.equal(recordFinish(db, "claude_code", "live"), null, "还在跑的一段不写日志（R9）");
  assert.equal(todayHealth(db, now).mean, null, "昨天的与还在跑的都不进今天的聚合");

  const start = new Date(Math.max(dayStart, now.getTime() - 60 * MIN)).toISOString();
  put.run("good", 0, start, now.toISOString(), "success", 40, start, 0);
  put.run("gone", 0, start, now.toISOString(), "orphaned", 99, start, 9);
  assert.ok(recordFinish(db, "claude_code", "good"));
  assert.equal(recordFinish(db, "claude_code", "gone"), null, "被回收的一段不写日志（R10）");
  assert.equal(loadHistorySegments(db, localDayStart(now)).length, 1);
  assert.deepEqual(todayHealth(db, now), { mean: 100, health: 1, segments: 1 });
});

test("本地午夜：localDayStart 落在同一天的 00:00（本地时区）", () => {
  const now = new Date(2026, 8, 29, 15, 30);
  const start = new Date(localDayStart(now));
  assert.equal(start.getFullYear(), 2026);
  assert.equal(start.getMonth(), 8);
  assert.equal(start.getDate(), 29);
  assert.equal(start.getHours(), 0);
  assert.equal(start.getMinutes(), 0);
});

test("批量读和逐个读是同一个口径；日志里存的打分输入与收工那一刻读到的一模一样", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  const t0 = Date.now() - 2000;
  for (const id of ["a", "b"]) {
    reg.handle(ev(t0, { session_id: id, event_type: "session_started", payload: { source: "startup" } }));
  }
  reg.handle(ev(t0 + 1000, { session_id: "a", event_type: "permission_required", payload: { tool_name: "Bash" } }));
  reg.handle(ev(t0 + 1000 + 3 * MIN, { session_id: "a", event_type: "agent_working", payload: {} }));
  db.prepare(
    "INSERT INTO events(event_id, agent, session_id, event_type, safe_summary, received_at) VALUES(?,?,?,?,?,?)",
  ).run("err-b", "claude_code", "b", "session_error", "x", new Date(t0 + 2 * MIN).toISOString().replace("T", " ").slice(0, 19));
  for (const id of ["a", "b"]) {
    reg.handle(ev(t0 + 5 * MIN, { session_id: id, event_type: "session_finished", payload: { outcome: "success" } }));
    recordFinish(db, "claude_code", id); // server 的事件链在这一刻写日志
  }
  const history = loadHistorySegments(db, localDayStart(new Date(t0), 1));
  assert.deepEqual(history.map((h) => h.sessionId).sort(), ["a", "b"]);
  for (const h of history) {
    assert.deepEqual(h.input, loadSegmentInput(db, "claude_code", h.sessionId), h.sessionId);
    assert.equal(h.project, "my-app", "日志行里只有短名，原始路径根本没存");
  }
  const a = history.find((h) => h.sessionId === "a")!.input;
  const b = history.find((h) => h.sessionId === "b")!.input;
  assert.deepEqual([a.waits.length, a.errorCount], [1, 0]);
  assert.deepEqual([b.waits.length, b.errorCount], [0, 1]);
});

test("localDayStart 往前数日历日；localDayKey 是本地的 YYYY-MM-DD", () => {
  const now = new Date(2026, 8, 29, 0, 5);
  const back = new Date(localDayStart(now, 6));
  assert.deepEqual([back.getMonth(), back.getDate(), back.getHours()], [8, 23, 0]);
  assert.equal(localDayKey(new Date(2026, 0, 3, 23, 59)), "2026-01-03");
  // 跨月
  assert.equal(localDayKey(new Date(localDayStart(new Date(2026, 9, 1, 9), 1))), "2026-09-30");
});
