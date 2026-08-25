#!/usr/bin/env node
/**
 * Vibepaws × pi-coding-agent adapter —— pi 插件（extension）。
 *
 * pi 的稳定集成方式就是插件：本文件挂到 pi 生命周期事件上，把 pi 的真实状态
 * 确定性地上报给 Vibepaws Core（agent="pi"）。相比 skill（靠模型自觉调用），
 * 插件是机器级事件钩子，与 Claude Code / Codex 的 hooks 同一层级。
 *
 * 安装（由 install.ts 复制本文件）：
 *   项目级：<repo>/.pi/extensions/vibepaws.ts（pi 自动发现，需项目被信任）
 *   全局：  ~/.pi/agent/extensions/vibepaws.ts（所有项目生效）
 *
 * 事件映射（与 CoreEvent 对齐）：
 *   session_start         → session_started（source: startup/resume/fork/continue）+ adapter_status
 *   before_agent_start    → agent_working（用户提交了新需求）
 *   tool_execution_start  → agent_working（带 tool_name）
 *   tool_execution_end    → session_error（isError 时；成功不重复报）
 *   message_end           → token_update（assistant 消息的真实 token/cost）
 *   session_compact       → context_update
 *   agent_settled         → decision_required（agent 忙完在等你 = Claude 的 Stop）
 *   session_shutdown      → session_finished
 *
 * 隐私：payload 只进白名单字段，safe_summary 固定措辞，绝不带 prompt/代码/路径。
 * 兜底：Core 离线时写 ~/.vibepaws/events/pi_*.jsonl（用户级，插件自包含、不知道仓库路径），
 * generic bridge 会连同仓库根 .vibepaws/events 一起补收。
 *
 * 注意：本文件零外部运行时依赖（不 import pi 包，类型用最小本地接口，可独立 typecheck）；
 * 运行在 pi 的 jiti 环境，pi.on / ctx.sessionManager 由 pi 提供。
 */
import { readFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { homedir } from "node:os";

/* ---------------- 最小接口（pi 运行时提供真实对象） ---------------- */

interface PiSessionManager {
  getSessionId?(): string | undefined;
  getSessionFile?(): string | undefined;
}
interface PiCtx {
  cwd: string;
  sessionManager?: PiSessionManager;
  hasUI?: boolean;
  [key: string]: unknown;
}
type PiEventData = Record<string, unknown>;
type PiHandler = (event: PiEventData, ctx: PiCtx) => Promise<unknown> | unknown;
interface PiAPI {
  on(event: string, handler: PiHandler): void;
}

/* ---------------- Core 事件（最小本地类型，与 src/core/events.ts 对齐） ---------------- */

type Severity = "low" | "medium" | "high";

export interface CoreEvent {
  event_id: string;
  seq: number;
  agent: string;
  session_id: string;
  project_id: string;
  event_type: string;
  severity: Severity;
  safe_summary: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

const CORE_PORT = 17893;
const AGENT = "pi";

/** 能力声明：对齐本插件真实能发的事件（无 statusline 实时通道，token 来自 message usage） */
export const PI_CAPABILITIES: readonly string[] = [
  "session_started",
  "agent_working",
  "decision_required",
  "token_update",
  "context_update",
  "session_finished",
  "session_error",
  "resume_command",
];

let seqCounter = 0;
let fileSeq = 0;

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function normalizeProject(cwd: string): string {
  const path = cwd.replace(/[\\/]+$/, "");
  return path.replace(/\\/g, "/");
}

/** session id：优先 pi 的 UUID，回退到 session 文件名，再回退到临时 id */
export function sessionIdOf(ctx: PiCtx): string {
  try {
    const sm = ctx.sessionManager;
    const id = sm?.getSessionId?.();
    if (id) return id;
    const file = sm?.getSessionFile?.();
    if (file) {
      const base = basename(file).replace(/\.(jsonl|json)$/i, "");
      if (base) return base;
    }
  } catch {
    // 回退
  }
  return `pi-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 项目根 package.json 版本（只有确实在 Vibepaws 仓库里才报，避免别的项目版本号误导） */
function adapterVersionOf(cwd: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf-8")) as {
      name?: string;
      version?: string;
    };
    return pkg.name === "vibepaws" ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

/** assistant usage → token 总量（字段名跨 provider 有差异，防御式取值） */
function totalTokens(u: Record<string, unknown>): number | undefined {
  const direct = num(u.totalTokens);
  if (direct !== undefined) return direct;
  const input =
    num(u.inputTokens) ?? num(u.input_tokens) ?? num(u.promptTokens) ?? num(u.prompt_tokens) ?? 0;
  const output =
    num(u.outputTokens) ?? num(u.output_tokens) ?? num(u.completionTokens) ?? num(u.completion_tokens) ?? 0;
  return input !== 0 || output !== 0 || "inputTokens" in u || "outputTokens" in u ? input + output : undefined;
}

export interface MapInput {
  type: string;
  data: PiEventData;
  sessionId: string;
  cwd: string;
  now?: string;
  /**
   * agent 进程的 pid（僵尸回收 G10）。插件跑在 pi 进程**内部**，所以调用方传的是
   * `process.pid` —— 这是最干净的一路：不需要猜 ppid，也没有包装 shell 的歧义。
   * 参数化而不是直接读 process.pid，是为了让 mapEvent 保持纯函数（单测可断言）。
   */
  pid?: number;
}

/**
 * pi 事件 → CoreEvent 列表（纯函数，可测试）。
 * 返回空数组 = 该事件不上报（成功类 tool_execution_end、非 assistant message 等）。
 */
export function mapEvent({ type, data, sessionId, cwd, now, pid }: MapInput): CoreEvent[] {
  const ts = now ?? new Date().toISOString();
  const projectId = normalizeProject(cwd);
  const mk = (
    eventType: string,
    payload: Record<string, unknown>,
    summary: string,
    severity: Severity = "low",
  ): CoreEvent => ({
    event_id: `pi-${eventType}-${sessionId}-${Date.now()}-${++seqCounter}`,
    seq: ++seqCounter,
    agent: AGENT,
    session_id: sessionId,
    project_id: projectId,
    event_type: eventType,
    severity,
    safe_summary: summary,
    timestamp: ts,
    // pid 挂在每条事件上，不只是 session_start：Core 要同一个 pid 出现两次才采信它
    // （见 core/reclaim.ts 的 notePid）。
    payload: pid === undefined ? payload : { ...payload, pid },
  });

  switch (type) {
    case "session_start": {
      const reason = String(data.reason ?? "startup");
      const source =
        reason === "resume" ? "resume" : reason === "fork" ? "fork" : reason === "reload" ? "continue" : "startup";
      return [
        mk("adapter_status", { capabilities: [...PI_CAPABILITIES], adapter_version: adapterVersionOf(cwd) }, "Adapter connected: pi"),
        mk("session_started", { source, cwd, title: basename(cwd) || undefined }, "Session started"),
      ];
    }
    case "before_agent_start":
      return [mk("agent_working", {}, "Working: agent")];
    case "tool_execution_start": {
      const tool = String(data.toolName ?? "");
      return [mk("agent_working", tool ? { tool_name: tool } : {}, `Working: ${tool || "agent"}`)];
    }
    case "tool_execution_end": {
      if (data.isError !== true) return []; // 成功路径不重复报 working
      const tool = String(data.toolName ?? "unknown");
      const payload: Record<string, unknown> = { error_kind: "tool_failed" };
      if (tool !== "unknown") payload.tool_name = tool;
      return [mk("session_error", payload, `Tool failed: ${tool}`, "high")];
    }
    case "message_end": {
      const msg = (data.message ?? {}) as Record<string, unknown>;
      if (msg.role !== "assistant") return [];
      const usage = (msg.usage ?? {}) as Record<string, unknown>;
      const tokens = totalTokens(usage);
      if (tokens === undefined) return [];
      const cost = num(((usage.cost ?? {}) as Record<string, unknown>).total);
      const payload: Record<string, unknown> = { tokens };
      if (cost !== undefined) payload.cost = cost;
      return [mk("token_update", payload, `Usage update: ${tokens} tokens`)];
    }
    case "session_compact":
      return [mk("context_update", {}, "Context compaction", "medium")];
    case "agent_settled":
      return [mk("decision_required", { kind: "idle" }, "Waiting for your decision", "high")];
    case "session_shutdown":
      return [mk("session_finished", { reason: "stopped" }, "Session finished")];
    default:
      return [];
  }
}

/* ---------------- 发送（POST + JSONL 兜底，与 hook_agent 的 deliver 同一语义） ---------------- */

function readApiToken(cwd: string): string {
  for (const p of [join(homedir(), ".vibepaws", "api_token"), join(cwd, ".vibepaws", "api_token")]) {
    try {
      const t = readFileSync(p, "utf-8").trim();
      if (t) return t;
    } catch {
      // 试下一个
    }
  }
  return "";
}

export async function deliverToCore(
  ev: CoreEvent,
  cwd: string,
  port = CORE_PORT,
  fallbackDir = join(homedir(), ".vibepaws", "events"),
): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/events`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-vibepaws-token": readApiToken(cwd) },
      body: JSON.stringify(ev),
    });
    if (res.ok) return true;
  } catch {
    // Core 离线 → 兜底
  }
  try {
    if (!existsSync(fallbackDir)) mkdirSync(fallbackDir, { recursive: true });
    appendFileSync(join(fallbackDir, `pi_${Date.now()}_${++fileSeq}.jsonl`), JSON.stringify(ev) + "\n");
  } catch {
    // 兜底也失败：不阻断 pi
  }
  return false;
}

/* ---------------- 插件入口 ---------------- */

/** 订阅的 pi 事件（键 = pi 事件名，值与 mapEvent 的 type 一致） */
const SUBSCRIPTIONS: readonly string[] = [
  "session_start",
  "before_agent_start",
  "tool_execution_start",
  "tool_execution_end",
  "message_end",
  "session_compact",
  "agent_settled",
  "session_shutdown",
];

export default function (pi: PiAPI): void {
  for (const name of SUBSCRIPTIONS) {
    pi.on(name, (event, ctx) => {
      try {
        // process.pid 就是 pi 自己：插件在 pi 进程里跑，这是最准的一路探活输入（G10）
        for (const ev of mapEvent({
          type: name,
          data: event,
          sessionId: sessionIdOf(ctx),
          cwd: ctx.cwd,
          pid: process.pid,
        })) {
          void deliverToCore(ev, ctx.cwd);
        }
      } catch {
        // 任何异常都不允许打断 pi
      }
    });
  }
}
