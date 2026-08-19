/**
 * hook_agent 归一化单测：Claude Code / Codex hook 输入 → 标准 schema。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeHook } from "./hook_agent.ts";

test("Claude Code SessionStart → session_started（白名单含 cwd/title，无敏感字段）", () => {
  const ev = normalizeHook(
    {
      hook_event_name: "SessionStart",
      session_id: "s-cc-1",
      cwd: "/Users/demo/api",
      transcript_path: "/Users/demo/.claude/projects/x/s-cc-1.jsonl",
      tool_input: { secret: "TOP" },
      prompt: "hidden prompt",
    },
    "claude_code",
  )!;
  assert.equal(ev.event_type, "session_started");
  assert.equal(ev.session_id, "s-cc-1");
  assert.equal(ev.project_id, "/Users/demo/api");
  assert.equal(ev.payload.source, "startup");
  assert.equal(ev.safe_summary, "Session started");
  assert.equal((ev.payload as Record<string, unknown>).tool_input, undefined);
  assert.equal((ev.payload as Record<string, unknown>).prompt, undefined);
  // transcript_path 绝不进 payload
  assert.deepEqual(Object.keys(ev.payload).sort(), ["cwd", "source", "title"]);
});

test("Claude Code PreToolUse(Bash) → agent_working + tool_name", () => {
  const ev = normalizeHook(
    { hook_event_name: "PreToolUse", matcher: "Bash", session_id: "s-1", cwd: "/p", tool_name: "Bash" },
    "claude_code",
  )!;
  assert.equal(ev.event_type, "agent_working");
  assert.equal(ev.payload.tool_name, "Bash");
});

test("Claude Code PreToolUse(AskUserQuestion) → decision_required（ask-user 弹气泡）", () => {
  const ev = normalizeHook(
    { hook_event_name: "PreToolUse", session_id: "s-1", cwd: "/p", tool_name: "AskUserQuestion" },
    "claude_code",
  )!;
  assert.equal(ev.event_type, "decision_required");
  assert.equal(ev.payload.kind, "question");
  assert.equal(ev.severity, "high");
  assert.match(ev.safe_summary, /answer/);
});

test("Claude Code PostToolUse(AskUserQuestion) → agent_working（已作答，不再弹气泡）", () => {
  const ev = normalizeHook(
    { hook_event_name: "PostToolUse", session_id: "s-1", cwd: "/p", tool_name: "AskUserQuestion" },
    "claude_code",
  )!;
  assert.equal(ev.event_type, "agent_working");
  assert.equal(ev.payload.kind, undefined);
});

test("Claude Code PermissionRequest → permission_required(high)", () => {
  const ev = normalizeHook(
    { hook_event_name: "PermissionRequest", session_id: "s-1", cwd: "/p", tool_name: "Write" },
    "claude_code",
  )!;
  assert.equal(ev.event_type, "permission_required");
  assert.equal(ev.severity, "high");
  assert.match(ev.safe_summary, /Write/);
});

test("Claude Code Notification(usage) → token_update", () => {
  const ev = normalizeHook(
    { hook_event_name: "Notification", matcher: "usage", session_id: "s-1", cwd: "/p", tokens: 12345 },
    "claude_code",
  )!;
  assert.equal(ev.event_type, "token_update");
  assert.equal(ev.payload.tokens, 12345);
});

test("Claude Code SessionEnd → session_finished", () => {
  const ev = normalizeHook({ hook_event_name: "SessionEnd", session_id: "s-1", cwd: "/p" }, "claude_code")!;
  assert.equal(ev.event_type, "session_finished");
});

test("Codex Stop → decision_required + turn_id", () => {
  const ev = normalizeHook(
    { hook_event_name: "Stop", session_id: "codex-s1", cwd: "/p", turn_id: "t-9" },
    "codex",
  )!;
  assert.equal(ev.event_type, "decision_required");
  assert.equal(ev.payload.turn_id, "t-9");
});

test("未知 hook 事件 → null（忽略）", () => {
  assert.equal(normalizeHook({ hook_event_name: "UnknownEvent" }, "codex"), null);
});

test("PostToolUseFailure → session_error", () => {
  const ev = normalizeHook(
    { hook_event_name: "PostToolUseFailure", session_id: "s-1", cwd: "/p", tool_name: "Edit" },
    "claude_code",
  )!;
  assert.equal(ev.event_type, "session_error");
});
