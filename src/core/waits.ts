/**
 * 「等你」账本（needs_input_waits，R4 / KTD2）—— 每一段 needs-you 一行。
 *
 * `sessions.needs_input_since` 只回答「现在在不在等」。它被清掉的地方有五处，
 * 没有一处记下「什么时候清的、怎么清的」：
 *
 *   registry  agent_working       → inferred    （agent 又动了：多半是在终端里答了）
 *   registry  非阻塞 decision     → turn_ended  （这一轮结束了）
 *   registry  session_finished    → finished
 *   registry  session_started     → restarted   （resume / clear / compact / 再次 startup）
 *   reclaim   僵尸回收             → timeout     （人走开了 —— 最长的那种等待）
 *
 * 每一处都在**清列的同一个地方**调 closeWaits，而不是靠 server 在事件前后比对 ——
 * 那样账本就依赖 HTTP 那一层的接线，simulator、单测、以后任何绕开 server 的入口都会漏记。
 * 被回收收掉的等待尤其不能漏：它们是「没人答」的那一类，丢掉它们 Response 就会把
 * 「走开了」报成「答得很快」。
 *
 * 本模块只 import 类型：registry 与 reclaim 都要用它，而 reclaim 又被 settings import。
 */
import type Database from "better-sqlite3";
import type { WaitResolution } from "./events.ts";

export interface OpenWaitInput {
  agent: string;
  sessionId: string;
  segment: number;
  kind: string;
  /** 进入 needs-you 的那条事件的时间戳 */
  startedAt: string;
  /** Core 处理它的时刻（与 startedAt 差得远 = 离线缓冲的回放） */
  receivedAt: string;
  /** 此刻生效的静音截止时刻（毫秒）；null = 没静音 */
  mutedUntil: number | null;
}

/**
 * 开一段等待。已经有一段没关的就什么都不做（返回 false）：needs-you 在没被清掉的情况下
 * 又来一次（第二个权限请求、同一个问题的重发）是**同一段**等待，不是两段重叠的等待 ——
 * 与 `needs_input_since = COALESCE(needs_input_since, ?)` 同一个语义。
 *
 * muted_ms 预填为「静音最多能覆盖到哪」（截止时刻 − 开始时刻），closeWaits 再夹到实际时长。
 * 已知的低估 / 高估：等待途中才开的静音记不到；等待途中手动取消的静音会被多算 ——
 * 静音的开关历史没有落库，这里能知道的只有「开始那一刻静没静音、静到什么时候」。
 */
export function openWait(db: Database.Database, w: OpenWaitInput): boolean {
  const open = db
    .prepare("SELECT 1 FROM needs_input_waits WHERE agent=? AND session_id=? AND cleared_at IS NULL LIMIT 1")
    .get(w.agent, w.sessionId);
  if (open) return false;
  const started = Date.parse(w.startedAt);
  const mutedMs =
    w.mutedUntil !== null && Number.isFinite(started) ? Math.max(0, Math.round(w.mutedUntil - started)) : 0;
  db.prepare(
    `INSERT INTO needs_input_waits(agent, session_id, segment, kind, started_at, received_at, muted_ms, slept_ms)
     VALUES(?, ?, ?, ?, ?, ?, ?, 0)`,
  ).run(w.agent, w.sessionId, w.segment, w.kind, w.startedAt, w.receivedAt, mutedMs);
  return true;
}

/**
 * 关掉这个 session 所有还开着的等待，记下关闭时刻和是哪一处关的。返回关掉了几行。
 *
 * 不要求 `needs_input_since` 此刻非空：账本和标记列万一不一致（升级前开的标记、
 * 手改过的库），「有开着的行就关」是自愈的方向，反过来会留下一行永远不关的等待。
 * slept_ms 保持 0：shell 里还没有休眠监听（powerMonitor），计划把它列为未处理的风险。
 */
export function closeWaits(
  db: Database.Database,
  agent: string,
  sessionId: string,
  clearedAt: string,
  resolution: WaitResolution,
): number {
  const rows = db
    .prepare("SELECT id, started_at, muted_ms FROM needs_input_waits WHERE agent=? AND session_id=? AND cleared_at IS NULL")
    .all(agent, sessionId) as Array<{ id: number; started_at: string; muted_ms: number }>;
  const cleared = Date.parse(clearedAt);
  const update = db.prepare("UPDATE needs_input_waits SET cleared_at=?, resolution=?, muted_ms=? WHERE id=?");
  for (const r of rows) {
    const started = Date.parse(r.started_at);
    // 时钟不一致（不同通道的时间戳、回拨）时时长夹在 0：静音不可能比等待本身更长
    const duration = Number.isFinite(cleared) && Number.isFinite(started) ? Math.max(0, cleared - started) : 0;
    update.run(clearedAt, resolution, Math.min(r.muted_ms, duration), r.id);
  }
  return rows.length;
}
