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
$("pet").addEventListener("click", (e) => {
  e.stopPropagation();
  state.panelOpen ? closePanel() : openPanel();
});
$("panel-close").onclick = closePanel;
// 隐藏宠物：关闭窗口（托盘常驻，点托盘图标/菜单可恢复）
$("act-hide").onclick = () => {
  const isElectron = Boolean(window.process?.versions?.electron);
  if (isElectron) {
    window.close();
  } else {
    closePanel();
  }
};
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

/* ---------------- 拖拽（浏览器里模拟移动；Electron 用 CSS app-region 拖拽） ---------------- */
(function setupDrag() {
  const isElectron = Boolean(window.process?.versions?.electron);
  if (isElectron) return; // Electron 由 -webkit-app-region: drag 处理
  const stage = $("stage");
  let sx = 0, sy = 0, ox = 0, oy = 0, dragging = false;
  stage.addEventListener("mousedown", (e) => {
    if (e.target.closest("#panel") || e.target.closest(".bubble")) return;
    dragging = true;
    sx = e.clientX; sy = e.clientY;
    ox = window.screenX || 0; oy = window.screenY || 0;
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    window.moveTo?.(ox + e.clientX - sx, oy + e.clientY - sy);
  });
  window.addEventListener("mouseup", () => (dragging = false));
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
