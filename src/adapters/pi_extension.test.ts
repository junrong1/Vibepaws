/**
 * pi_extension.ts 单测：事件映射、usage 提取、session id 回退、JSONL 兜底。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { mapEvent, sessionIdOf, deliverToCore, PI_CAPABILITIES } from "./pi_extension.ts";
import type { CoreEvent } from "./pi_extension.ts";

const NOW = "2026-08-21T00:00:00.000Z";
const CWD = "/Users/demo/Vibepaws";
const SID = "pi-uuid-123";

function map(type: string, data: Record<string, unknown> = {}): CoreEvent[] {
  return mapEvent({ type, data, sessionId: SID, cwd: CWD, now: NOW }) as CoreEvent[];
}

/** 取第 n 个事件（断言存在，绕过 noUncheckedIndexedAccess） */
function one(evs: CoreEvent[], index = 0): CoreEvent {
  assert.ok(evs[index], `缺少第 ${index} 个事件`);
  return evs[index]!;
}

test("session_start → adapter_status + session_started（startup）", () => {
  const evs = map("session_start", { reason: "startup" });
  assert.equal(evs.length, 2);
  const status = one(evs, 0);
  const started = one(evs, 1);
  assert.equal(status.event_type, "adapter_status");
  assert.equal(status.agent, "pi");
  // agents 表按 agent 键 upsert，session_id 仅随附（与 hook_agent 的固定 adapter-<agent> 语义不同但等效）
  assert.equal(status.session_id, SID);
  assert.deepEqual(status.payload.capabilities, [...PI_CAPABILITIES]);
  assert.equal(started.event_type, "session_started");
  assert.deepEqual(started.payload, { source: "startup", cwd: CWD, title: "Vibepaws" });
  assert.equal(started.project_id, "/Users/demo/Vibepaws");
});

test("session_start 的 source 映射：resume/fork/reload/new", () => {
  assert.equal(one(map("session_start", { reason: "resume" }), 1).payload.source, "resume");
  assert.equal(one(map("session_start", { reason: "fork" }), 1).payload.source, "fork");
  assert.equal(one(map("session_start", { reason: "reload" }), 1).payload.source, "continue");
  assert.equal(one(map("session_start", { reason: "new" }), 1).payload.source, "startup");
});

test("before_agent_start → agent_working", () => {
  const ev = one(map("before_agent_start"));
  assert.equal(ev.event_type, "agent_working");
  assert.equal(ev.safe_summary, "Working: agent");
  assert.deepEqual(ev.payload, {});
});

test("tool_execution_start → agent_working（带 tool_name）", () => {
  const ev = one(map("tool_execution_start", { toolName: "bash", toolCallId: "t1" }));
  assert.equal(ev.event_type, "agent_working");
  assert.deepEqual(ev.payload, { tool_name: "bash" });
  assert.equal(ev.safe_summary, "Working: bash");
});

test("tool_execution_end：isError → session_error；成功 → 不上报", () => {
  const err = one(map("tool_execution_end", { toolName: "edit", isError: true }));
  assert.equal(err.event_type, "session_error");
  assert.equal(err.severity, "high");
  assert.deepEqual(err.payload, { error_kind: "tool_failed", tool_name: "edit" });
  assert.deepEqual(map("tool_execution_end", { toolName: "edit", isError: false }), []);
});

test("message_end：assistant usage → token_update（tokens+cost）；非 assistant 不上报", () => {
  const ev = one(
    map("message_end", {
      message: { role: "assistant", usage: { inputTokens: 100, outputTokens: 50, cost: { total: 0.012 } } },
    }),
  );
  assert.equal(ev.event_type, "token_update");
  assert.deepEqual(ev.payload, { tokens: 150, cost: 0.012 });
  assert.equal(ev.safe_summary, "Usage update: 150 tokens");
  assert.deepEqual(map("message_end", { message: { role: "user" } }), []);
});

test("message_end：usage 字段名兼容（input_tokens/output_tokens）且无 usage 不上报", () => {
  const ev = one(map("message_end", { message: { role: "assistant", usage: { input_tokens: 10, output_tokens: 5 } } }));
  assert.equal(ev.payload.tokens, 15);
  assert.deepEqual(map("message_end", { message: { role: "assistant" } }), []);
});

test("session_compact → context_update（medium）", () => {
  const ev = one(map("session_compact", { reason: "threshold" }));
  assert.equal(ev.event_type, "context_update");
  assert.equal(ev.severity, "medium");
  assert.equal(ev.safe_summary, "Context compaction");
});

test("agent_settled → decision_required（high，等用户）", () => {
  const ev = one(map("agent_settled"));
  assert.equal(ev.event_type, "decision_required");
  assert.equal(ev.severity, "high");
  assert.deepEqual(ev.payload, { kind: "idle" });
});

test("session_shutdown → session_finished（reason=stopped）", () => {
  const ev = one(map("session_shutdown", { reason: "quit" }));
  assert.equal(ev.event_type, "session_finished");
  assert.deepEqual(ev.payload, { reason: "stopped" });
  assert.equal(ev.safe_summary, "Session finished");
});

test("未知事件 → 空数组（不阻断）", () => {
  assert.deepEqual(map("nope"), []);
});

test("sessionIdOf：UUID 优先，回退文件名，再回退临时 id", () => {
  assert.equal(sessionIdOf({ cwd: "/p", sessionManager: { getSessionId: () => "uuid-1" } }), "uuid-1");
  assert.equal(
    sessionIdOf({ cwd: "/p", sessionManager: { getSessionId: () => undefined, getSessionFile: () => "/x/sess-abc.jsonl" } }),
    "sess-abc",
  );
  const fallback = sessionIdOf({ cwd: "/p", sessionManager: undefined });
  assert.match(fallback, /^pi-\d+-\w+$/);
  // 异常也不该抛
  assert.match(sessionIdOf({ cwd: "/p", sessionManager: { getSessionId: () => { throw new Error("x"); } } }), /^pi-/);
});

test("deliverToCore：Core 离线时写 JSONL 兜底（默认 ~/.vibepaws/events，可注入 fallbackDir）", async () => {
  const dir = mkdtempSync(join(process.cwd(), ".vibepaws", "pi-ext-test-"));
  try {
    const ev: CoreEvent = {
      event_id: "pi-x", seq: 1, agent: "pi", session_id: "s", project_id: dir,
      event_type: "session_started", severity: "low", safe_summary: "x", timestamp: NOW, payload: {},
    };
    const fallbackDir = join(dir, "events");
    // 不可达端口（1）必然连不上 → 走 JSONL 兜底
    const ok = await deliverToCore(ev, dir, 1, fallbackDir);
    assert.equal(ok, false);
    assert.ok(existsSync(fallbackDir), "兜底目录应存在");
    const files = readdirSync(fallbackDir).filter((f) => f.endsWith(".jsonl"));
    assert.ok(files.length > 0, "应有兜底 jsonl");
    const written = readFileSync(join(fallbackDir, files[0]!), "utf-8").trim();
    assert.ok(written.includes('"agent":"pi"'), "兜底事件应含 agent=pi");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
