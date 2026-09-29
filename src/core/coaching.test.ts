/**
 * 辅导规则目录与「没用」的回路（U10 / R21 / R22）。
 *
 * 两条安全性质：调阈值不许当场换个数字再报一次（闩锁）；连按「没用」停在最安静的一档，
 * 而不是悄悄把最后一条警告也删掉。外加一条可测性：误报率是一条查询。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../db/schema.ts";
import { seedPetTypes } from "../db/seed.ts";
import {
  COACHING_RULES,
  coachingRule,
  falsePositiveRates,
  ruleThreshold,
  tuneRule,
  tuneThreshold,
} from "./coaching.ts";
import { NotificationEngine } from "./notifications.ts";
import { VibepawsServer } from "./server.ts";
import { getContextWarnPcts, setSetting } from "./settings.ts";
import type { CoreEvent } from "./events.ts";

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  seedPetTypes(db);
  return db;
}

/** repoRoot / home 换成临时目录：Core 的卸载 / 安装端点会碰用户级配置 */
function makeServer(): VibepawsServer {
  const base = mkdtempSync(join(tmpdir(), "vibepaws-coach-"));
  mkdirSync(join(base, "repo"));
  mkdirSync(join(base, "home"));
  return new VibepawsServer({ db: freshDb(), repoRoot: join(base, "repo"), home: join(base, "home") });
}

let seq = 0;
function ev(partial: Partial<CoreEvent>): CoreEvent {
  seq += 1;
  return {
    event_id: `coach-${seq}`,
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

const notifs = (server: VibepawsServer, type: string): Array<Record<string, unknown>> =>
  server.db.prepare("SELECT * FROM notifications WHERE type=? ORDER BY id").all(type) as Array<Record<string, unknown>>;

async function withHttp(server: VibepawsServer, fn: (base: string) => Promise<void>): Promise<void> {
  server.port = 0;
  await server.start();
  try {
    await fn(`http://127.0.0.1:${server.port}`);
  } finally {
    await server.close();
  }
}

function post(base: string, path: string, token: string, body: unknown): Promise<Response> {
  return fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-vibepaws-token": token },
    body: JSON.stringify(body),
  });
}

/* ---------------- 目录是数据 ---------------- */

test("目录覆盖 context / 重复编辑 / 报错 / 里程碑 / 漂移；每条都有建议动作和默认阈值，漂移是影子模式且不可调", () => {
  assert.deepEqual(COACHING_RULES.map((r) => r.id).sort(), ["context", "drift", "error", "milestone", "repeat_edit"]);
  for (const r of COACHING_RULES) {
    assert.ok(r.actionKey.startsWith("coach.") && r.condition.length > 0, r.id);
    assert.ok(r.defaults.length > 0, r.id);
  }
  assert.deepEqual([coachingRule("drift")!.shadow, coachingRule("drift")!.tunable], [true, false]);
  assert.ok(COACHING_RULES.filter((r) => !r.shadow).every((r) => r.tunable), "每条会弹气泡的规则都能调");
});

/* ---------------- 「没用」→ 调一档，且不当场重报 ---------------- */

test("88% 上按「没用」：85 挪到 90，同一个 session 到 91% 不再出第二条气泡；95 照常会响", async () => {
  const server = makeServer();
  await withHttp(server, async (base) => {
    server.handleEvent(ev({ payload: { source: "startup", cwd: "/Users/x/my-app" } }));
    server.handleEvent(ev({ event_type: "context_update", payload: { context_pct: 88 } }));
    const [first] = notifs(server, "context");
    assert.equal(first!.tier, 85);
    assert.equal(first!.rule_id, "context");

    const r = await post(base, "/api/action", server.token, { action: "not_useful", id: first!.id, ids: [first!.id] });
    assert.equal(r.status, 200);
    const body = (await r.json()) as { tuning: { before: number[]; after: number[]; changed: boolean } };
    assert.deepEqual(body.tuning.before, [70, 85, 95]);
    assert.deepEqual(body.tuning.after, [70, 90, 95]);
    assert.deepEqual(getContextWarnPcts(server.db), [70, 90, 95], "设置窗口看到的是同一份阈值");

    server.handleEvent(ev({ event_type: "context_update", payload: { context_pct: 91 } }));
    assert.equal(notifs(server, "context").length, 1, "刚嫌吵，不能换个数字马上再报一次");
    server.handleEvent(ev({ event_type: "context_update", payload: { context_pct: 96 } }));
    assert.equal(notifs(server, "context").length, 2, "更高的一档照常会响");
  });
});

test("设置窗口里改阈值也不当场重报：88% 时把 85 改成 80，下一条 89% 不响（闩锁重新对齐而不是清空）", async () => {
  const server = makeServer();
  await withHttp(server, async (base) => {
    server.handleEvent(ev({ payload: { source: "startup" } }));
    server.handleEvent(ev({ event_type: "context_update", payload: { context_pct: 88 } }));
    const r = await post(base, "/api/settings", server.token, { context_warn_pcts: [70, 80, 95] });
    assert.equal(r.status, 200);
    server.handleEvent(ev({ event_type: "context_update", payload: { context_pct: 89 } }));
    assert.equal(notifs(server, "context").length, 1);
    // 往下调到比已报过的更低：不补报（已经说过更高的了）；新的更高档照常
    server.handleEvent(ev({ event_type: "context_update", payload: { context_pct: 96 } }));
    assert.equal(notifs(server, "context").length, 2);
  });
});

test("relatch：每个闩锁落到不高于原档的最高新档；新阈值里没有这样的档就清掉", () => {
  const db = freshDb();
  const engine = new NotificationEngine(db, { dedupMs: 0 });
  engine.getForEvent(ev({ session_id: "a", event_type: "context_update", payload: { context_pct: 88 } }));
  setSetting(db, "context_warn_pcts", JSON.stringify([90, 95]));
  engine.relatch("context", [90, 95]);
  // 闩锁清掉了 → 从头武装：88 < 90 不响，91 响
  assert.equal(engine.getForEvent(ev({ session_id: "a", event_type: "context_update", payload: { context_pct: 88 } })), null);
  assert.ok(engine.getForEvent(ev({ session_id: "a", event_type: "context_update", payload: { context_pct: 91 } })));
});

test("连按「没用」停在最安静的一档，而不是把最后一条警告也删掉", () => {
  const context = coachingRule("context")!;
  let tiers = [70, 85, 95];
  for (let i = 0; i < 40; i++) {
    const r = tuneThreshold(context, tiers, tiers[0]!);
    tiers = r.after;
    assert.ok(tiers.length >= 1, "最后一档永远在");
  }
  assert.deepEqual(tiers, [97]);
  assert.equal(tuneThreshold(context, [97], 97).atQuietest, true);
  assert.equal(tuneThreshold(context, [97], 97).changed, false);

  const milestone = coachingRule("milestone")!;
  let m = [0.25, 0.5, 0.75, 0.9];
  for (let i = 0; i < 10; i++) m = tuneThreshold(milestone, m, m[0]!).after;
  assert.deepEqual(m, [0.9]);

  for (const id of ["repeat_edit", "error"] as const) {
    const rule = coachingRule(id)!;
    let n = [...rule.defaults];
    for (let i = 0; i < 20; i++) n = tuneThreshold(rule, n, n[0]!).after;
    assert.deepEqual(n, [rule.quietest], id);
  }
});

test("context 的一档挪到撞上上一档时并进去：85→…→90 撞 90 就只剩 [70, 90]，这个 session 闩在 90", () => {
  const context = coachingRule("context")!;
  const r = tuneThreshold(context, [70, 90, 95], 90);
  assert.deepEqual(r.after, [70, 95]);
  assert.equal(r.silencedAt, 95);
  const s = tuneThreshold(context, [70, 88, 95], 88);
  assert.deepEqual([s.after, s.silencedAt], [[70, 93, 95], 93]);
});

test("不可调的规则（drift）按「没用」只记理由，阈值不动", () => {
  const db = freshDb();
  const r = tuneRule(db, "drift", null);
  assert.equal(r.changed, false);
});

/* ---------------- 理由与规则一起落库 ---------------- */

test("一次「没用」记下理由和发它的规则；合并过的几行都记上；已经被回收的那行结局照旧是 timeout", async () => {
  const server = makeServer();
  await withHttp(server, async (base) => {
    server.handleEvent(ev({ payload: { source: "startup" } }));
    server.handleEvent(ev({ event_type: "context_update", payload: { context_pct: 72 } }));
    server.handleEvent(ev({ event_type: "context_update", payload: { context_pct: 88 } }));
    const [a, b] = notifs(server, "context");
    // 老的那一行先被别的路径结束了（回收）：结局是「第一次结束」，不许被理由覆盖
    server.db.prepare("UPDATE notifications SET status='dismissed', resolution='timeout', resolved_at=? WHERE id=?").run(
      new Date().toISOString(),
      a!.id,
    );
    await post(base, "/api/action", server.token, { action: "not_useful", id: b!.id, ids: [a!.id, b!.id] });
    const rows = notifs(server, "context");
    assert.deepEqual(
      rows.map((r) => [r.dismiss_reason, r.resolution, r.rule_id]),
      [
        ["not_useful", "timeout", "context"],
        ["not_useful", "dismissed", "context"],
      ],
    );
    // 调阈值按的是用户看着的最新那一行（88% → 85 那一档）
    assert.deepEqual(getContextWarnPcts(server.db), [70, 90, 95]);
  });
});

test("普通叉掉也记理由（dismissed），误报率的分子只数「没用」；没有 id 的「没用」400", async () => {
  const server = makeServer();
  await withHttp(server, async (base) => {
    server.handleEvent(ev({ payload: { source: "startup" } }));
    server.handleEvent(ev({ event_type: "session_error", payload: {} }));
    const [err] = notifs(server, "error");
    await post(base, "/api/action", server.token, { action: "dismiss", id: err!.id });
    assert.equal(notifs(server, "error")[0]!.dismiss_reason, "dismissed");
    assert.equal((await post(base, "/api/action", server.token, { action: "not_useful" })).status, 400);
    assert.equal((await post(base, "/api/action", server.token, { action: "not_useful", ids: ["x"] })).status, 400);
  });
});

test("「没用」不会落在不是辅导的气泡上：permission 行不记理由、不被结束、不调任何阈值", async () => {
  const server = makeServer();
  await withHttp(server, async (base) => {
    server.handleEvent(ev({ payload: { source: "startup" } }));
    server.handleEvent(ev({ event_type: "permission_required", payload: { tool_name: "Bash" } }));
    const [p] = notifs(server, "permission");
    const r = await post(base, "/api/action", server.token, { action: "not_useful", id: p!.id });
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as { tuning: unknown }).tuning, null);
    const row = notifs(server, "permission")[0]!;
    assert.deepEqual([row.dismiss_reason, row.resolution], [null, null]);
  });
});

/* ---------------- 别的规则的闩锁 ---------------- */

test("工具失败「每第 N 次」：按一次「没用」N 从 1 到 2，这个 session 的计数从头数", () => {
  // 引擎层直接测（去重窗口设 0）：同一 session 同类型 60s 去重会把「第二次失败」吞掉，那是另一件事。
  // 下面三步就是 server.notUseful 做的事：记理由 → 调阈值 → 给这个 session 上闩锁
  const db = freshDb();
  const engine = new NotificationEngine(db, { dedupMs: 0 });
  const fail = (): unknown => engine.getForEvent(ev({ session_id: "e", event_type: "session_error", payload: {} }));
  const first = fail() as { id: number };
  assert.ok(first);
  const r = engine.notUseful([first.id]);
  assert.deepEqual([r.fired!.rule_id, r.fired!.tier], ["error", 1]);
  const tuning = tuneRule(db, "error", r.fired!.tier);
  engine.silenceAfterTuning(tuning.rule, r.fired!.agent, r.fired!.session_id, tuning.silencedAt);
  assert.deepEqual(ruleThreshold(db, "error"), [2]);
  assert.equal(fail(), null, "按完之后的第一次失败不响");
  assert.ok(fail(), "凑满新的 N 才响");
  assert.equal(fail(), null);
});

test("重复编辑：数到阈值出一条（点名 Focus 的那类）；按「没用」后阈值 +1，这个 session 不因为下一次编辑马上再响", async () => {
  const server = makeServer();
  await withHttp(server, async (base) => {
    server.handleEvent(ev({ payload: { source: "startup" } }));
    const edit = (): void => {
      server.handleEvent(ev({ event_type: "agent_working", payload: { tool_name: "Write", file: "a.ts" } }));
    };
    for (let i = 0; i < 4; i++) edit(); // 第 2/3/4 次各算一次重复 → 计数 3
    const rows = notifs(server, "repeat_edit");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.rule_id, "repeat_edit");
    await post(base, "/api/action", server.token, { action: "not_useful", id: rows[0]!.id });
    assert.deepEqual(ruleThreshold(server.db, "repeat_edit"), [4]);
    edit(); // 计数 4 = 新阈值
    assert.equal(notifs(server, "repeat_edit").length, 1);
  });
});

/* ---------------- 影子模式 ---------------- */

test("漂移信号在影子模式下不弹气泡，但记了一行（shadow=1），误报率查询里看得到", () => {
  const server = makeServer();
  server.handleEvent(ev({ payload: { source: "startup" } }));
  assert.equal(server.notifications.getForEvent(ev({ event_type: "topic_drift_warning", payload: {} })), null);
  const rows = notifs(server, "drift");
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0]!.shadow, rows[0]!.status, rows[0]!.rule_id], [1, "muted", "drift"]);
  const fp = falsePositiveRates(server.db).find((r) => r.rule === "drift")!;
  assert.deepEqual([fp.shown, fp.shadow, fp.ratio], [0, 1, null], "没弹出来过的规则没有误报率，只有「本来会响几次」");
});

/* ---------------- 误报率是一条查询 ---------------- */

test("误报率：按规则 × 周给出「没用」占「真的弹出来过」的比例；被静音吞掉的不进分母", () => {
  const db = freshDb();
  const insert = db.prepare(
    `INSERT INTO notifications(agent, session_id, type, title, body, status, shown_at, rule_id, dismiss_reason, shadow)
     VALUES('claude_code', 's', ?, 't', 'b', ?, ?, ?, ?, 0)`,
  );
  // 2026-09-14 是周一；9-21 是下一个周一
  const rows: Array<[string, string, string, string | null]> = [
    ["context", "shown", "2026-09-15T10:00:00.000Z", "not_useful"],
    ["context", "dismissed", "2026-09-16T10:00:00.000Z", "dismissed"],
    ["context", "shown", "2026-09-20T23:59:00.000Z", null], // 周日，仍属 9-14 那一周
    ["context", "muted", "2026-09-17T10:00:00.000Z", null], // 静音吞掉的：没弹出来，不算
    ["context", "shown", "2026-09-21T00:00:01.000Z", "not_useful"], // 下一周
    ["error", "shown", "2026-09-15T10:00:00.000Z", null],
  ];
  for (const [rule, status, at, reason] of rows) insert.run(rule, status, at, rule, reason);
  const fp = falsePositiveRates(db, { now: new Date("2026-09-25T00:00:00.000Z"), weeks: 4 });
  assert.deepEqual(
    fp.map((r) => [r.rule, r.week, r.shown, r.not_useful, r.dismissed, r.ratio]),
    [
      ["context", "2026-09-14", 3, 1, 1, 1 / 3],
      ["error", "2026-09-14", 1, 0, 0, 0],
      ["context", "2026-09-21", 1, 1, 0, 1],
    ],
  );
});

test("HTTP：/api/coaching 要 token；返回目录、现在的阈值与误报率；恢复默认只认可调的规则", async () => {
  const server = makeServer();
  await withHttp(server, async (base) => {
    assert.equal((await fetch(`${base}/api/coaching`)).status, 401);
    tuneRule(server.db, "error", 1);
    const snap = (await (await fetch(`${base}/api/coaching`, { headers: { "x-vibepaws-token": server.token } })).json()) as {
      rules: Array<{ id: string; threshold: number[]; action_key: string }>;
      false_positive: unknown[];
    };
    assert.deepEqual(snap.rules.find((r) => r.id === "error")!.threshold, [2]);
    assert.ok(Array.isArray(snap.false_positive));
    const reset = await post(base, "/api/coaching", server.token, { reset: "error" });
    assert.equal(reset.status, 200);
    assert.deepEqual(ruleThreshold(server.db, "error"), [1]);
    assert.equal((await post(base, "/api/coaching", server.token, { reset: "drift" })).status, 400);
  });
});

test("文档回归：模块头的端点表里有 /api/coaching 与 not_useful", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
  const header = src.slice(0, src.indexOf("*/"));
  assert.match(header, /GET\s+\/api\/coaching/);
  assert.match(header, /not_useful/);
});
