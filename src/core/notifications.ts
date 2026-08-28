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
import {
  getSetting,
  setSetting,
  deleteSetting,
  getContextWarnPcts,
  getDefaultBudgetTokens,
  DEFAULT_CONTEXT_WARN_PCTS,
} from "./settings.ts";
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
  /**
   * 阈值闩锁的**待提交**项。必须等 persist() 真的把气泡发出去才记账 ——
   * 写在判定阶段的话，被 mute 或 60s 去重丢掉的那一档也会被记成「已经报过」，
   * 于是 72%→88%→96% 连着来时只出一条 72%，更高的两档永远不再出声。
   */
  latch?: { key: string; tier: number };
};

function render(text: I18nText): string {
  return t(DEFAULT_LOCALE, text.key, text.params);
}

const DEDUP_MS = 60_000; // 同 session 同类型 60s 合并
const MUTE_GLOBAL_KEY = "mute.global";
/**
 * 用户当初选的时长（分钟）。只存截止时刻是不够的：界面要把「哪个按钮是开着的」
 * 标出来，而从剩余时间反推会在 2 小时静音的最后半小时把 30 分钟那个按钮点亮。
 */
const MUTE_GLOBAL_MINUTES_KEY = "mute.global.minutes";
const MUTE_PROJECT_PREFIX = "mute.project.";
const MUTE_SESSION_PREFIX = "mute.session.";

/**
 * context 阈值的**默认值**（README 6.3）。真正生效的那份由设置窗口决定，
 * 见 settings.ts 的 getContextWarnPcts —— 这里只是「用户没表态时用什么」。
 */
export const CONTEXT_WARN_PCTS = DEFAULT_CONTEXT_WARN_PCTS;
/** token 里程碑（README 6.3 usage 提醒） */
export const TOKEN_MILESTONES = [0.25, 0.5, 0.75, 0.9] as const;

export interface NotificationOptions {
  /** 去重窗口（毫秒）。测试里设 0 才能单独验证阈值闩锁的行为。 */
  dedupMs?: number;
}

export class NotificationEngine {
  private db: Database.Database;
  private dedupMs: number;
  /** 由 server 注入的事件分发链（先 registry 后 exp） */
  onEvent: (ev: CoreEvent) => void = () => {};
  private lastShown = new Map<string, number>();
  /**
   * 阈值闩锁：记住每个 session 已经报到过的最高档位。
   *
   * 没有它的时候，`find()` 命中的是**最低**一档，而且每条事件都会重新命中：
   * context 一旦过 70%，之后每 60s（去重窗口）就复读一次同样的警告，直到
   * session 结束 —— token 里程碑同理。这正是用户会去点「全部安静」的原因
   * （issue #7）。现在只有跨进**更高**一档才出声，回落到最低档以下则重新武装。
   */
  private latched = new Map<string, number>();

  constructor(db: Database.Database, opts: NotificationOptions = {}) {
    this.db = db;
    this.dedupMs = opts.dedupMs ?? DEDUP_MS;
  }

  /** 事件 → 通知判定（幂等：同一事件只判一次，用 events 表保证） */
  getForEvent(ev: CoreEvent): Notification | null {
    if (ev.event_type === "session_finished") this.forgetSession(ev.agent, ev.session_id);
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
            body:
              kind === "question"
                ? { key: "notif.decision.body_question" }
                : kind
                  ? { key: "notif.decision.body_kind", params: { kind } }
                  : { key: "notif.decision.body" },
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
        const pct = ev.payload.context_pct;
        // 没带读数的事件不是「回落」，不能动闩锁（否则下一条同档警告又会重新出声）
        if (typeof pct !== "number") return null;
        // 阈值由设置窗口决定；空列表 = 用户把 context 警告关了（pendingThreshold
        // 会顺手把闩锁清掉，重新打开后从第一档重新开始报）
        const latch = this.pendingThreshold("context", ev, pct, getContextWarnPcts(this.db));
        if (!latch) return null;
        const severity = pct >= 95 ? "critical" : pct >= 85 ? "high" : "warn";
        return {
          ...base,
          type: "context",
          latch,
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
        const tokens = ev.payload.tokens;
        // Claude Code 的 PostToolUse 多数不带 tokens（见 adapters/hook_agent.ts）——
        // 把缺失当成 0 会清掉闩锁，于是 25% 里程碑每分钟复读一次，正是 issue #7 的老毛病
        if (typeof tokens !== "number") return null;
        const budget = this.getBudget(ev.agent, ev.session_id);
        if (budget <= 0) return null;
        const ratio = tokens / budget;
        const latch = this.pendingThreshold("budget", ev, ratio, TOKEN_MILESTONES);
        if (!latch) return null;
        return {
          ...base,
          type: "milestone",
          latch,
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

  /**
   * 只在跨进「更高一档」时返回该档位（**不**落闩锁，交给 persist 成功后提交）。
   * 值回落到最低档以下（compact / clear / 新 session）→ 立刻清掉闩锁重新武装。
   */
  private pendingThreshold(
    kind: "context" | "budget",
    ev: CoreEvent,
    value: number,
    thresholds: readonly number[],
  ): { key: string; tier: number } | null {
    const key = `${kind}:${ev.agent}:${ev.session_id}`;
    // 从高到低找：0 → 96% 该报 95 那一档，而不是 70 那一档
    const hit = [...thresholds].reverse().find((threshold) => value >= threshold);
    if (hit === undefined) {
      this.latched.delete(key);
      return null;
    }
    if (hit <= (this.latched.get(key) ?? 0)) return null;
    return { key, tier: hit };
  }

  /**
   * 重新武装阈值闩锁（设置窗口改完预算 / 阈值后调用）。
   *
   * 不做这一步的话，新设置要等到下一个 session 才有效果：用户刚在设置里把预算填上，
   * 这个 session 已经烧掉的量却一条里程碑都不会报 —— 从界面上看就是「填了没用」。
   * 不传 agent/session 就是全清。
   */
  resetLatches(kind: "context" | "budget", agent?: string, sessionId?: string): void {
    const prefix = agent && sessionId ? `${kind}:${agent}:${sessionId}` : `${kind}:`;
    for (const key of [...this.latched.keys()]) {
      if (key === prefix || key.startsWith(prefix)) this.latched.delete(key);
    }
  }

  /**
   * 忘掉全部去重窗口与闩锁（数据被重置后调用）。
   * 通知表已经空了，内存里那份「这条报过了」却还在 —— 不清的话，
   * 重置之后的第一批事件会被当成复读而静静吞掉。
   */
  forgetAll(): void {
    this.latched.clear();
    this.lastShown.clear();
  }

  /** session 结束：清掉它的去重/闩锁记录，别让长期运行的 Core 无限攒 key */
  private forgetSession(agent: string, sessionId: string): void {
    for (const key of [...this.latched.keys()]) {
      if (key.endsWith(`:${agent}:${sessionId}`)) this.latched.delete(key);
    }
    for (const key of [...this.lastShown.keys()]) {
      if (key.startsWith(`${agent}:${sessionId}:`)) this.lastShown.delete(key);
    }
  }

  /** 去重 + mute + 落库 */
  private persist(draft: Draft): Notification | null {
    // 落库与兜底用英文渲染；用户看到的语言由渲染层按 i18n 决定
    const { latch, ...rest } = draft;
    const n = { ...rest, title: render(draft.i18n.title), body: render(draft.i18n.body) };
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
    // 去重：同 session 同类型 60s。**升档除外** —— 去重是为了压住「同一件事重复说」，
    // 而 70%→95% 是完全不同的一件事（「留意一下」变成「赶紧收尾」）。闩锁保证每档
    // 最多说一次，所以放行升档不会变成骚扰；界面那边同 key 的气泡会原地更新文字。
    const key = `${n.agent}:${n.session_id}:${n.type}`;
    const now = Date.now();
    const last = this.lastShown.get(key) ?? 0;
    if (!latch && now - last < this.dedupMs) return null;
    this.lastShown.set(key, now);
    // 真的发出去了才记「这一档已经报过」
    if (latch) this.latched.set(latch.key, latch.tier);

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
    return getDefaultBudgetTokens(this.db);
  }

  // ---- 对外 mute 操作（浮层调用） ----
  muteGlobal(minutes: number): void {
    setSetting(this.db, MUTE_GLOBAL_KEY, until(minutes));
    setSetting(this.db, MUTE_GLOBAL_MINUTES_KEY, String(Math.round(minutes)));
  }
  muteProject(projectId: string, minutes: number): void {
    setSetting(this.db, MUTE_PROJECT_PREFIX + projectId, until(minutes));
  }
  muteSession(sessionId: string, minutes: number): void {
    setSetting(this.db, MUTE_SESSION_PREFIX + sessionId, until(minutes));
  }
  /** 取消静音（issue #7：静音是状态，用户必须能自己解除） */
  unmuteGlobal(): void {
    deleteSetting(this.db, MUTE_GLOBAL_KEY);
    deleteSetting(this.db, MUTE_GLOBAL_MINUTES_KEY);
  }
  unmuteProject(projectId: string): void {
    deleteSetting(this.db, MUTE_PROJECT_PREFIX + projectId);
  }
  unmuteSession(sessionId: string): void {
    deleteSetting(this.db, MUTE_SESSION_PREFIX + sessionId);
  }

  /**
   * 当前静音状态（进 pet_state 推送）—— 界面要能显示「还剩多久」并原地取消。
   * 返回毫秒时间戳；已过期视为未静音，并顺手把过期的 key 清掉。
   */
  muteStatus(): {
    global_until: number | null;
    /** 用户当初选的时长（分钟）—— 界面据此点亮对应的那个按钮 */
    global_minutes: number | null;
    projects: string[];
    sessions: string[];
  } {
    const rows = this.db
      .prepare("SELECT key, value FROM settings WHERE key = ? OR key LIKE ? OR key LIKE ?")
      .all(MUTE_GLOBAL_KEY, `${MUTE_PROJECT_PREFIX}%`, `${MUTE_SESSION_PREFIX}%`) as Array<{
      key: string;
      value: string;
    }>;
    let globalUntil: number | null = null;
    const projects: string[] = [];
    const sessions: string[] = [];
    for (const { key, value } of rows) {
      if (isExpired(value)) {
        deleteSetting(this.db, key);
        if (key === MUTE_GLOBAL_KEY) deleteSetting(this.db, MUTE_GLOBAL_MINUTES_KEY);
        continue;
      }
      if (key === MUTE_GLOBAL_KEY) globalUntil = Number(value);
      else if (key.startsWith(MUTE_PROJECT_PREFIX)) projects.push(key.slice(MUTE_PROJECT_PREFIX.length));
      else if (key.startsWith(MUTE_SESSION_PREFIX)) sessions.push(key.slice(MUTE_SESSION_PREFIX.length));
    }
    const rawMinutes = globalUntil === null ? null : Number(getSetting(this.db, MUTE_GLOBAL_MINUTES_KEY));
    return {
      global_until: globalUntil,
      global_minutes: rawMinutes !== null && Number.isFinite(rawMinutes) && rawMinutes > 0 ? rawMinutes : null,
      projects,
      sessions,
    };
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
  return agent === "claude_code" ? "Claude" : agent === "codex" ? "Codex" : agent === "pi" ? "Pi" : agent === "dsh" ? "DeepSeek" : agent;
}

function until(minutes: number): string {
  return String(Date.now() + minutes * 60_000);
}
/**
 * 静音是否已到期。解析不出数字的值（脏数据、手改过的 settings）算**已过期** ——
 * 反过来写会让一个坏值把通知永久静音，而界面上看不出任何原因。
 */
function isExpired(v: string): boolean {
  const t = Number(v);
  return !Number.isFinite(t) || t <= Date.now();
}

export { projectShortName };
