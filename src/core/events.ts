/**
 * Vibepaws 标准化事件 schema — 对应 docs/mvp_architecture.md §3
 * 隐私：payload 仅允许白名单字段（第一道闸在 adapter，第二道闸在 ingress）。
 */

export type AgentId = "claude_code" | "codex" | "generic" | "pi";
export type Severity = "low" | "medium" | "high";

export const AGENTS: AgentId[] = ["claude_code", "codex", "generic", "pi"];

export type EventType =
  | "session_started"
  | "agent_working"
  | "decision_required"
  | "permission_required"
  | "token_update"
  | "context_update"
  | "topic_drift_warning"
  | "session_finished"
  | "session_error"
  | "subagent_started"
  | "subagent_stopped"
  | "adapter_status";

export const EVENT_TYPES: EventType[] = [
  "session_started",
  "agent_working",
  "decision_required",
  "permission_required",
  "token_update",
  "context_update",
  "topic_drift_warning",
  "session_finished",
  "session_error",
  "subagent_started",
  "subagent_stopped",
  "adapter_status",
];

/** session_started 的 source：用于推断 session 生命周期（不解析 transcript 文件） */
export type SessionSource = "startup" | "resume" | "fork" | "clear" | "compact" | "continue";

/** 白名单 payload。任何不在这些字段里的内容都会被 ingress 丢弃。 */
export interface EventPayload {
  title?: string;              // session_started: 显示名提示（adapter 尽量不给，Core 用 cwd 目录名）
  cwd?: string;                // session_started
  source?: SessionSource;      // session_started
  tool_name?: string;          // agent_working / permission_required / session_error
  kind?: string;               // decision_required: "question"(AskUserQuestion) | Notification matcher | Stop 等
  turn_id?: string;            // decision_required
  tokens?: number;             // token_update
  cost?: number;               // token_update
  context_pct?: number;        // context_update
  signal_kind?: string;        // topic_drift_warning
  reason?: string;             // session_finished: completion | stopped | error | timeout
  outcome?: string;            // session_finished: success | partial | abandoned
  error_kind?: string;         // session_error
  parent_session_id?: string;  // subagent_started / fork
  subagent_kind?: string;      // subagent_started
  capabilities?: string[];     // adapter_status
  adapter_version?: string;    // adapter_status
  file?: string;               // agent_working: 目标文件（仅文件名 basename，防路径泄漏）
  /**
   * agent 进程的 pid（僵尸回收 G10）。Core 用它探活：进程没了 = session 死了，
   * 不必干等 15 分钟静默超时。隐私上这是一个本机整数，不携带任何用户内容 ——
   * 它唯一能回答的问题是「这个 session 背后的进程还在不在」。
   */
  pid?: number;
}

/** 标准化事件信封（§3.1） */
export interface CoreEvent {
  event_id: string;
  seq: number;
  agent: AgentId;
  session_id: string;
  project_id: string;
  event_type: EventType;
  severity: Severity;
  safe_summary: string;
  timestamp: string;           // ISO 8601
  payload: EventPayload;
}

/**
 * session 的结束归因。前三个来自 `session_finished` 事件（agent 自己说的），
 * 后两个由僵尸回收写入（G10，见 core/reclaim.ts）：
 *   orphaned —— agent 进程没了（崩溃 / kill -9），`SessionEnd` 永远不会来
 *   timeout  —— 进程在不在不知道，但已经静默超过阈值（休眠、拔网线、adapter 掉了）
 * 这两种都**不是**收工：不结算 EXP，宠物也不播庆祝动画。
 */
export type SessionOutcome = "success" | "partial" | "abandoned" | "orphaned" | "timeout";

/**
 * 这个 session 是被回收的（而不是正常收工的）吗。
 * 渲染层有一份等价实现（`ui/app.js` 的 `reclaimedSession`）—— 浏览器里的 app.js
 * 没法 import 这个模块，两处改动必须一起走。
 */
export function isReclaimed(outcome: string | null | undefined): boolean {
  return outcome === "orphaned" || outcome === "timeout";
}

/** 宠物聚合状态（7 态，READM 6.1 / 架构 §2.3） */
export type PetState =
  | "idle" | "working" | "needs-you" | "warning"
  | "finished" | "tired" | "level-up";

export const PET_STATES: PetState[] = [
  "idle", "working", "needs-you", "warning", "finished", "tired", "level-up",
];

/** Session 状态（Registry 内部） */
export type SessionState = "idle" | "working" | "needs-you" | "warning" | "finished";

/** 聚合后的 session 视图（SSE /api/state 输出） */
export interface SessionView {
  agent: AgentId;
  session_id: string;
  project_id: string;
  title: string;
  state: SessionState;
  token_used: number;
  context_pct: number;
  correction_count: number;
  last_event_at: string;
  finished_at: string | null;
  /** agent 卡在「等你」的起始时刻（ISO），null = 不在等 */
  needs_input_since: string | null;
  /** 这次要做什么（设置窗口录入）。有 goal → topic_multiplier 1.1，也是漂移判定的基准 */
  goal: string | null;
  /** 本 session 的 token 预算；null = 跟随设置里的全局默认 */
  budget_tokens: number | null;
  is_active: boolean;
  parent_id: number | null;
  outcome?: string;
}

export interface AgentCapabilities {
  agent: AgentId;
  adapter_version?: string;
  events: EventType[];
  resume_command?: string;   // jump-to 模板，如 "claude --resume <id>"
}

/** 已接入的 adapter（SSE 推给界面：空数组 = 没装 hooks，不是「还没干活」） */
export interface AdapterView {
  agent: AgentId;
  adapter_version: string | null;
  capabilities: string[];
  connected_at: string | null;
  last_event_at: string | null;
}

/** 聚合宠物状态推送（SSE） */
export interface PetStatePush {
  type: "pet_state";
  pet: {
    pet_type_id: number;
    name: string;
    level: number;
    exp: number;
    state: PetState;
    health_score: number;
    /** 升级所需 EXP —— 渲染层的 EXP 条分母，漏发会显示成 "37/undefined" */
    next_level_exp: number;
  };
  sessions: SessionView[];
  /** 已接入的 adapter。空数组 = 一个 hook 都没装 —— 界面要说的是「去装 adapter」，
   * 而不是「还没有 session」。这两句话指向完全不同的操作。 */
  adapters: AdapterView[];
  /** 当前静音状态：界面要能显示「还剩多久」、点亮对应按钮并原地取消（issue #7） */
  mute: { global_until: number | null; global_minutes: number | null };
  needs_you: SessionView[];
  warning: SessionView[];
  working: SessionView[];
  idle: SessionView[];
}
