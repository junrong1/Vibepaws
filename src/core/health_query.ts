/**
 * Session Health 的读库那一层：把 sessions / needs_input_waits / events 的行取出来，
 * 交给 health.ts 的纯函数。打分规则一条都不在这里 —— 这里只回答「哪些行属于这一段」。
 *
 * 口径：
 *   · 一段 = sessions 一行此刻的本段列（registry.startSegment 开新段时清零）
 *   · 等待 = needs_input_waits 里 (agent, session_id, segment) 三者一致的行
 *   · 报错 = events 里本段时间窗（segment_started_at → finished_at，没结算就到现在）内的
 *            session_error。events 只有 Core 的 received_at（SQLite 的 'YYYY-MM-DD HH:MM:SS'，
 *            秒级、UTC），与 ISO 时间戳都交给 julianday() 比较；起点放宽一秒吸收秒级截断
 *
 * 已知的缺口：一行 session 只记得**最近一段**的测量值。同一天里 clear 过的 session，
 * 前面几段在 session_finished 那一刻由日志（U12）取走；在那之前，当天聚合只看得到每行的最后一段。
 */
import type Database from "better-sqlite3";
import {
  dayMean,
  petHealthFromMean,
  segmentInputFromRows,
  type SegmentInput,
  type SessionHealthRow,
  type WaitRow,
} from "./health.ts";
import { isReclaimed } from "./events.ts";

/** 打分要读的 sessions 列（registry 的 VIEW_COLUMNS 也取齐了这些，才能把行直接交给 inputsForRows） */
export const SEGMENT_COLUMNS = `id, agent, agent_session_id, segment, segment_started_at, context_peak, context_reported_at,
  repeat_edit_count, finished_at, outcome, is_active`;

/** sessions 一行里打分要用的列 + 找等待 / 报错用的键 */
export type SegmentRowWithKey = SessionHealthRow & { id: number; agent: string; agent_session_id: string };

/**
 * 一次 IN (...) 里最多放多少个 id。SQLite 的变量上限（老版本 999）之下留足余量；
 * 状态推送最多 50 行，一次就够 —— 分块只是给「一周的历史」兜底。
 */
const IN_CHUNK = 500;

function chunks<T>(xs: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += IN_CHUNK) out.push(xs.slice(i, i + IN_CHUNK));
  return out;
}

/**
 * 一批行 → 一批 SegmentInput（顺序与 rows 一致）。
 *
 * **批量**：不管多少行，等待一条查询、报错一条查询（每 IN_CHUNK 行各一条）。stateSnapshot
 * 在每一帧 SSE / 每一次轮询上都会走到这里，按行各查一遍就是 50 × 2 条 SQL 一帧。
 * 口径与逐行时完全一样：等待按 (agent, session_id, segment) 三者对上；报错按本段时间窗
 * （segment_started_at 放宽一秒 → finished_at，没有 finished_at 就到现在）。
 */
export function inputsForRows(db: Database.Database, rows: readonly SegmentRowWithKey[]): SegmentInput[] {
  if (rows.length === 0) return [];
  const waits = new Map<number, WaitRow[]>();
  const errors = new Map<number, number>();
  for (const part of chunks(rows.map((r) => r.id))) {
    const marks = part.map(() => "?").join(",");
    const waitRows = db
      .prepare(
        `SELECT s.id AS sid, w.started_at, w.received_at, w.cleared_at, w.resolution, w.muted_ms, w.slept_ms
         FROM sessions s JOIN needs_input_waits w
           ON w.agent=s.agent AND w.session_id=s.agent_session_id AND w.segment=s.segment
         WHERE s.id IN (${marks}) ORDER BY w.id`,
      )
      .all(...part) as Array<WaitRow & { sid: number }>;
    for (const { sid, ...w } of waitRows) {
      const list = waits.get(sid);
      if (list) list.push(w);
      else waits.set(sid, [w]);
    }
    const errorRows = db
      .prepare(
        `SELECT s.id AS sid, COUNT(e.id) AS c
         FROM sessions s JOIN events e
           ON e.agent=s.agent AND e.session_id=s.agent_session_id AND e.event_type='session_error'
          AND julianday(e.received_at) >= julianday(s.segment_started_at) - 1.0/86400
          AND (s.finished_at IS NULL OR julianday(e.received_at) <= julianday(s.finished_at))
         WHERE s.id IN (${marks}) AND s.segment_started_at IS NOT NULL
         GROUP BY s.id`,
      )
      .all(...part) as Array<{ sid: number; c: number }>;
    for (const e of errorRows) errors.set(e.sid, e.c ?? 0);
  }
  return rows.map((r) => segmentInputFromRows(r, waits.get(r.id) ?? [], errors.get(r.id) ?? 0));
}

/** 一个 session 当前这一段的打分输入；没有这个 session → null */
export function loadSegmentInput(db: Database.Database, agent: string, agentSessionId: string): SegmentInput | null {
  const row = db
    .prepare(`SELECT ${SEGMENT_COLUMNS} FROM sessions WHERE agent=? AND agent_session_id=?`)
    .get(agent, agentSessionId) as SegmentRowWithKey | undefined;
  return row ? inputsForRows(db, [row])[0]! : null;
}

/**
 * 在 `since`（ISO）之后结算的段。被回收的也会返回（它们有 finished_at）—— 打分那一层负责
 * 把它们排除（R10），这里不替它做判断。
 */
export function loadSettledSegments(db: Database.Database, since: string): SegmentInput[] {
  const rows = db
    .prepare(
      `SELECT ${SEGMENT_COLUMNS} FROM sessions
       WHERE is_active=0 AND finished_at IS NOT NULL AND julianday(finished_at) >= julianday(?)
       ORDER BY finished_at`,
    )
    .all(since) as SegmentRowWithKey[];
  return inputsForRows(db, rows);
}

/** 一段历史：打分输入 + 它是谁的。project_id 是原始绝对路径，出这一层之前必须换成短名 */
export interface HistorySegment {
  agent: string;
  sessionId: string;
  segment: number;
  projectId: string;
  input: SegmentInput;
}

/**
 * 历史的**唯一来源**：`since`（ISO）之后结算的段。Den（U13）、周卡（U14）、/api/session_health
 * 都从这里取，别处不许自己再查 sessions 拼历史。
 *
 * 今天的来源是 sessions 表 —— 一行只记得最近一段，所以同一个 session clear 过、或者收工后又开了
 * 新的一段，前面那段就从历史里消失了（新段在跑的时候，这一行根本不是「已结算」）。
 * U12 把每段收工写进 memories 之后，把这个函数的函数体换成读日志行即可：签名不变，
 * 调用方一行不用改。被回收的段照样返回，排除它们是打分那一层的事（R10）。
 */
export function loadHistorySegments(db: Database.Database, since: string): HistorySegment[] {
  const rows = db
    .prepare(
      `SELECT ${SEGMENT_COLUMNS}, project_id FROM sessions
       WHERE is_active=0 AND finished_at IS NOT NULL AND julianday(finished_at) >= julianday(?)
       ORDER BY finished_at`,
    )
    .all(since) as Array<SegmentRowWithKey & { project_id: string }>;
  const inputs = inputsForRows(db, rows);
  return rows.map((r, i) => ({
    agent: r.agent,
    sessionId: r.agent_session_id,
    segment: r.segment,
    projectId: r.project_id,
    input: inputs[i]!,
  }));
}

/**
 * 「今天」从本地午夜算起（ISO）。用本地时区而不是 UTC：「今天打得怎么样」是用户的一天；
 * 午夜之后、第一段收工之前是「不知道」，按 R31 读作健康。`daysBack` 往前数日历日（历史用）。
 */
export function localDayStart(now: Date = new Date(), daysBack = 0): string {
  // 用年月日构造而不是减 24 小时：跨夏令时的那一天不是 24 小时
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack);
  return d.toISOString();
}

/** 本地日历日的键（YYYY-MM-DD）：23:50 收工的一段落在用户过的那一天，而不是 UTC 的那一天 */
export function localDayKey(at: Date): string {
  const y = at.getFullYear();
  const m = String(at.getMonth() + 1).padStart(2, "0");
  const d = String(at.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export interface DayHealth {
  /** 当天已结算段的时长加权三因子平均（0–100）；null = 今天还没有结算过的段 */
  mean: number | null;
  /** 映射后的宠物健康（0.5–1.0）；null = 不知道 */
  health: number | null;
  /** 参与聚合的段数（已结算、没被回收） */
  segments: number;
}

/** 今天的聚合：宠物健康（exp.ts healthScore）与状态推送（U4）共用这一份 */
export function todayHealth(db: Database.Database, now: Date = new Date()): DayHealth {
  const segs = loadSettledSegments(db, localDayStart(now));
  const mean = dayMean(segs);
  const counted = segs.filter((s) => !isReclaimed(s.outcome)).length;
  return { mean, health: petHealthFromMean(mean), segments: mean === null ? 0 : counted };
}
