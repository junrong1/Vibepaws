/**
 * dsh_plugin.ts 单测：session/event 映射、agent 生命周期、token 提取/累计、
 * context 百分比、session id 回退、JSONL 兜底，以及隐私（不进 payload）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import {
  mapSessionEvent,
  mapTokenUpdate,
  mapAgentCreated,
  mapAgentDisposed,
  mapAgentError,
  tokenDelta,
  TokenAccumulator,
  contextPctOf,
  sessionIdOf,
  cwdOf,
  deliverToCore,
  mapApprovalRequest,
  DSH_CAPABILITIES,
} from "./dsh_plugin.ts";
import type { CoreEvent } from "./dsh_plugin.ts";
import { transpileDshPlugin } from "./dsh_compile.ts";

const NOW = "2026-08-21T00:00:00.000Z";
const CWD = "/Users/demo/proj";
const SID = "session-7";

function map(type: string, data: Record<string, unknown> = {}, extra: Partial<Parameters<typeof mapSessionEvent>[0]> = {}): CoreEvent[] {
  return mapSessionEvent({ eventType: type, data, sessionId: SID, cwd: CWD, now: NOW, ...extra });
}

/** 取第 n 个事件（断言存在，绕过 noUncheckedIndexedAccess） */
function one(evs: CoreEvent[], index = 0): CoreEvent {
  assert.ok(evs[index], `缺少第 ${index} 个事件`);
  return evs[index]!;
}

test("turn/start → agent_working", () => {
  const ev = one(map("turn/start", { turn: 1 }));
  assert.equal(ev.event_type, "agent_working");
  assert.equal(ev.agent, "dsh");
  assert.equal(ev.safe_summary, "Working: agent");
  assert.deepEqual(ev.payload, {});
});

test("user/message：直接提示 → agent_working；注入上下文/工具 → 不上报", () => {
  const direct = one(map("user/message", { source: { kind: "user" } }));
  assert.equal(direct.event_type, "agent_working");
  assert.deepEqual(map("user/message", { source: { kind: "plugin" } }), []);
  assert.deepEqual(map("user/message", { source: { kind: "tool" } }), []);
  // 隐私：message content 永不进 payload
  assert.ok(!("content" in direct.payload));
});

test("tool/call → agent_working（带 tool_name，不带 arguments）", () => {
  const ev = one(map("tool/call", { turn: 1, step: 1, callId: "c1", name: "Bash", arguments: '{"cmd":"rm -rf /"}' }));
  assert.equal(ev.event_type, "agent_working");
  assert.deepEqual(ev.payload, { tool_name: "Bash" });
  // 隐私红线：raw arguments 绝不进 payload
  assert.ok(!("arguments" in ev.payload));
});

test("tool/call ask_user_question → decision_required（问问题，等回答）", () => {
  const ev = one(map("tool/call", { turn: 1, callId: "c1", name: "ask_user_question" }));
  assert.equal(ev.event_type, "decision_required");
  assert.equal(ev.severity, "high");
  assert.deepEqual(ev.payload, { kind: "question" });
  assert.equal(ev.safe_summary, "Waiting for your answer");
});

test("tool/result：出错 → session_error；成功 → 不上报", () => {
  const err = one(map("tool/result", { message: { isError: true }, error: { name: "E", code: "NONZERO_EXIT" } }, { toolName: "Bash" }));
  assert.equal(err.event_type, "session_error");
  assert.equal(err.severity, "high");
  assert.equal(err.payload.error_kind, "NONZERO_EXIT");
  assert.equal(err.payload.tool_name, "Bash");
  assert.deepEqual(map("tool/result", { message: { content: [] } }), []);
});

test("assistant/message：有 contextPct → context_update；无 → 空", () => {
  const ev = one(map("assistant/message", { usage: { inputTokens: 10, outputTokens: 5 } }, { contextPct: 72 }));
  assert.equal(ev.event_type, "context_update");
  assert.equal(ev.severity, "medium");
  assert.deepEqual(ev.payload, { context_pct: 72 });
  assert.deepEqual(map("assistant/message", { usage: {} }), []);
});

test("compaction/start：有 contextPct → context_update；无 → 空", () => {
  const ev = one(map("compaction/start", { compactionId: "c", turn: 3 }, { contextPct: 88 }));
  assert.equal(ev.event_type, "context_update");
  assert.deepEqual(ev.payload, { context_pct: 88 });
  assert.deepEqual(map("compaction/start", { compactionId: "c" }), []);
});

test("approval/asked → 不上报（审计）；approval/decided → agent_working", () => {
  assert.deepEqual(map("approval/asked", { id: "a1", toolName: "Write" }), []);
  assert.equal(one(map("approval/decided", { id: "a1", outcome: "allow" })).event_type, "agent_working");
});

test("mapApprovalRequest → permission_required（实时审批请求）", () => {
  const ev = mapApprovalRequest({ sessionId: SID, cwd: CWD, toolName: "Bash", now: NOW });
  assert.equal(ev.event_type, "permission_required");
  assert.equal(ev.severity, "high");
  assert.deepEqual(ev.payload, { tool_name: "Bash" });
  assert.equal(ev.safe_summary, "Tool permission needed: Bash");
});

test("turn/end：blocked → decision_required；error → session_error；completed → 空", () => {
  const blocked = one(map("turn/end", { turn: 1, reason: { kind: "blocked" } }));
  assert.equal(blocked.event_type, "decision_required");
  assert.equal(blocked.severity, "high");
  assert.deepEqual(blocked.payload, { kind: "blocked" });
  const err = one(map("turn/end", { turn: 1, reason: { kind: "error", error: { code: "CONTEXT_WINDOW_EXCEEDED" } } }));
  assert.equal(err.event_type, "session_error");
  assert.equal(err.payload.error_kind, "CONTEXT_WINDOW_EXCEEDED");
  assert.deepEqual(map("turn/end", { turn: 1, reason: { kind: "completed" } }), []);
});

test("subagent/descriptor → subagent_started", () => {
  assert.equal(one(map("subagent/descriptor", {})).event_type, "subagent_started");
});

test("未知事件 → 空数组（不阻断）", () => {
  assert.deepEqual(map("session/end-seed", {}), []);
  assert.deepEqual(map("nope", {}), []);
});

test("tokenDelta：仅 assistant/message 且带 usage 时返回 disjoint 合计", () => {
  assert.equal(tokenDelta({ type: "assistant/message", data: { usage: { inputTokens: 100, outputTokens: 40, cacheReadTokens: 10, cacheWriteTokens: 5 } } }), 155);
  assert.equal(tokenDelta({ type: "assistant/message", data: {} }), undefined);
  assert.equal(tokenDelta({ type: "tool/call", data: {} }), undefined);
});

test("TokenAccumulator：按 session 累计，reset 清零", () => {
  const acc = new TokenAccumulator();
  assert.equal(acc.add("s1", 100), 100);
  assert.equal(acc.add("s1", 50), 150);
  assert.equal(acc.add("s2", 7), 7);
  assert.equal(acc.get("s1"), 150);
  acc.reset("s1");
  assert.equal(acc.get("s1"), 0);
});

test("mapTokenUpdate：累计 tokens → token_update", () => {
  const ev = mapTokenUpdate({ sessionId: SID, cwd: CWD, tokens: 150, now: NOW });
  assert.equal(ev.event_type, "token_update");
  assert.deepEqual(ev.payload, { tokens: 150 });
  assert.equal(ev.safe_summary, "Usage update: 150 tokens");
});

test("mapAgentCreated → adapter_status + session_started", () => {
  const evs = mapAgentCreated({ sessionId: SID, cwd: CWD, now: NOW, adapterVersion: "0.1.0" });
  assert.equal(evs.length, 2);
  const status = one(evs, 0);
  const started = one(evs, 1);
  assert.equal(status.event_type, "adapter_status");
  assert.equal(status.session_id, "adapter-dsh"); // 固定：这是一条「我在」的声明
  assert.deepEqual(status.payload.capabilities, [...DSH_CAPABILITIES]);
  assert.equal(status.payload.adapter_version, "0.1.0");
  assert.equal(started.event_type, "session_started");
  assert.deepEqual(started.payload, { source: "startup", cwd: CWD });
});

test("mapAgentDisposed → session_finished；mapAgentError → session_error（映射保留，未挂监听）", () => {
  const done = mapAgentDisposed({ sessionId: SID, cwd: CWD, now: NOW });
  assert.equal(done.event_type, "session_finished");
  assert.deepEqual(done.payload, { reason: "stopped" });
  const err = mapAgentError({ sessionId: SID, cwd: CWD, now: NOW, kind: "TIMEOUT" });
  assert.equal(err.event_type, "session_error");
  assert.equal(err.severity, "high");
  assert.deepEqual(err.payload, { error_kind: "TIMEOUT" });
});

test("contextPctOf：token-meter 压力 / contextWindow → 百分比；缺则 undefined", () => {
  const ctx = { on: () => {}, get: (n: string) => (n === "tokenMeter" ? { measure: () => ({ totalTokens: 500 }) } : undefined) };
  const session = { requestContext: () => ({ contextWindow: 1000 }) };
  assert.equal(contextPctOf(ctx, session), 50);
  assert.equal(contextPctOf({ on: () => {}, get: () => undefined }, session), undefined);
  assert.equal(contextPctOf(ctx, { requestContext: () => undefined }), undefined);
});

test("sessionIdOf / cwdOf：取 session.id 与 header.cwd，异常回退", () => {
  assert.equal(sessionIdOf({ id: "session-1" }), "session-1");
  assert.match(sessionIdOf(undefined), /^dsh-\d+-\w+$/);
  assert.equal(cwdOf({ header: { cwd: "/a/b" } }), "/a/b");
  // ReactLoopAgent 形状（agent/created 等的 payload.agent）：header 在 .session 上
  assert.equal(cwdOf({ id: "s1", session: { header: { cwd: "/proj/x" } } }), "/proj/x");
  // ReactLoopAgent 形状：session id 在 .session.id 上，必须归一到它（否则 agent/created 与 session/event 各建一个 session）
  assert.equal(sessionIdOf({ id: "agent-1", session: { id: "session-1" } }), "session-1");
  // 两个位置都取不到才回退 process.cwd()
  assert.equal(cwdOf({ id: "s1" }), process.cwd());
  assert.equal(cwdOf(undefined), process.cwd());
});

test("deliverToCore：Core 离线时写 JSONL 兜底（可注入 fallbackDir）", async () => {
  const dir = mkdtempSync(join(process.cwd(), ".vibepaws", "dsh-test-"));
  try {
    const ev: CoreEvent = {
      event_id: "dsh-x", seq: 1, agent: "dsh", session_id: SID, project_id: dir,
      event_type: "session_started", severity: "low", safe_summary: "x", timestamp: NOW, payload: {},
    };
    const fallbackDir = join(dir, "events");
    const ok = await deliverToCore(ev, dir, 1, fallbackDir); // 端口 1 必然连不上
    assert.equal(ok, false);
    assert.ok(existsSync(fallbackDir));
    const files = readdirSync(fallbackDir).filter((f) => f.endsWith(".jsonl"));
    assert.ok(files.length > 0);
    const written = readFileSync(join(fallbackDir, files[0]!), "utf-8").trim();
    assert.ok(written.includes('"agent":"dsh"'), "兜底事件应含 agent=dsh");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("transpileDshPlugin：ESM .ts → 可 require() 的 CJS（dsh 侧绕开 require(esm) 环）", () => {
  const source = readFileSync(new URL("./dsh_plugin.ts", import.meta.url), "utf-8");
  const cjs = transpileDshPlugin(source);
  const dir = mkdtempSync(join(process.cwd(), ".vibepaws", "dsh-cjs-"));
  try {
    const file = join(dir, "vibepaws.cjs");
    writeFileSync(file, cjs);
    const require = createRequire(import.meta.url);
    const mod = require(file);
    // cordis 插件三件套 + 核心导出都得在
    assert.equal(mod.name, "vibepaws");
    assert.deepEqual(mod.inject, []);
    assert.equal(typeof mod.apply, "function");
    assert.equal(typeof mod.mapSessionEvent, "function");
    assert.equal(typeof mod.TokenAccumulator, "function");
    // 与 ESM 源码导出对齐（防转译漂移）
    assert.deepEqual(mod.DSH_CAPABILITIES, DSH_CAPABILITIES);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
