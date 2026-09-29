/**
 * Vibepaws Den 的逻辑（U13）。「该画成什么样」在 ./health/den.js（纯函数、有单测），这里只把它变成节点。
 *
 * 数据全部来自 Core，经 UI server 的 /api/* 代理（token 由代理在服务端盖上）：
 *   /api/state                    —— 今天的聚合（health_today，与宠物、名牌同一个数）+ 分数可见性
 *   /api/session_health?days=7    —— Today 的段 + 周卡（U14）
 *   /api/journal?month=&project=  —— Journal 的行（不是文件本身：文件是给 grep 的，这里按 locale 出字）
 *   /api/growth                   —— 等级曲线、这周的 EXP 来源、下一次进化还差什么
 *
 * 为什么是 5 秒轮询而不是 SSE：Den 读的是**收工之后**的东西，秒级的实时毫无意义；而轮询天然
 * 扛得住 Core 重启 —— 每一轮都是一次独立的请求，Core 一回来下一轮就接上，不需要任何重连状态机。
 *
 * 连接的三种样子：
 *   连上        —— 一行灰字；
 *   从来没连上  —— 每一页画「在等 Core」（不是 first-run：连不上时说「还没有 session」是在撒谎）；
 *   连上过又断了 —— 内容照留、调淡，顶上说「这是几点的样子」。一扇挂着旧数据却不说的窗口也是在撒谎。
 */
import { t as translate, normalizeLocale } from "/i18n.js";
import { todayModel, journalModel, growthModel, signature, denShowsScores, localDay } from "./health/den.js";
import { PIP_CELLS, PIP_GAP_AFTER } from "./health/pips.js";
import { FACTOR_MAX } from "./health/rows.js";

const $ = (id) => document.getElementById(id);

/** locale 来源与宠物 / 设置窗口一致：主进程传的 ?locale= > 浏览器语言 */
const LOCALE = normalizeLocale(new URLSearchParams(location.search).get("locale") ?? navigator.language);
const t = (key, params) => translate(LOCALE, key, params);
document.documentElement.lang = LOCALE;

/** 壳桥（desktop/preload-den.cjs）；纯浏览器预览里为 null */
const shell = window.vibepaws ?? null;

const POLL_MS = 5000;
const TABS = ["today", "journal", "growth"];
const TAB_PREF = "vibepaws.den.tab";

/** 最近一次成功拿到的每一份数据（null = 从来没拿到过） */
const data = { state: null, history: null, journal: null, growth: null };
/** 最近一次整轮成功的时刻（「这是几点的样子」） */
let lastOkAt = null;
let online = null; // null = 还没试过
let activeTab = readTabPref();
const journalFilter = { month: "", project: "" };
/** 每一页上一次画的指纹：没变就一个节点都不动（下拉框、焦点、滚动位置不会每 5 秒丢一次） */
const drawn = { today: null, journal: null, growth: null, conn: null };

/* ---------------- 工具 ---------------- */
function readTabPref() {
  try {
    const v = localStorage.getItem(TAB_PREF);
    return TABS.includes(v) ? v : "today";
  } catch {
    return "today"; // 存储不可用（隐私模式、被禁）：每次从 Today 开始，照样能用
  }
}
function writeTabPref(tab) {
  try {
    localStorage.setItem(TAB_PREF, tab);
  } catch {
    /* 记不住就算了：这只是个便利 */
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

const clockFmt = new Intl.DateTimeFormat(LOCALE, { hour: "2-digit", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat(LOCALE, { month: "short", day: "numeric", weekday: "short" });
const monthFmt = new Intl.DateTimeFormat(LOCALE, { year: "numeric", month: "long" });

function clock(iso) {
  const d = new Date(iso ?? "");
  return Number.isFinite(d.getTime()) ? clockFmt.format(d) : t("ui.time.unknown");
}
function dayLabel(key) {
  const [y, m, d] = String(key).split("-").map(Number);
  const date = new Date(y, (m || 1) - 1, d || 1);
  return Number.isFinite(date.getTime()) ? dayFmt.format(date) : String(key);
}
function monthLabel(key) {
  const [y, m] = String(key).split("-").map(Number);
  const date = new Date(y, (m || 1) - 1, 1);
  return Number.isFinite(date.getTime()) ? monthFmt.format(date) : String(key);
}
/** 时长：与浮层同一套 ui.time.* 文案 */
function duration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return t("ui.time.unknown");
  const s = Math.round(ms / 1000);
  if (s < 60) return t("ui.time.seconds", { n: s });
  const m = Math.round(s / 60);
  if (m < 60) return t("ui.time.minutes", { n: m });
  return t("ui.time.hoursminutes", { h: Math.floor(m / 60), m: String(m % 60).padStart(2, "0") });
}
function fmtNum(v) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "0";
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/** pip 条（编码见 ui/health/pips.js）。strip = scoreStrip 的结果 */
function pips(strip, small = false) {
  const box = el("span", `pips band-${strip.band}${small ? " small" : ""}`);
  box.setAttribute("aria-hidden", "true");
  for (let i = 0; i < PIP_CELLS; i++) {
    const cell = el("span", `pip${strip.cells[i] ? " on" : ""}${i === PIP_GAP_AFTER ? " gap" : ""}`);
    box.appendChild(cell);
  }
  return box;
}

function emptyCard(title, body, extraClass = "") {
  const card = el("div", `card empty ${extraClass}`.trim());
  card.appendChild(el("h3", "", title));
  if (body) card.appendChild(el("p", "", body));
  return card;
}

function offlineCard() {
  return emptyCard(t("den.offline.title"), t("den.offline.body"), "offline");
}

function factorRows(factors) {
  const box = el("div", "factors");
  for (const f of factors) {
    const row = el("div", `f-row ${f.status}`);
    row.appendChild(el("span", "f-name", t(`ui.health.factor.${f.name}`)));
    const track = el("span", "f-track");
    if (f.status === "scored") {
      const fill = el("span", "f-fill");
      fill.style.width = `${Math.round(f.ratio * 100)}%`;
      track.appendChild(fill);
    }
    row.appendChild(track);
    row.appendChild(el("span", "f-pts", f.status === "scored" ? `${fmtNum(f.points)}/${FACTOR_MAX}` : t("den.factor.omitted")));
    box.appendChild(row);
  }
  return box;
}

/* ---------------- HTTP ---------------- */
/** 失败一律 null：502（Core 不在）、401、UI server 自己没了（fetch 抛）对这扇窗口是同一件事 */
async function getJson(path) {
  try {
    const r = await fetch(path, { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

function journalPath() {
  const q = new URLSearchParams();
  if (journalFilter.month) q.set("month", journalFilter.month);
  if (journalFilter.project) q.set("project", journalFilter.project);
  const s = q.toString();
  return `/api/journal${s ? `?${s}` : ""}`;
}

/**
 * 一轮刷新。先拿 state（它说明 Core 在不在、分数显示不显示），再只拿当前这一页要的 ——
 * 三页的数据各 5 秒拉一遍没有意义，切页的时候会立刻补一次。
 */
let refreshing = false;
let queued = false;
async function refresh() {
  if (refreshing) {
    queued = true;
    return;
  }
  refreshing = true;
  try {
    const state = await getJson("/api/state");
    let ok = state !== null;
    if (ok) data.state = state;
    if (ok) {
      const tab = activeTab;
      if (tab === "today") {
        const h = await getJson("/api/session_health?days=7");
        if (h) data.history = h;
        else ok = false;
      } else if (tab === "journal") {
        const j = await getJson(journalPath());
        if (j) data.journal = j;
        else ok = false;
      } else if (tab === "growth") {
        const g = await getJson("/api/growth");
        if (g) data.growth = g;
        else ok = false;
      }
    }
    online = ok;
    if (ok) lastOkAt = new Date();
    render();
  } finally {
    refreshing = false;
    if (queued) {
      queued = false;
      void refresh();
    }
  }
}

/* ---------------- 渲染 ---------------- */
function render() {
  renderConn();
  renderTabs();
  const showScores = denShowsScores(data.state?.health_visibility);
  $("hidden-note").hidden = !data.state || showScores || activeTab === "growth";
  if (activeTab === "today") renderToday();
  else if (activeTab === "journal") renderJournal(showScores);
  else renderGrowth();
}

function renderConn() {
  const stale = online === false && lastOkAt !== null;
  const text =
    online === null ? "" : online ? t("den.conn.ok") : stale ? t("den.conn.stale", { time: clock(lastOkAt.toISOString()) }) : t("den.conn.offline");
  const key = `${online}:${text}`;
  document.body.classList.toggle("stale", stale);
  if (drawn.conn === key) return;
  drawn.conn = key;
  const c = $("conn");
  c.textContent = text;
  c.className = online === false ? "offline" : "";
}

function renderTabs() {
  for (const tab of TABS) {
    const btn = $(`tab-${tab}`);
    const on = tab === activeTab;
    btn.setAttribute("aria-selected", String(on));
    btn.tabIndex = on ? 0 : -1;
    $(`panel-${tab}`).hidden = !on;
  }
}

/* ---- Today ---- */
function renderToday() {
  const model = todayModel({ state: data.state, history: data.history, now: new Date() });
  const key = signature(model);
  if (drawn.today === key) return;
  drawn.today = key;
  const root = $("today");
  root.replaceChildren();

  if (model.kind === "offline") {
    root.appendChild(offlineCard());
    return;
  }
  if (model.kind === "first-run") {
    root.appendChild(emptyCard(t("den.today.empty.title"), t("den.today.empty.body")));
    return;
  }

  if (model.showScores) {
    const head = el("div", "card");
    head.appendChild(el("h2", "", t("den.today.score")));
    const block = el("div", "score-block");
    if (model.strip) {
      const big = el("div", `score-big band-${model.strip.band}`, String(Math.floor(model.mean)));
      big.appendChild(el("small", "", "/100"));
      block.appendChild(big);
    } else {
      block.appendChild(el("div", "score-big dim", t("ui.time.unknown")));
    }
    const side = el("div", "score-side");
    if (model.strip) side.appendChild(pips(model.strip));
    side.appendChild(el("span", "", t("den.today.summary", { n: model.segments, time: duration(model.duration_ms) })));
    side.appendChild(el("span", "hint", t("den.today.mean.hint")));
    block.appendChild(side);
    head.appendChild(block);
    root.appendChild(head);

    const fcard = el("div", "card");
    fcard.appendChild(el("h2", "", t("den.today.factors")));
    fcard.appendChild(factorRows(model.factors));
    fcard.appendChild(el("p", "hint", t("den.today.factors.hint")));
    root.appendChild(fcard);
  }

  const list = el("div", "card");
  list.appendChild(el("h2", "", t("den.today.sessions")));
  if (!model.showScores) list.appendChild(el("p", "hint", t("den.today.summary", { n: model.segments, time: duration(model.duration_ms) })));
  const items = el("div", "list");
  for (const s of model.sessions) items.appendChild(sessionItem(s));
  list.appendChild(items);
  root.appendChild(list);
}

function sessionItem(s) {
  const item = el("div", "item");
  const title = el("div", "item-title", s.project);
  title.appendChild(el("span", "agent-badge", s.agent));
  item.appendChild(title);
  const score = el("div", "item-score");
  if (s.strip) {
    score.appendChild(pips(s.strip, true));
    score.appendChild(el("b", `band-${s.strip.band}`, String(Math.floor(s.score))));
  }
  item.appendChild(score);
  item.appendChild(
    el("div", "item-meta", t("den.session.when", { start: clock(s.started_at), end: clock(s.finished_at), duration: duration(s.duration_ms) })),
  );
  return item;
}

/* ---- Journal ---- */
function renderJournal(showScores) {
  const model = journalModel(data.journal, { showScores, project: journalFilter.project || null });
  renderJournalFilters(model);
  const key = signature(model);
  if (drawn.journal === key) return;
  drawn.journal = key;
  const root = $("journal");
  root.replaceChildren();
  const fileLine = $("journal-file");
  fileLine.textContent = model.file ? t("den.journal.file", { file: model.file }) : "";

  if (model.kind === "offline") {
    root.appendChild(offlineCard());
    return;
  }
  if (model.kind === "first-run") {
    root.appendChild(emptyCard(t("den.journal.empty.title"), t("den.journal.empty.body")));
    return;
  }
  if (model.kind === "empty") {
    const month = monthLabel(model.month);
    root.appendChild(
      emptyCard(model.project ? t("den.journal.empty.project", { project: model.project, month }) : t("den.journal.empty.month", { month }), null),
    );
    return;
  }
  const card = el("div", "card");
  const list = el("div", "list");
  let lastDay = null;
  for (const e of model.entries) {
    const day = localDay(e.at);
    if (day !== lastDay) {
      list.appendChild(el("div", "day-head", dayLabel(day)));
      lastDay = day;
    }
    list.appendChild(e.kind === "evolution" ? evolutionItem(e) : journalItem(e));
  }
  card.appendChild(list);
  root.appendChild(card);
}

function journalItem(e) {
  const item = el("div", "item");
  const title = el("div", "item-title", e.project);
  title.appendChild(el("span", "agent-badge", e.agent));
  item.appendChild(title);
  const score = el("div", "item-score");
  if (e.strip) {
    score.appendChild(pips(e.strip, true));
    score.appendChild(el("b", `band-${e.strip.band}`, String(Math.floor(e.score))));
  }
  item.appendChild(score);
  const parts = [t("den.session.when", { start: clock(e.started_at), end: clock(e.finished_at), duration: duration(e.duration_ms) })];
  if (e.segment !== null && e.segment > 1) parts.push(t("den.session.segment", { n: e.segment }));
  if (e.outcome && ["success", "partial", "abandoned"].includes(e.outcome)) parts.push(t(`ui.health.outcome.${e.outcome}`));
  item.appendChild(el("div", "item-meta", parts.join(" · ")));
  if (e.factors.length > 0) {
    const f = e.factors.map((x) => `${t(`ui.health.factor.${x.name}`)} ${x.status === "scored" ? fmtNum(x.points) : "–"}`).join(" · ");
    item.appendChild(el("div", "item-meta", f));
  }
  if (e.omitted.length > 0) {
    item.appendChild(el("div", "item-meta", t("den.journal.omitted", { factors: e.omitted.map((f) => t(`ui.health.factor.${f}`)).join(", ") })));
  }
  if (e.files.length > 0) {
    const files = e.files.join(", ");
    const text = e.files_more > 0 ? t("den.journal.filesMore", { files, n: e.files_more }) : files;
    item.appendChild(el("div", "item-meta", t("den.journal.files", { files: text })));
  }
  return item;
}

function evolutionItem(e) {
  const item = el("div", "item evolution");
  item.appendChild(el("div", "item-title", t("den.journal.evolution", { from: e.from, to: e.to, level: e.level })));
  item.appendChild(el("div", "item-score dim", clock(e.at)));
  if (e.health !== null) item.appendChild(el("div", "item-meta", t("den.journal.evolution.health", { health: e.health })));
  return item;
}

/** 两个下拉框：选项变了才重建，而且保住当前的选择 —— 否则用户正在点的那一个每 5 秒被收起一次 */
let filterKey = null;
function renderJournalFilters(model) {
  const months = model.months ?? [];
  const current = model.month || journalFilter.month;
  const monthOpts = [...new Set([current, ...months].filter(Boolean))].sort().reverse();
  const projects = model.projects ?? [];
  const projectOpts = [...new Set([...(journalFilter.project ? [journalFilter.project] : []), ...projects])].sort();
  const key = JSON.stringify([monthOpts, projectOpts, current, journalFilter.project, LOCALE]);
  const disabled = model.kind === "offline" || model.kind === "first-run";
  $("journal-month").disabled = disabled;
  $("journal-project").disabled = disabled;
  if (filterKey === key) return;
  filterKey = key;

  const mSel = $("journal-month");
  mSel.replaceChildren(...monthOpts.map((m) => new Option(monthLabel(m), m)));
  mSel.value = current;
  const pSel = $("journal-project");
  pSel.replaceChildren(new Option(t("den.journal.allProjects"), ""), ...projectOpts.map((p) => new Option(p, p)));
  pSel.value = journalFilter.project;
}

/* ---- Growth ---- */
function renderGrowth() {
  const model = growthModel(data.growth);
  const key = signature(model);
  if (drawn.growth === key) return;
  drawn.growth = key;
  const root = $("growth");
  root.replaceChildren();
  if (model.kind === "offline") {
    root.appendChild(offlineCard());
    return;
  }
  const p = model.pet;

  // 等级与这一级的进度
  const lvl = el("div", "card");
  const line = el("div", "level-line");
  line.appendChild(el("b", "", p.name));
  if (p.species && p.species !== p.name) line.appendChild(el("span", "dim", p.species));
  line.appendChild(el("span", "", t("den.growth.level", { level: p.level, exp: fmtNum(p.exp), next: p.next })));
  lvl.appendChild(line);
  const bar = el("div", "progress");
  const fill = el("span");
  fill.style.width = `${Math.round(p.progress * 100)}%`;
  bar.appendChild(fill);
  lvl.appendChild(bar);
  lvl.appendChild(el("p", "hint", t("den.growth.toNext", { n: fmtNum(p.toNext), level: p.level + 1 })));
  root.appendChild(lvl);

  // 等级曲线
  const curveCard = el("div", "card");
  curveCard.appendChild(el("h2", "", t("den.growth.curve")));
  const curve = el("div", "curve");
  curve.setAttribute("role", "img");
  curve.setAttribute(
    "aria-label",
    t("den.growth.curve.aria", { last: model.curve.at(-1)?.level ?? p.level, name: p.name, level: p.level, exp: fmtNum(p.exp), next: p.next }),
  );
  for (const c of model.curve) {
    const col = el("div", "bar-col");
    col.title = t("den.growth.curve.bar", { level: c.level, next: c.level + 1, required: c.required });
    const b = el("div", `bar ${c.status}`);
    // 85%：柱子下面还要放一行等级标签，最高那根顶满的话会把标签挤出曲线框
    b.style.height = `${Math.max(4, Math.round(c.height * 85))}%`;
    const f = el("span");
    f.style.height = `${Math.round(c.fill * 100)}%`;
    b.appendChild(f);
    col.appendChild(b);
    col.appendChild(el("div", `bar-label${c.status === "current" ? " current" : ""}`, String(c.level)));
    curve.appendChild(col);
  }
  curveCard.appendChild(curve);
  curveCard.appendChild(el("p", "hint", t("den.growth.curve.hint")));
  root.appendChild(curveCard);

  // 这周的 EXP 从哪来
  const week = el("div", "card");
  week.appendChild(el("h2", "", t("den.growth.week")));
  if (model.week.empty) {
    week.appendChild(el("p", "dim", t("den.growth.week.empty")));
  } else {
    week.appendChild(el("div", "", t("den.growth.week.total", { total: fmtNum(model.week.total) })));
    const stack = el("div", "stack");
    stack.setAttribute("aria-hidden", "true");
    for (const s of model.week.sources) {
      if (s.share <= 0) continue;
      const seg = el("span", `src-${s.key}`);
      seg.style.width = `${(s.share * 100).toFixed(2)}%`;
      stack.appendChild(seg);
    }
    week.appendChild(stack);
    const legend = el("div", "legend");
    for (const s of model.week.sources) {
      const item = el("div", "legend-item");
      item.appendChild(el("span", `swatch src-${s.key}`));
      item.appendChild(el("span", "", t(`ui.exp.cat.${s.key}`)));
      item.appendChild(el("span", "amt", `${fmtNum(s.amount)} · ${Math.round(s.share * 100)}%`));
      legend.appendChild(item);
    }
    week.appendChild(legend);
    const days = el("div", "week-bars");
    for (const d of model.week.daily) {
      const col = el("div", "bar-col");
      col.title = t("den.growth.week.day", { day: dayLabel(d.day), total: fmtNum(d.total) });
      const b = el("div", "bar");
      b.style.height = "85%";
      const f = el("span");
      f.style.height = `${Math.round(d.height * 100)}%`;
      b.appendChild(f);
      col.appendChild(b);
      col.appendChild(el("div", "bar-label", dayLabel(d.day).split(/[\s,]+/)[0] ?? ""));
      days.appendChild(col);
    }
    week.appendChild(days);
  }
  week.appendChild(el("p", "hint", t("den.growth.week.note")));
  root.appendChild(week);

  // 下一次进化
  root.appendChild(evolutionCard(model.evolution, p));

  // 升级记录
  const hist = el("div", "card");
  hist.appendChild(el("h2", "", t("den.growth.history")));
  if (model.levelUps.length === 0) {
    hist.appendChild(el("p", "dim", t("den.growth.history.empty", { n: fmtNum(p.toNext), level: p.level + 1 })));
  } else {
    const list = el("div", "list");
    for (const u of model.levelUps) {
      const item = el("div", "item");
      item.appendChild(el("div", "item-title", t("den.growth.history.item", { level: u.level })));
      item.appendChild(el("div", "item-score dim", `${dayLabel(localDay(u.at))} ${clock(u.at)}`));
      list.appendChild(item);
    }
    hist.appendChild(list);
  }
  root.appendChild(hist);
}

function evolutionCard(evo, pet) {
  const card = el("div", "card");
  card.appendChild(el("h2", "", t("den.growth.evo")));
  if (!evo || evo.state === "final") {
    card.appendChild(el("p", "", t("den.growth.evo.final", { name: pet.species ?? pet.name })));
    return card;
  }
  const to = evo.to_form ?? `#${evo.to_type_id}`;
  card.appendChild(el("h3", "", t("den.growth.evo.target", { to, from: evo.from_level })));
  const conds = el("div", "conds");
  const levelMet = evo.level >= evo.from_level;
  conds.appendChild(cond(levelMet, t("den.growth.cond.level", { need: evo.from_level, have: evo.level })));
  const gate = Math.round((evo.health_gate ?? 0.7) * 100);
  const health = typeof evo.health === "number" ? evo.health : null;
  const healthMet = health === null || health >= (evo.health_gate ?? 0.7);
  conds.appendChild(
    cond(
      healthMet,
      t("den.growth.cond.health", { need: gate, have: health === null ? t("den.growth.cond.health.unknown") : `${Math.round(health * 100)}%` }),
    ),
  );
  card.appendChild(conds);
  const when =
    evo.state === "level"
      ? t("den.growth.evo.level", { n: Math.max(1, evo.from_level - evo.level) })
      : evo.state === "health"
        ? t("den.growth.evo.health")
        : t("den.growth.evo.ready");
  card.appendChild(el("p", "hint", when));
  return card;
}

function cond(met, text) {
  const row = el("div", `cond ${met ? "met" : "unmet"}`);
  row.appendChild(el("span", "mark", met ? "✓" : "✗"));
  row.appendChild(el("span", "", text));
  row.appendChild(el("span", "state", t(met ? "den.growth.cond.met" : "den.growth.cond.unmet")));
  return row;
}

/* ---------------- 交互 ---------------- */
function selectTab(tab, focus = false) {
  if (!TABS.includes(tab)) return;
  activeTab = tab;
  writeTabPref(tab);
  render(); // 先把已有的数据画出来（或「在等 Core」），再去拿新的
  if (focus) $(`tab-${tab}`).focus();
  void refresh();
}

for (const tab of TABS) {
  $(`tab-${tab}`).addEventListener("click", () => selectTab(tab));
}
// 标签页的键盘约定：左右方向键在标签之间走，Home / End 到头尾
$("tabs").addEventListener("keydown", (e) => {
  const i = TABS.indexOf(activeTab);
  let next = null;
  if (e.key === "ArrowRight") next = TABS[(i + 1) % TABS.length];
  else if (e.key === "ArrowLeft") next = TABS[(i - 1 + TABS.length) % TABS.length];
  else if (e.key === "Home") next = TABS[0];
  else if (e.key === "End") next = TABS[TABS.length - 1];
  if (next) {
    e.preventDefault();
    selectTab(next, true);
  }
});

$("journal-month").addEventListener("change", () => {
  journalFilter.month = $("journal-month").value;
  // 换了月份，项目列表跟着那个月走；原来选的项目那个月可能没有
  // 旧月份的行留到新的一到再换：清空的话中间会闪一下「在等 Core」
  journalFilter.project = "";
  drawn.journal = null;
  void refresh();
});
$("journal-project").addEventListener("change", () => {
  journalFilter.project = $("journal-project").value;
  drawn.journal = null;
  void refresh();
});

$("open-settings").addEventListener("click", () => {
  if (shell?.openSettings) shell.openSettings();
  else window.open(`/settings.html?locale=${encodeURIComponent(LOCALE)}`, "_blank", "noopener");
});

function applyStaticI18n() {
  for (const node of document.querySelectorAll("[data-i18n]")) node.textContent = t(node.dataset.i18n);
  document.title = t("den.title");
}

applyStaticI18n();
render();
void refresh();
setInterval(() => void refresh(), POLL_MS);
