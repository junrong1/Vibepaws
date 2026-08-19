/**
 * 通知引擎 — 架构 §2.4 / README 6.2。
 * 判定全在 Core（保证 5 秒验收）；去重 60s；mute：全局 30m/2h、按 project、按 session。
 * 气泡内容只用 safe_summary + agent 徽标 + session 短名，无敏感数据。
 */
import type Database from "better-sqlite3";
import type { CoreEvent } from "./events.ts";
import { projectShortName } from "./registry.ts";
import { getSetting, setSetting } from "./settings.ts";

export interface Notification {
  event_id?: string;
  agent: string;
  session_id: string;
  type: string;
  title: string;
  body: string;
  status: "shown" | "dismissed" | "actioned" | "muted";
  shown_at: string;
}

const DEDUP_MS = 60_000; // 同 session 同类型 60s 合并
const MUTE_GLOBAL_KEY = "mute.global";
const MUTE_PROJECT_PREFIX = "mute.project.";
const MUTE_SESSION_PREFIX = "mute.session.";

/** context 阈值（README 6.3） */
export const CONTEXT_WARN_PCTS = [70, 85, 95] as const;
/** token 里程碑（README 6.3 usage 提醒） */
export const TOKEN_MILESTONES = [0.25, 0.5, 0.75, 0.9] as const;

export class NotificationEngine {
  private db: Database.Database;
  /** 由 server 注入的事件分发链（先 registry 后 exp） */
  onEvent: (ev: CoreEvent) => void = () => {};
  private lastShown = new Map<string, number>();

  constructor(db: Database.Database) {
    this.db = db;
  }

  /** 事件 → 通知判定（幂等：同一事件只判一次，用 events 表保证） */
  getForEvent(ev: CoreEvent): Notification | null {
    const n = this.evaluate(ev);
    if (!n) return null;
    return this.persist(n);
  }

  private evaluate(ev: CoreEvent): Omit<Notification, "status" | "shown_at"> | null {
    switch (ev.event_type) {
      case "decision_required": {
        const kind = ev.payload.kind ?? "decision";
        return {
          event_id: ev.event_id,
          agent: ev.agent,
          session_id: ev.session_id,
          type: "decision",
          title: `需要你：${shortAgent(ev.agent)} · ${kind}`,
          body: ev.safe_summary || "Agent 需要你的决定",
        };
      }
      case "permission_required": {
        const tool = ev.payload.tool_name ?? "";
        return {
          event_id: ev.event_id,
          agent: ev.agent,
          session_id: ev.session_id,
          type: "permission",
          title: `权限请求：${tool || "tool"}`,
          body: ev.safe_summary || "Agent 等待批准",
        };
      }
      case "context_update": {
        const pct = ev.payload.context_pct ?? 0;
        const hit = CONTEXT_WARN_PCTS.find((t) => pct >= t);
        if (hit === undefined) return null;
        return {
          event_id: ev.event_id,
          agent: ev.agent,
          session_id: ev.session_id,
          type: "context",
          title: `上下文已用 ${Math.round(pct)}%`,
          body: pct >= 95 ? "建议尽快收尾或新开会话" : pct >= 85 ? "注意 token 消耗" : "上下文开始紧张",
        };
      }
      case "session_error": {
        return {
          event_id: ev.event_id,
          agent: ev.agent,
          session_id: ev.session_id,
          type: "error",
          title: `${shortAgent(ev.agent)} 出错`,
          body: ev.safe_summary || (ev.payload.error_kind ?? "unknown error"),
        };
      }
      case "topic_drift_warning": {
        return {
          event_id: ev.event_id,
          agent: ev.agent,
          session_id: ev.session_id,
          type: "drift",
          title: "话题漂移提醒",
          body: "任务可能偏离目标，建议新开一个会话",
        };
      }
      case "token_update": {
        const tokens = ev.payload.tokens ?? 0;
        const budget = this.getBudget(ev.agent, ev.session_id);
        if (budget <= 0) return null;
        const ratio = tokens / budget;
        const hit = TOKEN_MILESTONES.find((m) => ratio >= m);
        if (hit === undefined) return null;
        return {
          event_id: ev.event_id,
          agent: ev.agent,
          session_id: ev.session_id,
          type: "milestone",
          title: `已用 ${Math.round(ratio * 100)}% budget`,
          body: `${(tokens / 1000).toFixed(1)}k tokens · 预算 ${Math.round(budget / 1000)}k`,
        };
      }
      default:
        return null;
    }
  }

  /** 去重 + mute + 落库 */
  private persist(n: Omit<Notification, "status" | "shown_at">): Notification | null {
    // mute 检查
    const muted = this.isMuted(n.session_id, n.type);
    if (muted) {
      this.db
        .prepare(
          `INSERT INTO notifications(event_id, agent, session_id, type, title, body, status, shown_at)
           VALUES(?, ?, ?, ?, ?, ?, 'muted', ?)`,
        )
        .run(n.event_id ?? null, n.agent, n.session_id, n.type, n.title, n.body, new Date().toISOString());
      return null;
    }
    // 去重：同 session 同类型 60s
    const key = `${n.agent}:${n.session_id}:${n.type}`;
    const now = Date.now();
    const last = this.lastShown.get(key) ?? 0;
    if (now - last < DEDUP_MS) return null;
    this.lastShown.set(key, now);

    const shownAt = new Date().toISOString();
    const info = this.db
      .prepare(
        `INSERT INTO notifications(event_id, agent, session_id, type, title, body, status, shown_at)
         VALUES(?, ?, ?, ?, ?, ?, 'shown', ?)`,
      )
      .run(n.event_id ?? null, n.agent, n.session_id, n.type, n.title, n.body, shownAt);
    return { ...n, status: "shown", shown_at: shownAt };
  }

  // ---- mute 管理 ----
  private isMuted(sessionId: string, type: string): boolean {
    const g = getSetting(this.db, MUTE_GLOBAL_KEY);
    if (g && !isExpired(g)) return true;
    if (type === "drift" || type === "milestone") return false; // 这两类只按显式项目/session mute
    const project = this.projectForSession(sessionId);
    if (project) {
      const p = getSetting(this.db, MUTE_PROJECT_PREFIX + project);
      if (p && !isExpired(p)) return true;
    }
    const s = getSetting(this.db, MUTE_SESSION_PREFIX + sessionId);
    if (s && !isExpired(s)) return true;
    return false;
  }

  private projectForSession(sessionId: string): string | null {
    const row = this.db.prepare("SELECT project_id FROM sessions WHERE agent_session_id = ?").get(sessionId) as
      | { project_id: string }
      | undefined;
    return row?.project_id ?? null;
  }

  private getBudget(agent: string, sessionId: string): number {
    const row = this.db
      .prepare("SELECT budget_tokens FROM sessions WHERE agent=? AND agent_session_id=?")
      .get(agent, sessionId) as { budget_tokens: number } | undefined;
    if (row?.budget_tokens) return row.budget_tokens;
    const def = Number(getSetting(this.db, "budget_tokens") ?? "0");
    return def;
  }

  // ---- 对外 mute 操作（浮层调用） ----
  muteGlobal(minutes: number): void {
    setSetting(this.db, MUTE_GLOBAL_KEY, until(minutes));
  }
  muteProject(projectId: string, minutes: number): void {
    setSetting(this.db, MUTE_PROJECT_PREFIX + projectId, until(minutes));
  }
  muteSession(sessionId: string, minutes: number): void {
    setSetting(this.db, MUTE_SESSION_PREFIX + sessionId, until(minutes));
  }
  dismiss(notificationId: number): void {
    this.db.prepare("UPDATE notifications SET status='dismissed' WHERE id=?").run(notificationId);
  }
  actioned(notificationId: number): void {
    this.db
      .prepare("UPDATE notifications SET status='actioned', actioned_at=? WHERE id=?")
      .run(new Date().toISOString(), notificationId);
  }
  history(limit = 50): Notification[] {
    return this.db
      .prepare("SELECT * FROM notifications ORDER BY shown_at DESC LIMIT ?")
      .all(limit) as Notification[];
  }

  /** 聚合气泡：多条需要你的通知合并 */
  aggregateRecent(limit = 20): Notification[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM notifications WHERE status='shown' ORDER BY shown_at DESC LIMIT ?`,
      )
      .all(limit) as Notification[];
    return rows;
  }
}

export function shortAgent(agent: string): string {
  return agent === "claude_code" ? "Claude" : agent === "codex" ? "Codex" : agent;
}

function until(minutes: number): string {
  return String(Date.now() + minutes * 60_000);
}
function isExpired(v: string): boolean {
  const t = Number(v);
  return Number.isFinite(t) && t < Date.now();
}

export { projectShortName };
