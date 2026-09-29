/**
 * 周卡（U14 / R26）：这一周的四个因子和七天，画成一张能存下来、能发出去的图。
 *
 * 这个文件分三层，只有最后一层碰 canvas：
 *   1. weekBuckets / weekSummary —— 纯数据：按**本地**日分桶、只算已结算的段、项目名脱敏；
 *   2. layoutCard —— 纯排版：模型 → 一张「绘制清单」（矩形与文字）。量字靠调用方传进来的 measure，
 *      所以测试里用假的字宽就能验证「清单里没有一个路径分隔符」「零段的一周不除以零」；
 *   3. paint —— 把清单交给 ctx。没有任何判断。
 *
 * 为什么这么切：周卡是整个产品里**唯一**会离开这台机器的东西。它不许带出一个目录名 ——
 * 路径里有用户名、公司目录、客户名。project_id 是绝对路径（G16），history 里给的已经是
 * projectShortName() 的短名，这里再削一次（POSIX 与 Windows 两种分隔符），然后在清单的最后一步
 * 把所有文字里剩下的分隔符也换掉：守住的是「图上没有分隔符」这件事本身，而不是「每个来源都记得削」。
 *
 * 项目名要不要上卡，是计划里没定的一问（「短名也还是客户名」）。这里的回答：默认不写，只写有几个项目；
 * 用户每次导出时自己勾「写项目名」，才写至多三个短名。
 *
 * 文字宽度一律量（ctx.measureText），不按等宽字宽估：没有打包字体、等宽栈里没有 CJK，
 * 中文落到系统字体上，字宽不可预测。放不下就按量出来的宽度截断加省略号，不溢出。
 *
 * 导出走 canvas.toDataURL()：UI server 的 CSP 是 img-src 'self' data:，没有 blob:，
 * createObjectURL 的预览会被挡掉（见 src/ui/server.ts）。
 */
import { FACTOR_NAMES, FACTOR_MAX } from "./rows.js";
import { localDayKey } from "./day.js";
import { redactProject } from "./names.js";

export const CARD_W = 1200;
export const CARD_H = 630;
/** 与 core/health.ts 的时长加权下限一致（KTD10）：一行 claude -p 拉不垮四小时的正事 */
export const MIN_WEIGHT_MS = 5 * 60_000;
/** 卡上至多写几个项目名 */
export const MAX_PROJECTS = 3;

/* ================= 1. 数据 ================= */

/** 本地日往前数 n 天的那一天（用年月日构造：跨夏令时的那一天不是 24 小时） */
function dayBack(now, n) {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - n);
}

function finite(v) {
  return typeof v === "number" && Number.isFinite(v);
}

/** 一段能不能上卡：已结算、有收工时刻、没被回收（history 本来就只给这些 —— 这里是防御，R9 / R10） */
export function countable(s) {
  if (!s || typeof s !== "object") return false;
  if (s.unsettled === true) return false;
  if (s.outcome === "orphaned" || s.outcome === "timeout") return false;
  if (typeof s.finished_at !== "string") return false;
  return Number.isFinite(new Date(s.finished_at).getTime());
}

function weight(s) {
  return Math.max(finite(s.duration_ms) ? s.duration_ms : 0, MIN_WEIGHT_MS);
}

/** 一组段的时长加权平均。取不到值的段不进分子也不进分母；一段都没有 → null（不是 0，也不是 NaN） */
function weightedMean(segs, pick) {
  let sum = 0;
  let w = 0;
  for (const s of segs) {
    const v = pick(s);
    if (!finite(v)) continue;
    const k = weight(s);
    sum += v * k;
    w += k;
  }
  return w > 0 ? sum / w : null;
}

/** 卡上的「分」：三因子的宠物分（与当天聚合 daily.mean、宠物健康同一个口径，Response 不在里面） */
function segScore(s) {
  return finite(s.pet_score) ? s.pet_score : null;
}

/**
 * 最近 `days` 个本地日（含今天），从早到晚。每一天：均分（null = 那天没有段）、段数、时长。
 * 按 finished_at 的**本地**日分桶：23:50 收工的一段落在用户过的那一天。
 */
export function weekBuckets(segments, { now = new Date(), days = 7 } = {}) {
  const keys = [];
  for (let back = days - 1; back >= 0; back--) keys.push(localDayKey(dayBack(now, back)));
  const byDay = new Map(keys.map((k) => [k, []]));
  for (const s of Array.isArray(segments) ? segments : []) {
    if (!countable(s)) continue;
    const bucket = byDay.get(localDayKey(new Date(s.finished_at)));
    if (bucket) bucket.push(s);
  }
  return keys.map((day) => {
    const segs = byDay.get(day);
    return {
      day,
      mean: weightedMean(segs, segScore),
      segments: segs.length,
      duration_ms: segs.reduce((a, s) => a + (finite(s.duration_ms) ? s.duration_ms : 0), 0),
    };
  });
}

/**
 * 一周的模型。
 * @param {object|null} history /api/session_health?days=7 的响应
 * @param {{ now?: Date, includeProjects?: boolean }} [opts]
 * @returns {{ empty: boolean, days: object[], from: string, to: string, mean: number|null,
 *   factors: Array<{ name: string, points: number|null }>, sessions: number, duration_ms: number,
 *   projects: string[], projectCount: number }}
 */
export function weekSummary(history, { now = new Date(), includeProjects = false } = {}) {
  const days = weekBuckets(history?.segments, { now, days: 7 });
  const keys = new Set(days.map((d) => d.day));
  const segs = (Array.isArray(history?.segments) ? history.segments : []).filter(
    (s) => countable(s) && keys.has(localDayKey(new Date(s.finished_at))),
  );
  const factors = FACTOR_NAMES.map((name) => {
    const v = weightedMean(segs, (s) => s.factors?.[name]);
    return { name, points: v === null ? null : Math.round(v * 10) / 10 };
  });
  // 项目：按这周花的时间排，同样时长按名字排（导出两次得到同一张图）
  const time = new Map();
  for (const s of segs) {
    const name = redactProject(s.project);
    time.set(name, (time.get(name) ?? 0) + weight(s));
  }
  const ranked = [...time.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([n]) => n);
  return {
    empty: segs.length === 0,
    days,
    from: days[0].day,
    to: days.at(-1).day,
    mean: weightedMean(segs, segScore),
    factors,
    sessions: segs.length,
    duration_ms: segs.reduce((a, s) => a + (finite(s.duration_ms) ? s.duration_ms : 0), 0),
    projects: includeProjects ? ranked.slice(0, MAX_PROJECTS) : [],
    projectCount: ranked.length,
  };
}

/* ================= 2. 排版 ================= */

/** 卡片自己的配色：它要被发出去，不跟着系统深浅色走 —— 同一周导两次应该是同一张图 */
const C = {
  bg: "#0d1117",
  panel: "#161b22",
  border: "#30363d",
  text: "#e6edf3",
  dim: "#8b949e",
  track: "#21262d",
  accent: "#58a6ff",
  ok: "#3fb950",
  warn: "#f0883e",
  danger: "#f85149",
};
/** 无衬线系统字体栈：中文落到系统的中文字体上（计划里接受的降级渲染），拉丁字用等宽 */
const FACE = '"SF Mono", Menlo, Consolas, ui-monospace, "PingFang SC", "Microsoft YaHei", sans-serif';
export function font(size, weight = 400) {
  return `${weight} ${size}px ${FACE}`;
}

function band(score) {
  if (!finite(score)) return C.dim;
  if (score < 50) return C.danger;
  if (score < 70) return C.warn;
  return C.ok;
}

/**
 * 截断到放得下：量出来的宽度 ≤ maxWidth；放不下就逐字（按码点，不劈开一个汉字或 emoji）
 * 往回缩，再补一个省略号。连省略号都放不下 → 空串。
 * @param {(text: string, font: string) => number} measure
 */
export function fitText(text, maxWidth, measure, f) {
  const s = String(text ?? "");
  if (measure(s, f) <= maxWidth) return s;
  const ell = "…";
  if (measure(ell, f) > maxWidth) return "";
  const chars = [...s];
  let lo = 0;
  let hi = chars.length;
  // 二分：最长的、加上省略号还放得下的前缀
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(chars.slice(0, mid).join("") + ell, f) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  return chars.slice(0, lo).join("").trimEnd() + ell;
}

/** 文字里剩下的路径分隔符一律换掉：图上没有分隔符，是这张卡对外的承诺（R26） */
function noSeparators(s) {
  return String(s).replace(/[\\/]+/g, " ");
}

/**
 * 模型 → 绘制清单。
 * @param {ReturnType<typeof weekSummary>} model
 * @param {{ t: (key: string, params?: object) => string, measure: (text: string, font: string) => number,
 *   dayLabel: (dayKey: string) => string, weekday: (dayKey: string) => string,
 *   duration: (ms: number) => string, pet?: { name: string, level: number } | null }} env
 * @returns {{ width: number, height: number, ops: Array<object> }}
 */
export function layoutCard(model, env) {
  const { t, measure } = env;
  const ops = [];
  const rect = (x, y, w, h, fill, extra = {}) => ops.push({ type: "rect", x, y, w: Math.max(0, w), h: Math.max(0, h), fill, ...extra });
  const text = (x, y, s, f, fill, maxWidth, align = "left") => {
    const fitted = fitText(noSeparators(s), maxWidth, measure, f);
    if (fitted) ops.push({ type: "text", x, y, text: fitted, font: f, fill, align });
  };

  const PAD = 56;
  rect(0, 0, CARD_W, CARD_H, C.bg);
  rect(24, 24, CARD_W - 48, CARD_H - 48, C.panel, { stroke: C.border, radius: 18 });

  // 抬头：标题 + 日期范围在左，宠物在右。宠物名是用户起的，可能很长 —— 右边给它固定一块宽度
  const petText = env.pet ? t("card.pet", { name: env.pet.name, level: env.pet.level }) : "";
  const petW = petText ? Math.min(measure(noSeparators(petText), font(22, 700)), 380) : 0;
  text(PAD, 88, t("card.heading"), font(34, 700), C.text, CARD_W - PAD * 2 - petW - 24);
  text(PAD, 124, t("card.range", { from: env.dayLabel(model.from), to: env.dayLabel(model.to) }), font(20), C.dim, 600);
  if (petText) text(CARD_W - PAD, 88, petText, font(22, 700), C.dim, 380, "right");

  if (model.empty) {
    // 空的一周不是一张白卡：说清楚为什么是空的、什么时候会有
    text(CARD_W / 2, 300, t("card.empty"), font(34, 700), C.text, CARD_W - PAD * 2, "center");
    text(CARD_W / 2, 350, t("card.empty.body"), font(20), C.dim, CARD_W - PAD * 2, "center");
    text(PAD, CARD_H - 52, t("card.footnote"), font(15), C.dim, CARD_W - PAD * 2);
    return { width: CARD_W, height: CARD_H, ops };
  }

  // 左栏：这周的分 + pip 条 + 段数 / 时长 / 项目
  const LEFT_W = 400;
  const mean = model.mean;
  const shown = finite(mean) ? String(Math.floor(mean)) : "–";
  const bigFont = font(120, 700);
  text(PAD, 280, shown, bigFont, band(mean), LEFT_W);
  const bigW = Math.min(measure(shown, bigFont), LEFT_W);
  // 「满分 100」写成字，不写 "/100"：这张图上一个斜杠都不许有（见 noSeparators）
  text(PAD + bigW + 12, 280, t("card.outof"), font(22), C.dim, LEFT_W - bigW - 12);
  text(PAD, 318, t("card.mean"), font(18), C.dim, LEFT_W);
  // pip 条（编码见 ui/health/pips.js：十格、每格十分、向下取整、七格之后一道宽缝）
  const lit = finite(mean) ? Math.max(0, Math.min(10, Math.floor(mean / 10))) : 0;
  for (let i = 0; i < 10; i++) {
    const x = PAD + i * 30 + (i >= 7 ? 14 : 0);
    rect(x, 340, 24, 14, i < lit ? band(mean) : C.track, { radius: 3 });
  }
  text(PAD, 400, t("card.sessions", { n: model.sessions, time: env.duration(model.duration_ms) }), font(20), C.text, LEFT_W);
  if (model.projects.length > 0) {
    let y = 436;
    for (const p of model.projects) {
      text(PAD, y, `· ${p}`, font(18), C.dim, LEFT_W);
      y += 28;
    }
    const more = model.projectCount - model.projects.length;
    if (more > 0) text(PAD, y, t("card.projects.more", { n: more }), font(16), C.dim, LEFT_W);
  } else {
    text(PAD, 436, t("card.projects", { n: model.projectCount }), font(18), C.dim, LEFT_W);
  }

  // 右栏上半：四个因子
  const RX = 520;
  const RW = CARD_W - PAD - RX;
  const NAME_W = 150;
  const VAL_W = 90;
  const TRACK_X = RX + NAME_W + 12;
  const TRACK_W = RW - NAME_W - VAL_W - 24;
  let y = 176;
  for (const f of model.factors) {
    text(RX, y + 7, t(`ui.health.factor.${f.name}`), font(20), C.text, NAME_W);
    rect(TRACK_X, y - 8, TRACK_W, 14, C.track, { radius: 7 });
    if (finite(f.points)) {
      const ratio = Math.max(0, Math.min(1, f.points / FACTOR_MAX));
      rect(TRACK_X, y - 8, TRACK_W * ratio, 14, C.accent, { radius: 7 });
    }
    // 分值只写分子，「每项满分 25」在页脚里说：同样是为了图上没有斜杠
    const val = finite(f.points) ? (Number.isInteger(f.points) ? String(f.points) : f.points.toFixed(1)) : t("card.omitted");
    text(RX + RW, y + 7, val, font(18), C.dim, VAL_W, "right");
    y += 44;
  }

  // 右栏下半：七天。没有段的日子画空心框加一道短横，不画成 0 分（R31：不知道不是 0）
  const CH_TOP = 370;
  const CH_H = 150;
  const n = model.days.length;
  const gap = 14;
  const barW = (RW - gap * (n - 1)) / n;
  for (let i = 0; i < n; i++) {
    const d = model.days[i];
    const x = RX + i * (barW + gap);
    rect(x, CH_TOP, barW, CH_H, C.track, { radius: 6 });
    if (finite(d.mean)) {
      const h = Math.max(4, CH_H * Math.max(0, Math.min(1, d.mean / 100)));
      rect(x, CH_TOP + CH_H - h, barW, h, band(d.mean), { radius: 6 });
      text(x + barW / 2, CH_TOP + CH_H - h - 10, String(Math.floor(d.mean)), font(16, 700), C.text, barW, "center");
    } else {
      rect(x + barW / 2 - 8, CH_TOP + CH_H - 12, 16, 3, C.dim);
    }
    text(x + barW / 2, CH_TOP + CH_H + 28, env.weekday(d.day), font(16), C.dim, barW + gap, "center");
  }

  text(PAD, CARD_H - 52, t("card.footnote"), font(15), C.dim, CARD_W - PAD * 2);
  return { width: CARD_W, height: CARD_H, ops };
}

/* ================= 3. 绘制 ================= */

/** 把清单画到 ctx 上。不做任何判断 —— 该画什么、画多宽，layoutCard 都已经决定了 */
export function paint(ctx, card) {
  for (const op of card.ops) {
    if (op.type === "rect") {
      ctx.beginPath();
      if (op.radius && typeof ctx.roundRect === "function") ctx.roundRect(op.x, op.y, op.w, op.h, Math.min(op.radius, op.w / 2, op.h / 2));
      else ctx.rect(op.x, op.y, op.w, op.h);
      ctx.fillStyle = op.fill;
      ctx.fill();
      if (op.stroke) {
        ctx.strokeStyle = op.stroke;
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    } else if (op.type === "text") {
      ctx.font = op.font;
      ctx.fillStyle = op.fill;
      ctx.textAlign = op.align;
      ctx.textBaseline = "alphabetic";
      ctx.fillText(op.text, op.x, op.y);
    }
  }
}

/** 建议的文件名：vibepaws-week-YYYY-MM-DD.png（周的最后一天）。只有数字和连字符，不带任何名字 */
export function cardFileName(model) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(model?.to ?? "")) ? model.to : "week";
  return `vibepaws-week-${day}.png`;
}
