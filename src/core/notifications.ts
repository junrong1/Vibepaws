/**
 * 通知引擎 — 架构 §2.4 / README 6.2。
 * 判定全在 Core（保证 5 秒验收）；去重 60s；mute：全局 30m/2h、按 project、按 session。
 * 气泡内容只用固定文案模板 + 白名单 payload 参数 + agent 徽标，无敏感数据。
 *
 * i18n（issue #3 / #6）：Core 不决定用户看到哪种语言 —— 通知携带 `i18n`（文案 key + 参数），
 * 由渲染层按用户 locale 出字；落库的 title/body 固定用英文，DB 内容与界面语言解耦。
 */
import type Database from "better-sqlite3";
import type { CoreEvent } from "./events.ts";
import { projectShortName } from "./registry.ts";
import { getSetting, setSetting } from "./settings.ts";
import { t, DEFAULT_LOCALE } from "../i18n/messages.js";

/** 文案定位：渲染层用它出字，Core 用它渲染英文落库。 */
export interface I18nText {
  key: string;
  params?: Record<string, string | number>;
}

export interface Notification {
  event_id?: string;
  agent: string;
  session_id: string;
  type: string;
  /** 英文渲染结果（落库 + 老客户端兜底）；渲染层优先用 i18n。 */
  title: string;
  body: string;
  /** 文案 key + 参数，渲染层按用户 locale 出字 */
  i18n?: { title: I18nText; body: I18nText };
  status: "shown" | "dismissed" | "actioned" | "muted";
  shown_at: string;
}

/** 判定结果：只带 key/params，title/body 在落库前统一渲染成英文 */
type Draft = Omit<Notification, "status" | "shown_at" | "title" | "body"> & {
  i18n: { title: I18nText; body: I18nText };
};

function render(text: I18nText): string {
  return t(DEFAULT_LOCALE, text.key, text.params);
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

  private evaluate(ev: CoreEvent): Draft | null {
    const base = { event_id: ev.event_id, agent: ev.agent, session_id: ev.session_id };
    const agent = shortAgent(ev.agent);
    switch (ev.event_type) {
      case "decision_required": {
        const kind = ev.payload.kind;
        return {
          ...base,
          type: "decision",
          i18n: {
            title: { key: "notif.decision.title", params: { agent } },
            body: kind ? { key: "notif.decision.body_kind", params: { kind } } : { key: "notif.decision.body" },
          },
        };
      }
      case "permission_required": {
        const tool = ev.payload.tool_name;
        return {
          ...base,
          type: "permission",
          i18n: {
            title: { key: "notif.permission.title" },
            body: tool
              ? { key: "notif.permission.body", params: { agent, tool } }
              : { key: "notif.permission.body_unknown", params: { agent } },
          },
        };
      }
      case "context_update": {
        const pct = ev.payload.context_pct ?? 0;
        const hit = CONTEXT_WARN_PCTS.find((threshold) => pct >= threshold);
        if (hit === undefined) return null;
        const severity = pct >= 95 ? "critical" : pct >= 85 ? "high" : "warn";
        return {
          ...base,
          type: "context",
          i18n: {
            title: { key: "notif.context.title", params: { pct: Math.round(pct) } },
            body: { key: `notif.context.body.${severity}` },
          },
        };
      }
      case "session_error": {
        const kind = ev.payload.error_kind;
        return {
          ...base,
          type: "error",
          i18n: {
            title: { key: "notif.error.title", params: { agent } },
            body: kind ? { key: "notif.error.body_kind", params: { kind } } : { key: "notif.error.body" },
          },
        };
      }
      case "topic_drift_warning": {
        return {
          ...base,
          type: "drift",
          i18n: { title: { key: "notif.drift.title" }, body: { key: "notif.drift.body" } },
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
          ...base,
          type: "milestone",
          i18n: {
            title: { key: "notif.milestone.title", params: { pct: Math.round(ratio * 100) } },
            body: {
              key: "notif.milestone.body",
              params: { used: (tokens / 1000).toFixed(1), budget: Math.round(budget / 1000) },
            },
          },
        };
      }
      default:
        return null;
    }
  }

  /** 去重 + mute + 落库 */
  private persist(draft: Draft): Notification | null {
    // 落库与兜底用英文渲染；用户看到的语言由渲染层按 i18n 决定
    const n = { ...draft, title: render(draft.i18n.title), body: render(draft.i18n.body) };
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
