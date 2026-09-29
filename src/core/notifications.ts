/**
 * 通知引擎 — 架构 §2.4 / README 6.2。
 * 判定全在 Core（保证 5 秒验收）；去重 60s；mute：全局 30m/2h、按 project、按 session。
 * 气泡内容只用固定文案模板 + 白名单 payload 参数 + agent 徽标，无敏感数据。
 *
 * i18n（issue #3 / #6）：Core 不决定用户看到哪种语言 —— 通知携带 `i18n`（文案 key + 参数），
 * 由渲染层按用户 locale 出字；落库的 title/body 固定用英文，DB 内容与界面语言解耦。
 */
import type Database from "better-sqlite3";
import type { CoreEvent, NotificationResolution, NotificationResolvedPush } from "./events.ts";
import { projectShortName } from "./registry.ts";
import {
  getSetting,
  setSetting,
  deleteSetting,
  getContextWarnPcts,
  getDefaultBudgetTokens,
  DEFAULT_CONTEXT_WARN_PCTS,
  MUTE_GLOBAL_KEY,
  MUTE_GLOBAL_MINUTES_KEY,
  MUTE_PROJECT_PREFIX,
  MUTE_SESSION_PREFIX,
} from "./settings.ts";
import { t, DEFAULT_LOCALE } from "../i18n/messages.js";
import { DEFAULT_MILESTONE_TIERS, coachingRule, ruleForType, ruleThreshold, type CoachingRuleId } from "./coaching.ts";
import { isEditTool } from "./events.ts";

/** 文案定位：渲染层用它出字，Core 用它渲染英文落库。 */
export interface I18nText {
  key: string;
  params?: Record<string, string | number>;
}

export interface Notification {
  /**
   * 行 id（notifications.id）。界面拿它回 `/api/action` 叉掉 / 标记已处理，
   * Core 拿它推 `notification_resolved`。没有它，气泡在界面上是一个无法被指认的东西。
   */
  id?: number;
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
  /** 怎么结束的（NULL = 还挂着），见 events.ts 的 NotificationResolution */
  resolution?: NotificationResolution | null;
  resolved_at?: string | null;
  /**
   * 「永远允许」会写下的那条规则（U9）。只在 permission 上、只在 Core 是桌面壳拉起来的
   * （手里有 grant secret）时才有 —— 没有它，界面就不给这个选项。project 是短名。
   * 这是给人看的预览，不是授予的依据：授予时 Core 按 id 从库里重新推一遍。
   */
  grant?: { rule: string; project: string };
  /**
   * 辅导类气泡是哪条规则发的（U10）：建议动作的文案 key，以及能不能按「没用」去调它。
   * decision / permission / ready 不是辅导，没有这个字段。
   */
  coach?: { rule: CoachingRuleId; action: string; tunable: boolean };
}

/** 判定结果：只带 key/params，title/body 在落库前统一渲染成英文 */
type Draft = Omit<Notification, "id" | "status" | "shown_at" | "title" | "body" | "resolution" | "resolved_at"> & {
  i18n: { title: I18nText; body: I18nText };
  /**
   * 阈值闩锁的**待提交**项。必须等 persist() 真的把气泡发出去才记账 ——
   * 写在判定阶段的话，被 mute 或 60s 去重丢掉的那一档也会被记成「已经报过」，
   * 于是 72%→88%→96% 连着来时只出一条 72%，更高的两档永远不再出声。
   */
  latch?: { key: string; tier: number };
  /** 跨的是哪一档（context 的百分比 / 里程碑的比例 / 次数）—— 落进 notifications.tier，「没用」据此调阈值 */
  tier?: number;
  /** 影子模式（drift）：判定照常、照常落库，但不弹气泡（KTD11） */
  shadow?: boolean;
};

function render(text: I18nText): string {
  return t(DEFAULT_LOCALE, text.key, text.params);
}

const DEDUP_MS = 60_000; // 同 session 同类型 60s 合并
// 静音键名在 settings.ts（registry 的等待账本也要读，而它不能 import 这个模块）

/**
 * context 阈值的**默认值**（README 6.3）。真正生效的那份由设置窗口决定，
 * 见 settings.ts 的 getContextWarnPcts —— 这里只是「用户没表态时用什么」。
 */
export const CONTEXT_WARN_PCTS = DEFAULT_CONTEXT_WARN_PCTS;
/** token 里程碑（README 6.3 usage 提醒） */
export const TOKEN_MILESTONES = DEFAULT_MILESTONE_TIERS;

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
  /** 每个 session 攒了几次工具失败（error 规则「每第 N 次才说」的计数）；按「没用」后清零 */
  private errorCounts = new Map<string, number>();

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
        // ready 分流（与 registry.ts 一致）：question = 阻塞等你回答；其余 = 一轮结束待命
        if (kind !== "question") {
          return {
            ...base,
            type: "ready",
            i18n: {
              title: { key: "notif.ready.title", params: { agent } },
              body: { key: "notif.ready.body" },
            },
          };
        }
        return {
          ...base,
          type: "decision",
          i18n: {
            title: { key: "notif.decision.title", params: { agent } },
            body: { key: "notif.decision.body_question" },
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
          tier: latch.tier,
          i18n: {
            title: { key: "notif.context.title", params: { pct: Math.round(pct) } },
            body: { key: `notif.context.body.${severity}` },
          },
        };
      }
      case "session_error": {
        const kind = ev.payload.error_kind;
        // 「每第 N 次失败才说」（N 默认 1 = 每次都说）。N 由「没用」往上调，见 coaching.ts
        const countKey = `${ev.agent}:${ev.session_id}`;
        const count = (this.errorCounts.get(countKey) ?? 0) + 1;
        this.errorCounts.set(countKey, count);
        const every = ruleThreshold(this.db, "error")[0] ?? 1;
        if (count % every !== 0) return null;
        return {
          ...base,
          type: "error",
          tier: every,
          i18n: {
            title: { key: "notif.error.title", params: { agent } },
            body: kind ? { key: "notif.error.body_kind", params: { kind } } : { key: "notif.error.body" },
          },
        };
      }
      case "agent_working": {
        // 重复编辑（Focus 的警告）：registry 已经先处理过这条事件、把 repeat_edit_count 记好了
        if (!ev.payload.file || !isEditTool(ev.payload.tool_name)) return null;
        const count = this.repeatEditCount(ev.agent, ev.session_id);
        const latch = this.pendingThreshold("repeat", ev, count, ruleThreshold(this.db, "repeat_edit"));
        if (!latch) return null;
        return {
          ...base,
          type: "repeat_edit",
          latch,
          tier: latch.tier,
          i18n: {
            title: { key: "notif.repeat_edit.title", params: { n: count } },
            body: { key: "notif.repeat_edit.body" },
          },
        };
      }
      case "topic_drift_warning": {
        return {
          ...base,
          type: "drift",
          // 影子模式：记下来、不出声（KTD11 / G18）。误报率够低之前它不配占一条气泡
          shadow: coachingRule("drift")!.shadow,
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
        // 档位由「没用」从低往高摘（coaching.ts）；默认就是 TOKEN_MILESTONES
        const latch = this.pendingThreshold("budget", ev, ratio, ruleThreshold(this.db, "milestone"));
        if (!latch) return null;
        return {
          ...base,
          type: "milestone",
          latch,
          tier: latch.tier,
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
    kind: LatchKind,
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
  resetLatches(kind: LatchKind, agent?: string, sessionId?: string): void {
    const prefix = agent && sessionId ? `${kind}:${agent}:${sessionId}` : `${kind}:`;
    for (const key of [...this.latched.keys()]) {
      if (key === prefix || key.startsWith(prefix)) this.latched.delete(key);
    }
  }

  /**
   * 阈值变了之后**重新对齐**闩锁，而不是清掉（U10 的闩锁修正）。
   *
   * 从前改 context_warn_pcts 会清空全部 context 闩锁 —— 于是在 88% 上把 85 挪到 90，
   * 几秒后的下一条 context_update 就按「新的一档」再报一次：用户刚说了这条没用，它立刻又响。
   * 现在每个闩锁落到「不高于它原来那一档的最高新档」：已经报过的高度不再重报，
   * 比它更高的新档照常会响；新阈值里没有不高于它的档 → 清掉，从头开始。
   */
  relatch(kind: LatchKind, thresholds: readonly number[]): void {
    const prefix = `${kind}:`;
    for (const [key, tier] of [...this.latched]) {
      if (!key.startsWith(prefix)) continue;
      const floor = [...thresholds].reverse().find((t) => t <= tier);
      if (floor === undefined) this.latched.delete(key);
      else this.latched.set(key, floor);
    }
  }

  /**
   * 用户在这个 session 上按了「没用」、阈值已经挪过了：把它闩在新的那一档上，
   * 这个 session 不会因为「挪到了 90」而在 91% 时又说一次（R21）。只往高处闩，不往低处拉。
   */
  silenceAfterTuning(rule: CoachingRuleId, agent: string, sessionId: string, tier: number | null): void {
    if (rule === "error") {
      // 「每第 N 次」从头数：刚嫌过吵，就别让下一次失败立刻凑满新的 N
      this.errorCounts.delete(`${agent}:${sessionId}`);
      return;
    }
    if (tier === null) return;
    const kind: LatchKind | null = rule === "context" ? "context" : rule === "milestone" ? "budget" : rule === "repeat_edit" ? "repeat" : null;
    if (!kind) return;
    const key = `${kind}:${agent}:${sessionId}`;
    this.latched.set(key, Math.max(this.latched.get(key) ?? 0, tier));
  }

  /**
   * 忘掉全部去重窗口与闩锁（数据被重置后调用）。
   * 通知表已经空了，内存里那份「这条报过了」却还在 —— 不清的话，
   * 重置之后的第一批事件会被当成复读而静静吞掉。
   */
  forgetAll(): void {
    this.latched.clear();
    this.lastShown.clear();
    this.errorCounts.clear();
  }

  /** session 结束：清掉它的去重/闩锁记录，别让长期运行的 Core 无限攒 key */
  private forgetSession(agent: string, sessionId: string): void {
    for (const key of [...this.latched.keys()]) {
      if (key.endsWith(`:${agent}:${sessionId}`)) this.latched.delete(key);
    }
    for (const key of [...this.lastShown.keys()]) {
      if (key.startsWith(`${agent}:${sessionId}:`)) this.lastShown.delete(key);
    }
    this.errorCounts.delete(`${agent}:${sessionId}`);
  }

  private repeatEditCount(agent: string, sessionId: string): number {
    const row = this.db
      .prepare("SELECT repeat_edit_count FROM sessions WHERE agent=? AND agent_session_id=?")
      .get(agent, sessionId) as { repeat_edit_count: number } | undefined;
    return row?.repeat_edit_count ?? 0;
  }

  /** 去重 + mute + 落库 */
  private persist(draft: Draft): Notification | null {
    // 落库与兜底用英文渲染；用户看到的语言由渲染层按 i18n 决定
    const { latch, tier, shadow, ...rest } = draft;
    const n = { ...rest, title: render(draft.i18n.title), body: render(draft.i18n.body) };
    const rule = ruleForType(n.type);
    const ruleId = rule?.id ?? null;
    // 影子模式：判定命中了，记一行（误报率查询靠它攒「本来会响几次」），但它一出生就结束、不弹出来
    if (shadow) {
      const at = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO notifications(event_id, agent, session_id, type, title, body, status, shown_at,
                                     resolution, resolved_at, rule_id, tier, shadow)
           VALUES(?, ?, ?, ?, ?, ?, 'muted', ?, 'muted', ?, ?, ?, 1)`,
        )
        .run(n.event_id ?? null, n.agent, n.session_id, n.type, n.title, n.body, at, at, ruleId, tier ?? null);
      return null;
    }
    // mute 检查
    const muted = this.isMuted(n.session_id, n.type);
    if (muted) {
      // 被静音吞掉的通知一出生就结束了：resolved_at = shown_at
      const at = new Date().toISOString();
      this.db
        .prepare(
          `INSERT INTO notifications(event_id, agent, session_id, type, title, body, status, shown_at,
                                     resolution, resolved_at, rule_id, tier)
           VALUES(?, ?, ?, ?, ?, ?, 'muted', ?, 'muted', ?, ?, ?)`,
        )
        .run(n.event_id ?? null, n.agent, n.session_id, n.type, n.title, n.body, at, at, ruleId, tier ?? null);
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
        `INSERT INTO notifications(event_id, agent, session_id, type, title, body, status, shown_at, rule_id, tier)
         VALUES(?, ?, ?, ?, ?, ?, 'shown', ?, ?, ?)`,
      )
      .run(n.event_id ?? null, n.agent, n.session_id, n.type, n.title, n.body, shownAt, ruleId, tier ?? null);
    const coach = rule ? { coach: { rule: rule.id, action: rule.actionKey, tunable: rule.tunable } } : {};
    // lastInsertRowid 是 number | bigint；行 id 不可能超出安全整数，Number() 之后 JSON 才序列化得了
    return { ...n, ...coach, id: Number(info.lastInsertRowid), status: "shown", shown_at: shownAt };
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
  /**
   * 用户在宠物里叉掉 / 点了这条气泡。返回被结束的那条（调用方据此推 `notification_resolved`）；
   * null = 没有这一行，或者它早就结束了 —— 只记第一次结束，被回收过的气泡再叉一次仍是 timeout。
   */
  dismiss(notificationId: number): NotificationResolvedPush | null {
    const at = new Date().toISOString();
    // 理由与结局分开记（R22）：就算这一行早被回收 / 推断结束过，用户叉掉它这件事本身也是一个评价
    this.db.prepare("UPDATE notifications SET dismiss_reason='dismissed' WHERE id=? AND dismiss_reason IS NULL").run(notificationId);
    const row = this.db
      .prepare(
        `UPDATE notifications SET status='dismissed', resolution='dismissed', resolved_at=?
          WHERE id=? AND resolution IS NULL
          RETURNING id, agent, session_id, type, resolution, resolved_at`,
      )
      .get(at, notificationId) as NotificationResolvedPush | undefined;
    return row ?? null;
  }
  actioned(notificationId: number): NotificationResolvedPush | null {
    const at = new Date().toISOString();
    const row = this.db
      .prepare(
        `UPDATE notifications SET status='actioned', actioned_at=?, resolution='user_actioned', resolved_at=?
          WHERE id=? AND resolution IS NULL
          RETURNING id, agent, session_id, type, resolution, resolved_at`,
      )
      .get(at, at, notificationId) as NotificationResolvedPush | undefined;
    return row ?? null;
  }

  /**
   * 「等你」被 agent 自己的进展清掉了（用户多半在终端里答的）→ 把这个 session 还挂着的
   * decision / permission 气泡记成 inferred。只动这两类：它们是 needs-you 的气泡，
   * context / error 之类的提醒不因为 agent 继续干活就算「答过了」。
   */
  resolveInferred(agent: string, sessionId: string): NotificationResolvedPush[] {
    return this.db
      .prepare(
        `UPDATE notifications SET status='dismissed', resolution='inferred', resolved_at=?
          WHERE agent=? AND session_id=? AND status='shown' AND resolution IS NULL
            AND type IN ('decision','permission')
          RETURNING id, agent, session_id, type, resolution, resolved_at`,
      )
      .all(new Date().toISOString(), agent, sessionId) as NotificationResolvedPush[];
  }
  /**
   * 「没用」（U10 / R22）。一条原地合并过的辅导气泡代表好几行（界面的 b.ids）：每一行都记上理由，
   * 还挂着的顺带结束成 dismissed。理由写进 dismiss_reason，**不碰** resolution ——
   * resolution 是「第一次结束」，被回收过的行照旧是 timeout，理由是另一件事。
   * 返回被结束的那些（推 notification_resolved 用）与最新那一行的规则 / 档位（调阈值用）。
   */
  notUseful(ids: number[]): {
    resolved: NotificationResolvedPush[];
    fired: { rule_id: CoachingRuleId; tier: number | null; agent: string; session_id: string } | null;
  } {
    const unique = [...new Set(ids.filter((x) => Number.isInteger(x)))];
    if (unique.length === 0) return { resolved: [], fired: null };
    const at = new Date().toISOString();
    const marks = unique.map(() => "?").join(",");
    const tx = this.db.transaction(() => {
      this.db
        .prepare(`UPDATE notifications SET dismiss_reason='not_useful' WHERE id IN (${marks}) AND rule_id IS NOT NULL`)
        .run(...unique);
      const resolved = this.db
        .prepare(
          `UPDATE notifications SET status='dismissed', resolution='dismissed', resolved_at=?
            WHERE id IN (${marks}) AND rule_id IS NOT NULL AND resolution IS NULL
            RETURNING id, agent, session_id, type, resolution, resolved_at`,
        )
        .all(at, ...unique) as NotificationResolvedPush[];
      const fired = this.db
        .prepare(
          `SELECT rule_id, tier, agent, session_id FROM notifications
            WHERE id IN (${marks}) AND rule_id IS NOT NULL ORDER BY id DESC LIMIT 1`,
        )
        .get(...unique) as { rule_id: CoachingRuleId; tier: number | null; agent: string; session_id: string } | undefined;
      return { resolved, fired: fired ?? null };
    });
    return tx();
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

/** 闩锁的三种：context 阈值、预算里程碑、重复编辑次数 */
type LatchKind = "context" | "budget" | "repeat";

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
