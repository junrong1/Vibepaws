/**
 * hook_agent 归一化单测：Claude Code / Codex hook 输入 → 标准 schema。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  normalizeHook,
  extractCodexUsage,
  extractClaudeTokens,
  extractTranscriptUsage,
  extractUsageFromTranscript,
} from "./hook_agent.ts";

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

/* ---------------- transcript token 提取 ----------------
 *
 * Codex 没有 statusline 那条实时通道，界面上那个「0k」只有这里能填。两种存档的口径**相反**：
 * Codex 的 token_count 每条都是累计值（取最后一条），Claude 的每条是本轮增量（求和）。
 * 记反了不会报错，只会让数字静默地虚高几十倍 —— 所以两条都各留一个测试。
 */

/** 真实 Codex rollout 的形状（字段名照抄 codex-cli 0.153.4 的存档） */
function codexTokenLine(
  total: number,
  last: { total_tokens?: number; reasoning_output_tokens?: number } = {},
  window: number | null = 258_400,
): string {
  const info: Record<string, unknown> = {
    total_token_usage: {
      input_tokens: total - 100,
      cached_input_tokens: total - 500,
      output_tokens: 100,
      reasoning_output_tokens: 40,
      total_tokens: total,
    },
    last_token_usage: {
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: last.total_tokens ?? 15,
      reasoning_output_tokens: last.reasoning_output_tokens ?? 0,
    },
  };
  if (window !== null) info.model_context_window = window;
  return JSON.stringify({
    timestamp: "2026-09-06T02:45:49.629Z",
    type: "event_msg",
    payload: { type: "token_count", info },
  });
}

test("Codex rollout：取最后一条 token_count 的累计值（不是求和）", () => {
  const text = [
    JSON.stringify({ type: "session_meta", payload: { session_id: "s" } }),
    codexTokenLine(1000),
    JSON.stringify({ type: "response_item", payload: { type: "message", content: [{ text: "secret" }] } }),
    codexTokenLine(2500),
    codexTokenLine(9000),
  ].join("\n");
  assert.equal(extractCodexUsage(text)?.tokens, 9000); // 求和会得到 12500
});

test("Codex rollout：没有 token_count（会话刚开/中断）→ null", () => {
  assert.equal(extractCodexUsage(JSON.stringify({ type: "session_meta", payload: {} })), null);
});

test("Claude transcript：逐条 usage 求和（口径与 Codex 相反）", () => {
  const line = (i: number, o: number, c: number): string =>
    JSON.stringify({ message: { usage: { input_tokens: i, output_tokens: o, cache_creation_input_tokens: c } } });
  const text = [line(100, 10, 5), "坏行不是 JSON", line(200, 20, 0)].join("\n");
  assert.equal(extractClaudeTokens(text), 335);
});

test("大文件只读尾巴，仍能拿到 Codex 的累计值", () => {
  const dir = mkdtempSync(join(tmpdir(), "vibepaws-transcript-"));
  const file = join(dir, "rollout.jsonl");
  // 填料把文件顶过 512KB 的尾部窗口，且早期还有一条更小的累计值
  const filler = JSON.stringify({ type: "response_item", payload: { type: "message", text: "x".repeat(4000) } });
  writeFileSync(file, [codexTokenLine(42), ...Array(200).fill(filler), codexTokenLine(777_777)].join("\n"));
  assert.equal(extractUsageFromTranscript(file)?.tokens, 777_777);
});

test("transcript 不存在 / 未给路径 → null（降级，不影响核心循环）", () => {
  assert.equal(extractUsageFromTranscript(undefined), null);
  assert.equal(extractUsageFromTranscript("/nope/does-not-exist.jsonl"), null);
});

/* context_pct 的口径：占窗口的是**最后一轮**，不是累计量。记成累计量的话，一个跑到
 * 15M tokens 的会话会报出 5000%，而界面上那一格只会显示成「满」—— 看不出错。 */

test("Codex context_pct：最后一轮（扣掉 reasoning）占窗口的比例", () => {
  const text = codexTokenLine(9_000_000, { total_tokens: 132_000, reasoning_output_tokens: 2_000 }, 260_000);
  // (132000 - 2000) / 260000 = 50%
  assert.deepEqual(extractCodexUsage(text), { tokens: 9_000_000, context_pct: 50 });
});

test("Codex context_pct：累计量远超窗口也不会溢出（用的不是它）", () => {
  const usage = extractCodexUsage(codexTokenLine(15_000_000, { total_tokens: 26_000 }, 260_000));
  assert.equal(usage?.context_pct, 10);
});

test("Codex 存档没给 model_context_window → 不报 context_pct（宁可留空）", () => {
  const usage = extractCodexUsage(codexTokenLine(1234, { total_tokens: 500 }, null));
  assert.equal(usage?.tokens, 1234);
  assert.equal(usage?.context_pct, undefined);
});

test("Claude 存档没有窗口大小 → 只有 tokens（context 走 statusline 那条通道）", () => {
  const text = JSON.stringify({ message: { usage: { input_tokens: 100, output_tokens: 10 } } });
  assert.deepEqual(extractTranscriptUsage(text), { tokens: 110 });
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
