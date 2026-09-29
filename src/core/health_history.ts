/**
 * Session Health 的历史（GET /api/session_health）—— Den 的 Today / Growth（U13）与周卡（U14）读它。
 *
 * 这一层只做两件事：把 health_query.loadHistorySegments 取出来的段打分、换成线上的样子；
 * 按**本地**日历日分桶聚合。打分规则在 health.ts，取哪些行在 health_query.ts。
 *
 * 线上永远不出现原始 project_id（绝对路径）：一律 projectShortName()。周卡是要被截图发出去的，
 * 路径里的用户名、公司目录名不该跟着出去（R26）。
 *
 * 单独成一个文件而不是放进 health_query.ts：短名来自 registry.ts，而 registry 为了给 SessionView
 * 打分已经 import 了 health_query —— 反过来再 import 就成环了。
 */
import type Database from "better-sqlite3";
import {
  aggregateSegments,
  petHealthFromMean,
  petScore,
  scoreSegment,
  segmentDurationMs,
  type SegmentInput,
} from "./health.ts";
import { loadHistorySegments, localDayKey, localDayStart, type DayHealth } from "./health_query.ts";
import { projectShortName } from "./registry.ts";
import type {
  DayHealthView,
  SessionHealthDay,
  SessionHealthHistory,
  SessionHealthHistoryItem,
} from "./events.ts";

/** 不传 `days` 时给一周：周卡与 Growth 默认都看七天 */
export const HISTORY_DEFAULT_DAYS = 7;
/** 上限：一个季度。再长的曲线在 Den 里画不下，也没理由让一次请求扫全表 */
export const HISTORY_MAX_DAYS = 90;

/**
 * `?days=` → 天数。没传 → 默认；超过上限夹到上限；
 * 不是正整数 → null（调用方回 400，而不是悄悄换成默认值让界面以为自己拿到了想要的范围）。
 */
export function parseHistoryDays(raw: string | null): number | null {
  if (raw === null || raw === "") return HISTORY_DEFAULT_DAYS;
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1) return null;
  return Math.min(n, HISTORY_MAX_DAYS);
}

/** health_query.todayHealth 的结果 → PetStatePush.health_today */
export function dayHealthView(day: DayHealth): DayHealthView {
  return { mean: day.mean, health: day.health, unknown: day.mean === null, segments: day.segments };
}

/**
 * 最近 `days` 个本地日（含今天）的历史：每一段 + 每一天。
 * 只有已结算、没被回收的段（R9 / R10）；没有段的日子也列出来（unknown），
 * 这样周卡与 Growth 的横轴永远是完整的 `days` 格，不必自己补洞。
 */
export function sessionHealthHistory(
  db: Database.Database,
  opts: { days?: number; now?: Date } = {},
): SessionHealthHistory {
  const now = opts.now ?? new Date();
  const days = Math.min(Math.max(1, Math.floor(opts.days ?? HISTORY_DEFAULT_DAYS)), HISTORY_MAX_DAYS);
  const since = localDayStart(now, days - 1);

  const segments: SessionHealthHistoryItem[] = [];
  const byDay = new Map<string, SegmentInput[]>();
  for (const h of loadHistorySegments(db, since)) {
    const result = scoreSegment(h.input);
    if (!result || result.unsettled || h.input.finishedAt === null) continue;
    const day = localDayKey(new Date(h.input.finishedAt));
    segments.push({
      agent: h.agent,
      session_id: h.sessionId,
      segment: h.segment,
      project: projectShortName(h.projectId),
      day,
      started_at: h.input.startedAt,
      finished_at: h.input.finishedAt,
      duration_ms: segmentDurationMs(h.input),
      score: result.score,
      pet_score: petScore(result),
      factors: { ...result.factors },
      omitted: [...result.omitted],
    });
    const list = byDay.get(day);
    if (list) list.push(h.input);
    else byDay.set(day, [h.input]);
  }

  const daily: SessionHealthDay[] = [];
  for (let back = days - 1; back >= 0; back--) {
    const day = localDayKey(new Date(localDayStart(now, back)));
    const agg = aggregateSegments(byDay.get(day) ?? []);
    daily.push({
      day,
      mean: agg.mean,
      health: petHealthFromMean(agg.mean),
      unknown: agg.mean === null,
      segments: agg.mean === null ? 0 : agg.segments,
      factors: agg.factors,
      duration_ms: agg.durationMs,
    });
  }

  return { source: "sessions", days, since, until: now.toISOString(), segments, daily };
}
