/**
 * pi_agent.ts 归一化单测：事件映射、白名单 payload、safe_summary、session 状态复用。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseArgs,
  normalizePiArgs,
  loadState,
  saveState,
  clearState,
  piCapabilities,
  type PiEmitOptions,
} from "./pi_agent.ts";

const base: PiEmitOptions = { event: "session_started", cwd: "/Users/demo/proj" };

function norm(opts: PiEmitOptions, state: ReturnType<typeof loadState> = null) {
  return normalizePiArgs(opts, state);
}

test("session_started：默认 source=startup，payload 带 cwd/title", () => {
  const out = norm(base);
  assert.ok(out);
  assert.equal(out.ev.agent, "pi");
  assert.equal(out.ev.event_type, "session_started");
  assert.equal(out.ev.project_id, "/Users/demo/proj");
  assert.deepEqual(out.ev.payload, { cwd: "/Users/demo/proj", title: "proj", source: "startup" });
  assert.equal(out.ev.safe_summary, "Session started");
});

test("session_started：无显式 session-id 时生成并记住新 id", () => {
  const out = norm({ event: "session_started", cwd: "/p" });
  assert.ok(out);
  assert.match(out.ev.session_id, /^pi-/);
  assert.ok(out.nextState, "应生成 nextState 供落盘");
  assert.equal(out.nextState!.session_id, out.ev.session_id);
});

test("session_started：显式 --session-id 时复用且不改状态", () => {
  const out = norm({ event: "session_started", cwd: "/p", sessionId: "s-42" });
  assert.ok(out);
  assert.equal(out.ev.session_id, "s-42");
  assert.equal(out.nextState, null, "显式 id 无需落盘");
});

test("后续事件复用状态文件里的 session id", () => {
  const state = { session_id: "pi-live-1", project_id: "/p" };
  const out = norm({ event: "agent_working", cwd: "/p", tool: "Bash" }, state);
  assert.ok(out);
  assert.equal(out.ev.session_id, "pi-live-1");
  assert.equal(out.ev.event_type, "agent_working");
  assert.equal(out.ev.safe_summary, "Working: Bash");
  assert.deepEqual(out.ev.payload, { tool_name: "Bash" });
});

test("agent_working：--file 只留 basename（防路径泄漏）", () => {
  const out = norm({ event: "agent_working", cwd: "/p", file: "/Users/demo/proj/src/secret.ts" });
  assert.ok(out);
  assert.equal((out.ev.payload as Record<string, unknown>).file, "secret.ts");
});

test("decision_required：kind=question → 等待回答措辞 + turn_id", () => {
  const out = norm({ event: "decision_required", cwd: "/p", kind: "question", turnId: "t-9" });
  assert.ok(out);
  assert.equal(out.ev.severity, "high");
  assert.equal(out.ev.safe_summary, "Waiting for your answer");
  assert.deepEqual(out.ev.payload, { kind: "question", turn_id: "t-9" });
});

test("token_update：数字字段保留，坏值丢弃", () => {
  const out = norm({ event: "token_update", cwd: "/p", tokens: 1234, cost: 0.05 });
  assert.ok(out);
  assert.equal(out.ev.safe_summary, "Usage update: 1234 tokens");
  assert.deepEqual(out.ev.payload, { tokens: 1234, cost: 0.05 });
  // parseArgs 层面坏值 → undefined
  const parsed = parseArgs(["--event=token_update", "--tokens=abc", "--cost="]);
  assert.equal(parsed.tokens, undefined);
  assert.equal(parsed.cost, undefined);
});

test("context_update：带 pct 与不带 pct 的措辞", () => {
  const a = norm({ event: "context_update", cwd: "/p", contextPct: 85 });
  assert.equal(a?.ev.safe_summary, "Context: 85% used");
  assert.equal(a?.ev.severity, "medium");
  const b = norm({ event: "context_update", cwd: "/p" });
  assert.equal(b?.ev.safe_summary, "Context compaction");
});

test("session_finished：nextState=null（调用方清状态）", () => {
  const out = norm({ event: "session_finished", cwd: "/p", reason: "completion", outcome: "success" }, { session_id: "pi-live-1", project_id: "/p" });
  assert.ok(out);
  assert.equal(out.ev.session_id, "pi-live-1", "结束事件复用已有 id");
  assert.equal(out.nextState, null);
  assert.deepEqual(out.ev.payload, { reason: "completion", outcome: "success" });
});

test("session_error：error_kind 进 payload，severity=high", () => {
  const out = norm({ event: "session_error", cwd: "/p", errorKind: "tool_failed", tool: "Edit" });
  assert.ok(out);
  assert.equal(out.ev.severity, "high");
  assert.deepEqual(out.ev.payload, { error_kind: "tool_failed", tool_name: "Edit" });
});

test("adapter_status：能力声明 + 版本，固定 session_id=adapter-pi", () => {
  const out = norm({ event: "adapter_status", cwd: "/p" });
  assert.ok(out);
  assert.equal(out.ev.event_type, "adapter_status");
  assert.equal(out.ev.session_id, "adapter-pi");
  assert.ok(out.ev.payload.capabilities?.includes("session_started"));
  assert.ok(out.ev.payload.capabilities?.includes("resume_command"));
  assert.equal(out.nextState, null);
  assert.equal(piCapabilities().length, 8, "对齐插件真实事件集");
});

test("未知事件 → null（不阻断）", () => {
  assert.equal(norm({ event: "hack", cwd: "/p" }), null);
  assert.equal(norm({ event: "", cwd: "/p" }), null);
});

test("pi 无权限/子代理事件：手动发射器也不发（与 piCapabilities 对齐）", () => {
  assert.equal(norm({ event: "permission_required", cwd: "/p" }), null);
  assert.equal(norm({ event: "subagent_started", cwd: "/p" }), null);
  assert.equal(norm({ event: "subagent_stopped", cwd: "/p" }), null);
  assert.ok(!piCapabilities().includes("permission_required"));
  assert.ok(!piCapabilities().includes("subagent_started"));
});

test("parseArgs：全参数解析", () => {
  const opts = parseArgs([
    "--event=session_started", "--cwd=/p", "--session-id=s1", "--source=resume",
    "--tool=Bash", "--kind=question", "--turn-id=t1", "--tokens=100", "--context-pct=50",
    "--reason=stopped", "--outcome=partial", "--error-kind=e", "--file=a.ts",
  ]);
  assert.equal(opts.event, "session_started");
  assert.equal(opts.cwd, "/p");
  assert.equal(opts.sessionId, "s1");
  assert.equal(opts.source, "resume");
  assert.equal(opts.tool, "Bash");
  assert.equal(opts.kind, "question");
  assert.equal(opts.turnId, "t1");
  assert.equal(opts.tokens, 100);
  assert.equal(opts.contextPct, 50);
  assert.equal(opts.reason, "stopped");
  assert.equal(opts.outcome, "partial");
  assert.equal(opts.errorKind, "e");
  assert.equal(opts.file, "a.ts");
});

test("session 状态文件：save → load → clear 往返", () => {
  // 用 tmpdir() 而不是 <repo>/.vibepaws：那个目录是 gitignore 的运行期产物，
  // 干净 checkout 上根本不存在 —— 测试会以 ENOENT 挂掉，而在任何跑过一次 app 的
  // 机器上都是绿的。CI 第一次真跑起来时，四个用例就是这么红的。
  const dir = mkdtempSync(join(tmpdir(), "vibepaws-pi-state-test-"));
  try {
    assert.equal(loadState(dir), null);
    saveState(dir, { session_id: "pi-fs-1", project_id: dir });
    assert.deepEqual(loadState(dir), { session_id: "pi-fs-1", project_id: dir });
    clearState(dir);
    assert.equal(loadState(dir), null);
    assert.equal(existsSync(join(dir, ".vibepaws", "pi_session.json")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
