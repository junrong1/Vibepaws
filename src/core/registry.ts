/**
 * Session Registry — 跨 session 管理核心（架构 §2.3）。
 * 数据源：事件流。生命周期由 session_started 的 source 推断。
 * 宠物聚合状态：needs-you > warning > working > idle（finished/tired/level-up 由宠物引擎设置）。
 */
import type Database from "better-sqlite3";
import { isReclaimed } from "./events.ts";
import { notePid } from "./reclaim.ts";
import type { CoreEvent, PetState, SessionView, SessionState } from "./events.ts";

export type RegistryHandler = (ev: CoreEvent) => void;

/** 「等你」标记的安全阀：超过这个时长仍没有任何进展事件，就不再当成在等 */
const NEEDS_INPUT_MAX_MS = 30 * 60_000;
/** session_finished 之后仍算 finished 态的时长 */
const FINISHED_GLOW_MS = 60_000;

function recentlyFinished(finishedAt: string | null | undefined): boolean {
  if (!finishedAt) return false;
  const at = new Date(finishedAt).getTime();
  return Number.isFinite(at) && Date.now() - at < FINISHED_GLOW_MS;
}

export interface RegistryOptions {
  db: Database.Database;
  /** 每个事件处理后通知（SSE 推送等） */
  onUpdate?: () => void;
}

export class SessionRegistry {
  private db: Database.Database;
  private onUpdate?: () => void;
  /** correction 启发式：同一文件 30s 内重复 Edit → correction_count+1（架构 §3.3） */
  private lastEdit = new Map<string, { file: string; at: number }>();

  constructor(opts: RegistryOptions) {
    this.db = opts.db;
    this.onUpdate = opts.onUpdate;
  }

  /**
   * 忘掉全部内存启发式（数据被重置后调用）。
   * 不清的话，一条指向已经不存在的 session 的 lastEdit 还能给下一个同名 session
   * 记上一次「反复改同一个文件」—— 用户刚清空了数据，correction_count 却从 1 开始。
   */
  forgetAll(): void {
    this.lastEdit.clear();
  }

  /** 核心入口：事件 → 状态机 → sessions 表 + 内存回调 */
  handle(ev: CoreEvent): void {
    const db = this.db;
    switch (ev.event_type) {
      case "session_started": {
        const source = ev.payload.source ?? "startup";
        const existing = this.findSession(ev);
        if (existing) this.clearNeedsInput(ev);
        if (source === "resume" || source === "continue") {
          if (existing) {
            // 同一 (agent, session_id) 复用
            db.prepare(
              `UPDATE sessions SET is_active=1, last_event_at=?, title=COALESCE(?, title),
               project_id=COALESCE(?, project_id), started_at=COALESCE(started_at, ?)
               WHERE agent=? AND agent_session_id=?`,
            ).run(ev.timestamp, ev.payload.title ?? null, ev.project_id, ev.timestamp, ev.agent, ev.session_id);
          } else {
            this.insertSession(ev, source);
          }
        } else if (source === "fork") {
          // fork：新 session_id，parent=原 session（parent_session_id 来自 payload）
          this.insertSession(ev, "fork");
        } else if (source === "clear") {
          if (existing) {
            db.prepare(
              `UPDATE sessions SET is_active=1, context_pct=0, token_used=0, token_exp_granted=0,
                 needs_input_since=NULL, needs_input_kind=NULL, last_event_at=?
               WHERE agent=? AND agent_session_id=?`,
            ).run(ev.timestamp, ev.agent, ev.session_id);
          } else {
            this.insertSession(ev, "startup");
          }
        } else {
          // startup / compact（compact 不新建，仅更新状态）
          if (existing) {
            db.prepare(
              `UPDATE sessions SET is_active=1, last_event_at=? WHERE agent=? AND agent_session_id=?`,
            ).run(ev.timestamp, ev.agent, ev.session_id);
          } else {
            this.insertSession(ev, "startup");
          }
        }
        break;
      }

      case "agent_working": {
        this.ensureSession(ev);
        // correction 启发式：同文件 30s 内重复 Edit → correction_count+1
        const file = ev.payload.file;
        if (file && ev.payload.tool_name === "Edit") {
          const key = `${ev.agent}:${ev.session_id}`;
          const prev = this.lastEdit.get(key);
          const now = Date.now();
          if (prev && prev.file === file && now - prev.at < 30_000) {
            this.db
              .prepare(
                "UPDATE sessions SET correction_count = correction_count + 1 WHERE agent=? AND agent_session_id=?",
              )
              .run(ev.agent, ev.session_id);
          }
          this.lastEdit.set(key, { file, at: now });
        }
        this.clearNeedsInput(ev);
        db.prepare(
          `UPDATE sessions SET last_event_at=? WHERE agent=? AND agent_session_id=?`,
        ).run(ev.timestamp, ev.agent, ev.session_id);
        break;
      }

      case "decision_required":
      case "permission_required": {
        this.ensureSession(ev);
        // 「等你」是状态，不是瞬间事件：把起点记在 session 上，直到该 session
        // 再发来任何别的事件（= 用户已经回答 / agent 已经继续）才清掉。
        // 只靠 notifications 表的 60s 时间窗推断，会让宠物在 agent 仍被阻塞时
        // 悄悄安静下来 —— 而这正是这个产品唯一必须做对的提醒。
        db.prepare(
          `UPDATE sessions SET last_event_at=?,
             needs_input_since=COALESCE(needs_input_since, ?), needs_input_kind=?
           WHERE agent=? AND agent_session_id=?`,
        ).run(
          ev.timestamp,
          ev.timestamp,
          ev.event_type === "permission_required" ? "permission" : "decision",
          ev.agent,
          ev.session_id,
        );
        break;
      }

      case "session_error":
      case "topic_drift_warning": {
        this.ensureSession(ev);
        this.clearNeedsInput(ev);
        db.prepare(
          `UPDATE sessions SET last_event_at=? WHERE agent=? AND agent_session_id=?`,
        ).run(ev.timestamp, ev.agent, ev.session_id);
        break;
      }

      case "token_update": {
        this.ensureSession(ev);
        this.clearNeedsInput(ev);
        const tokens = typeof ev.payload.tokens === "number" ? ev.payload.tokens : 0;
        db.prepare(
          `UPDATE sessions SET token_used=MAX(token_used, ?), last_event_at=? WHERE agent=? AND agent_session_id=?`,
        ).run(tokens, ev.timestamp, ev.agent, ev.session_id);
        break;
      }

      case "context_update": {
        this.ensureSession(ev);
        this.clearNeedsInput(ev);
        const pct = typeof ev.payload.context_pct === "number" ? ev.payload.context_pct : 0;
        db.prepare(
          `UPDATE sessions SET context_pct=?, last_event_at=? WHERE agent=? AND agent_session_id=?`,
        ).run(pct, ev.timestamp, ev.agent, ev.session_id);
        break;
      }

      case "subagent_started": {
        this.ensureSession(ev);
        this.clearNeedsInput(ev);
        db.prepare(
          `UPDATE sessions SET last_event_at=? WHERE agent=? AND agent_session_id=?`,
        ).run(ev.timestamp, ev.agent, ev.session_id);
        break;
      }

      case "session_finished": {
        this.ensureSession(ev);
        this.clearNeedsInput(ev);
        const reason = ev.payload.reason ?? "completion";
        const outcome = ev.payload.outcome ?? "success";
        db.prepare(
          `UPDATE sessions SET is_active=0, finished_at=?, outcome=?, last_event_at=?
           WHERE agent=? AND agent_session_id=?`,
        ).run(ev.timestamp, outcome, ev.timestamp, ev.agent, ev.session_id);
        void reason;
        break;
      }

      case "adapter_status": {
        // agents 表由 ingress 的 upsertAgent 处理；这里只触发更新
        break;
      }
    }
    // 进程探活的输入（G10）。放在 switch 之后：这时 session 行必然已经存在，
    // 而 adapter_status 那种不建 session 的事件只会更新到零行（无害）。
    notePid(this.db, ev.agent, ev.session_id, ev.payload.pid);
    this.onUpdate?.();
  }

  /** 收到任何「进展」事件都说明用户已经回答 / agent 已经继续 → 停止「等你」 */
  private clearNeedsInput(ev: CoreEvent): void {
    this.db
      .prepare(
        `UPDATE sessions SET needs_input_since=NULL, needs_input_kind=NULL
         WHERE agent=? AND agent_session_id=? AND needs_input_since IS NOT NULL`,
      )
      .run(ev.agent, ev.session_id);
  }

  private findSession(ev: CoreEvent): { id: number } | undefined {
    return this.db
      .prepare("SELECT id FROM sessions WHERE agent=? AND agent_session_id=?")
      .get(ev.agent, ev.session_id) as { id: number } | undefined;
  }

  private ensureSession(ev: CoreEvent): number {
    const existing = this.findSession(ev);
    if (existing) return existing.id;
    return this.insertSession(ev, "startup");
  }

  private insertSession(ev: CoreEvent, source: string): number {
    const title = ev.payload.title ?? projectShortName(ev.project_id);
    const parentId = ev.payload.parent_session_id
      ? (this.db
          .prepare("SELECT id FROM sessions WHERE agent=? AND agent_session_id=?")
          .get(ev.agent, ev.payload.parent_session_id) as { id: number } | undefined)?.id ?? null
      : null;
    const info = this.db
      .prepare(
        `INSERT INTO sessions(agent, agent_session_id, project_id, title, parent_id, branch,
                              is_active, last_event_at, started_at)
         VALUES(?, ?, ?, ?, ?, ?, 1, ?, ?)`,
      )
      .run(
        ev.agent,
        ev.session_id,
        ev.project_id,
        title,
        parentId,
        source === "fork" ? "fork" : null,
        ev.timestamp,
        ev.timestamp,
      );
    return Number(info.lastInsertRowid);
  }

  /** session 视图共用的列清单（listSessions 与 sessionView 必须取一样的字段） */
  private static readonly VIEW_COLUMNS = `agent, agent_session_id as session_id, project_id, title, is_active,
                token_used, context_pct, correction_count, last_event_at, finished_at,
                needs_input_since, parent_id, outcome, goal, budget_tokens`;

  /** 全部 session 视图（按最后活动倒序） */
  listSessions(limit = 50): SessionView[] {
    const rows = this.db
      .prepare(
        `SELECT ${SessionRegistry.VIEW_COLUMNS}
         FROM sessions ORDER BY last_event_at DESC LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => this.toView(r));
  }

  /** 单个 session 视图（设置窗口写完 goal/budget 后要把生效结果回给界面） */
  sessionView(agent: string, sessionId: string): SessionView | null {
    const row = this.db
      .prepare(
        `SELECT ${SessionRegistry.VIEW_COLUMNS}
         FROM sessions WHERE agent=? AND agent_session_id=?`,
      )
      .get(agent, sessionId) as Record<string, unknown> | undefined;
    return row ? this.toView(row) : null;
  }

  /**
   * 写入 session 的 goal / budget_tokens（G17 的录入口）。
   *
   * 为什么这件事必须由界面提供：session 是在终端里诞生的，而 `goal` 是
   * topic_multiplier 和漂移判定的基准、`budget_tokens` 是里程碑的分母 ——
   * 没有录入时机的话，这两条规则对绝大多数用户永远空转。
   * 返回更新后的视图；session 不存在返回 null（调用方回 404，而不是静默成功）。
   */
  updateSession(
    agent: string,
    sessionId: string,
    patch: { goal?: string | null; budget_tokens?: number | null },
  ): SessionView | null {
    if (!this.db.prepare("SELECT 1 FROM sessions WHERE agent=? AND agent_session_id=?").get(agent, sessionId)) {
      return null;
    }
    const sets: string[] = [];
    const params: Array<string | number | null> = [];
    if (patch.goal !== undefined) {
      sets.push("goal=?");
      params.push(patch.goal);
    }
    if (patch.budget_tokens !== undefined) {
      sets.push("budget_tokens=?");
      params.push(patch.budget_tokens);
    }
    if (sets.length > 0) {
      // 故意不动 last_event_at：改设置不是 session 的「活动」，
      // 否则一次改名就能把一个 15 分钟没动静的 session 从 idle 拉回 working。
      this.db
        .prepare(`UPDATE sessions SET ${sets.join(", ")} WHERE agent=? AND agent_session_id=?`)
        .run(...params, agent, sessionId);
    }
    return this.sessionView(agent, sessionId);
  }

  private toView(r: Record<string, unknown>): SessionView {
    return {
      agent: r.agent as SessionView["agent"],
      session_id: r.session_id as string,
      project_id: r.project_id as string,
      title: (r.title as string) ?? projectShortName(r.project_id as string),
      state: this.sessionState(r),
      token_used: (r.token_used as number) ?? 0,
      context_pct: (r.context_pct as number) ?? 0,
      correction_count: (r.correction_count as number) ?? 0,
      last_event_at: r.last_event_at as string,
      finished_at: (r.finished_at as string | null) ?? null,
      needs_input_since: (r.needs_input_since as string | null) ?? null,
      goal: (r.goal as string | null) ?? null,
      budget_tokens: (r.budget_tokens as number | null) ?? null,
      is_active: (r.is_active as number) === 1,
      parent_id: r.parent_id as number | null,
      outcome: r.outcome as string | undefined,
    };
  }

  /** 推断单个 session 状态（Core 判定；tired/level-up 由宠物引擎叠加） */
  private sessionState(r: Record<string, unknown>): SessionState {
    // 被回收的僵尸不是「收工」（G10）。finished 在这个产品里是有奖励含义的状态 ——
    // 打勾、庆祝动画、outcome bonus 都挂在它上面。一个崩掉的会话显示成 finished
    // 等于告诉用户「这次干得不错」。它就是安静地停了：idle。
    if ((r.is_active as number) !== 1) {
      return isReclaimed(r.outcome as string | null) ? "idle" : "finished";
    }
    const agent = r.agent as string;
    const sessionId = r.session_id as string;
    // 需要你：session 上挂着未清除的「等你」标记（由 decision/permission 事件置位，
    // 任何后续进展事件清除）。上限 NEEDS_INPUT_MAX_MS 只是安全阀 ——
    // 万一清除事件永远没来，宠物也不该无限告警下去。
    const waitingSince = r.needs_input_since as string | null;
    if (waitingSince) {
      const since = new Date(waitingSince).getTime();
      // 解析不出来就当「不在等」：安全阀的意义是「不要无限告警」，
      // 反过来写会让一个坏时间戳把宠物永久钉在 needs-you 上。
      if (Number.isFinite(since) && Date.now() - since < NEEDS_INPUT_MAX_MS) return "needs-you";
    }
    // warning：最近 120s 有 context/error/drift 通知
    // datetime() 两侧都要包：shown_at 落库是 ISO-8601（'2026-08-20T05:28:57.268Z'），
    // 而 datetime('now') 是 '2026-08-20 05:28:57' —— 直接字符串比较时 'T'(0x54) > ' '(0x20)，
    // 于是**今天的任何一条**通知都满足「最近 120 秒」，宠物会橙一整天。
    const warn = this.db
      .prepare(
        `SELECT 1 FROM notifications WHERE agent=? AND session_id=? AND status='shown'
         AND type IN ('context','error','drift')
         AND datetime(shown_at) > datetime('now','-120 seconds') LIMIT 1`,
      )
      .get(agent, sessionId);
    if (warn) return "warning";
    const last = new Date((r.last_event_at as string) ?? 0).getTime();
    const idleMs = Date.now() - last;
    return idleMs > 15 * 60_000 ? "idle" : "working";
  }

  /**
   * 聚合宠物状态：needs-you > warning > working > finished > idle。
   * `sessions` 可传入已算好的列表 —— 每次事件都重新查一遍会让 listSessions
   * 的 per-session 子查询翻倍（一次事件几百条 SQL）。
   */
  aggregatePetState(overrides?: PetState, sessions?: SessionView[]): PetState {
    if (overrides && overrides !== "idle") return overrides;
    const list = sessions ?? this.listSessions(100);
    let hasNeeds = false, hasWarning = false, hasWorking = false;
    for (const s of list) {
      if (!s.is_active) continue;
      if (s.state === "needs-you") hasNeeds = true;
      else if (s.state === "warning") hasWarning = true;
      else if (s.state === "working") hasWorking = true;
    }
    if (hasNeeds) return "needs-you";
    if (hasWarning) return "warning";
    if (hasWorking) return "working";
    // 刚收工：短暂庆祝一下再回 idle（README 6.1 的 finished 态）。
    // 被回收的僵尸有 finished_at（那是回收时刻），但它不是收工 —— 不庆祝崩溃（G10）。
    if (list.some((s) => !s.is_active && recentlyFinished(s.finished_at) && !isReclaimed(s.outcome))) {
      return "finished";
    }
    return "idle";
  }

  /** 需要你的 session（needs-you 优先，其次 warning） */
  needsAttention(): SessionView[] {
    return this.listSessions(100).filter((s) => s.is_active && (s.state === "needs-you" || s.state === "warning"));
  }

  /** 最后活跃 session（每 agent 记录） */
  lastActivePerAgent(): Record<string, SessionView | undefined> {
    const out: Record<string, SessionView | undefined> = {};
    for (const s of this.listSessions(100)) {
      if (!out[s.agent]) out[s.agent] = s;
    }
    return out;
  }
}

/** project_id 归一化：取目录短名做默认标题 */
export function projectShortName(projectId: string): string {
  const clean = projectId.replace(/[\\/]+$/, "");
  const parts = clean.split(/[\\/]/);
  return parts[parts.length - 1] || projectId;
}
