/**
 * Vibepaws UI 应用逻辑 — 壳零业务逻辑：状态/气泡/浮层数据全部来自 Core（SSE）。
 * 文案全部走 i18n（issue #3 / #6）：不在本文件里写死任何一句人类可读文本。
 */
import { drawPet } from "./pets/render.js";
import * as petRegistry from "./pets/registry.js";
import { BLEND_MS, MOTION, motionAt } from "./pets/motion.js";
import {
  stickyBubbleStale, bubbleKey, isActionable, collapseTarget, sortBubbles, layoutBubbles, pickEvictions,
  bubbleFactor, bubbleActions, actionsLabel, MAX_STUBS, DWELL_MS,
  guardFocus, guardTop, guardContent, guardResnap, decideKey, decideClick, coachingThresholdLabel,
} from "./health/bubbles.js";
import { PIP_CELLS, PIP_GAP_AFTER, nameplateStrip, healthSurfaces } from "./health/pips.js";
import {
  FACTOR_MAX, rowHealth, sortSessions, panelSignature, factorBreakdown, weakestFactor, rowKey,
} from "./health/rows.js";
// 与 Core 共用的文案目录，由 UI server 的 /i18n.js 路由提供（src/i18n/messages.js）
import { t as translate, normalizeLocale } from "/i18n.js";

const $ = (id) => document.getElementById(id);

/* ---------------- i18n ---------------- */
// locale 来源：Electron 主进程传的 ?locale=（来自 app.getLocale()）> 浏览器语言。
// 两者都归一化成 en / zh-CN，保证壳与渲染层永远同一种语言。
const LOCALE = normalizeLocale(
  new URLSearchParams(location.search).get("locale") ?? navigator.language,
);
const t = (key, params) => translate(LOCALE, key, params);
document.documentElement.lang = LOCALE;

/** 填充 HTML 里的 data-i18n / data-i18n-title / data-i18n-aria 占位 */
function applyStaticI18n() {
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll("[data-i18n-title]")) el.title = t(el.dataset.i18nTitle);
  for (const el of document.querySelectorAll("[data-i18n-aria]")) {
    el.setAttribute("aria-label", t(el.dataset.i18nAria));
  }
}

/**
 * 只给调试用的状态覆写：?petstate=warning 之类。状态里有几个（tired / level-up）
 * 靠模拟器很难稳定复现，改一次动作就得等半天 —— 视觉验收需要能直接点到。
 * 值不在配方表里就当没写，绝不让一个拼错的参数把宠物卡在空状态。
 */
const PET_STATE_OVERRIDE = (() => {
  const v = new URLSearchParams(location.search).get("petstate");
  return v && Object.hasOwn(MOTION, v) ? v : null;
})();

/** 壳（Electron preload 暴露的桥）；纯浏览器里为 null */
const shell = window.vibepaws ?? null;
/**
 * 这扇窗口能不能发起「永远允许」（U9）：只有壳的 preload 有这条 IPC。浏览器预览里没有，
 * 那个选项也就根本不出现 —— 授予不能经 UI server 走（KTD13，见 desktop/grant.js）。
 */
const ACTION_CTX = Object.freeze({ canGrant: typeof shell?.grantAlways === "function" });

const POLL_MS = 5000;
const POLL_TIMEOUT_MS = 4000;
const BUBBLE_TTL_MS = 8000;
/** 同时在屏幕上的气泡上限：一条展开 + 三条单行。常驻的不受它限制（R16，见 pickEvictions） */
const MAX_BUBBLES = 1 + MAX_STUBS;
/** 「等你」类通知不自动消失：错过它就等于错过了这个产品唯一必须做对的提醒 */
const STICKY_TYPES = new Set(["decision", "permission"]);

const state = {
  pet: null,
  sessions: [],
  /** 已接入的 adapter。null = 还不知道（老 Core 不推这个字段，不能据此说「没装」）；
   * [] = Core 明确说一个都没有，也就是 hooks 没装上。 */
  adapters: null,
  mute: { global_until: null, global_minutes: null },
  /** 今天的 Session Health 聚合（PetStatePush.health_today）。null = 老 Core 不发 */
  healthToday: null,
  /** 分数显示在哪（R30）：off / flyout / everywhere。老 Core 不发时按默认 flyout */
  healthVisibility: "flyout",
  /** 事件流是否活着 —— 气泡只从这条流来，它断了就等于提醒功能死了 */
  streamOk: null,
  /** 5s 轮询是否活着 —— 只能证明 session 列表新鲜，证明不了气泡还会来 */
  pollOk: null,
  panelOpen: false,
};

/* ---------------- Core 连接 ---------------- */
let stream = null;
let reconnectTimer = null;
let reconnectDelay = 1000;

function connectCore() {
  openStream();
  pollState(); // 立刻拉一次：别让界面空等 5 秒
  setInterval(pollState, POLL_MS);
  setInterval(renderMute, 10_000); // 静音剩余时间自己走表
}

function openStream() {
  closeStream();
  const es = new EventSource("/api/sse");
  stream = es;
  es.onopen = () => {
    // 只重置退避，**不**点绿灯：代理为了让浏览器能自动重连，会先回 200 +
    // text/event-stream，再根据上游情况发 core_offline —— 照 onopen 点绿的话，
    // Core 不在时指示灯会绿红交替闪。真正的绿灯由第一条 pet_state 决定。
    reconnectDelay = 1000;
  };
  es.addEventListener("pet_state", (e) => {
    const push = parseJson(e.data);
    if (!push) return;
    setStream(true);
    applyPush(push);
  });
  es.addEventListener("notification", (e) => {
    const n = parseJson(e.data);
    if (n && !n.skip) pushBubble(n);
  });
  // Core 说这条气泡结束了（回收 / agent 自己往下走了 / 别的客户端叉掉了）→ 按 id 撤
  es.addEventListener("notification_resolved", (e) => {
    const r = parseJson(e.data);
    if (r && Number.isInteger(r.id)) removeBubbleById(r.id);
  });
  // UI server 明确告知「连上了代理但 Core 不在」（见 src/ui/server.ts 的 proxySse）
  es.addEventListener("core_offline", () => setStream(false));
  es.onerror = () => {
    setStream(false);
    // EventSource 只在「已建立后断开」时自己重连；CLOSED 说明它放弃了，
    // 必须由我们重开 —— 否则 Core 晚启动 / 重启一次，气泡就再也不来了。
    if (es.readyState === EventSource.CLOSED) scheduleReconnect();
  };
}

function closeStream() {
  if (stream) {
    stream.onerror = null;
    stream.close();
  }
  stream = null;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    openStream();
  }, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, 15_000); // 退避，但永不放弃
}

async function pollState() {
  try {
    // 超时必须有：Core 卡死（接了连接不回话）时没有超时的 fetch 永远不 settle，
    // pollOk 停在上一次的值 —— 指示灯就一直停在绿的，而气泡早就不来了。
    const r = await fetch("/api/state", { cache: "no-store", signal: AbortSignal.timeout(POLL_TIMEOUT_MS) });
    if (!r.ok) throw new Error(String(r.status));
    applyPush(await r.json());
    setPoll(true);
  } catch {
    setPoll(false);
  }
}

function applyPush(push) {
  if (!push || typeof push !== "object") return;
  state.pet = push.pet ?? state.pet;
  state.sessions = Array.isArray(push.sessions) ? push.sessions : [];
  if (Array.isArray(push.adapters)) state.adapters = push.adapters;
  state.mute = push.mute ?? { global_until: null, global_minutes: null };
  state.healthToday = push.health_today ?? null;
  state.healthVisibility = push.health_visibility ?? "flyout";
  render();
  // 顺带重画气泡：可见性变了，因子点名要跟着出现 / 消失
  reconcileStickyBubbles();
}

function parseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function setStream(ok) {
  if (state.streamOk === ok) return;
  state.streamOk = ok;
  renderConn();
  renderPanel(); // 「还没有 session」与「连不上 Core」是两句完全不同的话
}

function setPoll(ok) {
  if (state.pollOk === ok) return;
  state.pollOk = ok;
  renderConn();
  renderPanel();
}

/** Core 是否可达（任一通道通即可） */
function coreReachable() {
  return state.streamOk === true || state.pollOk === true;
}

/**
 * 连接状态四选一：unknown（还没连上过）/ ok / degraded / off。
 * 指示灯与名牌上的 pip 条读同一份 —— 名牌是余光里看的，不能指望用户同时去看右上角那个点。
 */
function connState() {
  if (state.streamOk === null && state.pollOk === null) return "unknown";
  if (state.streamOk) return "ok";
  // 半死：状态还在刷新，但气泡（只走 SSE）已经不会来了 —— 必须说出来
  if (state.pollOk) return "degraded";
  return "off";
}

const CONN_TITLES = { unknown: "ui.conn.title", ok: "ui.conn.ok", degraded: "ui.conn.degraded", off: "ui.conn.off" };

function renderConn() {
  const el = $("conn");
  const conn = connState();
  el.className = `conn-${conn}`;
  el.title = t(CONN_TITLES[conn]);
  // 连不上时 pip 条要当场变成「不知道」，而不是挂着断线前的最后一个分数
  renderNameplate();
}

/* ---------------- 渲染 ---------------- */
/**
 * 数据渲染与动画循环彻底分开。
 * 原来 render() 里调 renderPetFrame()，而后者自己 requestAnimationFrame 续帧 ——
 * 于是每来一次 pet_state、每跑一次 5 秒轮询，就多出一条永不结束的动画循环：
 * 跑一小时后是几百条循环在同一个 canvas 上叠着重绘，风扇直接起飞。
 * 现在整个进程里只有一条循环，由 startPetLoop() 保证唯一。
 */
function render() {
  renderExpBar();
  renderNameplate();
  renderMute();
  renderPanel();
}

/**
 * 减弱动态效果（R27）。系统里开了「减弱动态效果」时，宠物不再持续上下起伏：
 * 每个状态都停在它的中立姿态（相位 0 那一帧 —— 也就是一次性动作放完后停住的那一帧），
 * 状态切换不插值、直接换；叠加特效同样停在相位 0。状态本身照样看得出来 ——
 * 立绘、染色、特效的形状都还在，只是不动。
 * 一次性动作（finished / level-up）仍按真实时长计时，放够时长就照常回落，不会被钉在庆祝帧上。
 * 画面不动就不必每帧重画：只在画面该变的时候（状态 / 宠物 / 分身数）和每秒一次兜底时画。
 */
const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
/** 减弱动态下上一帧画的是什么；null = 下一帧必须画 */
let stillKey = null;
let stillDrawnAt = 0;
reducedMotion?.addEventListener?.("change", () => {
  stillKey = null;
});

let frameHandle = null;
function startPetLoop() {
  if (frameHandle !== null) return;
  const step = (now) => {
    drawPetFrame(now);
    frameHandle = requestAnimationFrame(step);
  };
  frameHandle = requestAnimationFrame(step);
}

function stopPetLoop() {
  if (frameHandle !== null) cancelAnimationFrame(frameHandle);
  frameHandle = null;
}

/** 放一遍就该停的动作。Core 会把 finished 推 60s、level-up 推 5s，但庆祝不该一直放。 */
const ONE_SHOT = new Set(["finished", "level-up"]);

/** 当前动作：state 从哪一刻开始（用于相位与一次性动作计时） */
let cur = { state: "idle", since: 0, done: false };
/** 上一个动作，只在插值窗口内存在 */
let prevAnim = null;
let blendStart = 0;
/** 已经放完的一次性动作：Core 还在推同一个状态，但不该再放一遍 */
let consumed = null;

/**
 * 现在整张桌面上同时在跑几个 subagent（轨道上画几颗小方块）。
 *
 * 跟 Core 的聚合口径一致，是**总数**而不是「有几个 session 在派活」：两个 session
 * 各派 1 个，跑着的就是 2 个（core/registry.ts 的 aggregatePetState，clawd #862）。
 * 只数 delegating / juggling 的 session —— 已经 idle 的那些哪怕计数没收回来也不算，
 * 免得一个漏收的 stop 在宠物身上留下一颗永远转圈的方块。
 *
 * `?petstate=` 调试覆写时桌面上通常一个 session 都没有，按覆写的档位补一个代表值
 * （delegating 1 颗 / juggling 3 颗），否则这两个状态点进去轨道是空的、没法验收。
 */
function liveSubagents() {
  let n = 0;
  for (const s of state.sessions) {
    if (!s.is_active) continue;
    if (s.state === "delegating" || s.state === "juggling") n += s.subagent_count ?? 0;
  }
  if (n === 0 && PET_STATE_OVERRIDE) return PET_STATE_OVERRIDE === "juggling" ? 3 : 1;
  return n;
}

function petStateNow() {
  const raw = PET_STATE_OVERRIDE ?? state.pet?.state ?? "idle";
  if (ONE_SHOT.has(raw)) {
    if (consumed === raw) return "idle"; // 放完了，安静下来
  } else {
    consumed = null; // 离开了一次性状态，下次再进来可以重放
  }
  return raw;
}

function drawPetFrame(now) {
  // 还没收到任何状态：清空而不是先画一只**别的**宠物。pollState() 是立刻发的，
  // 这段空白只有几毫秒，而画错宠物再换过来是看得见的。
  const petTypeId = state.pet?.pet_type_id;
  if (petTypeId == null) {
    const c = $("pet");
    const ctx = c.getContext("2d");
    // 先复位：drawPet 留下的是一个 dpr 变换，照着它按设备像素清会算错范围
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, c.width, c.height);
    stillKey = null;
    return;
  }

  const want = petStateNow();
  if (want !== cur.state) {
    prevAnim = { state: cur.state, since: cur.since };
    blendStart = now;
    cur = { state: want, since: now, done: false };
  }
  if (reducedMotion?.matches) {
    drawStillFrame(now, petTypeId);
    return;
  }
  stillKey = null;
  const blend = prevAnim ? Math.min(1, (now - blendStart) / BLEND_MS) : 1;

  const { done } = drawPet($("pet"), petTypeId, {
    state: cur.state,
    elapsed: now - cur.since,
    prev: prevAnim ? { state: prevAnim.state, elapsed: now - prevAnim.since } : null,
    blend,
    subagents: liveSubagents(),
  });

  if (blend >= 1) prevAnim = null;
  if (done && !cur.done) {
    cur.done = true;
    if (ONE_SHOT.has(cur.state)) consumed = cur.state;
  }
}

/** 减弱动态下的一帧：中立姿态、不插值；只在画面该变时重画 */
function drawStillFrame(now, petTypeId) {
  prevAnim = null;
  const subagents = liveSubagents();
  const key = `${petTypeId}:${cur.state}:${subagents}`;
  if (key !== stillKey || now - stillDrawnAt > 1000) {
    drawPet($("pet"), petTypeId, { state: cur.state, elapsed: 0, prev: null, blend: 1, subagents });
    stillKey = key;
    stillDrawnAt = now;
  }
  // done 与画面无关，只看时长：精灵高度不影响它，传什么都一样
  if (!cur.done && motionAt(cur.state, now - cur.since, 0).done) {
    cur.done = true;
    if (ONE_SHOT.has(cur.state)) consumed = cur.state;
  }
}

// 窗口被藏起来（托盘开关）时别继续烧 CPU —— backgroundThrottling 是关掉的，
// 没有这一步动画会在看不见的地方一直跑。
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopPetLoop();
  else startPetLoop();
});

function renderExpBar() {
  const p = state.pet;
  if (!p) return;
  const level = Number.isFinite(p.level) ? p.level : 1;
  const exp = Number.isFinite(p.exp) ? p.exp : 0;
  const need = Number.isFinite(p.next_level_exp) && p.next_level_exp > 0 ? p.next_level_exp : null;
  // 分母缺失/为 0 时不要算出 NaN%：宽度会被浏览器忽略（进度条卡住），
  // 文字则会变成 "37/undefined"（issue: EXP 条显示 37.01/undefined 的同一类问题）。
  const pct = need ? Math.max(0, Math.min(100, (exp / need) * 100)) : 0;
  $("expfill").style.width = pct + "%";
  $("exptext").textContent = need ? `Lv.${level} ${exp}/${need}` : `Lv.${level} ${exp}`;
}

/**
 * 名牌 = 宠物名 + （可见性为 everywhere 时）今天的 pip 条（R12 / R30）。
 * 读的是今天的聚合 health_today.mean，和宠物 health_score 是同一个数的两种读法 ——
 * 活着的 session 的临时分只在浮层里出现，名牌上不画一个还会变的数。
 * 条的宽度是固定的（见 style.css 的 #pips），名字过长时名字省略，名牌永远不宽过 EXP 条。
 */
function renderNameplate() {
  const name = state.pet?.name ?? "…";
  $("pet-name").textContent = name;
  const pips = $("pips");
  const show = healthSurfaces(state.healthVisibility).nameplate;
  pips.hidden = !show;
  if (!show) {
    $("nameplate").title = name;
    return;
  }
  const strip = nameplateStrip(state.healthToday, connState());
  if (pips.children.length !== PIP_CELLS) buildPipCells(pips, "pip");
  // kind / band 都来自 pips.js 的有限几个值，可以直接拼进 class
  pips.className = `pips ${strip.kind}${strip.band ? ` band-${strip.band}` : ""}`;
  strip.cells.forEach((on, i) => pips.children[i].classList.toggle("on", on));
  const label =
    strip.kind === "score" ? t("ui.health.today", { score: Math.floor(strip.score) })
    : strip.kind === "empty" ? t("ui.health.today.empty")
    : t("ui.health.today.offline");
  pips.setAttribute("aria-label", label);
  $("nameplate").title = `${name} · ${label}`;
}

/** 十个格子，第七格之后那一格带 gap class（宽缝画在它左边） */
function buildPipCells(box, cls) {
  box.replaceChildren();
  for (let i = 0; i < PIP_CELLS; i++) {
    const cell = document.createElement("span");
    cell.className = i === PIP_GAP_AFTER ? `${cls} gap` : cls;
    box.appendChild(cell);
  }
}

/* ---------------- 静音状态（issue #7） ---------------- */
function muteRemainingMs() {
  const until = Number(state.mute?.global_until ?? 0);
  if (!Number.isFinite(until) || until <= 0) return 0;
  return Math.max(0, until - Date.now());
}

/** 两个静音按钮：时长 → 元素 id / 文案 key */
const MUTE_BUTTONS = [
  { minutes: 30, id: "act-mute", label: "ui.btn.mute30", title: "ui.action.mute30" },
  { minutes: 120, id: "act-mute2h", label: "ui.btn.mute2h", title: "ui.action.mute2h" },
];

/**
 * 哪个按钮是「开着的」。以 Core 记下的时长为准；老数据没这个字段时按剩余时间猜
 * （只在 2 小时静音的最后半小时会猜错，且下一次静音就会自愈）。
 */
function activeMuteMinutes(remaining) {
  if (remaining <= 0) return null;
  const chosen = Number(state.mute?.global_minutes ?? 0);
  if (MUTE_BUTTONS.some((b) => b.minutes === chosen)) return chosen;
  return remaining > 30 * 60_000 ? 120 : 30;
}

/**
 * 静音是一个「选中了哪个时长」的状态，所以按钮就是单选组：选中的那个高亮，
 * 再点一次取消；另一个保持常态（点它就换成那个时长）。
 *
 * 两个职责分开，这一点很要紧：
 *   · 按钮标签 = 你选的时长，永远不变（点了 2h 就一直写着 2h）；
 *   · 剩余时间只出现在宠物脚边的徽章和 tooltip 里。
 * 把倒计时塞进标签里的话，它必然与你刚选的时长矛盾 —— 点完「2h」立刻变成「1h」，
 * 看上去就是个 bug。而「🔔 On」那种写法更糟：既能读成「静音开着」，
 * 也能读成「点它把通知打开」。
 */
function renderMute() {
  const remaining = muteRemainingMs();
  const muted = remaining > 0;
  const activeMinutes = activeMuteMinutes(remaining);
  const time = fmtDuration(remaining);

  const badge = $("mute-badge");
  badge.hidden = !muted;
  if (muted) {
    badge.textContent = t("ui.badge.muted", { time });
    badge.title = t("ui.mute.remaining", { time });
  }

  for (const btn of MUTE_BUTTONS) {
    const el = $(btn.id);
    const on = btn.minutes === activeMinutes;
    el.classList.toggle("active", on);
    el.setAttribute("aria-pressed", String(on));
    el.textContent = t(btn.label);
    el.title = on ? t("ui.action.unmute", { time }) : t(btn.title);
  }
}

/* ---------------- 气泡 ---------------- */
/** Core 只发文案 key + 参数（英文 title/body 仅作兜底），语言在这里决定 */
function notifText(n, slot) {
  const spec = n.i18n?.[slot];
  return spec ? t(spec.key, spec.params) : (n[slot] ?? "");
}

/**
 * 屏幕上的气泡：一份记录数组，DOM 只是它的画法（排版 / 键 / 淘汰的判定都在 ui/health/bubbles.js）。
 * 每条记录：
 *   uid      本地唯一标识（快照比的就是它；老 Core 不发 id 也照样能指认）
 *   seq      到达序号 —— 同一 tick 到的两条靠它定序，顶上那条不会在按键时换人
 *   ids      这条气泡代表过的通知行 id（辅导类原地合并时会攒好几个）；id = 最新那个
 */
const bubbles = [];
let bubbleSeq = 0;
/** 停留护栏 + 快照（见 ui/health/bubbles.js 的 decideKey）；null = 宠物窗口没有键盘焦点 */
let guard = null;
let dwellTimer = null;

/** 动作 id → 处理函数。U9 / U10 往 ACTION_SPECS 里加一项的同时，在这里加它的处理 */
const BUBBLE_ACTIONS = {
  dismiss(b) {
    resolveBubble(b, "dismiss");
    removeBubble(b);
  },
  /**
   * 永远允许（U9）。只把行 id 交给壳；壳带着它自己的 grant secret 去问 Core，Core 从库里推规则。
   * 成功后 Core 会把这条记成 user_actioned 并推 notification_resolved —— 这里先撤掉，
   * 并说清楚「以后不再问，但眼前这一个还得在终端里答」（还没有回传通道，U11）。
   */
  async always_allow(b) {
    if (!ACTION_CTX.canGrant || b.id === null) return;
    const r = await shell.grantAlways(b.id).catch(() => null);
    if (!r?.ok) {
      flash(t("ui.toast.grantfailed"), { error: true });
      return;
    }
    removeBubble(b);
    flash(t("ui.toast.granted", { rule: r.rule ?? b.n.grant?.rule ?? "", project: r.project ?? b.n.grant?.project ?? "" }));
  },
  /**
   * 没用（U10）。把这条气泡代表过的**每一行**都交上去（辅导类原地合并时 b.ids 攒了好几个），
   * id 是用户正看着的最新那行 —— Core 按它挪阈值。说出调成了什么：一个悄悄变安静的警告
   * 和一个坏掉的警告，从外面看不出区别。
   */
  async not_useful(b) {
    if (b.id === null) return;
    removeBubble(b);
    const res = await postAction("not_useful", { id: b.id, ids: b.ids });
    if (!res) {
      flash(t("ui.toast.actionfailed"), { error: true });
      return;
    }
    const tuning = res.tuning;
    if (!tuning) flash(t("ui.toast.noted"));
    else {
      const rule = t(`settings.coaching.rule.${tuning.rule}`);
      flash(tuning.changed
        ? t("ui.toast.tuned", { rule, threshold: coachingThresholdLabel(tuning.rule, tuning.after, t) })
        : t("ui.toast.quietest", { rule }));
    }
  },
};

function pushBubble(n) {
  const now = performance.now();
  // 聚合（只对辅导类）：同类同 session 已存在则更新文字并重新计时
  const existing = collapseTarget(bubbles, n);
  if (existing) {
    const changed = notifText(n, "title") !== notifText(existing.n, "title")
      || notifText(n, "body") !== notifText(existing.n, "body");
    existing.n = n;
    // 指向最新那一行：叉掉时标记的应当是用户正看着的这条文字。
    // 之前攒下的老 id 留在 ids 里 —— 叉掉只标记最新一条，老的几行照旧由 Core 自己收尾
    if (Number.isInteger(n.id)) {
      existing.id = n.id;
      existing.ids.push(n.id);
    }
    fillBubble(existing);
    // 重新计时：不重置的话，一条不断刷新的通知会在**第一次**出现后 8 秒消失，
    // 用户看到的是「刚更新完就没了」。
    armDismiss(existing);
    // 正文变了 = 用户读过的那句话已经不在了：停留护栏重新上膛（72% → 95%）
    if (changed) {
      guard = guardContent(guard, existing.uid, now);
      // 点击的停留护栏同理：正文刚换，按钮下面那句话用户还没读过
      existing.topSince = now;
      announce(existing);
    }
    renderBubbles();
    return;
  }

  const seq = ++bubbleSeq;
  const b = {
    uid: `b${seq}`,
    seq,
    key: bubbleKey(n),
    type: n.type ?? "",
    actionable: isActionable(n.type),
    sticky: STICKY_TYPES.has(n.type),
    agent: n.agent ?? "",
    session: n.session_id ?? "",
    // 行 id：回 /api/action 用，也是 notification_resolved 撤气泡的依据。老 Core 不发 id
    id: Number.isInteger(n.id) ? n.id : null,
    ids: Number.isInteger(n.id) ? [n.id] : [],
    createdAt: Date.now(),
    n,
    actions: bubbleActions(n, undefined, ACTION_CTX),
    /** 最近一次成为顶 / 改了正文的时刻（点击的停留护栏，见 decideClick）；-Infinity = 还没当过顶 */
    topSince: -Infinity,
    wasTop: false,
    timer: null,
    el: null,
  };
  b.el = buildBubble(b);
  bubbles.push(b);
  armDismiss(b);
  // 超出上限时先淘汰会自己消失的那些，常驻的一条都不碰（R16）
  for (const victim of pickEvictions(bubbles, MAX_BUBBLES)) removeBubble(victim, { render: false });
  renderBubbles();
  announce(b);
}

/** 一条气泡的 DOM，建一次；展开 / 单行 / 藏起来都只是换 class（见 renderBubbles） */
function buildBubble(b) {
  const el = document.createElement("div");
  el.className = `bubble ${bubbleTone(b.type)}${b.sticky ? " sticky" : ""}`;
  el.dataset.uid = b.uid;
  el.dataset.type = b.type;

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "b-dismiss";
  dismiss.textContent = "✕";
  dismiss.setAttribute("aria-label", t("ui.bubble.dismiss"));
  dismiss.onclick = (e) => {
    e.stopPropagation();
    runAction(b, "dismiss");
  };
  el.appendChild(dismiss);

  const head = document.createElement("div");
  head.className = "b-head";
  head.appendChild(line("b-factor", ""));
  head.appendChild(line("b-count", ""));
  el.appendChild(head);
  // textContent 而不是 innerHTML：agent / session_id 来自 hook 上报的外部数据，
  // 拼进 HTML 既可能注入，也可能因为字段缺失直接抛异常吃掉整条通知。
  const title = line("b-title", "");
  title.id = `${b.uid}-title`;
  el.appendChild(title);
  const body = line("b-body", "");
  body.id = `${b.uid}-body`;
  el.appendChild(body);
  // 建议动作（U10 / R21）：每条辅导警告都回答「那我该做什么」
  const advice = line("b-advice", "");
  advice.hidden = true;
  el.appendChild(advice);
  el.appendChild(line("b-meta", `${shortAgent(b.agent)} · ${shortId(b.session)}`));
  const note = line("b-note", t("ui.bubble.changed"));
  note.hidden = true;
  el.appendChild(note);

  // 动作行：按动作表画按钮，数字键写在按钮上（只有顶上那条露出来）
  const row = document.createElement("div");
  row.className = "b-actions";
  for (const a of b.actions) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `b-act${a.safe ? " safe" : ""}`;
    btn.dataset.action = a.id;
    const kbd = document.createElement("kbd");
    kbd.textContent = a.key;
    btn.appendChild(kbd);
    btn.appendChild(document.createTextNode(t(a.labelKey, a.params)));
    btn.onclick = (e) => {
      e.stopPropagation();
      clickAction(b, a);
    };
    row.appendChild(btn);
  }
  const dwell = document.createElement("span");
  dwell.className = "b-dwell";
  dwell.setAttribute("aria-hidden", "true");
  row.appendChild(dwell);
  el.appendChild(row);

  el.onclick = () => {
    openPanel();
    // 单行只是「后面还有这一条」：点它打开浮层，不替用户处理掉一条没展开读过的请求
    if (!el.classList.contains("top")) return;
    resolveBubble(b, "actioned");
    removeBubble(b);
  };
  fillBubble(b, el);
  return el;
}

/** 写进会变的那几段文字（原地合并时也走这里） */
function fillBubble(b, el = b.el) {
  el.querySelector(".b-title").textContent = notifText(b.n, "title");
  el.querySelector(".b-body").textContent = notifText(b.n, "body");
  const advice = el.querySelector(".b-advice");
  const action = b.n.coach?.action;
  advice.hidden = !action;
  advice.textContent = action ? t(action) : "";
}

/**
 * 按 layoutBubbles 的结果排 DOM：顶上那条展开、贴着宠物（列的最下面），
 * 后面的折成单行叠在它上方，再多的藏起来、折进顶上那条的计数里 —— 一条都不丢。
 */
function renderBubbles() {
  const box = $("bubbles");
  const { top, stubs, behind } = layoutBubbles(bubbles);
  const shown = new Set([top, ...stubs].filter(Boolean));
  const factorsOn = healthSurfaces(state.healthVisibility).flyout;
  const hiddenOnes = sortBubbles(bubbles).filter((b) => !shown.has(b));
  const order = [...hiddenOnes, ...[...stubs].reverse(), ...(top ? [top] : [])];
  order.forEach((b, i) => {
    if (box.children[i] !== b.el) box.insertBefore(b.el, box.children[i] ?? null);
  });

  for (const b of bubbles) {
    const el = b.el;
    const isTop = b === top;
    el.hidden = !shown.has(b);
    // 刚成为顶的那一刻起算点击的停留（被挤下去再回来也重新算：它上面那条刚被处理掉，眼睛还没回来）
    if (isTop && !b.wasTop) b.topSince = performance.now();
    b.wasTop = isTop;
    el.classList.toggle("top", isTop);
    el.classList.toggle("stub", !isTop && shown.has(b));
    // 因子点名（R14）；分数可见性为 off 时连因子名也不出现
    const factor = bubbleFactor(b.type);
    const chip = el.querySelector(".b-factor");
    chip.hidden = !(isTop && factor && factorsOn);
    chip.textContent = factor ? t("ui.bubble.factor", { factor: t(`ui.health.factor.${factor}`) }) : "";
    const count = el.querySelector(".b-count");
    count.hidden = !(isTop && behind > 0);
    count.textContent = t("ui.bubble.more", { count: behind });
    if (isTop) {
      // R28：可操作的顶端气泡是 alertdialog，无障碍名写明每个数字键做什么
      el.setAttribute("role", b.actionable ? "alertdialog" : "group");
      el.setAttribute("aria-label", bubbleAria(b));
      el.setAttribute("aria-describedby", `${b.uid}-body`);
    } else {
      el.removeAttribute("role");
      el.removeAttribute("aria-label");
      el.removeAttribute("aria-describedby");
      el.querySelector(".b-note").hidden = true;
    }
  }
  syncGuard();
}

function bubbleAria(b) {
  return t("ui.bubble.aria", {
    title: notifText(b.n, "title"),
    body: notifText(b.n, "body"),
    keys: actionsLabel(b.actions, t),
  });
}

function topBubble() {
  return layoutBubbles(bubbles).top;
}

/**
 * 气泡出现时报给辅助技术（R28）：可操作的走 assertive，辅导类走 polite。
 * 先清空再写：同一句话连着写两次，屏幕阅读器会当作没变。
 */
function announce(b) {
  const region = $(b.actionable ? "bubble-alert" : "bubble-status");
  if (!region) return;
  const text = b === topBubble()
    ? bubbleAria(b)
    : `${notifText(b.n, "title")}. ${notifText(b.n, "body")}`;
  region.textContent = "";
  setTimeout(() => {
    region.textContent = text;
  }, 30);
}

function line(cls, text) {
  const div = document.createElement("div");
  div.className = cls;
  div.textContent = text;
  return div;
}

function bubbleTone(type) {
  if (type === "error") return "danger";
  if (type === "milestone") return "ok";
  if (type === "evolution") return "ok";
  if (type === "context" || type === "drift") return "warn";
  if (type === "ready") return "ok";
  return "";
}

function armDismiss(b) {
  if (b.timer) clearTimeout(b.timer);
  b.timer = b.sticky ? null : setTimeout(() => removeBubble(b), BUBBLE_TTL_MS);
}

function removeBubble(b, { render = true } = {}) {
  if (b.timer) clearTimeout(b.timer);
  const i = bubbles.indexOf(b);
  if (i >= 0) bubbles.splice(i, 1);
  b.el?.remove();
  if (render) renderBubbles();
}

/**
 * Core 说这一行结束了。辅导类原地合并过的气泡代表好几行：只有最新那行结束才撤整条，
 * 老的那几行结束只是从账上划掉（用户看着的是最新那句话）。
 */
function removeBubbleById(id) {
  for (const b of [...bubbles]) {
    if (b.id === id) removeBubble(b);
    else if (b.ids.includes(id)) b.ids = b.ids.filter((x) => x !== id);
  }
}

/** 告诉 Core 用户在宠物里处理了这条气泡（dismiss / actioned）。没有 id 的老通知无从指认，跳过 */
function resolveBubble(b, action) {
  if (b.id === null) return;
  void postAction(action, { id: b.id });
}

/** 执行一个动作（点按钮或按数字键）。用户自己处理掉了顶上那条 → 对新的顶重拍快照 */
function runAction(b, actionId) {
  const handler = BUBBLE_ACTIONS[actionId];
  if (!handler) return;
  handler(b);
  guard = guardResnap(guard, topBubble()?.uid ?? null, performance.now());
  paintDwell();
}

/**
 * 点击一个动作。安全动作直接执行；别的（永远允许）和数字键一样过停留与「是不是顶」两道闸，
 * 被拦下时把进度线亮出来 —— 画出来，而不是悄悄吞掉这一下。
 */
function clickAction(b, a) {
  const top = topBubble();
  const r = decideClick({ action: a, uid: b.uid, topId: top?.uid ?? null, topSince: b.topSince, now: performance.now() });
  if (r.kind === "act") {
    runAction(b, a.id);
    return;
  }
  if (r.kind === "changed") showChangedNote(b);
  paintDwell({ clickFor: b });
}

/**
 * 用户回答了 agent 之后，Core 会把该 session 的 needs-you 撤掉 ——
 * 那条常驻气泡也该自己走，不必用户手动叉掉。session 从列表里消失了也一样
 * （判定见 ui/health/bubbles.js）。
 */
function reconcileStickyBubbles() {
  const now = Date.now();
  for (const b of [...bubbles]) {
    if (!b.sticky) continue;
    if (stickyBubbleStale({ agent: b.agent, session: b.session, createdAt: b.createdAt }, state.sessions, now)) {
      removeBubble(b, { render: false });
    }
  }
  renderBubbles();
}

/* ---- 停留护栏：画出来，而不是悄悄吞键 ----
 * 窗口拿到焦点、或者某条气泡成为顶（取较晚者）起，DWELL_MS 内按键不算数；
 * 这段时间动作行下面走一条进度线，走完数字键亮起来 = 现在按有效。 */
function syncGuard() {
  guard = guardTop(guard, topBubble()?.uid ?? null, performance.now());
  paintDwell();
}

function paintDwell({ clickFor = null } = {}) {
  if (dwellTimer) clearTimeout(dwellTimer);
  dwellTimer = null;
  const top = topBubble();
  for (const b of bubbles) {
    if (b === top) continue;
    b.el.classList.remove("dwell", "armed");
  }
  if (!top) return;
  const el = top.el;
  // 起算点：有焦点且快照就是这条 → 键盘护栏的 armedAt；刚被一次点击撞上（没有焦点也会点）→
  // 这条成为顶的时刻；都不是（没焦点，或者快照不是这条，按下去会被拒）→ 数字键不亮
  const armedAt = guard && guard.snapshotId === top.uid
    ? guard.armedAt
    : clickFor === top || (!guard && top.actions.some((x) => !x.safe) && top.topSince + DWELL_MS > performance.now())
      ? top.topSince
      : null;
  if (armedAt === null) {
    el.classList.remove("dwell", "armed");
    return;
  }
  const remaining = armedAt + DWELL_MS - performance.now();
  if (remaining > 0) {
    if (el._dwellFor !== armedAt) {
      // 重新上膛：摘掉再挂上，让进度线从头走（减弱动态下 CSS 不放这段动画，只剩「未亮」→「亮」）
      el._dwellFor = armedAt;
      el.classList.remove("dwell");
      void el.offsetWidth;
      el.style.setProperty("--dwell-ms", `${Math.round(remaining)}ms`);
    }
    el.classList.remove("armed");
    el.classList.add("dwell");
    dwellTimer = setTimeout(paintDwell, remaining + 5);
    return;
  }
  el.classList.remove("dwell");
  el.classList.add("armed");
}

/** 「请求变了」：按下去的数字没有落在新的那条上，并说明为什么 */
function showChangedNote(b) {
  const note = b.el.querySelector(".b-note");
  note.hidden = false;
  clearTimeout(note._timer);
  note._timer = setTimeout(() => {
    note.hidden = true;
  }, 2000);
}

window.addEventListener("focus", () => {
  guard = guardFocus(performance.now(), topBubble()?.uid ?? null);
  paintDwell();
});
window.addEventListener("blur", () => {
  guard = null;
  paintDwell();
});
if (document.hasFocus()) guard = guardFocus(performance.now(), null);

/** 在这些地方打字 / 按 Enter 是它们自己的事，气泡不抢 */
function keyBelongsToTarget(e) {
  const el = e.target;
  if (!(el instanceof Element)) return false;
  if (el.closest("input, textarea, select, [contenteditable='true']")) return true;
  // Enter 在按钮上是「按这个按钮」（宠物本身是 role=button：Enter 照旧开关浮层）
  return e.key === "Enter" && Boolean(el.closest("button, [role='button']"));
}

// 捕获阶段：早于宠物自己的 keydown；只吞我们认的键，其余照常下去
document.addEventListener("keydown", (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey || keyBelongsToTarget(e)) return;
  const top = topBubble();
  const now = performance.now();
  const r = decideKey(guard, {
    key: e.key, repeat: e.repeat, now, topId: top?.uid ?? null, actions: top?.actions ?? [],
  });
  if (r.kind === "pass") return;
  e.preventDefault();
  e.stopPropagation();
  if (r.kind === "unfocused") {
    // 焦点事件没来过就收到了键：现在上膛，这一下不算
    guard = guardFocus(now, top.uid);
    paintDwell();
  } else if (r.kind === "changed") {
    showChangedNote(top);
    guard = guardResnap(guard, top.uid, now);
    paintDwell();
  } else if (r.kind === "act") {
    runAction(top, r.action.id);
  }
  // swallow / dwell：什么都不做 —— 进度线本身就在说「还没到」
}, true);

/* ---------------- 浮层 ---------------- */
/* 开关浮层只改 DOM，一个字节的窗口几何都不碰：壳的窗口恒为 300×430，
 * 浮层的位置早就留好了。以前这里会让壳把窗口撑高/收回，而那次尺寸变化会在
 * 合成器里漏出一帧「新尺寸 + 旧原点」，宠物整块上跳 180px 再跳回来 ——
 * 关浮层时看到的那一下「闪」。详见 desktop/main.js 的 PANEL_GEOMETRY_NOTE。 */
function openPanel() {
  if (state.panelOpen) return;
  state.panelOpen = true;
  $("panel").hidden = false;
  renderPanel();
  $("panel-close").focus({ preventScroll: true });
}

function closePanel() {
  if (!state.panelOpen) return;
  state.panelOpen = false;
  $("panel").hidden = true;
}

function togglePanel() {
  state.panelOpen ? closePanel() : openPanel();
}

/** 浮层里最多展示的已结束 session 数（以及它们的保鲜期） */
const FINISHED_SHOWN = 3;
const FINISHED_MAX_AGE_MS = 6 * 3_600_000;

/**
 * 浮层无条件重绘（不再用 panelOpen 当门槛）：门槛把「DOM 可见性」和「数据新鲜度」
 * 绑成了一根绳 —— 一旦两者不同步，用户看到的就是一块永不更新的旧浮层（issue #5）。
 */
/** 上一次画出来的内容指纹：内容没变就不要重建 DOM（否则键盘焦点每 5 秒丢一次） */
let lastPanelSignature = null;

/**
 * 空面板要说哪句话。三种「什么都没有」长得一模一样，但要用户做的事完全不同：
 *   连不上 Core        → 去看 Core 起没起（issue #5：断线时说「还没有 session」是撒谎）
 *   Core 在但没有 adapter → 去装 hooks（在这之前这种情况完全不可见，宠物只是闲着）
 *   都正常，只是没干活   → 什么都不用做
 */
function emptyPanelKey() {
  if (!coreReachable()) return "ui.panel.offline";
  if (Array.isArray(state.adapters) && state.adapters.length === 0) return "ui.panel.noAdapter";
  return "ui.panel.empty";
}

/** 展开着因子明细的行（rowKey）。只活在这个窗口里：重开 App 全部收起 */
const expandedRows = new Set();

function renderPanel() {
  const container = $("sessions");
  // 分数显示在浮层里吗（R30）。关掉时排序也不看分数 —— 顺序本身就会泄露它
  const showHealth = healthSurfaces(state.healthVisibility).flyout;
  // needs-you 永远最前，其余按分数从差到好（排序、指纹、最弱因子都在 ui/health/rows.js）
  const sorted = sortSessions(state.sessions, { byScore: showHealth });
  // 有 session 在等你时，「等了多久」要继续走表 —— 让指纹每分钟变一次，
  // 其余时候完全不重建（不然焦点每 5 秒被清一次）。
  const waitTick = sorted.some((s) => s.needs_input_since) ? Math.floor(Date.now() / 60_000) : 0;
  // 不在推送里的行，展开状态也不留（不然一个消失又回来的 session 会莫名其妙地是展开的）
  for (const k of expandedRows) if (!sorted.some((x) => rowKey(x) === k)) expandedRows.delete(k);
  // 指纹里的每一项为什么要在（outcome、subagent_count、分数……）见 rows.js 的 sessionSignature
  const signature = panelSignature({
    reachable: coreReachable(),
    adapters: state.adapters === null ? null : state.adapters.length,
    waitTick,
    sessions: sorted,
    showHealth,
    expanded: expandedRows,
  });
  if (signature === lastPanelSignature) return;
  lastPanelSignature = signature;
  container.replaceChildren();
  const live = sorted.filter((s) => s.is_active);
  // 已结束的 session 会在列表里堆积到 50 条，把还在跑的挤出可见范围。
  // 只留最近一小段时间里的几条，其余折叠成一行计数。
  const finished = sorted.filter((s) => !s.is_active && freshlyFinished(s));
  const list = [...live, ...finished.slice(0, FINISHED_SHOWN)];
  const hidden = sorted.length - list.length;

  if (list.length === 0) {
    const empty = document.createElement("div");
    empty.id = "panel-empty";
    empty.textContent = t(emptyPanelKey());
    container.appendChild(empty);
    return;
  }

  for (const s of list) container.appendChild(sessionItem(s, showHealth));
  if (hidden > 0) {
    const more = document.createElement("div");
    more.id = "panel-more";
    more.textContent = t("ui.panel.more", { count: hidden });
    container.appendChild(more);
  }
}

function freshlyFinished(s) {
  const at = new Date(s.finished_at ?? s.last_event_at ?? 0).getTime();
  return Number.isFinite(at) && Date.now() - at < FINISHED_MAX_AGE_MS;
}

/**
 * 这个 session 是被回收的僵尸吗（G10，与 core/events.ts 的 isReclaimed 同一份判定）。
 * 「结束了」和「进程没了」在列表里必须长得不一样 —— 否则用户会以为那次会话正常收工了。
 */
function reclaimedSession(s) {
  return !s.is_active && (s.outcome === "orphaned" || s.outcome === "timeout");
}

/**
 * 与 core/events.ts 的 SessionState 一致。用途有两个，都要求它是**白名单**：
 * 拼进 class 名的字符串必须先被这张表认过（state 来自 Core，但渲染层不假设它干净），
 * 以及「哪些状态配一个文字标签」。设置窗口有一份同名常量（ui/settings.js）。
 */
const SESSION_STATES = [
  "idle", "working", "delegating", "juggling", "needs-you", "warning", "ready", "finished",
];

/**
 * 列表里的一项 = 原来那一行（点它复制 resume 命令）+ 右侧的分数按钮（点它展开四个因子）。
 * 分数按钮是行的**兄弟**而不是孩子：role=button 里再套一个 button，读屏和键盘都说不清按的是哪个。
 */
function sessionItem(s, showHealth) {
  const item = document.createElement("div");
  item.className = "session-item";
  item.appendChild(sessionRow(s));
  const rh = showHealth ? rowHealth(s) : null;
  // null = 被回收 / 没有 health：不画分数也不画 pip —— 它没有分数，不是 0 分
  if (!rh) return item;
  const key = rowKey(s);
  const open = expandedRows.has(key);
  item.appendChild(scoreToggle(s, rh, key, open));
  if (open) item.appendChild(factorDetails(s.health, rh));
  return item;
}

/** 分数 + 一条 4px 高的 pip 条。浮层里数字按色带着色：这是读的地方，不是余光扫的地方 */
function scoreToggle(s, rh, key, open) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "s-health";
  btn.dataset.rowKey = key;
  btn.setAttribute("aria-expanded", String(open));

  const num = document.createElement("span");
  num.className = "s-num";
  const pips = document.createElement("span");
  buildPipCells(pips, "pip");
  if (rh.kind === "score") {
    num.textContent = String(rh.shown);
    num.classList.add(`band-${rh.band}`);
    pips.className = `pips s-pips band-${rh.band}`;
    rh.strip.cells.forEach((on, i) => pips.children[i].classList.toggle("on", on));
    if (rh.provisional) btn.classList.add("provisional");
    btn.title = rh.provisional ? t("ui.health.provisional") : t("ui.health.settled");
    btn.setAttribute(
      "aria-label",
      t(rh.provisional ? "ui.health.aria.provisional" : "ui.health.aria", { score: rh.shown }),
    );
  } else {
    // 一个因子都没测到：说不知道，画空心格 —— 不是 0 分
    num.textContent = "—";
    pips.className = "pips s-pips empty";
    btn.title = t("ui.health.unknown");
    btn.setAttribute("aria-label", t("ui.health.unknown"));
  }
  btn.append(num, pips);

  btn.onclick = (e) => {
    e.stopPropagation();
    if (expandedRows.has(key)) expandedRows.delete(key);
    else expandedRows.add(key);
    renderPanel();
    // 整张列表按指纹重建了：把焦点还给同一行的按钮，键盘用户不会被甩回开头
    for (const el of $("sessions").querySelectorAll(".s-health")) {
      if (el.dataset.rowKey === key) el.focus({ preventScroll: true });
    }
  };
  return btn;
}

/**
 * 展开后的四个因子：名字、槽、分数、证据。
 * 省略的因子写「没测到」而不画一个 0；没结算的 Outcome 画虚线槽。
 * 最弱的那个（rows.js 的 weakestFactor：只在有分的因子里挑）会被点名。
 */
function factorDetails(h, rh) {
  const box = document.createElement("div");
  box.className = "s-factors";
  const weakest = weakestFactor(h);
  if (weakest) box.appendChild(line("f-weakest", t("ui.health.weakest", { factor: t(`ui.health.factor.${weakest}`) })));

  for (const f of factorBreakdown(h)) {
    const row = document.createElement("div");
    row.className = `f-row ${f.status}${f.name === weakest ? " weakest" : ""}`;

    const name = document.createElement("span");
    name.className = "f-name";
    name.textContent = t(`ui.health.factor.${f.name}`);

    const track = document.createElement("span");
    track.className = "f-track";
    if (f.status === "scored") {
      const fill = document.createElement("span");
      fill.className = "f-fill";
      fill.style.width = `${Math.round(f.ratio * 100)}%`;
      track.appendChild(fill);
    }

    const pts = document.createElement("span");
    pts.className = "f-pts";
    pts.textContent = f.status === "scored" ? `${f.points}/${FACTOR_MAX}` : "—";

    const ev = document.createElement("span");
    ev.className = "f-ev";
    ev.textContent = factorEvidence(f, h.evidence ?? {});

    row.append(name, track, pts, ev);
    box.appendChild(row);
  }
  if (rh.kind === "score" && rh.provisional) box.appendChild(line("f-note", t("ui.health.provisional")));
  return box;
}

/** 每个因子「为什么是这个分」的那半句 */
function factorEvidence(f, ev) {
  if (f.status === "omitted") return t(`ui.health.omitted.${f.name}`);
  if (f.status === "pending") return t("ui.health.pending");
  if (f.name === "context") return t("ui.health.ev.context", { pct: Math.round(ev.context_peak ?? 0) });
  if (f.name === "focus") return t("ui.health.ev.focus", { n: ev.repeat_edits ?? 0 });
  if (f.name === "response") {
    return t("ui.health.ev.response", {
      time: fmtDuration(ev.response_median_ms ?? 0),
      n: ev.response_samples ?? 0,
    });
  }
  const outcome = localizedOr(`ui.health.outcome.${ev.outcome}`, ev.outcome ?? "");
  return ev.error_count > 0 ? t("ui.health.ev.outcome.errors", { outcome, n: ev.error_count }) : outcome;
}

function sessionRow(s) {
  const row = document.createElement("div");
  row.className = "session-row";
  row.setAttribute("role", "button");
  row.tabIndex = 0;
  row.title = t("ui.session.tooltip", { project: s.project_id, time: fmtTime(s.last_event_at) });

  const dot = document.createElement("span");
  dot.className = "s-state";
  // class 里也不拼外部字符串：state 只可能是这几个已知值，别的一律不加 class
  if (SESSION_STATES.includes(s.state)) {
    dot.classList.add(s.state);
  }
  if (reclaimedSession(s)) dot.classList.add("lost");
  row.appendChild(dot);

  const badge = document.createElement("span");
  badge.className = "agent-badge";
  badge.textContent = shortAgent(s.agent);
  row.appendChild(badge);

  // 状态文字（与设置窗口共用 settings.session.state.* 同一份文案）。
  // 只有还活着的 session 需要：已结束的靠 finished 圆点、被回收的靠 s-lost 小字表达，
  // 再贴一个「空闲」反而重复。
  if (s.is_active && s.state !== "finished") {
    const label = document.createElement("span");
    label.className = `s-label ${s.state}`;
    // juggling 的文案带个数（「×3」）—— 「一堆」和「三个」不是同一条信息，
    // 而宠物本体最多只画 5 颗方块，确切的数字只能由这里给。
    label.textContent = t(`settings.session.state.${s.state}`, { n: s.subagent_count ?? 0 });
    row.appendChild(label);
  }

  const title = document.createElement("span");
  title.className = "s-title";
  title.textContent = s.title ?? "";
  row.appendChild(title);

  // 僵尸回收的归因（G10）。用户会问的是「它是崩了，还是我自己走开了」——
  // 这两句话对应完全不同的下一步动作（去看日志 / 直接 resume）。
  if (reclaimedSession(s)) {
    const lost = document.createElement("span");
    lost.className = "s-lost";
    lost.textContent = t(`ui.session.${s.outcome}`);
    row.appendChild(lost);
  }

  // 「等了多久」是决定先处理哪个 session 的关键信息
  if (s.state === "needs-you" && s.needs_input_since) {
    const wait = document.createElement("span");
    wait.className = "s-wait";
    wait.textContent = fmtTime(s.needs_input_since);
    row.appendChild(wait);
  }

  const meta = document.createElement("span");
  meta.className = "s-meta";
  // 统一显示 token 总量（结束与否由左侧状态圆点区分，✓ 会盖住 token 数）
  meta.textContent = `${Math.round((s.token_used ?? 0) / 1000)}k`;
  row.appendChild(meta);

  const activate = () => copyResume(s);
  row.onclick = activate;
  row.onkeydown = (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      activate();
    }
  };
  return row;
}

/** jump-to：复制各 agent 恢复命令（MVP 先复制到剪贴板，P1 唤起终端） */
async function copyResume(s) {
  const cmd = resumeCommand(s);
  if (await copyText(cmd)) {
    flash(t("ui.toast.copied", { cmd }));
  } else {
    // 复制不成就必须把命令留在屏幕上，而且要能选中 —— 全局 user-select:none
    // 会让「自己抄一遍」都做不到（.toast-copy 单独放开选中）。
    flash(t("ui.toast.command", { cmd }), { sticky: true, selectable: true });
  }
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* 窗口失焦 / 权限被拒时 clipboard API 会 reject，往下走兜底 */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * agent 的 session 是跟目录绑定的：`claude --resume <id>` 在别的目录里跑
 * 根本找不到这个 session，所以恢复命令必须先 cd 回项目。
 */
function resumeCommand(s) {
  const project = shellQuote(s.project_id ?? "");
  if (s.agent === "claude_code") return `cd ${project} && claude --resume ${s.session_id}`;
  if (s.agent === "codex") return `cd ${project} && codex resume ${s.session_id}`;
  if (s.agent === "dsh") return `cd ${project} && dsh web`;
  return `cd ${project}`;
}

/** 项目路径里可能有空格/引号，直接拼进命令会被 shell 拆开 */
function shellQuote(p) {
  return /^[\w@%+=:,./-]*$/.test(p) ? p : `'${String(p).replace(/'/g, `'\\''`)}'`;
}

function flash(msg, opts = {}) {
  const el = document.createElement("div");
  el.className = `bubble ${opts.error ? "danger" : "ok"}${opts.selectable ? " toast-copy" : ""}`;
  const title = line("b-title", msg);
  el.appendChild(title);
  if (opts.sticky) {
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "b-dismiss";
    dismiss.textContent = "✕";
    dismiss.setAttribute("aria-label", t("ui.bubble.dismiss"));
    dismiss.onclick = () => el.remove();
    el.insertBefore(dismiss, title);
  } else {
    setTimeout(() => el.remove(), 2500);
  }
  $("toasts").appendChild(el);
  while ($("toasts").children.length > 2) $("toasts").firstElementChild.remove();
}

/* ---------------- 事件绑定 ---------------- */
/** 上一次拖拽结束的时刻：拖完松手浏览器还会补一个 click，别让它翻开/关上浮层 */
let dragEndedAt = 0;

// 捕获阶段拦截：#stage 的 capture 监听早于 #pet 自己的 click 监听。
// 用时间戳而不是布尔 flag —— 如果松手时光标已在窗口外，click 根本不会来，
// 布尔 flag 就会一直挂着，把下一次正经点击也吃掉。
$("stage").addEventListener("click", (e) => {
  if (performance.now() - dragEndedAt < 250) {
    e.stopPropagation();
    e.preventDefault();
  }
}, true);

// 点空白处收起浮层（浮层与气泡是 #stage 的兄弟节点，它们的点击不会落到这里）
$("stage").addEventListener("click", (e) => {
  if (e.target !== $("pet") && state.panelOpen) closePanel();
});

$("pet").addEventListener("click", (e) => {
  e.stopPropagation();
  togglePanel();
});
$("pet").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    togglePanel();
  }
});
// Esc 收起浮层：没有它，点不到宠物时只能瞄准右上角那个 15px 的 ×
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && state.panelOpen) closePanel();
});

$("panel-close").onclick = closePanel;
$("mute-badge").onclick = () => setMute(null);
$("act-exp").onclick = () => loadExpLog();
/**
 * 设置窗口。壳里开一扇真正的窗口（有标题栏、能聚焦、系统复制粘贴都在）；
 * 纯浏览器预览里退成一个新标签页 —— 那时没有壳，也没有窗口那一段设置可改。
 */
$("act-settings").onclick = () => {
  if (shell?.openSettings) shell.openSettings();
  else window.open(`/settings.html?locale=${encodeURIComponent(LOCALE)}`, "_blank", "noopener");
};
/** Den（U13）。与设置同一个套路：壳里是一扇独立窗口，纯浏览器预览里是新标签页 */
$("act-den").onclick = () => {
  if (shell?.openDen) shell.openDen();
  else window.open(`/den.html?locale=${encodeURIComponent(LOCALE)}`, "_blank", "noopener");
};
// 单选组：点已经开着的那个 = 取消静音；点另一个 = 换成那个时长
for (const btn of MUTE_BUTTONS) {
  $(btn.id).onclick = () =>
    setMute(activeMuteMinutes(muteRemainingMs()) === btn.minutes ? null : btn.minutes);
}

/**
 * 静音开关。以前这里是「发出去就当成功」：Core 不在的时候照样弹「已安静 30 分钟」，
 * 而气泡还会继续来 —— 界面在撒谎。现在按响应说话，并用响应里的状态立刻回填按钮。
 */
async function setMute(minutes) {
  const buttons = MUTE_BUTTONS.map((b) => $(b.id));
  for (const b of buttons) b.disabled = true;
  const res = minutes === null
    ? await postAction("unmute")
    : await postAction("mute", { minutes });
  for (const b of buttons) b.disabled = false;
  if (!res) {
    flash(t("ui.toast.actionfailed"), { error: true });
    return;
  }
  state.mute = { global_until: res.global_until ?? null, global_minutes: res.global_minutes ?? null };
  renderMute();
  if (minutes === null) flash(t("ui.toast.unmuted"));
  else flash(t(minutes >= 120 ? "ui.toast.muted2h" : "ui.toast.muted30"));
}

async function postAction(action, body = {}) {
  try {
    const r = await fetch("/api/action", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, ...body }),
    });
    if (!r.ok) return null;
    return (await r.json().catch(() => ({}))) ?? {};
  } catch {
    return null;
  }
}

async function loadExpLog() {
  const box = $("explog");
  const btn = $("act-exp");
  if (!box.hidden) {
    box.hidden = true;
    btn.setAttribute("aria-expanded", "false");
    return;
  }
  btn.disabled = true;
  let data = null;
  let hooks = null;
  try {
    // 开销计数与 EXP 一起取：两个都是本机请求，而它们要一起被看到（见 costFooter）
    const [expRes, hookRes] = await Promise.all([
      fetch("/api/exp", { cache: "no-store" }),
      fetch("/api/hookstats", { cache: "no-store" }).catch(() => null),
    ]);
    if (expRes.ok) data = await expRes.json();
    if (hookRes?.ok) hooks = await hookRes.json();
  } catch {
    /* 下面统一提示 */
  }
  btn.disabled = false;
  if (!data) {
    // 以前这里是静默 return：用户点了按钮，什么都没发生，也不知道为什么
    flash(t("ui.toast.actionfailed"), { error: true });
    return;
  }
  box.replaceChildren(expTable(data.logs ?? []), costFooter(hooks));
  box.hidden = false;
  btn.setAttribute("aria-expanded", "true");
}

/**
 * 「它不会吃你的 token」（landscape 0.12 / clawd #102）。
 *
 * 断言那一行是无条件的 —— 它是一句关于程序本身的事实，Core 连不上也照样成立。
 * 计数那一行只有真的拿到数字时才出现：这段文案的全部价值在于可核对，
 * 而一个说不出数字的计数器比没有计数器更糟。详细版（延迟、curl 命令）在设置窗口。
 */
function costFooter(hooks) {
  const box = document.createElement("div");
  box.className = "cost";
  const claim = document.createElement("div");
  claim.className = "cost-claim";
  claim.textContent = t("ui.cost.claim");
  box.appendChild(claim);
  if (hooks?.calls) {
    const meter = document.createElement("div");
    meter.className = "cost-meter";
    meter.textContent = t("ui.cost.meter", {
      calls: hooks.calls.toLocaleString(),
      bytes: bytesLabel(hooks.bytes),
    });
    box.appendChild(meter);
  }
  return box;
}

/** 设置窗口有一份同样的实现：两个页面各自独立加载，没有可共用的模块（与 shortAgent 同理） */
function bytesLabel(n) {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function expTable(logs) {
  const table = document.createElement("table");
  const head = table.insertRow();
  for (const key of ["ui.exp.col.category", "ui.exp.col.amount", "ui.exp.col.note"]) {
    const th = document.createElement("th");
    th.textContent = t(key);
    head.appendChild(th);
  }
  for (const l of logs.slice(0, 15)) {
    const row = table.insertRow();
    row.insertCell().textContent = expCategory(l.category);
    const amount = row.insertCell();
    amount.className = "amount";
    amount.textContent = `+${l.amount}`;
    row.insertCell().textContent = expNote(l.note);
  }
  return table;
}

/** exp_logs.category 是内部枚举（token/outcome/care/self/level…），显示时本地化 */
function expCategory(category) {
  return localizedOr(`ui.exp.cat.${category}`, category ?? "");
}

/**
 * exp_logs.note 混了两类内容：散文式说明（要翻）与公式/键值（tokens=… ×ctx=…，两种语言一样）。
 * 用 note 原文当 key 查目录：查到就翻，查不到原样显示 —— 老数据也不会变成一串裸 key。
 */
function expNote(note) {
  return note ? localizedOr(`ui.exp.note.${note}`, note) : "";
}

function localizedOr(key, fallback) {
  const label = t(key);
  return label === key ? fallback : label;
}

/* ---------------- 拖拽（issue #8） ----------------
 * 旧实现同时跑两套：CSS `-webkit-app-region: drag` 和这里的 JS 拖拽 —— 因为
 * sandbox 下 `window.process` 恒为 undefined，本该跳过的兜底分支一直在跑。
 * 两套机制争同一个窗口位置，就是「不跟手 + 多重残影」的来源。现在只剩一套，
 * 且壳的存在改由 preload 暴露的 window.vibepaws 显式声明，不再靠嗅探。
 *
 * 坐标系分工（关键）：
 *   · 阈值判定用 clientX/Y —— 此刻窗口还没动，窗口内坐标就是可靠的位移量；
 *   · 一旦开拖，Electron 下位置全部由主进程按光标算（见 desktop/main.js），
 *     渲染层不再参与；纯浏览器兜底则用 screenX/Y，绝不用 clientX/Y ——
 *     窗口一动 clientX 跟着变，拿它算位移会形成反馈环，越拖越飘。
 */
(function setupDrag() {
  const stage = $("stage");
  /** 位移小于这个像素数算「点击」，不算拖拽 —— 否则点宠物开浮层会被误判成拖 */
  const THRESHOLD = 4;
  let pointerId = null;
  let clientX0 = 0, clientY0 = 0;   // 按下时的窗口内坐标 —— 只用来判阈值
  let screenX0 = 0, screenY0 = 0;   // 按下时的屏幕坐标 —— 只给浏览器兜底算位移
  let winX = 0, winY = 0;
  let dragging = false;

  // 只监听 #stage：浮层与气泡是它的兄弟节点，各自吃掉自己的 pointerdown，
  // 不会冒泡到这里，所以不需要额外的 closest() 排除。
  stage.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || pointerId !== null) return;
    pointerId = e.pointerId;
    clientX0 = e.clientX; clientY0 = e.clientY;
    screenX0 = e.screenX; screenY0 = e.screenY;
    winX = window.screenX; winY = window.screenY;
    dragging = false;
    // 注意：此刻**不**抓 pointer capture。capture 一旦生效，随后的 click 会被
    // 重定向到 #stage，宠物自己的 click 就再也收不到，浮层点不开了。
  });

  stage.addEventListener("pointermove", (e) => {
    if (e.pointerId !== pointerId) return;
    if (!dragging) {
      // 阈值判定用 clientX/Y：拖拽还没开始，窗口是静止的，窗口内坐标此刻等价于
      // 屏幕坐标，而且任何输入源都保证填充它（screenX 在合成事件里可能是 0）。
      if (Math.abs(e.clientX - clientX0) < THRESHOLD && Math.abs(e.clientY - clientY0) < THRESHOLD) return;
      dragging = true;
      // 过了阈值才抓 capture：这样光标移出窗口也收得到 pointerup
      stage.setPointerCapture(pointerId);
      document.body.classList.add("dragging");
      shell?.dragStart();
    }
    // Electron 下位置由主进程跟随光标，这里不用再算。
    // 浏览器兜底才需要自己算，且必须用屏幕坐标：窗口一动 clientX 就跟着变，
    // 拿它算位移会形成反馈环（旧实现发飘的原因）。
    if (!shell) window.moveTo?.(winX + e.screenX - screenX0, winY + e.screenY - screenY0);
  });

  function endDrag(e) {
    if (pointerId === null || (e && e.pointerId !== pointerId)) return;
    if (dragging) {
      shell?.dragEnd();
      document.body.classList.remove("dragging");
      dragEndedAt = performance.now();
    }
    if (stage.hasPointerCapture?.(pointerId)) stage.releasePointerCapture(pointerId);
    pointerId = null;
    dragging = false;
  }
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);
  stage.addEventListener("lostpointercapture", endDrag);
})();

/* ---------------- 命中测试（点击穿透） ----------------
 * 壳的窗口恒为 300×430，但真正要吃点击的只有宠物那 210×250、展开时的浮层、以及气泡。
 * 剩下全是透明空白 —— 而透明不等于穿透：不管的话宠物头顶那一大片会把桌面的点击全吃掉。
 *
 * 判据就是 elementFromPoint 落在谁身上：气泡层是 pointer-events:none，浮层收起时是
 * hidden，所以空白处命中的必然是 body/html。不用维护选择器白名单，加了新元素也不会漏。
 *
 * 光标离开窗口时一律报「可交互」：穿透状态下唯一能把交互要回来的信道就是 mousemove，
 * 万一它没来，停在「可交互」最坏只是短暂挡住桌面（= 修好前的老行为），
 * 停在「穿透」则是宠物彻底点不动。两种失败模式不对称，所以默认值只能取前者。 */
(function setupHitTest() {
  if (!shell?.setHit) return; // 纯浏览器预览：没有壳，也没有穿透这回事
  let last = null;
  function report(over) {
    if (over === last) return; // mousemove 是高频事件，只在翻转时才发 IPC
    last = over;
    shell.setHit(over);
  }
  function isHit(x, y) {
    const el = document.elementFromPoint(x, y);
    return !!el && el !== document.body && el !== document.documentElement;
  }
  // capture 阶段：拖拽/浮层里的监听会 stopPropagation，别让它们把上报吃掉
  window.addEventListener("mousemove", (e) => report(isHit(e.clientX, e.clientY)), true);
  // relatedTarget 为空 = 光标离开了整个文档（mouseleave 在 document 上不总触发）
  document.addEventListener("mouseout", (e) => {
    if (!e.relatedTarget) report(true);
  }, true);
  window.addEventListener("blur", () => report(true));
})();

/* ---------------- 工具 ---------------- */
function shortAgent(a) {
  return a === "claude_code" ? "Claude" : a === "codex" ? "Codex" : a === "pi" ? "Pi" : a === "dsh" ? "DeepSeek" : String(a ?? "?");
}
function shortId(id) {
  return String(id ?? "").slice(0, 10) || "?";
}
function fmtTime(iso) {
  if (!iso) return t("ui.time.unknown");
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return t("ui.time.unknown");
  const diff = Date.now() - d.getTime();
  if (diff < 60_000) return t("ui.time.justnow");
  if (diff < 86_400_000) return fmtDuration(diff);
  return d.toLocaleDateString(LOCALE);
}
/**
 * 时长本地化：以前直接拼 "5m"/"3h"，中文界面里就混出了英文单位（issue #6）。
 *
 * 整小时之外要把分钟也说出来（"1h59m"）。只报小时的话，round 会把剩 90 分钟
 * 说成 "2h"（多报半小时），floor 会把刚点下的 2 小时说成 "1h"（少报一小时，
 * 看着就是个 bug）—— 一个数字承担不了两小时的精度。
 */
function fmtDuration(ms) {
  if (ms < 60_000) return t("ui.time.seconds", { n: Math.max(1, Math.round(ms / 1000)) });
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 60) return t("ui.time.minutes", { n: totalMinutes });
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return m === 0 ? t("ui.time.hours", { n: h }) : t("ui.time.hoursminutes", { h, m });
}

applyStaticI18n();
renderConn();
// 宠物动画循环只启动一次（startPetLoop 内部会自续帧）；
// 不能放在 render() 里 —— render() 每次 SSE/轮询都会调用，会把 rAF 循环越堆越多，
// 导致渲染进程 CPU 打满、气泡无法及时弹出（issue：其他窗口 ask 无通知）。
// 先把素材清单读进来：preload() 内部吞掉所有错误（失败就全员走程序生成兜底），
// 所以这里不需要 catch，也不会因为素材层挂了而不启动循环。
petRegistry.preload().then(startPetLoop);
connectCore();
