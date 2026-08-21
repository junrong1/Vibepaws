#!/usr/bin/env node
/**
 * pi_agent.ts — pi-coding-agent 事件发射器（手动兜底 / 其他 harness 路径，架构 §2.1）。
 *
 * pi 的标准接入方式是插件（src/adapters/pi_extension.ts，安装器 `--agent pi` 部署），
 * 确定性挂载 pi 生命周期事件。本脚本是手动兜底：无插件环境、调试、或其他 harness
 * 想手工补发事件时使用。
 *
 * 事件流：pi_agent.ts → deliver（POST Core；Core 离线时写 .vibepaws/events/ JSONL 兜底）
 *        → generic bridge 监听到兜底文件后补发 → Core 落库。
 *
 * 用法（任意 cwd 下成立）：
 *   node --experimental-strip-types <repo>/src/adapters/pi_agent.ts \
 *     --event=session_started [--cwd=<project>] [--session-id=<id>] [--source=startup|resume]
 *   … --event=agent_working --tool=Bash [--file=server.ts]
 *   … --event=decision_required --kind=question --turn-id=<id>
 *   … --event=session_finished --reason=completion --outcome=success
 *
 * 隐私：payload 只进白名单字段；--file 只取 basename；safe_summary 固定措辞。
 * session id：不知道时用 <cwd>/.vibepaws/pi_session.json 记住，后续事件复用同一 id
 * （与 Registry 的 resume 语义一致）；知道的话用 --session-id 覆盖。
 */
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join, basename } from "node:path";
import { deliver } from "./hook_agent.ts";
import { adapterVersion, piCapabilities } from "./hooks.ts";
export { piCapabilities } from "./hooks.ts"; // 测试与安装器共用
import type { CoreEvent, EventPayload, Severity } from "../core/events.ts";

/* ---------------- session 状态（发射器记住 pi 的 session id） ---------------- */

export interface PiSessionState {
  session_id: string;
  project_id: string;
}

export function stateFilePath(cwd: string): string {
  return join(cwd, ".vibepaws", "pi_session.json");
}

export function loadState(cwd: string): PiSessionState | null {
  try {
    const o = JSON.parse(readFileSync(stateFilePath(cwd), "utf-8")) as Partial<PiSessionState>;
    return o && typeof o.session_id === "string" && typeof o.project_id === "string"
      ? { session_id: o.session_id, project_id: o.project_id }
      : null;
  } catch {
    return null; // 无状态文件 / 坏 JSON → 从头开始
  }
}

export function saveState(cwd: string, state: PiSessionState): void {
  mkdirSync(join(cwd, ".vibepaws"), { recursive: true });
  writeFileSync(stateFilePath(cwd), JSON.stringify(state, null, 2) + "\n");
}

/** session 结束后清掉状态，让下一次 session_started 生成新 id（而不是被当成 resume） */
export function clearState(cwd: string): void {
  try {
    unlinkSync(stateFilePath(cwd));
  } catch {
    // 无状态文件，忽略
  }
}

/* ---------------- 参数解析与归一化（可测试的核心） ---------------- */

export interface PiEmitOptions {
  event: string;
  cwd?: string;
  sessionId?: string;
  source?: string;
  tool?: string;
  kind?: string;
  turnId?: string;
  tokens?: number;
  cost?: number;
  contextPct?: number;
  reason?: string;
  outcome?: string;
  errorKind?: string;
  file?: string;
}

export function parseArgs(argv: string[]): PiEmitOptions {
  const get = (name: string): string | undefined => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit?.split("=").slice(1).join("=");
  };
  const num = (name: string): number | undefined => {
    const v = get(name);
    // 空串（--cost=）Number('')===0 是个坑：没传值必须当 undefined，不能当 0
    if (v === undefined || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const opts: PiEmitOptions = {
    event: get("event") ?? "",
    cwd: get("cwd"),
    sessionId: get("session-id"),
    source: get("source"),
    tool: get("tool"),
    kind: get("kind"),
    turnId: get("turn-id"),
    tokens: num("tokens"),
    cost: num("cost"),
    contextPct: num("context-pct"),
    reason: get("reason"),
    outcome: get("outcome"),
    errorKind: get("error-kind"),
    file: get("file"),
  };
  return opts;
}

// 与 piCapabilities()（hooks.ts）/ 插件 PI_CAPABILITIES 对齐的实事件集：
// pi 无 permission 弹窗、无 subagent 概念，resume_command 是能力标记而非可发射事件。
const PI_EVENTS: ReadonlySet<string> = new Set([
  "session_started",
  "agent_working",
  "decision_required",
  "token_update",
  "context_update",
  "session_finished",
  "session_error",
]);

let seqCounter = 0;

function newSessionId(): string {
  return `pi-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeProject(cwd: string): string {
  const path = cwd.replace(/[\\/]+$/, "");
  return path.replace(/\\/g, "/");
}

function severityOf(eventType: string): Severity {
  if (eventType === "decision_required" || eventType === "session_error") return "high";
  if (eventType === "context_update") return "medium";
  return "low";
}

function safeSummary(opts: PiEmitOptions): string {
  switch (opts.event) {
    case "session_started": return "Session started";
    case "agent_working": return `Working: ${opts.tool ?? "agent"}`;
    case "decision_required":
      return opts.kind === "question" ? "Waiting for your answer" : "Waiting for your decision";
    case "token_update": return `Usage update: ${opts.tokens ?? "?"} tokens`;
    case "context_update": return opts.contextPct !== undefined ? `Context: ${opts.contextPct}% used` : "Context compaction";
    case "session_finished": return "Session finished";
    case "session_error": return `Session error: ${opts.errorKind ?? opts.tool ?? "unknown"}`;
    default: return "Event";
  }
}

function payloadOf(opts: PiEmitOptions): EventPayload {
  switch (opts.event) {
    case "session_started": {
      const cwd = opts.cwd ?? process.cwd();
      return { cwd, title: basename(cwd) || undefined, source: (opts.source as EventPayload["source"]) ?? "startup" };
    }
    case "agent_working": {
      const p: EventPayload = {};
      if (opts.tool) p.tool_name = opts.tool;
      if (opts.file) p.file = basename(opts.file); // 只留 basename，防路径泄漏
      return p;
    }
    case "decision_required": {
      const p: EventPayload = { kind: opts.kind ?? "question" };
      if (opts.turnId) p.turn_id = opts.turnId;
      return p;
    }
    case "token_update": {
      const p: EventPayload = {};
      if (opts.tokens !== undefined) p.tokens = opts.tokens;
      if (opts.cost !== undefined) p.cost = opts.cost;
      return p;
    }
    case "context_update": {
      const p: EventPayload = {};
      if (opts.contextPct !== undefined) p.context_pct = opts.contextPct;
      return p;
    }
    case "session_finished": {
      const p: EventPayload = {};
      if (opts.reason) p.reason = opts.reason as EventPayload["reason"];
      if (opts.outcome) p.outcome = opts.outcome as EventPayload["outcome"];
      return p;
    }
    case "session_error": {
      const p: EventPayload = {};
      if (opts.errorKind) p.error_kind = opts.errorKind;
      if (opts.tool) p.tool_name = opts.tool;
      return p;
    }
    default: return {};
  }
}

export interface NormalizedPi {
  ev: CoreEvent;
  /** 落盘用；null = 不改变状态（session_finished 由调用方清状态） */
  nextState: PiSessionState | null;
}

/**
 * 归一化：emit 参数 → CoreEvent（agent="pi"）。
 * state 来自 loadState(cwd)；adapter_status 不参与 session 生命周期。
 * 返回 null = 未知事件（忽略，不阻断）。
 */
export function normalizePiArgs(opts: PiEmitOptions, state: PiSessionState | null): NormalizedPi | null {
  if (opts.event === "adapter_status") {
    const cwd = opts.cwd ?? process.cwd();
    return {
      ev: {
        event_id: `pi-adapter-status-${Date.now()}-${++seqCounter}`,
        seq: ++seqCounter,
        agent: "pi",
        session_id: `adapter-pi`,
        project_id: normalizeProject(cwd),
        event_type: "adapter_status",
        severity: "low",
        safe_summary: "Adapter connected: pi",
        timestamp: new Date().toISOString(),
        payload: { capabilities: piCapabilities(), adapter_version: adapterVersion() },
      },
      nextState: null,
    };
  }

  if (!PI_EVENTS.has(opts.event)) return null;

  const cwd = opts.cwd ?? process.cwd();
  const projectId = normalizeProject(cwd);
  const isStart = opts.event === "session_started";
  const isEnd = opts.event === "session_finished";
  const sessionId = opts.sessionId ?? state?.session_id ?? newSessionId();
  const ev: CoreEvent = {
    event_id: `pi-${opts.event}-${sessionId}-${Date.now()}-${++seqCounter}`,
    seq: ++seqCounter,
    agent: "pi",
    session_id: sessionId,
    project_id: projectId,
    event_type: opts.event as CoreEvent["event_type"],
    severity: severityOf(opts.event),
    safe_summary: safeSummary(opts),
    timestamp: new Date().toISOString(),
    payload: payloadOf(opts),
  };
  // session_started 且没有显式 session-id 时记住新 id；session_finished 后清掉
  const nextState: PiSessionState | null = isEnd ? null : isStart && !opts.sessionId ? { session_id: sessionId, project_id: projectId } : null;
  return { ev, nextState };
}

/* ---------------- CLI 入口 ---------------- */

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const debug = args.includes("--debug");
  const opts = parseArgs(args);
  const cwd = opts.cwd ?? process.cwd();
  const state = loadState(cwd);
  const out = normalizePiArgs(opts, state);
  if (!out) {
    console.error(`[pi] unknown --event=${opts.event || "(missing)"}`);
    process.exit(2);
  }
  // 先落状态再发送：Core 离线时 JSONL 兜底事件也能保持 session 连续性
  if (out.nextState) saveState(cwd, out.nextState);
  else if (out.ev.event_type === "session_finished") clearState(cwd);
  const delivered = await deliver(out.ev);
  if (debug) console.error(`[pi] ${out.ev.event_type} delivered=${delivered}`);
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
