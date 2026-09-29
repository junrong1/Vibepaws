/**
 * Den（U13）三个标签页各自「该画成什么样」。纯函数，不碰 DOM、不碰 fetch ——
 * 所以能被 ui/health/den.test.js 直接单测；ui/den.js 只负责把这里的结果变成节点。
 *
 * 每个标签页的结果都先回答「是哪一种」（kind），再给数据：
 *   offline   —— 从来没从 Core 拿到过这一页的数据。它**不是**第一次使用：
 *                连不上的时候说「还没有 session」是在撒谎，用户会以为数据丢了；
 *   first-run —— Core 在，只是真的还没有东西（今天没收工的段 / 从来没写过日志）。
 *                新用户打开 Den 看到的第一屏就是它，所以它必须说出「什么时候会有」，而不是一片空白；
 *   其余      —— 有数据。
 * 连上过之后 Core 又没了：保留上一次的数据，由 den.js 挂一条「这是几点的样子」—— 那是 conn 的事，不是这里的。
 *
 * 分数可见性（R30）：Den 是用户自己打开的一扇窗，flyout / everywhere 都照常显示分数；
 * 只有 off（「哪都不显示」）会把 Today 与 Journal 里的分数、因子收起来，周卡整个不给做 ——
 * 用户说了「哪都不显示」，一张要发出去的图就更不该有分数。session 与条目照样列出来：关掉的是分数，不是历史。
 */
import { FACTOR_NAMES, FACTOR_MAX } from "./rows.js";
import { scoreStrip } from "./pips.js";
import { localDayKey } from "./day.js";
import { shortName } from "./names.js";

/** Den 显示分数吗（off = 不显示；认不出的值按默认 flyout 走 = 显示） */
export function denShowsScores(visibility) {
  return visibility !== "off";
}

function finite(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * 一组因子（满分 25，null = 没数据）→ 四行。与浮层 rows.js 的 factorBreakdown 同一个形状，
 * 只是这里的来源是「一天的时长加权平均」而不是一段：没有 pending（历史里只有已结算的段）。
 */
export function dayFactors(factors) {
  return FACTOR_NAMES.map((name) => {
    const points = factors?.[name];
    if (!finite(points)) return { name, status: "omitted", points: null, ratio: null };
    const rounded = Math.round(points * 10) / 10;
    return { name, status: "scored", points: rounded, ratio: Math.max(0, Math.min(1, points / FACTOR_MAX)) };
  });
}

/** 历史里的一段能不能算：已结算、有收工时刻、没被回收（history 本来就只给这些，这里是防御） */
export function settledSegment(s) {
  if (!s || typeof s !== "object") return false;
  if (s.unsettled === true) return false;
  if (typeof s.finished_at !== "string" || !Number.isFinite(new Date(s.finished_at).getTime())) return false;
  if (s.outcome === "orphaned" || s.outcome === "timeout") return false;
  return true;
}

/**
 * Today 标签页。
 * @param {{ state: object|null, history: object|null, now?: Date }} p
 *   state = 最近一次 /api/state（null = 从来没拿到）；history = /api/session_health?days=7
 * @returns {{ kind: "offline" } | { kind: "first-run", showScores: boolean }
 *   | { kind: "day", showScores: boolean, mean: number|null, strip: object|null, segments: number,
 *       duration_ms: number, factors: object[], sessions: object[] }}
 *   sessions 从新到旧；showScores=false 时 sessions 里的 score 一律是 null（不是只在画的时候不画）
 */
export function todayModel({ state, history, now = new Date() }) {
  if (!state || !history) return { kind: "offline" };
  const showScores = denShowsScores(state.health_visibility);
  const today = localDayKey(now);
  const segments = (Array.isArray(history.segments) ? history.segments : [])
    .filter(settledSegment)
    .filter((s) => localDayKey(s.finished_at) === today);
  if (segments.length === 0) return { kind: "first-run", showScores };

  const daily = (Array.isArray(history.daily) ? history.daily : []).find((d) => d?.day === today) ?? null;
  // 分数取 state.health_today：那是宠物与名牌读的同一个数（每次推送都新）；history 里那一天是它的备份
  const mean = finite(state.health_today?.mean) ? state.health_today.mean : finite(daily?.mean) ? daily.mean : null;
  const sessions = segments
    .map((s) => ({
      key: `${s.agent}:${s.session_id}:${s.segment}`,
      project: shortName(s.project),
      agent: typeof s.agent === "string" ? s.agent : "?",
      started_at: s.started_at ?? null,
      finished_at: s.finished_at,
      duration_ms: finite(s.duration_ms) ? s.duration_ms : null,
      score: showScores && finite(s.score) ? s.score : null,
      strip: showScores && finite(s.score) ? scoreStrip(s.score) : null,
    }))
    .sort((a, b) => (a.finished_at < b.finished_at ? 1 : a.finished_at > b.finished_at ? -1 : 0));
  return {
    kind: "day",
    showScores,
    mean: showScores ? mean : null,
    strip: showScores && mean !== null ? scoreStrip(mean) : null,
    segments: segments.length,
    duration_ms: segments.reduce((sum, s) => sum + (finite(s.duration_ms) ? s.duration_ms : 0), 0),
    factors: showScores ? dayFactors(daily?.factors) : [],
    sessions,
  };
}

/**
 * Journal 标签页。
 * @param {object|null} view /api/journal 的响应（null = 从来没拿到）
 * @param {{ showScores?: boolean, project?: string|null }} [opts]
 * @returns {{ kind: "offline" } | { kind: "first-run" } | { kind: "empty", month: string, project: string|null, months: string[], projects: string[], file: string|null }
 *   | { kind: "entries", month: string, months: string[], projects: string[], file: string|null, entries: object[] }}
 *   entries 从新到旧（日志是往回翻的）
 */
export function journalModel(view, { showScores = true, project = null } = {}) {
  if (!view || typeof view !== "object") return { kind: "offline" };
  const months = Array.isArray(view.months) ? view.months : [];
  const projects = (Array.isArray(view.projects) ? view.projects : []).map(shortName);
  const entries = Array.isArray(view.entries) ? view.entries : [];
  // 一个月份都没有 = 从来没写过：这是新用户的第一屏，不是「这个月没东西」
  if (months.length === 0 && entries.length === 0) return { kind: "first-run" };
  const base = { month: String(view.month ?? ""), months, projects, file: typeof view.file === "string" ? view.file : null };
  if (entries.length === 0) return { kind: "empty", ...base, project: project ? shortName(project) : null };
  return {
    kind: "entries",
    ...base,
    entries: entries
      .map((e) => journalEntry(e, showScores))
      .filter(Boolean)
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.id - a.id)),
  };
}

function journalEntry(e, showScores) {
  if (!e || typeof e !== "object") return null;
  if (e.kind === "evolution" && e.evolution) {
    return {
      kind: "evolution",
      id: Number(e.id) || 0,
      at: String(e.at ?? ""),
      from: String(e.evolution.from ?? "?"),
      to: String(e.evolution.to ?? "?"),
      level: Number(e.evolution.level) || 0,
      health: finite(e.evolution.health) ? Math.round(e.evolution.health * 100) : null,
    };
  }
  return {
    kind: "session",
    id: Number(e.id) || 0,
    at: String(e.at ?? ""),
    project: shortName(e.project),
    agent: typeof e.agent === "string" ? e.agent : "?",
    segment: finite(e.segment) ? e.segment : null,
    started_at: e.started_at ?? null,
    finished_at: e.finished_at ?? null,
    duration_ms: finite(e.duration_ms) ? e.duration_ms : null,
    outcome: typeof e.outcome === "string" ? e.outcome : null,
    score: showScores && finite(e.score) ? e.score : null,
    strip: showScores && finite(e.score) ? scoreStrip(e.score) : null,
    factors: showScores && e.factors ? dayFactors(e.factors) : [],
    omitted: showScores && Array.isArray(e.omitted) ? e.omitted.filter((f) => FACTOR_NAMES.includes(f)) : [],
    files: (Array.isArray(e.files) ? e.files : []).map(shortName),
    files_more: Math.max(0, (Number(e.files_total) || 0) - (Array.isArray(e.files) ? e.files.length : 0)),
  };
}

/**
 * Growth 标签页。曲线永远画得出来（它是公式，不是历史），所以这一页没有整页的 first-run；
 * 有 first-run 的是其中两块：这周还没有 EXP、从来没升过级。
 * @param {object|null} view /api/growth 的响应
 */
export function growthModel(view) {
  if (!view || typeof view !== "object" || !view.pet) return { kind: "offline" };
  const pet = view.pet;
  const level = Number.isInteger(pet.level) && pet.level >= 1 ? pet.level : 1;
  const next = finite(pet.next_level_exp) && pet.next_level_exp > 0 ? pet.next_level_exp : 100;
  const exp = finite(pet.exp) ? Math.max(0, pet.exp) : 0;
  const curve = (Array.isArray(view.curve) ? view.curve : []).filter((p) => Number.isInteger(p?.level) && finite(p?.required));
  const maxRequired = curve.reduce((m, p) => Math.max(m, p.required), 0) || 1;
  const week = view.week ?? {};
  const total = finite(week.total) ? week.total : 0;
  const sources = ["token", "outcome", "care", "self"].map((k) => {
    const amount = finite(week.sources?.[k]) ? week.sources[k] : 0;
    return { key: k, amount, share: total > 0 ? amount / total : 0 };
  });
  const daily = (Array.isArray(week.daily) ? week.daily : []).map((d) => ({ day: String(d.day), total: finite(d.total) ? d.total : 0 }));
  const dailyMax = daily.reduce((m, d) => Math.max(m, d.total), 0);
  return {
    kind: "growth",
    pet: {
      name: String(pet.name ?? ""),
      species: pet.species ?? null,
      level,
      exp,
      next,
      toNext: Math.max(0, Math.round((next - exp) * 100) / 100),
      progress: Math.max(0, Math.min(1, exp / next)),
      health: finite(pet.health) ? pet.health : null,
    },
    curve: curve.map((p) => ({
      level: p.level,
      required: p.required,
      height: p.required / maxRequired,
      status: p.level < level ? "done" : p.level === level ? "current" : "ahead",
      fill: p.level < level ? 1 : p.level === level ? Math.max(0, Math.min(1, exp / next)) : 0,
    })),
    week: {
      empty: total <= 0,
      total,
      sources,
      daily: daily.map((d) => ({ ...d, height: dailyMax > 0 ? d.total / dailyMax : 0 })),
    },
    levelUps: Array.isArray(view.level_ups) ? view.level_ups.filter((u) => Number.isInteger(u?.level)) : [],
    evolution: view.evolution && typeof view.evolution === "object" ? view.evolution : { state: "final" },
  };
}

/**
 * 两次渲染之间有没有变化。Den 每 5 秒轮询一次；没变就一个节点都不动 ——
 * 否则展开着的下拉框、键盘焦点、滚动位置每 5 秒丢一次。
 */
export function signature(model) {
  return JSON.stringify(model);
}
