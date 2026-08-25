/**
 * hook_agent 归一化单测：Claude Code / Codex hook 输入 → 标准 schema。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

/* ---------------- Token 信任的两条不变量（landscape 0.12 / clawd #102） ----------------
 *
 * 界面和 README 都在向用户断言「宠物花不掉你的 token」。那句话的依据不是善意，
 * 而是两个具体事实：hook 不往 stdout 写东西，且永远以 0 退出。
 *
 * stdout 为什么是唯一要紧的通道：Claude Code 会把某些 hook（`UserPromptSubmit`）
 * 的 stdout **当成上下文注入**给模型，非零退出码的 stderr 也会被回喂。也就是说
 * 一条随手加的 `console.log` 调试语句，真的会开始花用户的 token —— 而它看起来
 * 完全无害，谁都不会想到要为它写测试。所以这里对源码本身设一道闸。
 */
const HOOK_AGENT_SRC = readFileSync(new URL("./hook_agent.ts", import.meta.url), "utf-8");

test("hook 不往 stdout 写一个字节（stdout 会被 agent 当成上下文注入）", () => {
  const offenders = HOOK_AGENT_SRC.split("\n")
    .map((line, i) => ({ line, no: i + 1 }))
    .filter(({ line }) => /\bconsole\.(log|info|debug)\b|\bprocess\.stdout\b/.test(line));
  assert.deepEqual(
    offenders.map((o) => `${o.no}: ${o.line.trim()}`),
    [],
    "调试输出请走 console.error（stderr）或 debugLog（文件）",
  );
});

test("hook 永远以 0 退出（非零退出会让 stderr 被回喂给模型）", () => {
  const exits = [...HOOK_AGENT_SRC.matchAll(/process\.exit\(([^)]*)\)/g)].map((m) => m[1]?.trim());
  assert.ok(exits.length > 0, "main 里那句 process.exit(0) 是「非阻断」的保证，不该消失");
  assert.deepEqual([...new Set(exits)], ["0"]);
});
