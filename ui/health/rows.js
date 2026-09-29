/**
 * 浮层 session 列表里 Session Health 的那一半（R13）。纯函数，不碰 DOM ——
 * 所以能被 ui/health/rows.test.js 直接单测。
 *
 * 浮层是用来决定「先处理哪一个、为什么」的：
 *   · 排序：等你的永远在最前（分数再高也一样 —— 它此刻卡着），其余按分数从差到好；
 *   · 指纹：分数变了列表就要重画，没变就一个节点都不许动（否则键盘焦点每 5 秒丢一次）；
 *   · 最弱因子：展开一行时点名「拖分的是哪一个」。省略的因子没有数据、没结算的 Outcome
 *     还会变，两者都不能被选成「最弱」—— 否则一个 Response 没测到的 session 会被说成反应慢。
 */
import { scoreStrip } from "./pips.js";

/** 四个因子的固定顺序，与 core/health.ts 的 FACTOR_NAMES 一致 —— 每个界面都按这个顺序、用这四个名字 */
export const FACTOR_NAMES = ["context", "focus", "response", "outcome"];
/** 每个因子的满分（core/health.ts 的 FACTOR_MAX） */
export const FACTOR_MAX = 25;

/** 与 ui/app.js 原来那张表一致：分数排不出先后时，按状态排 */
const STATE_RANK = { "needs-you": 0, warning: 1, juggling: 2, delegating: 3, working: 4, ready: 5, idle: 6, finished: 7 };

/** 被回收的僵尸（与 core/events.ts 的 isReclaimed 同一份判定） */
function reclaimed(s) {
  return !s.is_active && (s.outcome === "orphaned" || s.outcome === "timeout");
}

function finiteScore(h) {
  return typeof h?.score === "number" && Number.isFinite(h.score) ? h.score : null;
}

/** 每个因子都被省略了吗（防御：Core 这时会给 score=null，但界面不假设） */
function allOmitted(h) {
  const omitted = Array.isArray(h?.omitted) ? h.omitted : [];
  return FACTOR_NAMES.every((f) => omitted.includes(f));
}

/**
 * 一行该画成什么样。
 * @returns {null | { kind: "unknown" } | { kind: "score", score: number, shown: number, band: string, provisional: boolean, strip: object }}
 *   null = 被回收 / 没有 health —— 不画分数也不画 pip（它没有分数，不是 0 分，R10）；
 *   unknown = 有这一段，但一个因子都没测到 —— 说「不知道」，不是 0；
 *   score：shown 是显示用的整数（向下取整，与 pip 条同一个口径）；provisional = 没结算的临时分（R9）
 */
export function rowHealth(s) {
  if (!s || reclaimed(s) || !s.health) return null;
  const h = s.health;
  const score = finiteScore(h);
  if (score === null || allOmitted(h)) return { kind: "unknown" };
  const strip = scoreStrip(score);
  return { kind: "score", score, shown: Math.floor(score), band: strip.band, provisional: h.unsettled === true, strip };
}

/**
 * 排序。needs-you 永远最前；其余按分数从差到好，没有分数的（未知 / 被回收 / 老 Core）排在有分数的后面；
 * 分数相同或都没有时退回状态排序。byScore=false（可见性为 off）时只按状态排 ——
 * 用户关掉了分数，列表顺序就不该还在泄露它。
 */
export function sortSessions(sessions, { byScore = true } = {}) {
  const key = (s) => {
    const needsYou = s.state === "needs-you" ? 0 : 1;
    const r = byScore ? rowHealth(s) : null;
    const score = r?.kind === "score" ? r.score : null;
    return { needsYou, score, rank: STATE_RANK[s.state] ?? 5 };
  };
  return sessions
    .map((s, i) => ({ s, i, k: key(s) }))
    .sort((a, b) => {
      if (a.k.needsYou !== b.k.needsYou) return a.k.needsYou - b.k.needsYou;
      if (a.k.score !== b.k.score) {
        if (a.k.score === null) return 1;
        if (b.k.score === null) return -1;
        return a.k.score - b.k.score;
      }
      if (a.k.rank !== b.k.rank) return a.k.rank - b.k.rank;
      return a.i - b.i; // 稳定：同分同状态保持 Core 给的顺序（最近活动在前）
    })
    .map((x) => x.s);
}

/** 一行的稳定键（展开状态按它记） */
export function rowKey(s) {
  return `${s.agent ?? "?"}:${s.session_id ?? "?"}`;
}

/**
 * 一个 session 在指纹里的那一段。原有字段照旧（见 ui/app.js 各项的注释），再加上 health 里
 * 界面画得出来的每一样：分数、四个因子、是否临时、省略了谁、以及展开后才看得见的证据。
 */
export function sessionSignature(s) {
  const h = s.health ?? null;
  return [
    s.agent, s.session_id, s.state, s.is_active, s.token_used, s.needs_input_since, s.title, s.outcome,
    s.subagent_count,
    h ? [h.score, h.unsettled, h.omitted, h.factors, h.evidence] : null,
  ];
}

/**
 * 整个面板的指纹。
 * @param {{ reachable: boolean, adapters: number|null, waitTick: number, sessions: object[], showHealth: boolean, expanded: string[] }} p
 *   sessions 必须已经排好序；expanded 是展开着的行键
 */
export function panelSignature({ reachable, adapters, waitTick, sessions, showHealth, expanded }) {
  return JSON.stringify([
    reachable,
    adapters,
    waitTick,
    showHealth,
    // 只有还在列表里的行的展开状态才算：一个已经消失的行没东西可画
    [...expanded].filter((k) => sessions.some((s) => rowKey(s) === k)).sort(),
    sessions.map(sessionSignature),
  ]);
}

/**
 * 展开后的四行。每一行说清楚自己是哪种：
 *   scored  —— 有分（points / FACTOR_MAX）；
 *   omitted —— 没测到，界面写「没测到」而不是画一个 0；
 *   pending —— 只有 Outcome 会是这个：还没结算，画虚线槽。
 */
export function factorBreakdown(health) {
  const omitted = Array.isArray(health?.omitted) ? health.omitted : [];
  return FACTOR_NAMES.map((name) => {
    const points = health?.factors?.[name];
    if (omitted.includes(name)) return { name, status: "omitted", points: null, ratio: null };
    if (name === "outcome" && health?.unsettled) return { name, status: "pending", points: null, ratio: null };
    if (typeof points !== "number" || !Number.isFinite(points)) return { name, status: "omitted", points: null, ratio: null };
    return { name, status: "scored", points, ratio: Math.max(0, Math.min(1, points / FACTOR_MAX)) };
  });
}

/**
 * 最弱的因子：只在有分的因子里挑（省略的、没结算的 Outcome 都不算），挑得分率最低的那个。
 * 并列时取靠前的（FACTOR_NAMES 顺序）。全满分时也返回 null —— 「最弱的是满分」不是一句有用的话。
 * @returns {string|null}
 */
export function weakestFactor(health) {
  let worst = null;
  for (const f of factorBreakdown(health)) {
    if (f.status !== "scored") continue;
    if (worst === null || f.ratio < worst.ratio) worst = f;
  }
  return worst && worst.ratio < 1 ? worst.name : null;
}
