/**
 * 气泡的纯判定逻辑。不碰 DOM —— 所以能被 ui/health/bubbles.test.js 直接单测。
 *
 * 目前只有一件事：一条常驻（sticky）气泡什么时候该自己走。
 */

/**
 * 气泡出生后的这段时间里，不因为「session 不见了 / 不在等你」撤掉它。
 *
 * 原因是一个真实的时序：5s 轮询的请求在事件到达**之前**发出、在气泡出现**之后**才回来
 * （POLL_TIMEOUT_MS 是 4s）。那份快照里要么还没有这个新 session，要么它还是 working ——
 * 照单全收的话，一条刚弹出来的「等你」会在同一秒被一份过期的列表撤掉。
 * 真的答完了也不靠这个窗口：Core 会推 `notification_resolved`，按 id 立刻撤。
 */
export const STALE_PUSH_GRACE_MS = 10_000;

/**
 * 这条常驻气泡是否该撤掉。
 *
 * session **不在列表里**也要撤：`listSessions` 是 `ORDER BY last_event_at DESC LIMIT 50`，
 * 被回收的 session 可能已经掉出列表 —— 只处理「在列表里且不再等你」的话，
 * 它的气泡就永远挂在那儿。
 *
 * @param {{ agent: string, session: string, createdAt: number }} bubble
 * @param {Array<{ agent: string, session_id: string, state: string }>} sessions 最新一份推送里的 session 列表
 * @param {number} now 毫秒时间戳
 * @returns {boolean}
 */
export function stickyBubbleStale(bubble, sessions, now) {
  if (now - bubble.createdAt < STALE_PUSH_GRACE_MS) return false;
  const s = sessions.find((x) => x.session_id === bubble.session && x.agent === bubble.agent);
  return !s || s.state !== "needs-you";
}
