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
 * 一行 session 只记得**最近一段**的测量值；前面几段在 session_finished 那一刻由日志（core/journal.ts）
 * 取走。所以「活的」读 sessions（loadSegmentInput / inputsForRows），「历史」读日志行（loadHistorySegments）。
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

/** 一段历史：打分输入 + 它是谁的。project 已经是短名 —— 原始 project_id 根本没进日志行 */
export interface HistorySegment {
  agent: string;
  sessionId: string;
  segment: number;
  project: string;
  input: SegmentInput;
}

/**
 * 历史的**唯一来源**：`since`（ISO）之后收工的段。Den（U13）、周卡（U14）、/api/session_health、
 * 当天聚合（todayHealth）都从这里取，别处不许自己再查 sessions 拼历史。
 *
 * 来源是日志行（memories kind='session'，U12）：每一段在 session_finished 那一刻写一行，
 * 所以 clear 过、resume 过的 session，前面那几段也都还在 —— sessions 表一行只记得最近一段。
 * 行里存的是收工那一刻的打分**输入**（input_json），这里重新打分：口径与活的 session 永远是同一份
 * health.ts。被回收的段根本不会写进日志（R10），打分那一层照旧会再排除一遍。
 */
export function loadHistorySegments(db: Database.Database, since: string): HistorySegment[] {
  // `day >= ?` 只是给 idx_memories_day(kind, day) 一个下界，让每一帧状态推送的代价跟着「今天」走、
  // 而不是跟着整份日志长。day 是写入那一刻的本地日：往前多留一天，时区变过也不会把边界上的行裁掉；
  // 精确的边界仍是后面那条 occurred_at 比较
  const sinceMs = Date.parse(since);
  const dayFloor = Number.isFinite(sinceMs) ? localDayKey(new Date(sinceMs - 24 * 60 * 60_000)) : "";
  const rows = db
    .prepare(
      `SELECT agent, agent_session_id, segment, project, input_json FROM memories
       WHERE kind='session' AND day >= ? AND input_json IS NOT NULL AND julianday(occurred_at) >= julianday(?)
       ORDER BY occurred_at, id`,
    )
    .all(dayFloor, since) as Array<{ agent: string; agent_session_id: string; segment: number; project: string | null; input_json: string }>;
  const out: HistorySegment[] = [];
  for (const r of rows) {
    const input = parseSegmentInput(r.input_json);
    if (!input) continue; // 一行坏掉的 JSON 不该让整份历史 500
    out.push({ agent: r.agent, sessionId: r.agent_session_id, segment: r.segment, project: r.project ?? "", input });
  }
  return out;
}

/** input_json → SegmentInput；形状不对 → null */
function parseSegmentInput(raw: string): SegmentInput | null {
  try {
    const v = JSON.parse(raw) as SegmentInput;
    if (!v || typeof v !== "object" || !Array.isArray(v.waits)) return null;
    return v;
  } catch {
    return null;
  }
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
  // 读日志而不是 sessions：同一个 session 今天 clear 过三次，三段都算（sessions 只剩最后一段）
  const segs = loadHistorySegments(db, localDayStart(now)).map((h) => h.input);
  const mean = dayMean(segs);
  const counted = segs.filter((s) => !isReclaimed(s.outcome)).length;
  return { mean, health: petHealthFromMean(mean), segments: mean === null ? 0 : counted };
}
