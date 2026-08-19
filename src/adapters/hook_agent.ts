#!/usr/bin/env node
/**
 * hook_agent.ts — Claude Code / Codex 共享采集模板（架构 §2.1）。
 * 读 stdin JSON → matcher→标准化事件映射 → 白名单提取（丢弃 tool_input/prompt）
 * → safe_summary（固定措辞模板）→ POST Core（失败写 JSONL 兜底）→ exit 0（非阻断）。
 *
 * 用法（由 hooks 配置调用，见 install.ts）：
 *   node src/adapters/hook_agent.ts <event-name>   （stdin 为 hook 输入 JSON）
 */
import { readFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { readApiToken } from "../core/token.ts";
import type { CoreEvent, AgentId } from "../core/events.ts";

function debugLog(line: string): void {
  try {
    const dir = join(".vibepaws", "events");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "hook_debug.log"), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // 忽略
  }
}

/* ---------------- 事件映射（references/event_collection.md §3.2） ---------------- */

interface HookMapping {
  event: CoreEvent["event_type"];
  /** 是否必须带 matcher（claude 用 matcher 细分，codex 直接用 hook_event_name） */
  usesMatcher?: boolean;
}

const MATCHER_MAP: Record<string, HookMapping> = {
  // Claude Code hooks
  SessionStart: { event: "session_started" },
  UserPromptSubmit: { event: "agent_working", usesMatcher: true },
  PreToolUse: { event: "agent_working", usesMatcher: true },
  PostToolUse: { event: "token_update", usesMatcher: true },
  Notification: { event: "decision_required", usesMatcher: true },
  Stop: { event: "decision_required" },
  PermissionRequest: { event: "permission_required" },
  PreCompact: { event: "context_update" },
  PostCompact: { event: "context_update" },
  PostToolUseFailure: { event: "session_error" },
  SessionEnd: { event: "session_finished" },
  SubagentStart: { event: "subagent_started" },
  SubagentStop: { event: "subagent_stopped" },
};

/** matcher 细分（Claude Code）：PostToolUse/PreToolUse 按 tool 决定 */
function refineByTool(
  hookEvent: string,
  toolName: string | undefined,
  base: CoreEvent["event_type"],
): CoreEvent["event_type"] {
  if (hookEvent === "PostToolUse" && toolName && /(^|_)(apply|write|edit|multi_edit|create|insert)$/i.test(toolName)) {
    return "token_update"; // 编辑类工具后通常带 usage
  }
  if (hookEvent === "PostToolUse" && /(fail|error|conflict)/i.test(toolName ?? "")) {
    return "session_error";
  }
  void base;
  return "agent_working";
}

/* ---------------- 归一化（可测试的核心） ---------------- */

export interface HookInput {
  hook_event_name?: string;
  matcher?: string;
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  transcript_path?: string;
  turn_id?: string;
  tool_input?: unknown;
  prompt?: unknown;
  [key: string]: unknown;
}

let seqCounter = 0;

/** hook 原始输入 → CoreEvent（白名单提取，隐私第一道闸） */
export function normalizeHook(
  raw: HookInput,
  agent: AgentId,
  opts: { fallbackCwd?: string } = {},
): CoreEvent | null {
  const hookEvent = raw.hook_event_name ?? "";
  const map = MATCHER_MAP[hookEvent];
  if (!map) return null; // 未知事件忽略（能力声明外的）

  const sessionId = raw.session_id ?? `anon-${Math.random().toString(36).slice(2, 10)}`;
  const cwd = raw.cwd ?? opts.fallbackCwd ?? process.cwd();
  const projectId = normalizeProject(cwd);
  const toolName = typeof raw.tool_name === "string" ? raw.tool_name : undefined;

  // matcher 细分（Claude Code 的 matcher 字段）
  let eventType = map.event;
  if (hookEvent === "PreToolUse" || hookEvent === "PostToolUse") {
    const matcherTool = typeof raw.matcher === "string" ? raw.matcher : toolName;
    eventType = refineByTool(hookEvent, matcherTool ?? toolName, map.event);
  } else if (hookEvent === "Notification" && typeof raw.matcher === "string") {
    eventType = raw.matcher === "usage" ? "token_update" : "decision_required";
  }

  // 白名单 payload（绝不含 tool_input/prompt/代码）
  const payload: CoreEvent["payload"] = {};
  if (eventType === "session_started") payload.source = "startup";
  if (hookEvent === "SessionStart") {
    payload.cwd = cwd;
    payload.title = basename(cwd) || undefined;
  }
  if (toolName) payload.tool_name = toolName;
  if (eventType === "decision_required" || eventType === "permission_required") {
    payload.kind = raw.matcher ?? hookEvent;
    if (raw.turn_id) payload.turn_id = String(raw.turn_id);
  }
  if (eventType === "token_update" && typeof raw.tokens === "number") payload.tokens = raw.tokens;
  if (raw.turn_id) payload.turn_id = String(raw.turn_id);
  void raw.transcript_path; // 明确不使用（隐私）

  return {
    event_id: `hook-${agent}-${sessionId}-${Date.now()}-${++seqCounter}`,
    seq: ++seqCounter,
    agent,
    session_id: sessionId,
    project_id: projectId,
    event_type: eventType,
    severity: eventSeverity(hookEvent, eventType),
    safe_summary: safeSummary(eventType, toolName, raw),
    timestamp: new Date().toISOString(),
    payload,
  };
}

function normalizeProject(cwd: string): string {
  const path = cwd.replace(/[\\/]+$/, "");
  // 归一化：Windows 反斜杠 → 斜杠（隐私：保留项目路径用于分组，已属白名单）
  return path.replace(/\\/g, "/");
}

function eventSeverity(hookEvent: string, eventType: CoreEvent["event_type"]): CoreEvent["severity"] {
  if (eventType === "decision_required" || eventType === "permission_required" || eventType === "session_error") return "high";
  if (eventType === "context_update" || eventType === "topic_drift_warning") return "medium";
  return "low";
}

/** safe_summary：固定措辞模板，不含任何用户内容 */
function safeSummary(
  eventType: CoreEvent["event_type"],
  toolName: string | undefined,
  raw: HookInput,
): string {
  switch (eventType) {
    case "session_started": return "Session started";
    case "agent_working": return `Working: ${toolName ?? "agent"}`;
    case "decision_required": return `Needs decision (${raw.matcher ?? "notification"})`;
    case "permission_required": return `Tool permission needed: ${toolName ?? "unknown"}`;
    case "token_update": return `Usage update: ${raw.tokens ?? "?"} tokens`;
    case "context_update": return "Context compaction";
    case "session_error": return `Tool failed: ${toolName ?? "unknown"}`;
    case "session_finished": return "Session finished";
    case "subagent_started": return `Subagent started: ${toolName ?? "subagent"}`;
    case "subagent_stopped": return "Subagent stopped";
    default: return "Event";
  }
}

/* ---------------- 发送（POST + JSONL 兜底） ---------------- */

/**
 * SessionEnd 时从 transcript 提取 token 消耗（Claude Code JSONL：assistant message.usage）。
 * 隐私：只提取数字，不读代码/文本内容。返回 null 表示无法提取（降级，不影响核心循环）。
 */
export function extractTokensFromTranscript(transcriptPath: string | undefined): number | null {
  if (!transcriptPath) return null;
  try {
    const content = readFileSync(transcriptPath, "utf-8");
    let total = 0;
    let found = false;
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as {
          message?: { usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number } };
        };
        const u = obj.message?.usage;
        if (u) {
          found = true;
          total += (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        }
      } catch {
        // 跳过坏行
      }
    }
    return found ? total : null;
  } catch {
    return null; // 文件不存在/不可读 → 降级
  }
}

export async function deliver(ev: CoreEvent, corePort = 17893): Promise<boolean> {
  const token = readApiToken();
  try {
    const res = await fetch(`http://127.0.0.1:${corePort}/events`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-vibepaws-token": token },
      body: JSON.stringify(ev),
    });
    if (res.ok) return true;
    // fallthrough: 非 2xx 也走 JSONL 兜底
  } catch {
    // Core 离线 → JSONL 兜底
  }
  const dir = join(".vibepaws", "events");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "fallback.jsonl"), JSON.stringify(ev) + "\n");
  return false;
}

/* ---------------- CLI 入口 ---------------- */

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const agent = (args.find((a) => a.startsWith("--agent="))?.split("=")[1] ?? "generic") as AgentId;
  const debug = args.includes("--debug");
  let stdin = "";
  process.stdin.on("data", (c) => (stdin += c));
  process.stdin.on("end", async () => {
    try {
      const raw = stdin.trim() ? (JSON.parse(stdin) as HookInput) : {};
      if (debug) debugLog(`RAW INPUT: ${JSON.stringify(raw)}`);
      const ev = normalizeHook(raw, agent);
      if (ev) {
        const delivered = await deliver(ev);
        if (debug) debugLog(`${ev.event_type} delivered=${delivered} payload=${JSON.stringify(ev.payload)}`);
        // SessionEnd：从 transcript 提取 token 总量 → 补发 token_update（一次性总量）
        if (ev.event_type === "session_finished") {
          const tokens = extractTokensFromTranscript(raw.transcript_path);
          if (tokens !== null && tokens > 0) {
            const tokenEv: CoreEvent = {
              event_id: `hook-token-${Date.now()}-${++seqCounter}`,
              seq: ++seqCounter,
              agent: ev.agent,
              session_id: ev.session_id,
              project_id: ev.project_id,
              event_type: "token_update",
              severity: "low",
              safe_summary: `Session total tokens: ${tokens}`,
              timestamp: new Date().toISOString(),
              payload: { tokens },
            };
            const ok = await deliver(tokenEv);
            if (debug) debugLog(`token_update(${tokens}) delivered=${ok}`);
          } else if (debug) {
            debugLog(`no tokens extracted from transcript: ${raw.transcript_path}`);
          }
        }
      } else if (debug) {
        debugLog(`ignored (no mapping): ${raw.hook_event_name}`);
      }
    } catch (err) {
      console.error("[hook] error:", err);
    }
    // 非阻断：始终 exit 0（MVP 只监听，不做 allow/deny）
    process.exit(0);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
