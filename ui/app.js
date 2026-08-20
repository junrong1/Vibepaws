/**
 * Vibepaws UI 应用逻辑 — 壳零业务逻辑：状态/气泡/浮层数据全部来自 Core（SSE）。
 * 文案全部走 i18n（issue #3 / #6）：不在本文件里写死任何一句人类可读文本。
 */
import { getPet, renderPet } from "./pets.js";
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

/** 壳（Electron preload 暴露的桥）；纯浏览器里为 null */
const shell = window.vibepaws ?? null;

const POLL_MS = 5000;
const POLL_TIMEOUT_MS = 4000;
const BUBBLE_TTL_MS = 8000;
const MAX_BUBBLES = 3;
/** 「等你」类通知不自动消失：错过它就等于错过了这个产品唯一必须做对的提醒 */
const STICKY_TYPES = new Set(["decision", "permission"]);

const state = {
  pet: null,
  sessions: [],
  mute: { global_until: null, global_minutes: null },
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
  state.mute = push.mute ?? { global_until: null, global_minutes: null };
  render();
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

function renderConn() {
  const el = $("conn");
  if (state.streamOk === null && state.pollOk === null) {
    el.className = "conn-unknown";
    el.title = t("ui.conn.title");
    return;
  }
  if (state.streamOk) {
    el.className = "conn-ok";
    el.title = t("ui.conn.ok");
  } else if (state.pollOk) {
    // 半死：状态还在刷新，但气泡（只走 SSE）已经不会来了 —— 必须说出来
    el.className = "conn-degraded";
    el.title = t("ui.conn.degraded");
  } else {
    el.className = "conn-off";
    el.title = t("ui.conn.off");
  }
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

function drawPetFrame(now) {
  const pet = getPet(state.pet?.pet_type_id ?? 1);
  renderPet($("pet"), pet, state.pet?.state ?? "idle", 10, now);
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

function renderNameplate() {
  $("nameplate").textContent = state.pet?.name ?? "…";
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

function bubbleKey(n) {
  return `${n.agent ?? "?"}:${n.session_id ?? "?"}:${n.type ?? "?"}`;
}

function pushBubble(n) {
  const box = $("bubbles");
  const key = bubbleKey(n);
  const sticky = STICKY_TYPES.has(n.type);
  // 聚合：同类同 session 已存在则更新文字并重新计时
  const existing = [...box.children].find((el) => el.dataset.key === key);
  if (existing) {
    existing.querySelector(".b-title").textContent = notifText(n, "title");
    existing.querySelector(".b-body").textContent = notifText(n, "body");
    // 重新计时：不重置的话，一条不断刷新的通知会在**第一次**出现后 8 秒消失，
    // 用户看到的是「刚更新完就没了」。
    armDismiss(existing, sticky);
    return;
  }

  const el = document.createElement("div");
  el.className = `bubble ${bubbleTone(n.type)}${sticky ? " sticky" : ""}`;
  el.dataset.key = key;
  el.dataset.agent = n.agent ?? "";
  el.dataset.session = n.session_id ?? "";
  el.dataset.type = n.type ?? "";

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.className = "b-dismiss";
  dismiss.textContent = "✕";
  dismiss.setAttribute("aria-label", t("ui.bubble.dismiss"));
  dismiss.onclick = (e) => {
    e.stopPropagation();
    removeBubble(el);
  };
  el.appendChild(dismiss);
  // textContent 而不是 innerHTML：agent / session_id 来自 hook 上报的外部数据，
  // 拼进 HTML 既可能注入，也可能因为字段缺失直接抛异常吃掉整条通知。
  el.appendChild(line("b-title", notifText(n, "title")));
  el.appendChild(line("b-body", notifText(n, "body")));
  el.appendChild(line("b-meta", `${shortAgent(n.agent)} · ${shortId(n.session_id)}`));

  el.onclick = () => {
    openPanel();
    removeBubble(el);
  };
  box.appendChild(el);
  armDismiss(el, sticky);
  trimBubbles();
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
  if (type === "context" || type === "drift") return "warn";
  return "";
}

function armDismiss(el, sticky) {
  if (el._timer) clearTimeout(el._timer);
  el._timer = sticky ? null : setTimeout(() => removeBubble(el), BUBBLE_TTL_MS);
}

function removeBubble(el) {
  if (el._timer) clearTimeout(el._timer);
  el.remove();
}

/** 超出上限时先淘汰会自己消失的那些，别把「等你」挤掉 */
function trimBubbles() {
  const box = $("bubbles");
  while (box.children.length > MAX_BUBBLES) {
    const victim =
      [...box.children].find((el) => !el.classList.contains("sticky")) ?? box.firstElementChild;
    if (!victim) return;
    removeBubble(victim);
  }
}

/**
 * 用户回答了 agent 之后，Core 会把该 session 的 needs-you 撤掉 ——
 * 那条常驻气泡也该自己走，不必用户手动叉掉。
 */
function reconcileStickyBubbles() {
  for (const el of [...$("bubbles").children]) {
    if (!el.classList.contains("sticky")) continue;
    const s = state.sessions.find(
      (x) => x.session_id === el.dataset.session && x.agent === el.dataset.agent,
    );
    if (s && s.state !== "needs-you") removeBubble(el);
  }
}

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

function renderPanel() {
  const container = $("sessions");
  const rank = { "needs-you": 0, warning: 1, working: 2, idle: 3, finished: 4 };
  const sorted = [...state.sessions].sort((a, b) => (rank[a.state] ?? 5) - (rank[b.state] ?? 5));
  // 有 session 在等你时，「等了多久」要继续走表 —— 让指纹每分钟变一次，
  // 其余时候完全不重建（不然焦点每 5 秒被清一次）。
  const waitTick = sorted.some((s) => s.needs_input_since) ? Math.floor(Date.now() / 60_000) : 0;
  const signature = JSON.stringify([
    coreReachable(),
    waitTick,
    sorted.map((s) => [s.agent, s.session_id, s.state, s.is_active, s.token_used, s.needs_input_since, s.title]),
  ]);
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
    // 断线时 sessions 也是空的，但此时说「还没有 session」是在撒谎（issue #5）。
    empty.textContent = t(coreReachable() ? "ui.panel.empty" : "ui.panel.offline");
    container.appendChild(empty);
    return;
  }

  for (const s of list) container.appendChild(sessionRow(s));
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

function sessionRow(s) {
  const row = document.createElement("div");
  row.className = "session-row";
  row.setAttribute("role", "button");
  row.tabIndex = 0;
  row.title = t("ui.session.tooltip", { project: s.project_id, time: fmtTime(s.last_event_at) });

  const dot = document.createElement("span");
  dot.className = "s-state";
  // class 里也不拼外部字符串：state 只可能是这几个已知值，别的一律不加 class
  if (["idle", "working", "needs-you", "warning", "finished"].includes(s.state)) {
    dot.classList.add(s.state);
  }
  row.appendChild(dot);

  const badge = document.createElement("span");
  badge.className = "agent-badge";
  badge.textContent = shortAgent(s.agent);
  row.appendChild(badge);

  const title = document.createElement("span");
  title.className = "s-title";
  title.textContent = s.title ?? "";
  row.appendChild(title);

  // 「等了多久」是决定先处理哪个 session 的关键信息
  if (s.state === "needs-you" && s.needs_input_since) {
    const wait = document.createElement("span");
    wait.className = "s-wait";
    wait.textContent = fmtTime(s.needs_input_since);
    row.appendChild(wait);
  }

  const meta = document.createElement("span");
  meta.className = "s-meta";
  meta.textContent = s.is_active ? `${Math.round((s.token_used ?? 0) / 1000)}k` : "✓";
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
  try {
    const r = await fetch("/api/exp", { cache: "no-store" });
    if (r.ok) data = await r.json();
  } catch {
    /* 下面统一提示 */
  }
  btn.disabled = false;
  if (!data) {
    // 以前这里是静默 return：用户点了按钮，什么都没发生，也不知道为什么
    flash(t("ui.toast.actionfailed"), { error: true });
    return;
  }
  box.replaceChildren(expTable(data.logs ?? []));
  box.hidden = false;
  btn.setAttribute("aria-expanded", "true");
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
  return a === "claude_code" ? "Claude" : a === "codex" ? "Codex" : String(a ?? "?");
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
startPetLoop();
connectCore();
// 宠物动画循环只启动一次（renderPetFrame 内部会自续帧）；
// 不能放在 render() 里 —— render() 每次 SSE/轮询都会调用，会把 rAF 循环越堆越多，
// 导致渲染进程 CPU 打满、气泡无法及时弹出（issue：其他窗口 ask 无通知）。
renderPetFrame();
