/**
 * Session Registry — 跨 session 管理核心（架构 §2.3）。
 * 数据源：事件流。生命周期由 session_started 的 source 推断。
 * 宠物聚合状态：needs-you > warning > working > idle（finished/tired/level-up 由宠物引擎设置）。
 */
import type Database from "better-sqlite3";
import type { CoreEvent, PetState, SessionView, SessionState } from "./events.ts";

export type RegistryHandler = (ev: CoreEvent) => void;

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

  /** 核心入口：事件 → 状态机 → sessions 表 + 内存回调 */
  handle(ev: CoreEvent): void {
    const db = this.db;
    switch (ev.event_type) {
      case "session_started": {
        const source = ev.payload.source ?? "startup";
        const existing = this.findSession(ev);
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
              `UPDATE sessions SET is_active=1, context_pct=0, token_used=0, last_event_at=? WHERE agent=? AND agent_session_id=?`,
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
        db.prepare(
          `UPDATE sessions SET last_event_at=? WHERE agent=? AND agent_session_id=?`,
        ).run(ev.timestamp, ev.agent, ev.session_id);
        break;
      }

      case "decision_required":
      case "permission_required":
      case "session_error":
      case "topic_drift_warning": {
        this.ensureSession(ev);
        db.prepare(
          `UPDATE sessions SET last_event_at=? WHERE agent=? AND agent_session_id=?`,
        ).run(ev.timestamp, ev.agent, ev.session_id);
        break;
      }

      case "token_update": {
        this.ensureSession(ev);
        const tokens = typeof ev.payload.tokens === "number" ? ev.payload.tokens : 0;
        db.prepare(
          `UPDATE sessions SET token_used=MAX(token_used, ?), last_event_at=? WHERE agent=? AND agent_session_id=?`,
        ).run(tokens, ev.timestamp, ev.agent, ev.session_id);
        break;
      }

      case "context_update": {
        this.ensureSession(ev);
        const pct = typeof ev.payload.context_pct === "number" ? ev.payload.context_pct : 0;
        db.prepare(
          `UPDATE sessions SET context_pct=?, last_event_at=? WHERE agent=? AND agent_session_id=?`,
        ).run(pct, ev.timestamp, ev.agent, ev.session_id);
        break;
      }

      case "subagent_started": {
        this.ensureSession(ev);
        db.prepare(
          `UPDATE sessions SET last_event_at=? WHERE agent=? AND agent_session_id=?`,
        ).run(ev.timestamp, ev.agent, ev.session_id);
        break;
      }

      case "session_finished": {
        this.ensureSession(ev);
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
    this.onUpdate?.();
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

  /** 全部 session 视图（按最后活动倒序） */
  listSessions(limit = 50): SessionView[] {
    const rows = this.db
      .prepare(
        `SELECT agent, agent_session_id as session_id, project_id, title, is_active,
                token_used, context_pct, correction_count, last_event_at, parent_id, outcome
         FROM sessions ORDER BY last_event_at DESC LIMIT ?`,
      )
      .all(limit) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      agent: r.agent as SessionView["agent"],
      session_id: r.session_id as string,
      project_id: r.project_id as string,
      title: (r.title as string) ?? projectShortName(r.project_id as string),
      state: this.sessionState(r),
      token_used: (r.token_used as number) ?? 0,
      context_pct: (r.context_pct as number) ?? 0,
      correction_count: (r.correction_count as number) ?? 0,
      last_event_at: r.last_event_at as string,
      is_active: (r.is_active as number) === 1,
      parent_id: r.parent_id as number | null,
      outcome: r.outcome as string | undefined,
    }));
  }

  /** 推断单个 session 状态（Core 判定；tired/level-up 由宠物引擎叠加） */
  private sessionState(r: Record<string, unknown>): SessionState {
    if ((r.is_active as number) !== 1) return "finished";
    const agent = r.agent as string;
    const sessionId = r.session_id as string;
    // 需要你：最近 60s 有未处理的 decision/permission 通知
    const needs = this.db
      .prepare(
        `SELECT 1 FROM notifications WHERE agent=? AND session_id=? AND status='shown'
         AND type IN ('decision','permission') AND shown_at > datetime('now','-60 seconds') LIMIT 1`,
      )
      .get(agent, sessionId);
    if (needs) return "needs-you";
    // warning：最近 120s 有 context/error/drift 通知
    const warn = this.db
      .prepare(
        `SELECT 1 FROM notifications WHERE agent=? AND session_id=? AND status='shown'
         AND type IN ('context','error','drift') AND shown_at > datetime('now','-120 seconds') LIMIT 1`,
      )
      .get(agent, sessionId);
    if (warn) return "warning";
    const last = new Date((r.last_event_at as string) ?? 0).getTime();
    const idleMs = Date.now() - last;
    return idleMs > 15 * 60_000 ? "idle" : "working";
  }

  /** 聚合宠物状态：needs-you > warning > working > idle */
  aggregatePetState(overrides?: PetState): PetState {
    if (overrides && overrides !== "idle") return overrides;
    const sessions = this.listSessions(100);
    let hasNeeds = false, hasWarning = false, hasWorking = false;
    for (const s of sessions) {
      if (!s.is_active) continue;
      if (s.state === "needs-you") hasNeeds = true;
      else if (s.state === "warning") hasWarning = true;
      else if (s.state === "working") hasWorking = true;
    }
    if (hasNeeds) return "needs-you";
    if (hasWarning) return "warning";
    if (hasWorking) return "working";
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
