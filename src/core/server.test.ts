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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../db/schema.ts";
import { seedPetTypes } from "../db/seed.ts";
import { VibepawsServer } from "./server.ts";
import type { CoreEvent } from "./events.ts";

/**
 * repoRoot / home 必须一起换成临时目录：/api/uninstall 会同时清项目级与用户级配置，
 * 少传一个，跑一次测试就会把开发机上真实的全局 hooks 卸掉（问过了，会）。
 */
function sandbox(): { repoRoot: string; home: string } {
  const base = mkdtempSync(join(tmpdir(), "vibepaws-server-"));
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
  return new VibepawsServer({ db, ...sandbox() });
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

    for (const path of ["/api/state", "/api/sessions", "/api/exp", "/sse", "/api/reset", "/api/uninstall"]) {
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

/* ================= 危险区（重置 / 卸载） ================= */

async function withServer(fn: (server: VibepawsServer, base: string) => Promise<void>): Promise<void> {
  const server = makeServer();
  server.port = 0;
  await server.start();
  try {
    await fn(server, `http://127.0.0.1:${server.port}`);
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

/**
 * 「删除全部数据」不该是一次拼错的 fetch 就能触发的事。token 之外还要一个显式
 * confirm —— 本机任何网页都能打到这个端口，而这两个端点一个删库、一个改用户
 * 其他工具的配置文件。
 */
test("HTTP：没有 confirm 的重置/卸载一律 400，且什么都没发生", async () => {
  await withServer(async (server, base) => {
    server.handleEvent(ev({ payload: { source: "startup" } }));
    const before = server.stateSnapshot().sessions.length;

    for (const body of [{ scope: "data" }, { scope: "data", confirm: "yes" }, {}]) {
      assert.equal((await post(base, "/api/reset", server.token, body)).status, 400);
    }
    assert.equal((await post(base, "/api/uninstall", server.token, {})).status, 400);
    assert.equal(server.stateSnapshot().sessions.length, before, "被拒的请求不该删掉任何东西");

    // scope 也要认：拼错的 scope 不能被当成「全都删了吧」
    assert.equal((await post(base, "/api/reset", server.token, { scope: "everything", confirm: true })).status, 400);
    assert.equal(server.stateSnapshot().sessions.length, before);
  });
});

test("HTTP：带 confirm 的重置真的清空，并把新状态一起回给界面", async () => {
  await withServer(async (server, base) => {
    server.handleEvent(ev({ payload: { source: "startup" } }));
    server.handleEvent(ev({ event_type: "token_update", payload: { tokens: 50_000 } }));

    const res = await post(base, "/api/reset", server.token, { scope: "data", confirm: true });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { footprint: { sessions: number }; pet: { level: number }; sessions: unknown[] };
    // 界面不该为了显示「现在是空的」再追一次请求
    assert.equal(body.footprint.sessions, 0);
    assert.equal(body.pet.level, 1);
    assert.deepEqual(body.sessions, []);
  });
});

test("HTTP：卸载预览是只读的（dry_run 不需要 confirm，也不写任何文件）", async () => {
  const server = makeServer();
  server.port = 0;
  await server.start();
  const settings = join(server.repoRoot, ".claude", "settings.json");
  mkdirSync(join(server.repoRoot, ".claude"), { recursive: true });
  const installed = JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: "command", command: "node /x/src/adapters/hook_agent.ts" }] }] },
  });
  writeFileSync(settings, installed);
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const scan = (await (await fetch(`${base}/api/uninstall`, { headers: { "x-vibepaws-token": server.token } })).json()) as {
      targets: Array<{ file: string; hooks: number }>;
    };
    assert.equal(scan.targets.length, 1, "扫描要看得见我们写进去的那一条");
    assert.equal(scan.targets[0]!.hooks, 1);

    const dry = await post(base, "/api/uninstall", server.token, { dry_run: true });
    assert.equal(dry.status, 200);
    assert.equal(readFileSync(settings, "utf-8"), installed, "预览不该动文件");

    const real = await post(base, "/api/uninstall", server.token, { confirm: true });
    assert.equal(real.status, 200);
    const report = (await real.json()) as { results: Array<{ changed: boolean }>; targets: unknown[] };
    assert.equal(report.results[0]!.changed, true);
    assert.deepEqual(report.targets, [], "清完了，返回的扫描结果就该是空的");
    assert.equal("hooks" in (JSON.parse(readFileSync(settings, "utf-8")) as object), false);
  } finally {
    await server.close();
  }
});
