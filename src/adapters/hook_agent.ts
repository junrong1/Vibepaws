#!/usr/bin/env node
/**
 * hook_agent.ts — Claude Code / Codex 共享采集模板（架构 §2.1）。
 * 读 stdin JSON → matcher→标准化事件映射 → 白名单提取（丢弃 tool_input/prompt）
 * → safe_summary（固定措辞模板）→ POST Core（失败写 JSONL 兜底）→ exit 0（非阻断）。
 *
 * 用法（由 hooks 配置调用，见 install.ts）：
 *   node src/adapters/hook_agent.ts <event-name>   （stdin 为 hook 输入 JSON）
 */
import { readFileSync, appendFileSync, mkdirSync, existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readApiToken } from "../core/token.ts";
import { adapterStatusEvent } from "./hooks.ts";
import type { CoreEvent, AgentId } from "../core/events.ts";

/** 仓库根（由本文件位置反推），离线兜底缓冲固定写回 Vibepaws 仓库，任意 cwd 下都能被 bridge 找到。 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 调试日志：写回仓库 .vibepaws/events/hook_debug.log（与 deliver 兜底一致，任意 cwd 可找到） */
function debugLog(line: string): void {
  try {
    const dir = join(REPO_ROOT, ".vibepaws", "events");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "hook_debug.log"), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // 忽略（调试日志失败不影响采集）
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

/**
 * agent 进程的 pid（僵尸回收 G10 的输入）。
 *
 * hook 是 agent 起的子进程，所以 `ppid` 就是 agent —— 前提是中间那层 `sh -c`
 * exec 掉了自己（我们写进配置的命令是一条不带重定向/管道的简单命令，正是会被
 * exec 优化的那种）。万一某个平台不这样，ppid 会是一个转瞬即逝的 shell；Core
 * 侧的「同一个 pid 见过两次才采信」正是为这种情况准备的（见 core/reclaim.ts），
 * 所以这里报一个**可能**是包装进程的 pid 是安全的。
 */
function agentPid(): number | undefined {
  const ppid = process.ppid;
  return Number.isInteger(ppid) && ppid > 1 ? ppid : undefined;
}

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
  /**
   * `pid` 必须由调用方显式给：只有**真的跑在 agent 子进程里**的那次调用（CLI main）
   * 知道自己的 ppid 是 agent。bridge 补发 JSONL 时也会走这个函数，那时的 ppid 是
   * bridge 自己的父进程 —— 报上去就是给 Core 一个和该 session 毫无关系的 pid。
   */
  opts: { fallbackCwd?: string; pid?: number } = {},
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

  // Claude Code 的 AskUserQuestion 工具 = agent 在等用户回答。
  // 只在 PreToolUse（提问瞬间）弹「需要你」气泡；PostToolUse 由 refineByTool 落回 agent_working（已作答）。
  const isAskUser = toolName === "AskUserQuestion";
  if (isAskUser && hookEvent === "PreToolUse") eventType = "decision_required";

  // 白名单 payload（绝不含 tool_input/prompt/代码）
  const payload: CoreEvent["payload"] = {};
  if (eventType === "session_started") payload.source = "startup";
  if (hookEvent === "SessionStart") {
    payload.cwd = cwd;
    payload.title = basename(cwd) || undefined;
  }
  if (toolName) payload.tool_name = toolName;
  if (eventType === "decision_required" || eventType === "permission_required") {
    payload.kind = isAskUser ? "question" : (raw.matcher ?? hookEvent);
    if (raw.turn_id) payload.turn_id = String(raw.turn_id);
  }
  if (eventType === "token_update" && typeof raw.tokens === "number") payload.tokens = raw.tokens;
  if (raw.turn_id) payload.turn_id = String(raw.turn_id);
  // 每条事件都带 pid：Core 靠「同一个 pid 反复出现」确认它是 agent 而不是包装 shell，
  // 只报在 SessionStart 上的话永远攒不到第二次确认（G10）。
  if (opts.pid !== undefined) payload.pid = opts.pid;
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
    case "decision_required":
      return toolName === "AskUserQuestion"
        ? "Waiting for your answer"
        : `Needs decision (${raw.matcher ?? "notification"})`;
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

/* ---------------- transcript 用量提取（无 statusline 的 agent 的唯一来源） ---------------- */

/**
 * 尾部读多少字节。Codex 每轮结束都会往 rollout 里写一条 token_count，
 * 所以「最近一条」几乎必然落在尾巴里 —— 而整份 rollout 动辄几 MB，
 * 这个函数现在每轮都要跑，不能每次都把它整个读进内存。
 */
const TRANSCRIPT_TAIL_BYTES = 512 * 1024;

/**
 * 哪几条 hook 之后值得回头读一次 transcript。
 *
 * PostToolUse：一个长回合里的实时刻度（Codex 一轮可以跑几十个工具）。
 * Stop：一轮说完的那一刻 —— 界面上「安静了」旁边显示的就是这个数。
 * SessionEnd：收尾总量。
 *
 * 其余事件跳过：读的是同一份存档、报的是同一个累计值，只会给 Core 灌重复行。
 * （重复本身无害：registry 是 MAX，exp 只结算增量。）
 */
const TOKEN_REFRESH_HOOKS = new Set(["PostToolUse", "Stop", "SessionEnd"]);

/** 一次 transcript 读取能拿到的东西。Core 侧分两条事件落库，所以这里也分两个字段。 */
export interface TranscriptUsage {
  /** session 至今的累计 token（token_update） */
  tokens: number;
  /** 最后一轮占 context 窗口的百分比（context_update）。存档里没有窗口大小时为 undefined。 */
  context_pct?: number;
}

/**
 * Codex rollout JSONL → 这次会话的用量。
 *
 * 每轮一条：{"type":"event_msg","payload":{"type":"token_count","info":{
 *   "total_token_usage":{…,"total_tokens":N},
 *   "last_token_usage":{…,"total_tokens":M,"reasoning_output_tokens":R},
 *   "model_context_window":W}}}
 *
 * · tokens：`total_token_usage` **本身就是累计值**，所以取最后一条、绝不求和 ——
 *   求和等于把每轮的累计值再累计一遍，一个 10M tokens 的会话能报到几十上百 M。
 * · context_pct：占 context 的是**最后一轮**的用量（`last_token_usage`，其中 input
 *   已含此前全部对话），不是累计量 —— 拿累计量去除窗口，第二轮就能「超过 100%」。
 *   再减掉 reasoning：那部分下一轮不会带回上下文（Codex 自己的 context 条目同此口径）。
 */
export function extractCodexUsage(text: string): TranscriptUsage | null {
  const lines = text.split("\n");
  // 从后往前 = 时间上从新到旧，命中即止
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    // 先按字符串筛一道：rollout 里绝大多数行是消息体，不值得 JSON.parse
    if (!line.includes('"token_count"')) continue;
    try {
      const obj = JSON.parse(line) as { payload?: { type?: string; info?: Record<string, unknown> } };
      if (obj.payload?.type !== "token_count") continue;
      const info = obj.payload.info;
      if (!info) continue;
      const cumulative = (info.total_token_usage ?? {}) as Record<string, unknown>;
      // total_tokens 已含 cached input 与 reasoning output（与 Claude statusline 的口径一致）
      const tokens =
        num(cumulative.total_tokens) ?? (num(cumulative.input_tokens) ?? 0) + (num(cumulative.output_tokens) ?? 0);
      if (tokens <= 0) continue;
      return { tokens, context_pct: codexContextPct(info) };
    } catch {
      // 坏行/半行（尾部读取会切断第一行）→ 继续往前找
    }
  }
  return null;
}

/** 最后一轮在 context 窗口里占了多少（0–100）。窗口未知 → undefined（宁可不报，也不报个假的）。 */
function codexContextPct(info: Record<string, unknown>): number | undefined {
  const window = num(info.model_context_window);
  const last = (info.last_token_usage ?? {}) as Record<string, unknown>;
  const total = num(last.total_tokens);
  if (window === undefined || window <= 0 || total === undefined) return undefined;
  const inContext = Math.max(0, total - (num(last.reasoning_output_tokens) ?? 0));
  return Math.max(0, Math.min(100, Math.round((inContext / window) * 100)));
}

/** Claude Code JSONL → token 总量：每条 assistant 消息带一份**本轮** usage，所以这里是求和。 */
export function extractClaudeTokens(text: string): number | null {
  let total = 0;
  let found = false;
  for (const line of text.split("\n")) {
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
}

/** 两种存档格式都试一遍（Codex 优先：它的判据更具体，不会误吃 Claude 的行）。 */
export function extractTranscriptUsage(text: string): TranscriptUsage | null {
  const codex = extractCodexUsage(text);
  if (codex) return codex;
  const tokens = extractClaudeTokens(text);
  // Claude 的存档里没有窗口大小，context_pct 只能留空（它本来也走 statusline 那条实时通道）
  return tokens === null ? null : { tokens };
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * 从 transcript 文件提取用量。隐私：只认 usage 里的数字，不读 message/content 里的任何文本。
 * 返回 null 表示无法提取（降级，不影响核心循环）。
 *
 * 大文件只读尾巴，且**只采信 Codex 那条累计值** —— Claude 那种「逐条求和」的口径在半份
 * 存档上算出来的是个偏小的假数，宁可把整份读完。
 */
export function extractUsageFromTranscript(transcriptPath: string | undefined): TranscriptUsage | null {
  if (!transcriptPath) return null;
  let fd: number | undefined;
  try {
    const size = statSync(transcriptPath).size;
    if (size > TRANSCRIPT_TAIL_BYTES) {
      fd = openSync(transcriptPath, "r");
      const buf = Buffer.allocUnsafe(TRANSCRIPT_TAIL_BYTES);
      const read = readSync(fd, buf, 0, TRANSCRIPT_TAIL_BYTES, size - TRANSCRIPT_TAIL_BYTES);
      const fromTail = extractCodexUsage(buf.toString("utf-8", 0, read));
      if (fromTail !== null) return fromTail;
    }
    return extractTranscriptUsage(readFileSync(transcriptPath, "utf-8"));
  } catch {
    return null; // 文件不存在/不可读 → 降级
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* 关不上也没什么可做的 */
      }
    }
  }
}

/* ---------------- 自计时（landscape 0.12 / clawd #102） ---------------- */

/**
 * 本进程到现在为止花了多少毫秒（`performance.now()` 的原点是进程启动）。
 *
 * 为什么这个数只能在 hook 里取：采集开销的大头是 Node 自己的启动，那段时间 Core
 * 根本还不知道有这次调用。所以「宠物让我的 agent 慢了多少」这个问题，Core 侧的
 * 计时永远答不全 —— 它测得到的只是最后那零点几毫秒。
 *
 * 语义是「进程启动 → 发出这一条」。一次 hook 调用通常只发一条事件；SessionStart
 * 那次会先发一条 adapter_status，于是第二条的数字里含着第一条的往返 —— 那依然是
 * 这个进程真实的存活时长，没有虚报。
 */
function selfMs(): number {
  return Math.round(performance.now() * 10) / 10;
}

/* ---------------- 发送（POST + JSONL 兜底） ---------------- */

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
  const dir = join(REPO_ROOT, ".vibepaws", "events");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, "fallback.jsonl"), JSON.stringify(ev) + "\n");
  return false;
}

/* ---------------- CLI 入口 ---------------- */

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const agent = (args.find((a) => a.startsWith("--agent="))?.split("=")[1] ?? "generic") as AgentId;
  const debug = args.includes("--debug");
  /**
   * 发一条事件，顺手带上本进程的自计时。
   *
   * 打点必须在**这一层**而不是 `deliver()` 里：generic bridge 补发 JSONL 时走的是
   * 同一个 deliver，那时 `performance.now()` 量的是 bridge 自己的存活时长 ——
   * 报上去就是把一个跟 hook 无关的数字混进采集开销面板。
   */
  const send = (ev: CoreEvent): Promise<boolean> => {
    ev.payload.hook_ms = selfMs();
    return deliver(ev);
  };
  let stdin = "";
  process.stdin.on("data", (c) => (stdin += c));
  process.stdin.on("end", async () => {
    try {
      const raw = stdin.trim() ? (JSON.parse(stdin) as HookInput) : {};
      if (debug) debugLog(`RAW INPUT: ${JSON.stringify(raw)}`);
      // 每次会话开始都重新自报家门：安装时报过一次是不够的 —— 换机器、清库、
      // 重装 Core 之后 agents 表就空了，而用户并不会想到要再跑一次安装器。
      if (raw.hook_event_name === "SessionStart" && (agent === "claude_code" || agent === "codex")) {
        const announced = await send(adapterStatusEvent(agent, raw.cwd ?? process.cwd()));
        if (process.env.VIBEPAWS_DEBUG || debug) console.error(`[hook] adapter_status delivered=${announced}`);
      }
      const ev = normalizeHook(raw, agent, { pid: agentPid() });
      if (ev) {
        const delivered = await send(ev);
        if (process.env.VIBEPAWS_DEBUG || debug) console.error(`[hook] ${ev.event_type} delivered=${delivered}`);
        // 从 transcript 提取用量 → 补发 token_update（+ Codex 还给得出 context_update）。
        // hooks stdin 无 token 字段（实测），用量只存在于 transcript_path 指向的存档里。
        // 只在 SessionEnd 补一次是不够的：会话没结束之前界面上就一直是 0k，而 Codex 的
        // 会话常常一开就是一整天。Codex 的每条 hook 输入都带 transcript_path（源码 schema
        // 确认），所以按 TOKEN_REFRESH_HOOKS 的节奏刷。
        // Claude Code 除外：它有 statusline 实时通道（准确），transcript 逐条求和会虚高。
        if (ev.agent !== "claude_code" && TOKEN_REFRESH_HOOKS.has(raw.hook_event_name ?? "")) {
          const usage = extractUsageFromTranscript(raw.transcript_path);
          if (usage && usage.tokens > 0) {
            const stamp = Date.now();
            // token_update 只写 token_used，context_pct 必须走独立的 context_update（registry.ts），
            // 与 statusline.ts 那条通道同构。
            const usageEvents: CoreEvent[] = [
              {
                event_id: `hook-token-${stamp}-${++seqCounter}`,
                seq: ++seqCounter,
                agent: ev.agent,
                session_id: ev.session_id,
                project_id: ev.project_id,
                event_type: "token_update",
                severity: "low",
                safe_summary: `Transcript tokens: ${usage.tokens}`,
                timestamp: new Date().toISOString(),
                payload: { tokens: usage.tokens },
              },
            ];
            if (usage.context_pct !== undefined) {
              usageEvents.push({
                event_id: `hook-ctx-${stamp}-${++seqCounter}`,
                seq: ++seqCounter,
                agent: ev.agent,
                session_id: ev.session_id,
                project_id: ev.project_id,
                event_type: "context_update",
                severity: "low",
                safe_summary: `Transcript context: ${usage.context_pct}%`,
                timestamp: new Date().toISOString(),
                payload: { context_pct: usage.context_pct },
              });
            }
            for (const usageEv of usageEvents) {
              const ok = await send(usageEv);
              if (debug) debugLog(`${usageEv.event_type}(${usageEv.safe_summary}) delivered=${ok}`);
            }
          } else if (debug) {
            debugLog(`no usage extracted from transcript: ${raw.transcript_path}`);
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
