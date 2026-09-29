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

const SEGMENT_COLUMNS = `id, agent, agent_session_id, segment, segment_started_at, context_peak, context_reported_at,
  repeat_edit_count, finished_at, outcome, is_active`;

type SegmentRowWithKey = SessionHealthRow & { id: number; agent: string; agent_session_id: string };

function waitsFor(db: Database.Database, agent: string, sessionId: string, segment: number): WaitRow[] {
  return db
    .prepare(
      `SELECT started_at, received_at, cleared_at, resolution, muted_ms, slept_ms
       FROM needs_input_waits WHERE agent=? AND session_id=? AND segment=? ORDER BY id`,
    )
    .all(agent, sessionId, segment) as WaitRow[];
}

function errorsFor(db: Database.Database, row: SegmentRowWithKey): number {
  if (!row.segment_started_at) return 0;
  const r = db
    .prepare(
      `SELECT COUNT(*) AS c FROM events
       WHERE agent=? AND session_id=? AND event_type='session_error'
         AND julianday(received_at) >= julianday(?) - 1.0/86400
         AND (? IS NULL OR julianday(received_at) <= julianday(?))`,
    )
    .get(row.agent, row.agent_session_id, row.segment_started_at, row.finished_at, row.finished_at) as { c: number };
  return r.c ?? 0;
}

function toInput(db: Database.Database, row: SegmentRowWithKey): SegmentInput {
  return segmentInputFromRows(row, waitsFor(db, row.agent, row.agent_session_id, row.segment), errorsFor(db, row));
}

/** 一个 session 当前这一段的打分输入；没有这个 session → null */
export function loadSegmentInput(db: Database.Database, agent: string, agentSessionId: string): SegmentInput | null {
  const row = db
    .prepare(`SELECT ${SEGMENT_COLUMNS} FROM sessions WHERE agent=? AND agent_session_id=?`)
    .get(agent, agentSessionId) as SegmentRowWithKey | undefined;
  return row ? toInput(db, row) : null;
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
  return rows.map((r) => toInput(db, r));
}

/**
 * 「今天」从本地午夜算起（ISO）。用本地时区而不是 UTC：「今天打得怎么样」是用户的一天；
 * 午夜之后、第一段收工之前是「不知道」，按 R31 读作健康。
 */
export function localDayStart(now: Date = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return d.toISOString();
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
