/**
 * Simulator 场景生成器 — 按场景生成标准化事件序列（QA 关键件，架构 §2.1）。
 * 每个场景返回 CoreEvent 数组（带递增时间戳与 event_id）。
 */
import type { CoreEvent } from "../core/events.ts";

export type ScenarioName =
  | "normal"
  | "frequent_decisions"
  | "context_overload"
  | "correction_loop"
  | "multi_session";

export const SCENARIOS: ScenarioName[] = [
  "normal",
  "frequent_decisions",
  "context_overload",
  "correction_loop",
  "multi_session",
];

let seqCounter = 0;

function ev(
  agent: CoreEvent["agent"],
  session_id: string,
  project_id: string,
  event_type: CoreEvent["event_type"],
  safe_summary: string,
  payload: CoreEvent["payload"],
  severity: CoreEvent["severity"] = "low",
  offsetSec = 0,
): CoreEvent {
  const t = new Date(Date.now() + offsetSec * 1000).toISOString();
  return {
    event_id: `sim-${agent}-${session_id}-${++seqCounter}-${offsetSec}`,
    seq: seqCounter,
    agent,
    session_id,
    project_id,
    event_type,
    severity,
    safe_summary,
    timestamp: t,
    payload,
  };
}

/** 正常会话：start → 若干 working + token → finish(success) */
function normal(): CoreEvent[] {
  const out: CoreEvent[] = [];
  out.push(ev("claude_code", "sim-normal-1", "/Users/demo/api-server", "session_started", "Session started", { source: "startup", cwd: "/Users/demo/api-server" }));
  out.push(ev("claude_code", "sim-normal-1", "/Users/demo/api-server", "agent_working", "Reading project files", { tool_name: "Read" }, "low", 1));
  out.push(ev("claude_code", "sim-normal-1", "/Users/demo/api-server", "agent_working", "Editing config", { tool_name: "Edit" }, "low", 3));
  out.push(ev("claude_code", "sim-normal-1", "/Users/demo/api-server", "token_update", "Tokens used", { tokens: 12000 }, "low", 5));
  out.push(ev("claude_code", "sim-normal-1", "/Users/demo/api-server", "context_update", "Context usage", { context_pct: 42 }, "low", 6));
  out.push(ev("claude_code", "sim-normal-1", "/Users/demo/api-server", "agent_working", "Running tests", { tool_name: "Bash" }, "low", 8));
  out.push(ev("claude_code", "sim-normal-1", "/Users/demo/api-server", "session_finished", "Session complete", { reason: "completion", outcome: "success" }, "low", 10));
  return out;
}

/** 频繁决策：多次 permission/decision → 宠物 needs-you 聚合 */
function frequentDecisions(): CoreEvent[] {
  const out: CoreEvent[] = [];
  const agent: CoreEvent["agent"] = "claude_code";
  out.push(ev(agent, "sim-decision-1", "/Users/demo/api-server", "session_started", "Session started", { source: "startup" }));
  out.push(ev(agent, "sim-decision-1", "/Users/demo/api-server", "permission_required", "Approve Bash command", { tool_name: "Bash" }, "high", 2));
  out.push(ev(agent, "sim-decision-1", "/Users/demo/api-server", "decision_required", "Notification: stop?", { kind: "Stop" }, "high", 5));
  out.push(ev(agent, "sim-decision-1", "/Users/demo/api-server", "agent_working", "Continue work", { tool_name: "Edit" }, "low", 8));
  out.push(ev(agent, "sim-decision-1", "/Users/demo/api-server", "permission_required", "Approve Write", { tool_name: "Write" }, "high", 11));
  out.push(ev(agent, "sim-decision-1", "/Users/demo/api-server", "session_finished", "Session ended", { reason: "stopped", outcome: "partial" }, "medium", 14));
  return out;
}

/** context 超限：token 爬升 + context 88/96% → warning 气泡 + EXP 倍率下降 */
function contextOverload(): CoreEvent[] {
  const out: CoreEvent[] = [];
  const agent: CoreEvent["agent"] = "codex";
  out.push(ev(agent, "sim-ctx-1", "/Users/demo/legacy-mono", "session_started", "Session started", { source: "startup" }));
  out.push(ev(agent, "sim-ctx-1", "/Users/demo/legacy-mono", "token_update", "Tokens used", { tokens: 30000 }, "low", 2));
  out.push(ev(agent, "sim-ctx-1", "/Users/demo/legacy-mono", "context_update", "Context 72%", { context_pct: 72 }, "low", 4));
  out.push(ev(agent, "sim-ctx-1", "/Users/demo/legacy-mono", "token_update", "Tokens used", { tokens: 60000 }, "low", 6));
  out.push(ev(agent, "sim-ctx-1", "/Users/demo/legacy-mono", "context_update", "Context 88%", { context_pct: 88 }, "medium", 8));
  out.push(ev(agent, "sim-ctx-1", "/Users/demo/legacy-mono", "context_update", "Context 96%", { context_pct: 96 }, "high", 10));
  out.push(ev(agent, "sim-ctx-1", "/Users/demo/legacy-mono", "session_finished", "Session ended", { reason: "completion", outcome: "partial" }, "medium", 12));
  return out;
}

/** correction loop：反复同文件修改 → topic_multiplier 0.8 */
function correctionLoop(): CoreEvent[] {
  const out: CoreEvent[] = [];
  const agent: CoreEvent["agent"] = "codex";
  out.push(ev(agent, "sim-cor-1", "/Users/demo/parser", "session_started", "Session started", { source: "startup" }));
  for (let i = 0; i < 7; i++) {
    out.push(ev(agent, "sim-cor-1", "/Users/demo/parser", "agent_working", `Edit attempt ${i + 1}`, { tool_name: "Edit", file: "parser.ts" }, "low", 2 + i * 2));
  }
  out.push(ev(agent, "sim-cor-1", "/Users/demo/parser", "session_error", "Tool failed", { error_kind: "edit_conflict" }, "high", 16));
  out.push(ev(agent, "sim-cor-1", "/Users/demo/parser", "session_finished", "Session ended", { reason: "error", outcome: "abandoned" }, "medium", 18));
  return out;
}

/** 多 session 并行：3 个 session 交叉 → 轮播/聚合需求 */
function multiSession(): CoreEvent[] {
  const out: CoreEvent[] = [];
  const mk = (id: string, proj: string, name: string) =>
    ev("claude_code", id, proj, "session_started", "Session started", { source: "startup", cwd: proj, title: name });
  out.push(mk("sim-ms-1", "/Users/demo/frontend", "frontend"));
  out.push(mk("sim-ms-2", "/Users/demo/backend", "backend"));
  out.push(mk("sim-ms-3", "/Users/demo/ci", "ci-config"));
  out.push(ev("claude_code", "sim-ms-1", "/Users/demo/frontend", "agent_working", "Working", { tool_name: "Edit" }, "low", 2));
  out.push(ev("claude_code", "sim-ms-2", "/Users/demo/backend", "permission_required", "Approve deploy", { tool_name: "Bash" }, "high", 4));
  out.push(ev("claude_code", "sim-ms-3", "/Users/demo/ci", "decision_required", "Notification", { kind: "Notification" }, "high", 6));
  out.push(ev("claude_code", "sim-ms-1", "/Users/demo/frontend", "token_update", "Tokens used", { tokens: 8000 }, "low", 8));
  out.push(ev("claude_code", "sim-ms-2", "/Users/demo/backend", "context_update", "Context 78%", { context_pct: 78 }, "medium", 10));
  out.push(ev("claude_code", "sim-ms-1", "/Users/demo/frontend", "session_finished", "Done", { reason: "completion", outcome: "success" }, "low", 12));
  return out;
}

const GENERATORS: Record<ScenarioName, () => CoreEvent[]> = {
  normal,
  frequent_decisions: frequentDecisions,
  context_overload: contextOverload,
  correction_loop: correctionLoop,
  multi_session: multiSession,
};

export function generateScenario(name: ScenarioName): CoreEvent[] {
  const gen = GENERATORS[name];
  if (!gen) throw new Error(`unknown scenario: ${name}`);
  seqCounter = 0;
  return gen();
}
