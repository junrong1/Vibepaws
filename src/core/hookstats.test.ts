/**
 * 采集开销计量（landscape 0.12 / clawd #102）。
 *
 * 这组测试钉住的是**可核对性**，而不是某个功能：整段文案的说服力全部建立在
 * 「这些数字是真的、而且你可以自己 curl 出来」上。所以要钉住三件事：
 *   · 数字来自真实观测（字节数 = 请求体字节数；被拒的事件也算，面板不许比真相好看）；
 *   · 恒为 0 的两项真的在 JSON 里（curl 出来看不到它们，那句话就没有落地）；
 *   · adapter 上报的 hook_ms 既能穿过隐私白名单，也不会被脏值污染成 NaN。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../db/schema.ts";
import { seedPetTypes } from "../db/seed.ts";
import { HookMeter, hookMsOf, percentile } from "./hookstats.ts";
import { ingestEvent } from "./ingress.ts";
import { VibepawsServer } from "./server.ts";
import type { CoreEvent } from "./events.ts";

test("percentile：空样本给 null（而不是 0 —— 0 会被读成「快到测不出来」）", () => {
  assert.equal(percentile([], 50), null);
  assert.equal(percentile([5], 50), 5);
  assert.equal(percentile([1, 2, 3, 4], 50), 2);
  assert.equal(percentile([1, 2, 3, 4], 95), 4);
  assert.equal(percentile([4, 3, 2, 1], 50), 2, "输入顺序不该影响结果");
});

test("窗口只留最近 200 条：老数据必须被挤出去，否则第一天的数字会永远压着分位数", () => {
  const meter = new HookMeter();
  for (let i = 0; i < 200; i++) meter.record({ bytes: 10, coreMs: 1 });
  for (let i = 0; i < 200; i++) meter.record({ bytes: 10, coreMs: 9 });
  const snap = meter.snapshot();
  assert.equal(snap.calls, 400, "calls 是累计值，不受窗口限制");
  assert.equal(snap.sample, 200, "分位数样本被窗口封顶");
  assert.equal(snap.core_ms_p50, 9, "窗口里应该只剩后 200 条");
  assert.equal(snap.bytes, 4000);
});

test("脏值不进窗口：一个 NaN 就能让整条分位数变成 NaN，而界面上看不出是坏数据", () => {
  const meter = new HookMeter();
  meter.record({ bytes: 100, coreMs: 0.5, hookMs: Number.NaN });
  meter.record({ bytes: Number.NaN, coreMs: 0.5, hookMs: -3 });
  meter.record({ bytes: 100, coreMs: 0.5, hookMs: "31" as unknown as number });
  const snap = meter.snapshot();
  assert.equal(snap.calls, 3, "调用次数照数：它确实来过");
  assert.equal(snap.bytes, 200, "NaN 字节不该污染总量");
  assert.equal(snap.core_ms_p50, 0.5);
  assert.equal(snap.hook_ms_p50, null, "没有一个合法的自计时 → null，而不是 0");
});

test("恒为 0 的两项出现在快照里：它们就是这个面板要回答的问题", () => {
  const snap = new HookMeter(new Date("2026-08-25T10:00:00.000Z")).snapshot();
  assert.equal(snap.model_calls, 0);
  assert.equal(snap.outbound_bytes, 0);
  assert.equal(snap.since, "2026-08-25T10:00:00.000Z", "界面必须能说清「从什么时候起算」");
  assert.equal(snap.calls, 0);
  assert.equal(snap.core_ms_p50, null);
});

test("hookMsOf：从未经校验的 body 里取数，形状不对就给 null", () => {
  assert.equal(hookMsOf({ payload: { hook_ms: 31.4 } }), 31.4);
  assert.equal(hookMsOf({ payload: { hook_ms: "31" } }), null);
  assert.equal(hookMsOf({ payload: { hook_ms: -1 } }), null);
  assert.equal(hookMsOf({ payload: null }), null);
  assert.equal(hookMsOf({}), null);
  assert.equal(hookMsOf("nope"), null);
  assert.equal(hookMsOf(null), null);
});

test("hook_ms 穿得过隐私白名单（它是本机数字，不是用户内容）", () => {
  const db = new Database(":memory:");
  applySchema(db);
  seedPetTypes(db);
  const r = ingestEvent(
    {
      event_id: "hs-1",
      seq: 1,
      agent: "claude_code",
      session_id: "s1",
      project_id: "/p",
      event_type: "agent_working",
      severity: "low",
      safe_summary: "Working",
      timestamp: new Date().toISOString(),
      payload: { hook_ms: 34.2, tool_name: "Edit", tool_input: { content: "TOP_SECRET" } },
    },
    { db, onEvent: () => {} },
  );
  assert.equal(r.ok, true);
  assert.equal(r.event?.payload.hook_ms, 34.2);
  const row = db.prepare("SELECT payload_json FROM events WHERE event_id='hs-1'").get() as { payload_json: string };
  assert.ok(row.payload_json.includes("hook_ms"));
  assert.ok(!row.payload_json.includes("TOP_SECRET"), "白名单照旧：多一个字段不等于闸门松了");
});

/* ---------------- 端到端：POST /events → GET /api/hookstats ---------------- */

function sandbox(): { repoRoot: string; home: string } {
  const base = mkdtempSync(join(tmpdir(), "vibepaws-hookstats-"));
  const dirs = { repoRoot: join(base, "repo"), home: join(base, "home") };
  mkdirSync(dirs.repoRoot, { recursive: true });
  mkdirSync(dirs.home, { recursive: true });
  return dirs;
}

function makeServer(): VibepawsServer {
  const db = new Database(":memory:");
  applySchema(db);
  seedPetTypes(db);
  // persistToken 默认关闭（注入 db）：绝不能覆盖用户真实的 ~/.vibepaws/api_token
  return new VibepawsServer({ db, port: 0, ...sandbox() });
}

function hookEvent(hookMs: number): CoreEvent {
  return {
    event_id: `hs-e2e-${hookMs}`,
    seq: 1,
    agent: "claude_code",
    session_id: "s-e2e",
    project_id: "/Users/x/app",
    event_type: "agent_working",
    severity: "low",
    safe_summary: "Working: Edit",
    timestamp: new Date().toISOString(),
    payload: { tool_name: "Edit", hook_ms: hookMs },
  };
}

test("计数器数的是真实观测：字节数 = 请求体字节数，被拒的事件也算", async () => {
  const server = makeServer();
  await server.start();
  const base = `http://127.0.0.1:${server.port}`;
  const post = (body: string): Promise<Response> =>
    fetch(`${base}/events`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-vibepaws-token": server.token },
      body,
    });
  try {
    const bodies = [JSON.stringify(hookEvent(31)), JSON.stringify(hookEvent(47))];
    for (const b of bodies) assert.equal((await post(b)).status, 200);
    // 信封不合法的一条：hook 照样付了字节和毫秒，所以它必须被算进去
    const rejected = JSON.stringify({ payload: { hook_ms: 12 } });
    assert.equal((await post(rejected)).status, 400);

    const res = await fetch(`${base}/api/hookstats`, { headers: { "x-vibepaws-token": server.token } });
    assert.equal(res.status, 200);
    const stats = (await res.json()) as {
      calls: number;
      bytes: number;
      sample: number;
      core_ms_p50: number | null;
      hook_ms_p50: number | null;
      model_calls: number;
      outbound_bytes: number;
      endpoint: string;
    };
    assert.equal(stats.calls, 3, "被拒的那条也要算");
    const expected = [...bodies, rejected].reduce((n, b) => n + Buffer.byteLength(b), 0);
    assert.equal(stats.bytes, expected, "字节数必须等于真的读进来的那些字节");
    assert.equal(stats.hook_ms_p50, 31, "adapter 自报的耗时进得了分位数窗口");
    assert.equal(stats.sample, 3);
    assert.ok(stats.core_ms_p50 !== null && stats.core_ms_p50 >= 0, "Core 侧耗时是实测的");
    assert.equal(stats.model_calls, 0);
    assert.equal(stats.outbound_bytes, 0);
    assert.ok(
      stats.endpoint.includes(`:${server.port}/api/hookstats`),
      "界面要照抄的那条 curl 命令必须指向真实端口（打包版是动态的）",
    );
  } finally {
    await server.close();
  }
});

test("/api/hookstats 不是裸的：这条路由也要 token（它会说出这台机器上跑了多少次 hook）", async () => {
  const server = makeServer();
  await server.start();
  try {
    assert.equal((await fetch(`http://127.0.0.1:${server.port}/api/hookstats`)).status, 401);
  } finally {
    await server.close();
  }
});

test("设置窗口那一屏拿得到同一份数字（不必为它多发一次请求）", () => {
  const server = makeServer();
  server.hookMeter.record({ bytes: 420, coreMs: 0.4, hookMs: 33 });
  const view = server.settingsSnapshot();
  assert.equal(view.hooks.calls, 1);
  assert.equal(view.hooks.bytes, 420);
  assert.equal(view.hooks.hook_ms_p50, 33);
  assert.ok(view.hooks.endpoint.startsWith("http://127.0.0.1:"));
});
