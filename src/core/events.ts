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
  kind?: string;               // decision_required: Notification | Stop 等
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
  needs_you: SessionView[];
  warning: SessionView[];
  working: SessionView[];
  idle: SessionView[];
}
