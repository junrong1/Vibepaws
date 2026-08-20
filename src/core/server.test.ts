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
