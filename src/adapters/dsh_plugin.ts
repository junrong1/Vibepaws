#!/usr/bin/env node
/**
 * dsh_plugin.ts — Vibepaws × DeepSeek Harness adapter（Cordis 插件）。
 *
 * DeepSeek Harness 的稳定集成方式就是 Cordis 插件：本文件导出 `name` / `inject` /
 * `apply(ctx)`，挂到 Harness 的生命周期事件上，把 dsh 的真实状态确定性地上报给
 * Vibepaws Core（agent="dsh"）。与 Claude Code / Codex 的 hooks、pi 的 extension
 * 同一层级 —— 都是机器级事件钩子，而不是靠模型自觉调用的 skill。
 *
 * 安装（由 install.ts 复制本文件到 dsh 项目，或手工写 cordis patch）：
 *   cordis.yml 一行 patch：
 *     - insert:
 *         - id: vibepaws
 *           name: '/absolute/path/to/dsh_plugin.ts'
 *   然后 `dsh web --patch ./cordis.yml`（或 `pnpm dsh web --patch ./cordis.yml`）。
 *
 * 事件映射（与 CoreEvent 对齐，见 src/core/events.ts）：
 *   agent/created        → session_started + adapter_status
 *   agent/disposed       → session_finished
 *   session/event 里的：
 *     turn/start         → agent_working（新一轮开始）
 *     user/message(直接提示) → agent_working
 *     tool/call          → agent_working（带 tool_name）
 *     tool/call(ask_user_question) → decision_required（问用户问题，等回答）
 *     tool/result(出错)  → session_error
 *     assistant/message  → token_update（按 session 累计的真实 token）+ context_update
 *     compaction/start   → context_update（配合 token-meter 算 context_pct）
 *     approval/request   → permission_required（工具审批，等用户；cordis 实时事件）
 *     approval/asked     → 不上报（session 审计，避免与 approval/request 双发）
 *     approval/decided   → agent_working（用户已回应）
 *     turn/end blocked   → decision_required（agent 忙完在等你）
 *     turn/end error     → session_error
 *     subagent/descriptor → subagent_started
 *
 *   错误只走 turn/end error 这一条路：dsh 对同一次 turn 失败会先发 out-of-band 的
 *   agent/error（{turn, step, error, agent}，不在 session 事件流里）再补 turn/end error；
 *   两个都监听会对同一次失败双发 session_error。session/event 是单一事实来源且自带
 *   session（cwd 准确），所以 agent/error 有意不监听（mapAgentError 保留为可复用映射）。
 *
 * 隐私：payload 只进白名单字段，safe_summary 固定措辞，绝不带 prompt / 代码 / 路径 /
 *      tool arguments / message content。token 只发数字，context 只发百分比。
 * 兜底：Core 离线时写 ~/.vibepaws/events/dsh_*.jsonl（用户级，插件自包含、不知道仓库路径），
 *      generic bridge 会连同仓库根 .vibepaws/events 一起补收。
 *
 * 注意：本文件零外部运行时依赖（不 import @deepseek-ai/* 包，类型用最小本地接口，
 *      可独立 typecheck / 复制到任意 dsh 项目）。运行环境是 Node 原生 type stripping
 *      （Node ≥ 22.18 默认开启；22.6–22.17 需 --experimental-strip-types；dsh 发布版
 *      不带 jiti/tsx）；ctx.on / ctx.get 由 Cordis 提供。
 */
import { readFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/* ---------------- 最小接口（dsh / Cordis 运行时提供真实对象） ---------------- */

/** Cordis 插件上下文的最小面：我们只用 on() 与可选的 get()。 */
export interface DshContext {
  on(event: string, handler: (...args: any[]) => unknown): void;
  get?(name: string): unknown;
  [key: string]: unknown;
}

/** dsh 的 Session 最小面（真实对象是 @deepseek-ai/dsh-session 的 Session）。 */
export interface DshSession {
  id?: string;
  header?: { cwd?: string; [key: string]: unknown };
  requestContext?: () => { contextWindow?: number } | undefined;
  [key: string]: unknown;
}

/** dsh 的持久化事件信封最小面（SessionEvent）。 */
export interface DshSessionEvent {
  type?: string;
  data?: Record<string, unknown>;
  [key: string]: unknown;
}

/** 插件配置（cordis.yml 的 config 块），全部可选、带默认值。 */
export interface DshConfig {
  /** Vibepaws Core 端口（默认 17893） */
  port?: number;
  /** 上报的 agent id（默认 "dsh"） */
  agent?: string;
  /** adapter 版本号（adapter_status 用；不填则省略） */
  adapter_version?: string;
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
const DEFAULT_AGENT = "dsh";

/** 能力声明：对齐本插件真实能发的事件（与 hooks.ts 的 dshCapabilities 保持一致） */
export const DSH_CAPABILITIES: readonly string[] = [
  "session_started",
  "agent_working",
  "decision_required",
  "permission_required",
  "token_update",
  "context_update",
  "session_finished",
  "session_error",
  "subagent_started",
];

let seqCounter = 0;
let fileSeq = 0;

/* ---------------- 类型收窄（strict + noUncheckedIndexedAccess 友好） ---------------- */

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function obj(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

function normalizeProject(cwd: string): string {
  const path = cwd.replace(/[\\/]+$/, "");
  return path.replace(/\\/g, "/");
}

/* ---------------- session 身份与 cwd 提取 ---------------- */

export function sessionIdOf(session: DshSession | undefined, fallback?: string): string {
  // 兼容两种真实对象：dsh Session（id 在自身上）与 ReactLoopAgent
  // （agent/created、agent/disposed、agent/error 的 payload.agent 是它，
  //  真正的 session id 在 .session.id 上，自身 .id 是 agent 自己的 id）。
  //  必须先取嵌套的 .session.id：否则 agent/created（ReactLoopAgent）拿的是 agent id，
  //  而 session/event（Session）拿的是 session id，两者不一致 → Core 会建两个 session。
  const nested = str((session as { session?: DshSession } | undefined)?.session?.id);
  if (nested) return nested;
  const id = str(session?.id);
  if (id) return id;
  if (fallback) return fallback;
  return `dsh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function cwdOf(session: DshSession | undefined): string {
  // 兼容两种真实对象：dsh Session（header.cwd 在自身上）与 ReactLoopAgent
  // （agent/created、agent/disposed、agent/error 的 payload.agent 是它，
  //  cwd 在 .session.header.cwd 上，自身没有 header）。都取不到才回退 process.cwd()。
  const direct = str(session?.header?.cwd);
  if (direct && direct.length > 0) return direct;
  const nested = str((session as { session?: DshSession } | undefined)?.session?.header?.cwd);
  if (nested && nested.length > 0) return nested;
  return process.cwd();
}

/* ---------------- context 百分比（token-meter + requestContext） ---------------- */

/** 用 token-meter 的请求压力 + 当前路由的 contextWindow 算百分比；算不出来返回 undefined。 */
export function contextPctOf(ctx: DshContext, session: DshSession | undefined): number | undefined {
  try {
    const rc = session?.requestContext?.();
    const window = num(obj(rc as unknown)?.contextWindow);
    if (window === undefined || window <= 0) return undefined;
    const meter = ctx?.get?.("tokenMeter");
    const measure = (meter as { measure?: (s: DshSession) => unknown } | undefined)?.measure;
    if (typeof measure !== "function") return undefined;
    const total = num(obj(measure(session as DshSession) as unknown)?.totalTokens);
    if (total === undefined) return undefined;
    const pct = Math.round((total / window) * 100);
    return Number.isFinite(pct) ? pct : undefined;
  } catch {
    return undefined;
  }
}

/* ---------------- token 提取与累计 ---------------- */

/** assistant/message 的 usage → 本次调用的 token 数（input+output+cache，disjoint 字段）。 */
export function tokenDelta(event: DshSessionEvent | undefined): number | undefined {
  if (!event || event.type !== "assistant/message") return undefined;
  const usage = obj(event.data?.usage);
  if (!usage) return undefined;
  if (!("inputTokens" in usage) && !("outputTokens" in usage)) return undefined;
  return (num(usage.inputTokens) ?? 0) + (num(usage.outputTokens) ?? 0) + (num(usage.cacheReadTokens) ?? 0) + (num(usage.cacheWriteTokens) ?? 0);
}

/** 按 session 累计 token（Core 的 token_used 是「见过的最大值」，需要累计值才能对里程碑生效）。 */
export class TokenAccumulator {
  private totals = new Map<string, number>();
  add(sessionId: string, delta: number): number {
    const next = (this.totals.get(sessionId) ?? 0) + delta;
    this.totals.set(sessionId, next);
    return next;
  }
  get(sessionId: string): number {
    return this.totals.get(sessionId) ?? 0;
  }
  reset(sessionId: string): void {
    this.totals.delete(sessionId);
  }
}

/* ---------------- 纯映射（可测试核心） ---------------- */

export interface MapSessionInput {
  eventType: string;
  data?: Record<string, unknown>;
  sessionId: string;
  cwd: string;
  /** 由调用方算好的 context 百分比；undefined = 不发 context_update */
  contextPct?: number;
  /** 出错工具的最近一次 tool/call 名字（由调用方按 callId/最近一次解析） */
  toolName?: string;
  pid?: number;
  now?: string;
  /** 用哪个 agent id（默认 "dsh"；测试可覆盖） */
  agent?: string;
}

export function mapSessionEvent(input: MapSessionInput): CoreEvent[] {
  const { eventType, data, sessionId, cwd, contextPct, toolName, pid, now, agent } = input;
  const ag = agent ?? DEFAULT_AGENT;
  const ts = now ?? new Date().toISOString();
  const projectId = normalizeProject(cwd);
  const mk = (et: string, payload: Record<string, unknown>, summary: string, severity: Severity = "low"): CoreEvent => ({
    event_id: `${ag}-${et}-${sessionId}-${Date.now()}-${++seqCounter}`,
    seq: ++seqCounter,
    agent: ag,
    session_id: sessionId,
    project_id: projectId,
    event_type: et,
    severity,
    safe_summary: summary,
    timestamp: ts,
    payload: pid === undefined ? payload : { ...payload, pid },
  });

  switch (eventType) {
    case "turn/start":
      return [mk("agent_working", {}, "Working: agent")];
    case "user/message": {
      // 只有直接人类提示（source.kind === 'user'）才是「用户提交了新需求」；
      // injected context / tool / plugin 都不算（会淹没 working 信号）。
      const src = obj(data?.source);
      return src?.kind === "user" ? [mk("agent_working", {}, "Working: agent")] : [];
    }
    case "tool/call": {
      const name = str(data?.name);
      // ask_user_question 是「问用户问题」工具：agent 调它 = 暂停等用户回答，不是
      // working。上报 decision_required（kind=question），与 turn/end blocked 区分。
      if (name === "ask_user_question") {
        return [mk("decision_required", { kind: "question" }, "Waiting for your answer", "high")];
      }
      return [mk("agent_working", name ? { tool_name: name } : {}, `Working: ${name || "agent"}`)];
    }
    case "tool/result": {
      const err = obj(data?.error);
      const msg = obj(data?.message);
      const isErr = err !== undefined || msg?.isError === true;
      if (!isErr) return []; // 成功路径不重复报 working
      const code = str(err?.code) ?? str(err?.name);
      const payload: Record<string, unknown> = { error_kind: code ?? "tool_failed" };
      if (toolName) payload.tool_name = toolName;
      return [mk("session_error", payload, `Tool failed: ${toolName ?? "unknown"}`, "high")];
    }
    case "assistant/message": {
      const out: CoreEvent[] = [];
      if (contextPct !== undefined) {
        out.push(mk("context_update", { context_pct: contextPct }, `Context: ${contextPct}% used`, "medium"));
      }
      return out;
    }
    case "compaction/start": {
      return contextPct !== undefined
        ? [mk("context_update", { context_pct: contextPct }, `Context: ${contextPct}% used`, "medium")]
        : [];
    }
    case "approval/asked":
      // approval/asked 是 session 日志里的审计事件（session.append），而实时「正在等
      // 用户批准」的信号是 cordis 的 approval/request，已在 apply() 单独监听；
      // 这里跳过，避免同一审批双发 permission_required。
      return [];
    case "approval/decided":
      return [mk("agent_working", {}, "Working: agent")];
    case "turn/end": {
      const reason = obj(data?.reason);
      const kind = str(reason?.kind);
      if (kind === "blocked") {
        return [mk("decision_required", { kind: "blocked" }, "Waiting for your decision", "high")];
      }
      if (kind === "error") {
        const err = obj(reason?.error);
        const code = str(err?.code) ?? str(err?.message) ?? "turn_failed";
        return [mk("session_error", { error_kind: code }, "Session error", "high")];
      }
      return [];
    }
    case "subagent/descriptor":
      return [mk("subagent_started", {}, "Subagent started")];
    default:
      return [];
  }
}

export interface MapTokenInput {
  sessionId: string;
  cwd: string;
  tokens: number;
  pid?: number;
  now?: string;
  agent?: string;
}

export function mapTokenUpdate(input: MapTokenInput): CoreEvent {
  const { sessionId, cwd, tokens, pid, now, agent } = input;
  const ag = agent ?? DEFAULT_AGENT;
  const ts = now ?? new Date().toISOString();
  const payload: Record<string, unknown> = { tokens };
  if (pid !== undefined) payload.pid = pid;
  return {
    event_id: `${ag}-token_update-${sessionId}-${Date.now()}-${++seqCounter}`,
    seq: ++seqCounter,
    agent: ag,
    session_id: sessionId,
    project_id: normalizeProject(cwd),
    event_type: "token_update",
    severity: "low",
    safe_summary: `Usage update: ${tokens} tokens`,
    timestamp: ts,
    payload,
  };
}

export interface MapLifecycleInput {
  sessionId: string;
  cwd: string;
  pid?: number;
  now?: string;
  agent?: string;
  /** adapter_status 的能力声明（默认 DSH_CAPABILITIES） */
  capabilities?: readonly string[];
  adapterVersion?: string;
}

/** agent/created → adapter_status + session_started */
export function mapAgentCreated(input: MapLifecycleInput): CoreEvent[] {
  const { sessionId, cwd, pid, now, agent, capabilities, adapterVersion } = input;
  const ag = agent ?? DEFAULT_AGENT;
  const ts = now ?? new Date().toISOString();
  const projectId = normalizeProject(cwd);
  const mk = (et: string, payload: Record<string, unknown>, summary: string, severity: Severity = "low"): CoreEvent => ({
    event_id: `${ag}-${et}-${sessionId}-${Date.now()}-${++seqCounter}`,
    seq: ++seqCounter,
    agent: ag,
    session_id: sessionId,
    project_id: projectId,
    event_type: et,
    severity,
    safe_summary: summary,
    timestamp: ts,
    payload: pid === undefined ? payload : { ...payload, pid },
  });
  const caps = capabilities ?? DSH_CAPABILITIES;
  const statusPayload: Record<string, unknown> = { capabilities: [...caps] };
  if (adapterVersion) statusPayload.adapter_version = adapterVersion;
  const status = mk("adapter_status", statusPayload, `Adapter connected: ${ag}`);
  status.session_id = `adapter-${ag}`; // 固定 session_id：这是一条「我在」的声明，不是一次会话
  const started = mk("session_started", { source: "startup", cwd }, "Session started");
  return [status, started];
}

/** agent/disposed → session_finished */
export function mapAgentDisposed(input: MapLifecycleInput): CoreEvent {
  const { sessionId, cwd, pid, now, agent } = input;
  const ag = agent ?? DEFAULT_AGENT;
  const ts = now ?? new Date().toISOString();
  const payload: Record<string, unknown> = { reason: "stopped" };
  if (pid !== undefined) payload.pid = pid;
  return {
    event_id: `${ag}-session_finished-${sessionId}-${Date.now()}-${++seqCounter}`,
    seq: ++seqCounter,
    agent: ag,
    session_id: sessionId,
    project_id: normalizeProject(cwd),
    event_type: "session_finished",
    severity: "low",
    safe_summary: "Session finished",
    timestamp: ts,
    payload,
  };
}

/** agent/error → session_error（保留为可复用映射；不在 apply() 里挂监听——
 *  dsh 对同一次 turn 失败会先发 agent/error 再补 turn/end error，两个都监听会
 *  双发 session_error；turn/end error 在 session/event 流里、自带 session，是唯一入口）。 */
export function mapAgentError(input: MapLifecycleInput & { kind?: string }): CoreEvent {
  const { sessionId, cwd, pid, now, agent, kind } = input;
  const ag = agent ?? DEFAULT_AGENT;
  const ts = now ?? new Date().toISOString();
  const payload: Record<string, unknown> = { error_kind: kind ?? "agent_error" };
  if (pid !== undefined) payload.pid = pid;
  return {
    event_id: `${ag}-session_error-${sessionId}-${Date.now()}-${++seqCounter}`,
    seq: ++seqCounter,
    agent: ag,
    session_id: sessionId,
    project_id: normalizeProject(cwd),
    event_type: "session_error",
    severity: "high",
    safe_summary: `Session error: ${kind ?? "unknown"}`,
    timestamp: ts,
    payload,
  };
}

export interface MapApprovalRequestInput {
  sessionId: string;
  cwd: string;
  toolName?: string;
  pid?: number;
  now?: string;
  agent?: string;
}

/** approval/request（cordis 实时审批请求）→ permission_required */
export function mapApprovalRequest(input: MapApprovalRequestInput): CoreEvent {
  const { sessionId, cwd, toolName, pid, now, agent } = input;
  const ag = agent ?? DEFAULT_AGENT;
  const ts = now ?? new Date().toISOString();
  const payload: Record<string, unknown> = {};
  if (toolName) payload.tool_name = toolName;
  if (pid !== undefined) payload.pid = pid;
  return {
    event_id: `${ag}-permission_required-${sessionId}-${Date.now()}-${++seqCounter}`,
    seq: ++seqCounter,
    agent: ag,
    session_id: sessionId,
    project_id: normalizeProject(cwd),
    event_type: "permission_required",
    severity: "high",
    safe_summary: `Tool permission needed: ${toolName ?? "unknown"}`,
    timestamp: ts,
    payload,
  };
}

/* ---------------- 发送（POST + JSONL 兜底，与 pi_extension 的 deliver 同一语义） ---------------- */

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
    appendFileSync(join(fallbackDir, `dsh_${Date.now()}_${++fileSeq}.jsonl`), JSON.stringify(ev) + "\n");
  } catch {
    // 兜底也失败：不阻断 dsh
  }
  return false;
}

/* ---------------- 配置归一化 ---------------- */

export function normalizeConfig(config?: DshConfig): Required<Pick<DshConfig, "port" | "agent">> & Pick<DshConfig, "adapter_version"> {
  return {
    port: num(config?.port) ?? CORE_PORT,
    agent: str(config?.agent) ?? DEFAULT_AGENT,
    adapter_version: str(config?.adapter_version),
  };
}

/* ---------------- 插件入口（Cordis function form） ---------------- */

export const name = "vibepaws";
export const inject: string[] = [];

export function apply(ctx: DshContext, config: DshConfig = {}): void {
  const cfg = normalizeConfig(config);
  const tokens = new TokenAccumulator();
  /** sessionId → 最近一次 tool/call 名（tool/result 出错时回填 tool_name） */
  const lastTool = new Map<string, string>();

  const deliver = (ev: CoreEvent, cwd: string): void => {
    void deliverToCore(ev, cwd, cfg.port);
  };

  // 会话开始（agent/created 是「一个可用的 agent + 它的 live session」的发布点）
  ctx.on("agent/created", (payload) => {
    try {
      const agent = (payload as { agent?: DshSession } | undefined)?.agent;
      const sid = sessionIdOf(agent);
      const cwd = cwdOf(agent);
      for (const ev of mapAgentCreated({
        sessionId: sid,
        cwd,
        pid: process.pid,
        agent: cfg.agent,
        adapterVersion: cfg.adapter_version,
      })) {
        deliver(ev, cwd);
      }
    } catch {
      // 任何异常都不允许打断 dsh
    }
  });

  // 会话结束（agent/disposed：driver 静默后、session 脱离 store 前）
  ctx.on("agent/disposed", (payload) => {
    try {
      const agent = (payload as { agent?: DshSession } | undefined)?.agent;
      const sid = sessionIdOf(agent);
      const cwd = cwdOf(agent);
      deliver(mapAgentDisposed({ sessionId: sid, cwd, pid: process.pid, agent: cfg.agent }), cwd);
      tokens.reset(sid);
      lastTool.delete(sid);
    } catch {
      // 忽略
    }
  });

  // 注意：没有 ctx.on("agent/error", …)。dsh 对同一次 turn 失败先发 agent/error
  // （payload 会被注入 agent，但不在 session 事件流里），随后必然补一条
  // turn/end reason.kind === "error"（见 dsh-agent-loop 的 catch + finally）。
  // 只监听 session/event 里的 turn/end error：单一事实来源、自带 session/cwd，
  // 避免同一次失败双发 session_error。详见头部注释的事件映射表。

  // 实时审批请求（cordis 事件）：这是「正在等用户批准」的真实信号。approval/asked
  // 只是 session 里的审计日志（事后追加），不能拿来做等待态。必须透传 next()，
  // 否则审批链会卡死（插件绝不打断 dsh）。
  ctx.on("approval/request", (req, next) => {
    try {
      const r = req as { agent?: DshSession; toolName?: string } | undefined;
      const agent = r?.agent;
      const cwd = cwdOf(agent);
      deliver(mapApprovalRequest({
        sessionId: sessionIdOf(agent),
        cwd,
        toolName: str(r?.toolName),
        pid: process.pid,
        agent: cfg.agent,
      }), cwd);
    } catch {
      // 忽略
    }
    return next();
  });

  // 持久化事件流（session/event → (session, event)）：会话活动的单一事实来源
  ctx.on("session/event", (session, event) => {
    try {
      const s = session as DshSession | undefined;
      const e = event as DshSessionEvent | undefined;
      const sid = sessionIdOf(s);
      const cwd = cwdOf(s);

      // 先记 tool/call 名（tool/result 出错时回填）
      if (e?.type === "tool/call") {
        const tname = str(e.data?.name);
        if (tname) lastTool.set(sid, tname);
      }

      // token 累计（assistant/message 的 usage 是「本次调用」的 disjoint 计数）
      const delta = tokenDelta(e);
      if (delta !== undefined && delta > 0) {
        const total = tokens.add(sid, delta);
        deliver(mapTokenUpdate({ sessionId: sid, cwd, tokens: total, pid: process.pid, agent: cfg.agent }), cwd);
      }

      // context 百分比：只在可能变化时算（assistant/message、compaction/start）
      let pct: number | undefined;
      if (e?.type === "assistant/message" || e?.type === "compaction/start") {
        pct = contextPctOf(ctx, s);
      }

      for (const ev of mapSessionEvent({
        eventType: e?.type ?? "",
        data: e?.data,
        sessionId: sid,
        cwd,
        contextPct: pct,
        toolName: lastTool.get(sid),
        pid: process.pid,
        agent: cfg.agent,
      })) {
        deliver(ev, cwd);
      }
    } catch {
      // 任何异常都不允许打断 dsh
    }
  });
}
