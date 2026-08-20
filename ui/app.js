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

/** 填充 HTML 里的 data-i18n / data-i18n-title 占位 */
function applyStaticI18n() {
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  for (const el of document.querySelectorAll("[data-i18n-title]")) el.title = t(el.dataset.i18nTitle);
}
const state = {
  pet: null,
  sessions: [],
  notifications: [],
  /** null = 还没连上也还没失败（启动瞬间）；true/false = 已确认 */
  connected: null,
  panelOpen: false,
};

/* ---------------- Core 连接 ---------------- */
function connectCore() {
  const es = new EventSource("/api/sse");
  es.onopen = () => setConn(true);
  es.onerror = () => setConn(false);
  es.addEventListener("pet_state", (e) => {
    const push = JSON.parse(e.data);
    state.pet = push.pet;
    state.sessions = push.sessions;
    render();
  });
  es.addEventListener("notification", (e) => {
    const n = JSON.parse(e.data);
    if (n && !n.skip) pushBubble(n);
  });
  // 轮询兜底
  setInterval(async () => {
    try {
      const r = await fetch("/api/state");
      if (r.ok) {
        const push = await r.json();
        state.pet = push.pet;
        state.sessions = push.sessions;
        render();
        setConn(true);
      }
    } catch { setConn(false); }
  }, 5000);
}

function setConn(ok) {
  state.connected = ok;
  $("conn").className = ok ? "conn-ok" : "conn-off";
  $("conn").title = t(ok ? "ui.conn.ok" : "ui.conn.off");
}

/* ---------------- 渲染 ---------------- */
/**
 * 浮层无条件重绘（不再用 panelOpen 当门槛）：门槛把「DOM 可见性」和「数据新鲜度」
 * 绑成了一根绳 —— 一旦两者不同步，用户看到的就是一块永不更新的旧浮层
 * （issue #5：浮层说「还没有 session」，同一时刻 EXP 明细里却躺着这个 session 的流水）。
 * 代价只是几行 session DOM，换来的是「屏幕上的浮层永远等于 Core 的当前状态」。
 */
function render() {
  renderPetFrame();
  renderExpBar();
  renderNameplate();
  renderPanel();
}

function renderPetFrame() {
  const canvas = $("pet");
  const pet = getPet(state.pet?.pet_type_id ?? 1);
  renderPet(canvas, pet, state.pet?.state ?? "idle", 10, performance.now());
  requestAnimationFrame(renderPetFrame);
}

function renderExpBar() {
  const p = state.pet;
  if (!p) return;
  const pct = Math.min(100, (p.exp / p.next_level_exp) * 100);
  $("expfill").style.width = pct + "%";
  $("exptext").textContent = `Lv.${p.level} ${p.exp}/${p.next_level_exp}`;
}

function renderNameplate() {
  $("nameplate").textContent = state.pet?.name ?? "…";
}

/* ---------------- 气泡 ---------------- */
/** Core 只发文案 key + 参数（英文 title/body 仅作兜底），语言在这里决定 */
function notifText(n, slot) {
  const spec = n.i18n?.[slot];
  return spec ? t(spec.key, spec.params) : (n[slot] ?? "");
}

function pushBubble(n) {
  const box = $("bubbles");
  // 聚合：同类同 session 已存在则更新文字
  const existing = [...box.children].find(
    (el) => el.dataset.key === `${n.agent}:${n.session_id}:${n.type}`,
  );
  if (existing) {
    existing.querySelector(".b-body").textContent = notifText(n, "body");
    return;
  }
  const el = document.createElement("div");
  el.className = `bubble ${n.type === "error" ? "danger" : n.type === "milestone" ? "ok" : n.type === "context" || n.type === "drift" ? "warn" : ""}`;
  el.dataset.key = `${n.agent}:${n.session_id}:${n.type}`;
  el.innerHTML = `
    <button class="b-dismiss">✕</button>
    <div class="b-title">${escapeHtml(notifText(n, "title"))}</div>
    <div class="b-body">${escapeHtml(notifText(n, "body"))}</div>
    <div class="b-meta">${shortAgent(n.agent)} · ${n.session_id.slice(0, 10)}</div>`;
  el.querySelector(".b-dismiss").onclick = (e) => {
    e.stopPropagation();
    el.remove();
  };
  el.onclick = () => {
    openPanel();
    el.remove();
  };
  box.appendChild(el);
  // 自动消失 8s；多气泡轮播：最多同时 3 条
  setTimeout(() => el.remove(), 8000);
  while (box.children.length > 3) box.firstChild.remove();
}

/* ---------------- 浮层 ---------------- */
function openPanel() {
  state.panelOpen = true;
  $("panel").hidden = false;
  renderPanel();
}
function closePanel() {
  state.panelOpen = false;
  $("panel").hidden = true;
}

function renderPanel() {
  const container = $("sessions");
  container.innerHTML = "";
  const list = [...state.sessions].sort((a, b) => {
    const rank = { "needs-you": 0, warning: 1, working: 2, idle: 3, finished: 4 };
    return (rank[a.state] ?? 5) - (rank[b.state] ?? 5);
  });
  if (list.length === 0) {
    const empty = document.createElement("div");
    empty.style.cssText = "color:var(--dim);padding:6px;";
    // 断线时 sessions 也是空的，但此时说「还没有 session」是在撒谎 —— 空列表
    // 只有在确认连得上 Core 的前提下才代表「真的没有 session」（issue #5）。
    empty.textContent = t(state.connected === false ? "ui.panel.offline" : "ui.panel.empty");
    container.appendChild(empty);
    return;
  }
  for (const s of list) {
    const row = document.createElement("div");
    row.className = "session-row";
    row.title = t("ui.session.tooltip", { project: s.project_id, time: fmtTime(s.last_event_at) });
    row.innerHTML = `
      <span class="s-state ${s.state}"></span>
      <span class="agent-badge">${shortAgent(s.agent)}</span>
      <span class="s-title">${escapeHtml(s.title)}</span>
      <span class="s-meta">${s.is_active ? (s.token_used / 1000).toFixed(0) + "k" : "✓"}</span>`;
    row.onclick = () => copyResume(s);
    container.appendChild(row);
  }
}

/** jump-to：复制各 agent 恢复命令（MVP 先复制到剪贴板，P1 唤起终端） */
async function copyResume(s) {
  const cmd = resumeCommand(s);
  try {
    await navigator.clipboard.writeText(cmd);
    flash(t("ui.toast.copied", { cmd }));
  } catch {
    flash(t("ui.toast.command", { cmd }));
  }
}

function resumeCommand(s) {
  const p = state.sessions.find((x) => x.session_id === s.session_id && x.agent === s.agent);
  const project = p?.project_id ?? s.project_id;
  if (s.agent === "claude_code") return `claude --resume ${s.session_id}`;
  if (s.agent === "codex") return `cd ${project} && codex resume ${s.session_id}`;
  return `cd ${project}`;
}

function flash(msg) {
  const el = document.createElement("div");
  el.className = "bubble ok";
  el.innerHTML = `<div class="b-title">${escapeHtml(msg)}</div>`;
  $("bubbles").appendChild(el);
  setTimeout(() => el.remove(), 2500);
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

$("pet").addEventListener("click", (e) => {
  e.stopPropagation();
  state.panelOpen ? closePanel() : openPanel();
});
$("panel-close").onclick = closePanel;
$("act-mute").onclick = async () => { await postAction("mute", { minutes: 30 }); flash(t("ui.toast.muted30")); };
$("act-mute2h").onclick = async () => { await postAction("mute", { minutes: 120 }); flash(t("ui.toast.muted2h")); };
$("act-exp").onclick = async () => { await loadExpLog(); };

async function postAction(action, body) {
  await fetch(`/api/action`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, ...body }),
  });
}

async function loadExpLog() {
  const box = $("explog");
  if (!box.hidden) { box.hidden = true; return; }
  const r = await fetch("/api/exp");
  if (!r.ok) return;
  const data = await r.json();
  const head = `<tr><th>${t("ui.exp.col.category")}</th><th>${t("ui.exp.col.amount")}</th><th>${t("ui.exp.col.note")}</th></tr>`;
  box.innerHTML = `<table>${head}${
    (data.logs ?? []).slice(0, 15).map((l) =>
      `<tr><td>${escapeHtml(expCategory(l.category))}</td><td class="amount">+${l.amount}</td><td>${escapeHtml(expNote(l.note))}</td></tr>`,
    ).join("")
  }</table>`;
  box.hidden = false;
}

/** exp_logs.category 是内部枚举（token/outcome/care/self/level…），显示时本地化 */
function expCategory(category) {
  return localizedOr(`ui.exp.cat.${category}`, category);
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
  const shell = window.vibepaws ?? null;
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

/* ---------------- 工具 ---------------- */
function shortAgent(a) {
  return a === "claude_code" ? "Claude" : a === "codex" ? "Codex" : a;
}
function fmtTime(iso) {
  if (!iso) return t("ui.time.unknown");
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return t("ui.time.unknown");
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60_000) return t("ui.time.justnow");
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + "m";
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + "h";
  return d.toLocaleDateString(LOCALE);
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

applyStaticI18n();
connectCore();
