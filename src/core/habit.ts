/**
 * HabitEngine — 用户级工作习惯画像（docs/handoff-habit-layer.md）。
 *
 * 这不是 EXP 引擎，是**聚合**引擎：把事件流折叠进按天汇总（behavior_daily），
 * 再用指数衰减聚合出一个单行画像（habit_profile），驱动进化条件、宠物行为与气泡语气。
 *
 * 隐私（§7）：behavior_daily / habit_profile 只存计数、求和与少量分类标签 ——
 * 绝不存 prompt、代码、文件路径、命令文本或项目名。工具名 `tool_name` 只用于
 * 统计「Edit/Bash/Read 多不多」这类粗粒度亲和度，不推断 commit / test / 交付
 * （payload 白名单里本就没有命令文本，sessions.outcome 是唯一的「shipper」代理）。
 *
 * 衰减：指数衰减，半衰期 14 天（weight = 0.5^(ageDays/14)）。
 * 分类维度（chronotype/cadence/outcome_bias）用窗口内的**原始计数**，连续分
 * （depth/precision/context_hygiene/responsiveness）用**衰减后**的加权和。
 */
import type Database from "better-sqlite3";
import type { CoreEvent, EventPayload } from "./events.ts";
import { getHabitEnabled } from "./settings.ts";

export type Chronotype = "early_bird" | "day" | "night_owl";
export type Cadence = "burst" | "steady" | "sparse";
export type OutcomeBias = "shipper" | "explorer";

/** 用户级习惯画像。ready=false 表示数据不足，UI 应保持中立。 */
export interface HabitProfile {
  chronotype: Chronotype | null;
  cadence: Cadence | null;
  depth: number;
  precision: number;
  context_hygiene: number;
  responsiveness: number;
  outcome_bias: OutcomeBias | null;
  tool_affinity: string[];
  sample_days: number;
  sample_sessions: number;
  updated_at: string;
  /** cold-start：false 表示「数据不够 —— UI 保持中立」 */
  ready: boolean;
}

const WINDOW_DAYS = 14;
const HALF_LIFE_DAYS = 14;
/** ready 门槛：不足 5 个 session 且 2 个活跃日之前，绝不给人画像 */
const READY_SESSIONS = 5;
const READY_DAYS = 2;

/* ================= 纯函数（可单测） ================= */

export function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** 指数衰减权重：ageDays 天前的数据权重为 0.5^(ageDays/halfLifeDays)。 */
export function decayWeight(ageDays: number, halfLifeDays = HALF_LIFE_DAYS): number {
  if (!Number.isFinite(ageDays) || ageDays < 0) ageDays = 0;
  return Math.pow(0.5, ageDays / halfLifeDays);
}

/**
 * 作息类型。hours 是 24 个 UTC 小时的加权活动计数。
 * 阈值（§3）：night_owl = 活动 ≥40% 落在 [22,06)；early_bird = ≥40% 落在 [05,10)；否则 day。
 * 注意这两个窗口在 hour=5 上有 1 小时重叠 —— 照规范原文实现，重叠不影响启发式稳定性。
 */
export function classifyChronotype(hours: number[]): Chronotype | null {
  const total = hours.reduce((a, b) => a + (b || 0), 0);
  if (total <= 0) return null;
  let night = 0;
  let early = 0;
  for (let h = 0; h < 24; h++) {
    const c = hours[h] ?? 0;
    if (h >= 22 || h < 6) night += c;
    if (h >= 5 && h < 10) early += c;
  }
  if (night / total >= 0.4) return "night_owl";
  if (early / total >= 0.4) return "early_bird";
  return "day";
}

/**
 * 工作节奏。sessions 是窗口内 session 数，activeDays 是活跃日数，activeMin 是总时长（分钟）。
 * burst：≥4 session/活跃日 且 平均 <20 分钟；sparse：<0.5 session/活跃日；否则 steady。
 */
export function classifyCadence(sessions: number, activeDays: number, activeMin: number): Cadence | null {
  if (sessions <= 0 || activeDays <= 0) return null;
  const perDay = sessions / activeDays;
  const meanMin = activeMin / sessions;
  if (perDay >= 4 && meanMin < 20) return "burst";
  if (perDay < 0.5) return "sparse";
  return "steady";
}

/** 平均时长 → 0..1：45 分钟封顶（§3 length_factor）。 */
export function computeLengthFactor(meanMin: number): number {
  return clamp01(meanMin / 45);
}

/** 精确度：correction 越少越高。clamp(1 − total_corrections / max(1,sessions) / 5)。 */
export function computePrecision(totalCorrections: number, sessions: number): number {
  return clamp01(1 - totalCorrections / Math.max(1, sessions) / 5);
}

/** context 卫生：>85% 穿越次数越少越高。clamp(1 − crossings / max(1,sessions))。 */
export function computeContextHygiene(context85Crossings: number, sessions: number): number {
  return clamp01(1 - context85Crossings / Math.max(1, sessions));
}

/** 响应度：平均等待越短越高，30 分钟封底为 0。waitCount=0 时视为全响应。 */
export function computeResponsiveness(waitMs: number, waitCount: number): number {
  if (waitCount <= 0) return 1;
  const meanWait = waitMs / waitCount;
  return clamp01(1 - meanWait / 1_800_000);
}

/** 深度：0.5·length_factor + 0.3·context_hygiene + 0.2·precision（§3）。 */
export function computeDepth(meanMin: number, contextHygiene: number, precision: number): number {
  return clamp01(0.5 * computeLengthFactor(meanMin) + 0.3 * contextHygiene + 0.2 * precision);
}

/**
 * 结果倾向。仅统计 success/partial/abandoned（orphaned/timeout 不会进 behavior_daily）。
 * shipper：success 占比 ≥0.6 且总数 ≥3；explorer：(partial+abandoned) 占比 ≥0.5；否则 null。
 */
export function classifyOutcomeBias(success: number, partial: number, abandoned: number): OutcomeBias | null {
  const total = success + partial + abandoned;
  if (total < 3) return null;
  if (success / total >= 0.6) return "shipper";
  if ((partial + abandoned) / total >= 0.5) return "explorer";
  return null;
}

/** 工具亲和度：按频率取前 N 个（同频按名称升序，保证确定性）。 */
export function topToolAffinity(counts: Record<string, number>, top = 5): string[] {
  return Object.entries(counts)
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .slice(0, top)
    .map(([name]) => name);
}

/* ================= 内部工具 ================= */

function dayOf(iso: string): string {
  const d = iso ? iso.slice(0, 10) : "";
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : new Date().toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  const da = Date.parse(`${a}T00:00:00Z`);
  const db = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(da) || !Number.isFinite(db)) return 0;
  return (db - da) / 86_400_000;
}

function waitKey(agent: string, sessionId: string): string {
  return `${agent}:${sessionId}`;
}

interface DailyRow {
  day: string;
  agent: string;
  sessions: number;
  active_min: number;
  tokens: number;
  corrections: number;
  errors: number;
  context_85: number;
  wait_ms: number;
  wait_count: number;
  edits: number;
  shells: number;
  reads: number;
  success: number;
  partial: number;
  abandoned: number;
}

interface ProfileRow {
  chronotype: string | null;
  cadence: string | null;
  depth: number;
  precision: number;
  context_hygiene: number;
  responsiveness: number;
  outcome_bias: string | null;
  tool_affinity: string;
  sample_days: number;
  sample_sessions: number;
  updated_at: string;
}

function neutralProfile(): HabitProfile {
  return {
    chronotype: null,
    cadence: null,
    depth: 0.5,
    precision: 0.5,
    context_hygiene: 0.5,
    responsiveness: 0.5,
    outcome_bias: null,
    tool_affinity: [],
    sample_days: 0,
    sample_sessions: 0,
    updated_at: "",
    ready: false,
  };
}

export interface HabitEngineOptions {
  windowDays?: number;
  halfLifeDays?: number;
}

/* ================= HabitEngine ================= */

export class HabitEngine {
  private db: Database.Database;
  private windowDays: number;
  private halfLifeDays: number;
  /** 阻塞等待的起始时刻，键 `${agent}:${session_id}`（镜像 registry.ts 的 needs_input_since） */
  private pendingWait = new Map<string, number>();
  private backfilling = false;

  constructor(db: Database.Database, opts: HabitEngineOptions = {}) {
    this.db = db;
    this.windowDays = opts.windowDays ?? WINDOW_DAYS;
    this.halfLifeDays = opts.halfLifeDays ?? HALF_LIFE_DAYS;
    if (this.enabled()) {
      this.backfill();
      if (!this.profileExists()) this.recompute();
    }
  }

  private enabled(): boolean {
    return getHabitEnabled(this.db);
  }

  private profileExists(): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM habit_profile WHERE id=1").get());
  }

  private dailyCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM behavior_daily").get() as { c: number }).c ?? 0;
  }

  private sessionCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM sessions").get() as { c: number }).c ?? 0;
  }

  /** 事件入口：折叠进今天的 behavior_daily，session_finished 触发重算。 */
  handle(ev: CoreEvent): void {
    if (!this.enabled()) return;
    this.fold(ev);
    if (ev.event_type === "session_finished") this.recompute();
  }

  /** 把一条事件折叠进按天汇总（不触发重算；backfill 直接复用它）。 */
  private fold(ev: CoreEvent): void {
    const day = dayOf(ev.timestamp);
    switch (ev.event_type) {
      case "session_started":
        this.resolveWait(ev);
        break;
      case "agent_working": {
        this.bucketTool(day, ev.agent, ev.payload.tool_name);
        this.resolveWait(ev);
        break;
      }
      case "context_update": {
        const pct = ev.payload.context_pct;
        if (typeof pct === "number" && pct > 85) this.bump(day, ev.agent, "context_85", 1);
        this.resolveWait(ev);
        break;
      }
      case "session_error":
      case "topic_drift_warning":
        this.bump(day, ev.agent, "errors", 1);
        break;
      case "session_finished":
        this.resolveWait(ev);
        this.finishSession(day, ev);
        break;
      case "decision_required":
      case "permission_required": {
        const blocking = ev.event_type === "permission_required" || ev.payload.kind === "question";
        if (blocking) {
          const key = waitKey(ev.agent, ev.session_id);
          if (!this.backfilling && !this.pendingWait.has(key)) this.pendingWait.set(key, Date.now());
        }
        break;
      }
      case "token_update":
      case "subagent_started":
      case "subagent_stopped":
        this.resolveWait(ev);
        break;
      default:
        break;
    }
  }

  /** 任何「进展」事件都说明用户已经回应 / agent 继续 → 结算一次等待时长。 */
  private resolveWait(ev: CoreEvent): void {
    if (this.backfilling) return; // backfill 无法可靠重建历史等待时长，跳过（响应度保持中性）
    const key = waitKey(ev.agent, ev.session_id);
    const start = this.pendingWait.get(key);
    if (start === undefined) return;
    this.pendingWait.delete(key);
    const delta = Math.max(0, Date.now() - start);
    const day = dayOf(ev.timestamp);
    this.ensureDaily(day, ev.agent);
    this.db
      .prepare("UPDATE behavior_daily SET wait_ms = wait_ms + ?, wait_count = wait_count + 1 WHERE day=? AND agent=?")
      .run(delta, day, ev.agent);
  }

  private bucketTool(day: string, agent: string, toolName: string | undefined): void {
    if (!toolName) return;
    // 适配器上报的工具名大小写不一致（pi 报 bash/edit/read，claude 报 Bash/Edit）——
    // 统一小写再分桶，否则 edits/shells/reads 会漏掉一半真实数据。
    const t = String(toolName).toLowerCase();
    if (t === "edit") this.bump(day, agent, "edits", 1);
    else if (t === "bash") this.bump(day, agent, "shells", 1);
    else if (t === "read" || t === "glob" || t === "grep") this.bump(day, agent, "reads", 1);
  }

  private finishSession(day: string, ev: CoreEvent): void {
    this.ensureDaily(day, ev.agent);
    const row = this.db
      .prepare(
        "SELECT started_at, finished_at, token_used, correction_count FROM sessions WHERE agent=? AND agent_session_id=?",
      )
      .get(ev.agent, ev.session_id) as
      | { started_at: string | null; finished_at: string | null; token_used: number; correction_count: number }
      | undefined;

    let activeMin = 0;
    let tokens = 0;
    let corrections = 0;
    if (row) {
      const start = Date.parse(row.started_at ?? "");
      const end = Date.parse(row.finished_at ?? ev.timestamp);
      if (Number.isFinite(start) && Number.isFinite(end)) activeMin = Math.max(0, (end - start) / 60_000);
      tokens = Math.max(0, Number(row.token_used) || 0);
      corrections = Math.max(0, Number(row.correction_count) || 0);
    }

    const outcome = ev.payload.outcome ?? "success";
    const col = outcome === "partial" ? "partial" : outcome === "abandoned" ? "abandoned" : "success";
    this.db
      .prepare(
        `UPDATE behavior_daily SET sessions=sessions+1, active_min=active_min+?, tokens=tokens+?,
         corrections=corrections+?, ${col}=${col}+1 WHERE day=? AND agent=?`,
      )
      .run(activeMin, tokens, corrections, day, ev.agent);
  }

  private ensureDaily(day: string, agent: string): void {
    this.db.prepare("INSERT OR IGNORE INTO behavior_daily(day, agent) VALUES(?, ?)").run(day, agent);
  }

  private bump(day: string, agent: string, column: string, amount: number): void {
    this.ensureDaily(day, agent);
    // column 来自固定白名单（本文件内部），不做外部拼接
    this.db.prepare(`UPDATE behavior_daily SET ${column} = ${column} + ? WHERE day=? AND agent=?`).run(amount, day, agent);
  }

  /** 聚合 behavior_daily（衰减）→ 写 habit_profile 单行。幂等。 */
  recompute(): void {
    if (!this.enabled()) return;
    const today = dayOf(new Date().toISOString());
    const cutoff = this.cutoffDay(today);
    const rows = this.db.prepare("SELECT * FROM behavior_daily WHERE day >= ?").all(cutoff) as DailyRow[];

    let wSessions = 0;
    let wActiveMin = 0;
    let wCorrections = 0;
    let wContext85 = 0;
    let wWaitMs = 0;
    let wWaitCount = 0;

    let rawSessions = 0;
    let rawActiveMin = 0;
    let rawSuccess = 0;
    let rawPartial = 0;
    let rawAbandoned = 0;
    const activeDays = new Set<string>();

    for (const r of rows) {
      const age = daysBetween(r.day, today);
      const w = decayWeight(age, this.halfLifeDays);
      wSessions += r.sessions * w;
      wActiveMin += r.active_min * w;
      wCorrections += r.corrections * w;
      wContext85 += r.context_85 * w;
      wWaitMs += r.wait_ms * w;
      wWaitCount += r.wait_count * w;

      rawSessions += r.sessions;
      rawActiveMin += r.active_min;
      rawSuccess += r.success;
      rawPartial += r.partial;
      rawAbandoned += r.abandoned;
      if (r.sessions > 0) activeDays.add(r.day);
    }

    const sampleDays = activeDays.size;
    const chronotype = this.computeChronotype(cutoff);
    const cadence = classifyCadence(rawSessions, sampleDays, rawActiveMin);
    const precision = computePrecision(wCorrections, wSessions);
    const contextHygiene = computeContextHygiene(wContext85, wSessions);
    const responsiveness = computeResponsiveness(wWaitMs, wWaitCount);
    const meanMin = wSessions > 0 ? wActiveMin / wSessions : 0;
    const depth = computeDepth(meanMin, contextHygiene, precision);
    const outcomeBias = classifyOutcomeBias(rawSuccess, rawPartial, rawAbandoned);
    const toolAffinity = this.computeToolAffinity(cutoff);

    this.db
      .prepare(
        `INSERT INTO habit_profile(id, chronotype, cadence, depth, precision, context_hygiene,
           responsiveness, outcome_bias, tool_affinity, sample_days, sample_sessions, updated_at)
         VALUES(1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           chronotype=excluded.chronotype, cadence=excluded.cadence, depth=excluded.depth,
           precision=excluded.precision, context_hygiene=excluded.context_hygiene,
           responsiveness=excluded.responsiveness, outcome_bias=excluded.outcome_bias,
           tool_affinity=excluded.tool_affinity, sample_days=excluded.sample_days,
           sample_sessions=excluded.sample_sessions, updated_at=excluded.updated_at`,
      )
      .run(
        chronotype,
        cadence,
        round4(depth),
        round4(precision),
        round4(contextHygiene),
        round4(responsiveness),
        outcomeBias,
        JSON.stringify(toolAffinity),
        sampleDays,
        rawSessions,
        new Date().toISOString(),
      );
  }

  private cutoffDay(today: string): string {
    const d = new Date(Date.parse(`${today}T00:00:00Z`) - (this.windowDays - 1) * 86_400_000);
    return d.toISOString().slice(0, 10);
  }

  /** chronotype 需要小时粒度，而 behavior_daily 只有天粒度 —— 直接读 events（不新增逐事件行）。 */
  private computeChronotype(cutoff: string): Chronotype | null {
    const rows = this.db
      .prepare(
        `SELECT strftime('%H', received_at) AS hour, julianday('now') - julianday(received_at) AS age
         FROM events WHERE event_type IN ('agent_working','session_started') AND received_at >= ?`,
      )
      .all(cutoff) as Array<{ hour: string; age: number }>;
    const hours = new Array<number>(24).fill(0);
    for (const r of rows) {
      const h = Number(r.hour);
      if (!Number.isInteger(h) || h < 0 || h > 23) continue;
      const age = Number(r.age);
      const w = Number.isFinite(age) ? decayWeight(age, this.halfLifeDays) : 1;
      hours[h] = (hours[h] ?? 0) + w;
    }
    return classifyChronotype(hours);
  }

  /** tool_affinity 需要完整 tool_name 计数，而 behavior_daily 只留了 3 个桶 —— 直接读 events。 */
  private computeToolAffinity(cutoff: string): string[] {
    const rows = this.db
      .prepare("SELECT payload_json FROM events WHERE event_type='agent_working' AND received_at >= ?")
      .all(cutoff) as Array<{ payload_json: string }>;
    const counts: Record<string, number> = {};
    for (const r of rows) {
      let tool: unknown;
      try {
        tool = (JSON.parse(r.payload_json) as { tool_name?: unknown }).tool_name;
      } catch {
        continue;
      }
      if (typeof tool !== "string" || !tool) continue;
      counts[tool] = (counts[tool] ?? 0) + 1;
    }
    return topToolAffinity(counts, 5);
  }

  /** 一次性回填：behavior_daily 为空但 sessions 非空时，重放既有 events。幂等。 */
  backfill(): void {
    if (this.dailyCount() > 0) return;
    if (this.sessionCount() === 0) return;
    const rows = this.db.prepare("SELECT * FROM events ORDER BY id").all() as Array<Record<string, unknown>>;
    this.backfilling = true;
    try {
      for (const r of rows) this.fold(rowToEvent(r));
    } finally {
      this.backfilling = false;
    }
    this.recompute();
  }

  /** 数据被重置后清理内存启发式（pendingWait），避免旧 session 的等待标记泄漏。 */
  forgetAll(): void {
    this.pendingWait.clear();
  }

  getProfile(): HabitProfile {
    if (!this.enabled()) return neutralProfile();
    const row = this.db.prepare("SELECT * FROM habit_profile WHERE id=1").get() as ProfileRow | undefined;
    if (!row) return neutralProfile();
    const ready = row.sample_sessions >= READY_SESSIONS && row.sample_days >= READY_DAYS;
    let toolAffinity: string[] = [];
    try {
      const v = JSON.parse(row.tool_affinity ?? "[]") as unknown;
      if (Array.isArray(v)) toolAffinity = v.filter((x): x is string => typeof x === "string");
    } catch {
      toolAffinity = [];
    }
    return {
      chronotype: ready ? (row.chronotype as Chronotype | null) ?? null : null,
      cadence: ready ? (row.cadence as Cadence | null) ?? null : null,
      depth: ready ? row.depth : 0.5,
      precision: ready ? row.precision : 0.5,
      context_hygiene: ready ? row.context_hygiene : 0.5,
      responsiveness: ready ? row.responsiveness : 0.5,
      outcome_bias: ready ? (row.outcome_bias as OutcomeBias | null) ?? null : null,
      tool_affinity: ready ? toolAffinity : [],
      sample_days: row.sample_days,
      sample_sessions: row.sample_sessions,
      updated_at: row.updated_at,
      ready,
    };
  }
}

function rowToEvent(r: Record<string, unknown>): CoreEvent {
  let payload: EventPayload = {};
  try {
    payload = (JSON.parse(String(r.payload_json ?? "{}")) as EventPayload) ?? {};
  } catch {
    payload = {};
  }
  return {
    event_id: String(r.event_id ?? ""),
    seq: Number(r.seq) || 0,
    agent: String(r.agent ?? "generic") as CoreEvent["agent"],
    session_id: String(r.session_id ?? ""),
    project_id: "", // events 表不落 project_id；fold 不用它
    event_type: String(r.event_type ?? "") as CoreEvent["event_type"],
    severity: (String(r.severity ?? "low") as CoreEvent["severity"]),
    safe_summary: String(r.safe_summary ?? ""),
    timestamp: String(r.received_at ?? new Date().toISOString()),
    payload,
  };
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
