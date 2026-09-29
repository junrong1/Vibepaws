/**
 * Session Health 的 pip 条：分数 → 十格。纯函数，不碰 DOM —— 所以能被 ui/health/pips.test.js 直接单测。
 *
 * 编码（R12）：十格，每格十分，**向下取整**；七格之后留一道宽缝，再三格。
 * 于是「亮着的一串刚好碰到那道缝」就是 70 这条线本身 —— 余光里看的是长度，不是颜色：
 *   · ≥ 70 中性灰（宠物身上不该常驻一个在喊的颜色，健康就是不起眼）；
 *   · < 70 琥珀，< 50 红。颜色是冗余的：亮了几格已经说完了，色弱或者灰度下照样读得出来。
 *
 * 「不知道」有两种，长得必须不一样：
 *   · empty   —— Core 在，今天只是还没有结算过的段（R31）：十个空心格；
 *   · offline —— Core 连不上：十格压成一条平线。连接断了还挂着上一个分数是在撒谎
 *     （和 conn-degraded 指示灯存在的理由相同），而且看名牌的人不会同时去看右上角那个点。
 * 「0 分」是真的分数（有样本、就是很差），画十个实心暗格，不是空心 —— 和 empty 分得开。
 */

/** 格数 */
export const PIP_CELLS = 10;
/** 宽缝在第几格之后 —— 7 × 10 = 70，就是中性/琥珀的分界 */
export const PIP_GAP_AFTER = 7;
/** 每格代表的分数 */
export const POINTS_PER_CELL = 10;
/** 从这里往上是中性色 */
export const NEUTRAL_AT = 70;
/** 从这里往下是红色（49 红，50 琥珀） */
export const RED_BELOW = 50;

/** 分数所在的色带：neutral / amber / red。不是有限数字时返回 null */
export function pipBand(score) {
  if (typeof score !== "number" || !Number.isFinite(score)) return null;
  if (score >= NEUTRAL_AT) return "neutral";
  if (score >= RED_BELOW) return "amber";
  return "red";
}

/**
 * 亮几格。向下取整：79.9 永远读成 7 格而不是 8 格 —— 碰到缝就意味着「真的到了 70」，
 * 四舍五入会让 69.5 也碰到缝，整套编码就不成立了。收进 0..10。
 */
export function litCells(score) {
  if (typeof score !== "number" || !Number.isFinite(score)) return 0;
  return Math.max(0, Math.min(PIP_CELLS, Math.floor(score / POINTS_PER_CELL)));
}

/**
 * 一条有分数的 pip 条。
 * @param {number} score 0–100
 * @returns {{ kind: "score", score: number, lit: number, band: "neutral"|"amber"|"red", gapClosed: boolean, cells: boolean[] }}
 *   gapClosed = 缝前那一格亮着，也就是 ≥ 70；cells[i] = 第 i 格亮不亮
 */
export function scoreStrip(score) {
  const lit = litCells(score);
  return {
    kind: "score",
    score,
    lit,
    band: pipBand(score) ?? "red",
    gapClosed: lit >= PIP_GAP_AFTER,
    cells: Array.from({ length: PIP_CELLS }, (_, i) => i < lit),
  };
}

/** 不知道的那两种：cells 全灭，kind 说明是哪一种 */
function unknownStrip(kind) {
  return { kind, score: null, lit: 0, band: null, gapClosed: false, cells: Array(PIP_CELLS).fill(false) };
}

/**
 * 宠物名牌上那条读什么（今天的聚合 health_today.mean —— 与宠物 health_score 是同一个数的两种读法）。
 *
 * @param {{ mean: number|null, unknown?: boolean } | null | undefined} today PetStatePush.health_today（老 Core 不发 = undefined）
 * @param {"ok"|"degraded"|"off"|"unknown"} conn 与 ui/app.js 的 renderConn 同一份连接状态
 * @returns 见 scoreStrip；kind 另有 "empty"（没样本）与 "offline"（连不上 / 半死 / 还没连上）
 */
export function nameplateStrip(today, conn) {
  // 只有事件流活着才算可信：半死（只剩轮询）和还没连上一律按连不上画 ——
  // 名牌是余光里读的，这里宁可说「不知道」，也不要让一个可能停住的数继续挂着。
  if (conn !== "ok") return unknownStrip("offline");
  const mean = today?.mean;
  if (!today || today.unknown || typeof mean !== "number" || !Number.isFinite(mean)) return unknownStrip("empty");
  return scoreStrip(mean);
}

/**
 * 可见性（R30，设置里的 health_visibility）→ 两个界面各自显示不显示。
 * 认不出的值（老 Core 不发这个字段）按默认 flyout 走。
 * @param {unknown} visibility
 * @returns {{ nameplate: boolean, flyout: boolean }}
 */
export function healthSurfaces(visibility) {
  if (visibility === "off") return { nameplate: false, flyout: false };
  if (visibility === "everywhere") return { nameplate: true, flyout: true };
  return { nameplate: false, flyout: true };
}
