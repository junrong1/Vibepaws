/**
 * Core 服务器单测：宠物聚合状态（7 态真的推得出去）+ 静音状态 + 动作校验。
 *
 * 为什么这组测试值得存在：pet_state 里的 state 曾经直接取 pets 表那一列，
 * 而那一列只会是 idle / level-up —— 宠物永远是 idle 表情，
 * registry.aggregatePetState 成了没人调用的死代码，而这恰好是产品的核心。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema.ts";
import { seedPetTypes } from "../db/seed.ts";
import { VibepawsServer } from "./server.ts";
import type { CoreEvent } from "./events.ts";

function makeServer(): VibepawsServer {
  const db = new Database(":memory:");
  applySchema(db);
  seedPetTypes(db);
  // persistToken 默认关闭（注入 db）：绝不能覆盖用户真实的 ~/.vibepaws/api_token
  return new VibepawsServer({ db });
}

let seq = 0;
function ev(partial: Partial<CoreEvent>): CoreEvent {
  seq += 1;
  return {
    event_id: `srv-${seq}`,
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

test("宠物状态跟着 session 走：working → needs-you → working → finished", () => {
  const server = makeServer();
  server.handleEvent(ev({ payload: { source: "startup", cwd: "/Users/x/my-app" } }));
  assert.equal(server.stateSnapshot().pet.state, "working", "有活跃 session 时不该还是 idle");

  server.handleEvent(ev({ event_type: "permission_required", payload: { tool_name: "Bash" } }));
  assert.equal(server.stateSnapshot().pet.state, "needs-you");

  // 用户批准后 agent 继续干活 → 提醒解除
  server.handleEvent(ev({ event_type: "agent_working", payload: { tool_name: "Bash" } }));
  assert.equal(server.stateSnapshot().pet.state, "working");

  server.handleEvent(ev({ event_type: "session_finished", payload: { outcome: "success" } }));
  assert.equal(server.stateSnapshot().pet.state, "finished");
});

test("needs-you 不会因为通知过期而自己消失（agent 还在等）", () => {
  const server = makeServer();
  server.handleEvent(ev({ payload: { source: "startup" } }));
  server.handleEvent(ev({ event_type: "decision_required", payload: { kind: "question" } }));
  // 把通知行改成 10 分钟前：旧实现只看 notifications 的 60s 时间窗，这里就会回落成 working
  server.db.prepare("UPDATE notifications SET shown_at = datetime('now','-10 minutes')").run();
  assert.equal(server.stateSnapshot().pet.state, "needs-you");
  const session = server.stateSnapshot().sessions[0]!;
  assert.equal(session.state, "needs-you");
  assert.ok(session.needs_input_since, "浮层要能显示「等了多久」");
});

test("静音状态进推送，unmute 能解除", () => {
  const server = makeServer();
  assert.equal(server.stateSnapshot().mute.global_until, null);
  server.notifications.muteGlobal(30);
  const until = server.stateSnapshot().mute.global_until;
  assert.ok(until && until > Date.now(), "界面靠这个显示「还剩多久」");
  server.notifications.unmuteGlobal();
  assert.equal(server.stateSnapshot().mute.global_until, null);
});

test("EXP 条分母永远有值（next_level_exp 缺失会显示成 37/undefined）", () => {
  const server = makeServer();
  const pet = server.stateSnapshot().pet;
  assert.ok(pet.next_level_exp > 0);
  assert.equal(typeof pet.state, "string");
});

test("HTTP：/health 免鉴权，其余端点没 token 一律 401", async () => {
  const server = makeServer();
  // port 0 → 系统分配；start() 会把真实端口写回 server.port
  server.port = 0;
  await server.start();
  const base = `http://127.0.0.1:${server.port}`;
  try {
    assert.equal((await fetch(`${base}/health`)).status, 200, "健康检查必须免鉴权（壳靠它判断 Core 在不在）");

    for (const path of ["/api/state", "/api/sessions", "/api/exp", "/sse"]) {
      assert.equal((await fetch(base + path)).status, 401, `${path} 不该无鉴权可读`);
    }
    // 任何本机网页都能 POST 的静音是最难被发现的骚扰
    const forged = await fetch(`${base}/api/action`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "mute", minutes: 120 }),
    });
    assert.equal(forged.status, 401);
    assert.equal(server.stateSnapshot().mute.global_until, null, "未授权的静音不该生效");

    const ok = await fetch(`${base}/api/state`, { headers: { "x-vibepaws-token": server.token } });
    assert.equal(ok.status, 200);
    const authedAction = await fetch(`${base}/api/action`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-vibepaws-token": server.token },
      body: JSON.stringify({ action: "mute", minutes: 30 }),
    });
    assert.equal(authedAction.status, 200);
    assert.ok(server.stateSnapshot().mute.global_until);
  } finally {
    await server.close();
  }
});

test("健康分低且没有活跃 session 时宠物是 tired（README 6.4，不做永久死亡）", () => {
  const server = makeServer();
  // 最近一天里若干报错 → healthScore 掉到 0.7 以下
  for (let i = 0; i < 5; i++) {
    server.db
      .prepare("INSERT INTO events(event_id, agent, session_id, event_type, safe_summary) VALUES(?,?,?,?,?)")
      .run(`err-${i}`, "claude_code", "gone", "session_error", "x");
  }
  assert.equal(server.stateSnapshot().pet.state, "tired");
})

/**
 * adapter 可见性：装没装 hooks，界面必须分得出来。
 *
 * 在这之前 adapter_status 这条通路是「只有接收端」的：events.ts 声明了类型、
 * ingress 有 upsertAgent、registry 和 server 都有分支，但没有任何代码发出过这条事件
 * —— 安装器把 capabilities() 打进了 console.log 就完事。于是「hooks 没装」和
 * 「装了但 agent 还没干活」在界面上是同一只闲着的宠物，用户无从排查。
 */
test("没有 adapter 上报过时 adapters 为空 —— 界面据此说「去装 adapter」而不是「还没有 session」", () => {
  const server = makeServer();
  assert.deepEqual(server.stateSnapshot().adapters, []);
});

test("adapter_status 落库后出现在 stateSnapshot，且不会伪造出一条 session", () => {
  const server = makeServer();
  const r = server.handleEvent(
    ev({
      event_type: "adapter_status",
      session_id: "adapter-claude_code",
      payload: { capabilities: ["decision_required", "session_finished"], adapter_version: "9.9.9" },
    }),
  );
  assert.equal(r.ok, true);

  const snap = server.stateSnapshot();
  assert.equal(snap.adapters.length, 1);
  assert.equal(snap.adapters[0]!.agent, "claude_code");
  assert.equal(snap.adapters[0]!.adapter_version, "9.9.9");
  assert.deepEqual(snap.adapters[0]!.capabilities, ["decision_required", "session_finished"]);
  // 安装自检曾经发假的 session_started，在宠物面板里留下一条永不结束的 "install-probe"
  assert.equal(snap.sessions.length, 0, "adapter_status 不该产生 session 行");
});

test("同一 agent 重复上报只占一行（每次会话开始都会重新自报家门）", () => {
  const server = makeServer();
  for (const v of ["0.1.0", "0.2.0"]) {
    server.handleEvent(
      ev({ event_type: "adapter_status", session_id: "adapter-claude_code", payload: { adapter_version: v } }),
    );
  }
  const adapters = server.stateSnapshot().adapters;
  assert.equal(adapters.length, 1);
  assert.equal(adapters[0]!.adapter_version, "0.2.0", "版本要跟着最新一次上报走");
});

test("capabilities 列是脏数据时状态推送不炸（老库 / 手改过的行）", () => {
  const server = makeServer();
  server.db
    .prepare("INSERT INTO agents(agent, capabilities, connected_at, last_event_at) VALUES(?,?,?,?)")
    .run("codex", "not json{", "t", "t");
  assert.deepEqual(server.stateSnapshot().adapters[0]!.capabilities, []);
});
