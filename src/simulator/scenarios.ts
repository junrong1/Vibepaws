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
  | "multi_session"
  | "crashed_session"
  | "subagent_fanout";

export const SCENARIOS: ScenarioName[] = [
  "normal",
  "frequent_decisions",
  "context_overload",
  "correction_loop",
  "multi_session",
  "crashed_session",
  "subagent_fanout",
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

/**
 * 崩掉的会话（G10）：卡在权限询问上，然后**再也没有任何事件** —— 没有 `session_finished`，
 * 因为 `kill -9` / 崩溃 / 合盖都不会发出它。
 *
 * 全部事件的时间戳都落在 20 分钟前，这样注入完就已经越过默认的 15 分钟静默阈值：
 * 宠物先红一下（needs-you 还在 30 分钟安全阀之内），随后被 Core 的 sweep 收掉 ——
 * 一个周期内最多 60 秒。旁边那个正常 session 用来验证「回收不会连坐」。
 *
 * 这个场景走的是**静默超时**那条路。进程探活那条路需要一个真实的、已经死掉的进程，
 * 生成器里造不出来 —— 它由 `src/core/reclaim.test.ts` 的真进程 kill 用例覆盖。
 */
function crashedSession(): CoreEvent[] {
  const out: CoreEvent[] = [];
  const ago = (min: number): number => -min * 60;
  const proj = "/Users/demo/api-server";
  out.push(ev("claude_code", "sim-zombie-1", proj, "session_started", "Session started", { source: "startup", cwd: proj, title: "api-server" }, "low", ago(25)));
  out.push(ev("claude_code", "sim-zombie-1", proj, "agent_working", "Editing config", { tool_name: "Edit" }, "low", ago(23)));
  out.push(ev("claude_code", "sim-zombie-1", proj, "token_update", "Tokens used", { tokens: 42_000 }, "low", ago(22)));
  // 最后一声：在等你放行。然后进程就没了。
  out.push(ev("claude_code", "sim-zombie-1", proj, "permission_required", "Approve Bash command", { tool_name: "Bash" }, "high", ago(20)));
  // 同时还有一个真的在干活的 session：它不该被这次回收连坐
  out.push(ev("claude_code", "sim-zombie-2", "/Users/demo/frontend", "session_started", "Session started", { source: "startup", cwd: "/Users/demo/frontend", title: "frontend" }));
  out.push(ev("claude_code", "sim-zombie-2", "/Users/demo/frontend", "agent_working", "Running tests", { tool_name: "Bash" }, "low", 2));
  return out;
}

/**
 * subagent 扇出（landscape 0.11）：working → delegating → juggling → 收回来 → 收工。
 *
 * 这个场景存在的理由是它是**唯一**能把两个新状态跑出来的入口 —— 没有它，验收
 * delegating / juggling 就得真的去开一个会派分身的 agent 再守着看。事件按秒铺开，
 * 注入后照着宠物看一遍就能验完：
 *
 *   +1s  1 个分身  → delegating（沉稳的动作，轨道上 1 颗方块）
 *   +3s  3 个分身  → juggling（急促，3 颗）—— 这一跳就是 clawd #862 的升档
 *   +6s  收回 2 个 → 还剩 1 个，退回 delegating
 *   +8s  收回最后1个 → **working**，不是 ready、更不是 finished（clawd #214）
 *   +11s session_finished
 *
 * 旁边那个 session 一直只有 1 个分身：它和主 session 各派 1 个的那几秒，宠物必须是
 * juggling（聚合看的是全桌面的总数，不是单个 session 的档位）。
 */
function subagentFanout(): CoreEvent[] {
  const out: CoreEvent[] = [];
  const proj = "/Users/demo/api-server";
  const sid = "sim-sub-1";
  const push = (type: CoreEvent["event_type"], summary: string, payload: CoreEvent["payload"], at: number) =>
    out.push(ev("claude_code", sid, proj, type, summary, payload, "low", at));

  push("session_started", "Session started", { source: "startup", cwd: proj, title: "api-server" }, 0);
  push("agent_working", "Planning the change", { tool_name: "Read" }, 1);
  // 1 个：delegating
  push("subagent_started", "Subagent started: Task", { tool_name: "Task", subagent_kind: "explore" }, 2);
  // 3 个：juggling
  push("subagent_started", "Subagent started: Task", { tool_name: "Task", subagent_kind: "review" }, 4);
  push("subagent_started", "Subagent started: Task", { tool_name: "Task", subagent_kind: "test" }, 5);
  // 收回两个 → 退回 delegating
  push("subagent_stopped", "Subagent stopped", {}, 7);
  push("subagent_stopped", "Subagent stopped", {}, 8);
  // 最后一个回来：这里必须落回 working。宠物在这一秒**不该**庆祝，也不该说「待命」
  push("subagent_stopped", "Subagent stopped", {}, 10);
  push("agent_working", "Applying the result", { tool_name: "Edit", file: "server.ts" }, 11);
  push("token_update", "Tokens used", { tokens: 38_000 }, 12);
  push("session_finished", "Session complete", { reason: "completion", outcome: "success" }, 14);

  // 第二个 session：全程只派 1 个分身，用来验证跨 session 的总数聚合
  const proj2 = "/Users/demo/frontend";
  out.push(ev("claude_code", "sim-sub-2", proj2, "session_started", "Session started", { source: "startup", cwd: proj2, title: "frontend" }, "low", 0));
  out.push(ev("claude_code", "sim-sub-2", proj2, "agent_working", "Running tests", { tool_name: "Bash" }, "low", 1));
  out.push(ev("claude_code", "sim-sub-2", proj2, "subagent_started", "Subagent started: Task", { tool_name: "Task" }, "low", 3));
  return out;
}

const GENERATORS: Record<ScenarioName, () => CoreEvent[]> = {
  normal,
  frequent_decisions: frequentDecisions,
  context_overload: contextOverload,
  correction_loop: correctionLoop,
  multi_session: multiSession,
  crashed_session: crashedSession,
  subagent_fanout: subagentFanout,
};

export function generateScenario(name: ScenarioName): CoreEvent[] {
  const gen = GENERATORS[name];
  if (!gen) throw new Error(`unknown scenario: ${name}`);
  seqCounter = 0;
  return gen();
}
