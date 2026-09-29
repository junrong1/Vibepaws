/**
 * 气泡的纯判定逻辑。不碰 DOM —— 所以能被 ui/health/bubbles.test.js 直接单测。
 *
 * 两件事：
 *   1. 一条常驻（sticky）气泡什么时候该自己走（U1，stickyBubbleStale）；
 *   2. 「能往上放按钮」的气泡组件（U7）：键、原地合并、排序与单行折叠、淘汰、
 *      动作表，以及按数字键之前的停留护栏和快照规则。
 * app.js 只负责把这里的判定画出来、把按键和点击接到 /api/action 上。
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

/* ================= U7：气泡组件 ================= */

/**
 * 可操作的（等你回答的）类型。它们常驻、按事件 id 各自成条、永远不原地改写（R15）：
 * 以前 `agent:session:type` 的键会把同一 session 的两个权限请求并成一条、显示第二条的文字 ——
 * 等上面挂了「允许」按钮，那就是批准了一个用户根本没读到的调用。
 */
export const ACTIONABLE_TYPES = new Set(["decision", "permission"]);

/** @param {string|undefined} type */
export function isActionable(type) {
  return ACTIONABLE_TYPES.has(type ?? "");
}

/**
 * 气泡的键。可操作类按通知行 id（老 Core 没有 id 时退到 event_id）；两样都没有 → null，
 * null 永远不和任何气泡匹配 —— 宁可多一条，也不合并两条请求。
 * 辅导类（context / error / ready …）照旧按 `agent:session:type` 原地合并：
 * 72% → 88% 是同一件事在变，不是两件事。
 *
 * @param {{ agent?: string, session_id?: string, type?: string, id?: number, event_id?: string }} n
 * @returns {string|null}
 */
export function bubbleKey(n) {
  if (isActionable(n.type)) {
    if (Number.isInteger(n.id)) return `id:${n.id}`;
    if (n.event_id) return `evt:${n.event_id}`;
    return null;
  }
  return `${n.agent ?? "?"}:${n.session_id ?? "?"}:${n.type ?? "?"}`;
}

/**
 * 新通知该原地更新屏幕上的哪一条；null = 另起一条。
 * 可操作的气泡永远不被选中，哪怕键撞上了（比如同一个 id 被重推）。
 *
 * @template {{ key: string|null, actionable: boolean }} B
 * @param {B[]} bubbles 屏幕上的气泡
 * @param {{ type?: string }} n 新到的通知
 * @returns {B|null}
 */
export function collapseTarget(bubbles, n) {
  if (isActionable(n.type)) return null;
  const key = bubbleKey(/** @type {any} */ (n));
  if (key === null) return null;
  return bubbles.find((b) => !b.actionable && b.key === key) ?? null;
}

/**
 * 显示顺序：可操作的在前；同一档按到达序号（seq，单调递增的本地计数）从老到新。
 * 用 seq 而不是时间戳：同一个 tick 到的两条时间戳一样，靠它定序才稳定 ——
 * 顶上那条不会在用户按键的那一瞬换人。后来的同档气泡排在后面，不抢顶。
 *
 * @template {{ actionable: boolean, seq: number }} B
 * @param {B[]} bubbles
 * @returns {B[]}
 */
export function sortBubbles(bubbles) {
  return [...bubbles].sort((a, b) => Number(b.actionable) - Number(a.actionable) || a.seq - b.seq);
}

/**
 * 顶上最多几条单行。一条带动作行的气泡约 90px，气泡区只有 180px（窗口比舞台高出的那一截）。
 */
export const MAX_STUBS = 3;

/**
 * 排版：只有顶上那条展开（带动作行），其余折成单行；单行放不下的折进计数。
 * 一条都不丢 —— `behind` 永远等于顶上那条后面还有几条。
 *
 * @template {{ actionable: boolean, seq: number }} B
 * @param {B[]} bubbles
 * @param {number} [maxStubs]
 * @returns {{ top: B|null, stubs: B[], behind: number, hidden: number }}
 */
export function layoutBubbles(bubbles, maxStubs = MAX_STUBS) {
  const sorted = sortBubbles(bubbles);
  const top = sorted[0] ?? null;
  const rest = sorted.slice(1);
  const stubs = rest.slice(0, maxStubs);
  return { top, stubs, behind: rest.length, hidden: rest.length - stubs.length };
}

/**
 * 超出上限时该淘汰哪些：只从会自己消失的里面挑，按到达顺序先老后新。
 * 常驻气泡**永远不淘汰**（R16）—— 屏幕上全是常驻时返回空，多出来的交给 layoutBubbles 折叠。
 * （以前 trimBubbles 找不到非常驻的就退到 `box.firstElementChild`，正好是最老的那条「等你」。）
 *
 * @template {{ sticky: boolean, seq: number }} B
 * @param {B[]} bubbles
 * @param {number} max
 * @returns {B[]}
 */
export function pickEvictions(bubbles, max) {
  const over = bubbles.length - max;
  if (over <= 0) return [];
  return bubbles
    .filter((b) => !b.sticky)
    .sort((a, b) => a.seq - b.seq)
    .slice(0, over);
}

/**
 * 通知类型 → 它动的是哪个因子（R14），用 `ui.health.factor.*` 点名。
 * drift 不在表里：主题漂移是影子模式，不带分（KTD11），点名一个不会动的因子只会误导。
 * repeat_edit / correction 是 Focus 的警告类型，Core 还没发，先占位。
 */
export const COACHING_FACTOR = Object.freeze({
  context: "context",
  error: "outcome",
  repeat_edit: "focus",
  correction: "focus",
});

/**
 * @param {string|undefined} type
 * @returns {"context"|"focus"|"response"|"outcome"|null}
 */
export function bubbleFactor(type) {
  return Object.hasOwn(COACHING_FACTOR, type ?? "") ? COACHING_FACTOR[/** @type {keyof typeof COACHING_FACTOR} */ (type)] : null;
}

/** 一条气泡最多几个动作（数字键 1–3） */
export const MAX_ACTIONS = 3;

/**
 * 动作表 —— 是数据，不是写死在 DOM 里的按钮。每一项：
 *   id        动作名，app.js 的 BUBBLE_ACTIONS 按它找处理函数
 *   labelKey  文案 key（params 可选：由 params(n) 从通知自己的字段算出来）
 *   safe      安全动作；Enter 只绑它，每条气泡恰好一个
 *   applies   这条通知有没有这个动作
 *
 * 数字键按在表里的位置编号，所以加一项不用改任何键位。
 * U9（Always allow）往 permission 上加一项、U10（Not useful）往辅导类上加一项，都只是在这里追加。
 * 没有回传通道之前，这里绝不出现「允许」这一类会放行调用的动作（R19 / KTD7）。
 *
 * `applies(n, ctx)` 的 ctx 是渲染层的处境：`{ canGrant }` = 这扇窗口有没有壳的授予通道
 * （preload 的 grantAlways；浏览器预览里没有）。
 *
 * @type {ReadonlyArray<{ id: string, labelKey: string, safe?: boolean,
 *   applies: (n: any, ctx: { canGrant?: boolean }) => boolean,
 *   params?: (n: any) => Record<string, string|number> }>}
 */
export const ACTION_SPECS = Object.freeze([
  { id: "dismiss", labelKey: "ui.bubble.dismiss", safe: true, applies: () => true },
  /**
   * 永远允许（U9）。三个条件缺一不可：是 permission、Core 给出了一条它推得出来的安全规则
   * （n.grant —— 危险类、推不出参数的工具、非 Claude Code 都不会有）、这扇窗口在壳里。
   * 文案里写明会记住的那条规则和项目：没有范围选择器，用户读到的就是会写进去的。
   * 不是 safe：Enter 永远不落在它身上；点击和数字键一样过停留护栏（decideClick）。
   */
  {
    id: "always_allow",
    labelKey: "ui.bubble.always",
    applies: (n, ctx) => n.type === "permission" && Boolean(ctx?.canGrant) && typeof n.grant?.rule === "string",
    params: (n) => ({ rule: n.grant.rule, project: n.grant.project ?? "" }),
  },
]);

/**
 * @param {{ type?: string }} n
 * @param {typeof ACTION_SPECS} [specs]
 * @param {{ canGrant?: boolean }} [ctx]
 * @returns {Array<{ id: string, key: string, labelKey: string, params?: Record<string, string|number>, safe: boolean }>}
 */
export function bubbleActions(n, specs = ACTION_SPECS, ctx = {}) {
  return specs
    .filter((s) => s.applies(n, ctx))
    .slice(0, MAX_ACTIONS)
    .map((s, i) => ({
      id: s.id,
      key: String(i + 1),
      labelKey: s.labelKey,
      ...(s.params ? { params: s.params(n) } : {}),
      safe: s.safe === true,
    }));
}

/**
 * 无障碍名里「每个数字键做什么」那一段（R28），例如 "1: Dismiss, 2: Always allow for Bash in my-app"。
 * @param {ReturnType<typeof bubbleActions>} actions
 * @param {(key: string, params?: Record<string, string|number>) => string} tr
 */
export function actionsLabel(actions, tr) {
  return actions.map((a) => `${a.key}: ${tr(a.labelKey, a.params)}`).join(", ");
}

/* ---------------- 停留护栏与快照 ----------------
 * 数字键只在宠物窗口有键盘焦点时才到得了这里。两道闸：
 *   停留：窗口拿到焦点、或者某条气泡成为顶（取较晚者）之后的 DWELL_MS 内不认按键 ——
 *         Firefox 的权限框用 1000ms、Chrome 大约 600ms，都是为了同一件事：
 *         用户本来要按给别处的键，不能落在一个刚冒出来的请求上。
 *   快照：拿到焦点时记下顶上是哪一条；按键落下时顶上已经换了人 → 拒绝，并告诉用户请求变了。
 *         否则读了 A、转头、B 插到前面、再按一个记住的数字 —— 就批准了一个没读过的 B。
 * 状态 g = { focusedAt, snapshotId, armedAt }；null = 窗口没有焦点。 */

/** 停留时长（500–750ms 之间） */
export const DWELL_MS = 600;

/**
 * 窗口拿到焦点：快照当前的顶，从现在起算停留。
 * @param {number} now
 * @param {string|number|null} topId
 */
export function guardFocus(now, topId) {
  return { focusedAt: now, snapshotId: topId ?? null, armedAt: now };
}

/**
 * 顶上换了人。已经有快照 → 快照不动（换人是按键时要拒绝的那件事，不是要跟着走的那件事）；
 * 拿焦点时还没有气泡 → 这一条就是用户第一眼看到的，拍快照、从现在起算停留。
 * @param {ReturnType<typeof guardFocus>|null} g
 * @param {string|number|null} topId
 * @param {number} now
 */
export function guardTop(g, topId, now) {
  if (!g || g.snapshotId !== null || topId === null || topId === undefined) return g;
  return { ...g, snapshotId: topId, armedAt: now };
}

/**
 * 重拍快照并重新计停留：按键被拒之后（让用户看清新的那条）、以及用户自己处理掉顶上那条之后。
 * @param {ReturnType<typeof guardFocus>|null} g
 * @param {string|number|null} topId
 * @param {number} now
 */
export function guardResnap(g, topId, now) {
  if (!g) return g;
  return { ...g, snapshotId: topId ?? null, armedAt: now };
}

/**
 * 快照那条原地改了正文（辅导类 72% → 95%）：重新上膛。改的不是快照那条 → 原样返回。
 * @param {ReturnType<typeof guardFocus>|null} g
 * @param {string|number} id
 * @param {number} now
 */
export function guardContent(g, id, now) {
  if (!g || g.snapshotId !== id) return g;
  return { ...g, armedAt: now };
}

/**
 * 一次按键怎么处理：
 *   pass      不是我们的键 / 没有气泡 → 不吞，交给别的监听
 *   swallow   自动连发 → 吞掉，什么也不做
 *   unfocused 没有护栏状态（焦点事件没来过）→ 调用方现在上膛
 *   changed   顶上的气泡已经不是快照那条 → 拒绝，提示「请求变了」
 *   dwell     还在停留窗口里 → 拦下（remaining 毫秒后才认）
 *   act       执行 action
 *
 * @param {ReturnType<typeof guardFocus>|null} g
 * @param {{ key: string, repeat: boolean, now: number, topId: string|number|null,
 *   actions: ReturnType<typeof bubbleActions> }} e
 */
export function decideKey(g, { key, repeat, now, topId, actions }) {
  const action = key === "Enter" ? actions.find((a) => a.safe) : actions.find((a) => a.key === key);
  if (!action || topId === null || topId === undefined) return { kind: "pass" };
  if (repeat) return { kind: "swallow" };
  if (!g) return { kind: "unfocused" };
  if (g.snapshotId !== topId) return { kind: "changed" };
  const remaining = g.armedAt + DWELL_MS - now;
  if (remaining > 0) return { kind: "dwell", remaining };
  return { kind: "act", action };
}

/**
 * 一次**点击**怎么处理（U9）。数字键的护栏只管键盘；「永远允许」是一个永久裁决，点击也得过同样两道闸：
 *   act      安全动作（叉掉）永远直接执行 —— 叉错了代价只是再等一次
 *   changed  点的不是当前顶上那条（刚被挤下去、DOM 还没来得及换位）→ 不执行
 *   dwell    它成为顶、或者正文变了之后还不到 DWELL_MS → 不执行，调用方把进度线亮出来
 * `topSince` 是这条气泡**最近一次**成为顶或改了正文的时刻：鼠标停在按钮上时一条新请求顶上来，
 * 同一个位置换成了另一条的按钮 —— 这一下点击不能落在一个没读过的请求上。
 *
 * @param {{ action: { safe: boolean }, uid: string|number, topId: string|number|null,
 *   topSince: number, now: number }} e
 */
export function decideClick({ action, uid, topId, topSince, now }) {
  if (action.safe) return { kind: "act" };
  if (topId === null || topId === undefined || uid !== topId) return { kind: "changed" };
  const remaining = topSince + DWELL_MS - now;
  if (remaining > 0) return { kind: "dwell", remaining };
  return { kind: "act" };
}
