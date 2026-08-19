/**
 * Vibepaws UI 应用逻辑 — 壳零业务逻辑：状态/气泡/浮层数据全部来自 Core（SSE）。
 */
import { getPet, renderPet } from "./pets.js";

const $ = (id) => document.getElementById(id);
const state = {
  pet: null,
  sessions: [],
  notifications: [],
  connected: false,
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
  $("conn").title = ok ? "Core 已连接" : "Core 未连接";
}

/* ---------------- 渲染 ---------------- */
function render() {
  renderPetFrame();
  renderExpBar();
  renderNameplate();
  if (state.panelOpen) renderPanel();
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
function pushBubble(n) {
  const box = $("bubbles");
  // 聚合：同类同 session 已存在则更新文字
  const existing = [...box.children].find(
    (el) => el.dataset.key === `${n.agent}:${n.session_id}:${n.type}`,
  );
  if (existing) {
    existing.querySelector(".b-body").textContent = n.body;
    return;
  }
  const el = document.createElement("div");
  el.className = `bubble ${n.type === "error" ? "danger" : n.type === "milestone" ? "ok" : n.type === "context" || n.type === "drift" ? "warn" : ""}`;
  el.dataset.key = `${n.agent}:${n.session_id}:${n.type}`;
  el.innerHTML = `
    <button class="b-dismiss">✕</button>
    <div class="b-title">${escapeHtml(n.title)}</div>
    <div class="b-body">${escapeHtml(n.body)}</div>
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
    container.innerHTML = `<div style="color:var(--dim);padding:6px;">还没有 session — 启动你的 coding agent 试试</div>`;
    return;
  }
  for (const s of list) {
    const row = document.createElement("div");
    row.className = "session-row";
    row.title = `${s.project_id} · 最后活动 ${fmtTime(s.last_event_at)}`;
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
    flash(`已复制：${cmd}`);
  } catch {
    flash(`命令：${cmd}`);
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
$("act-mute").onclick = async () => { await postAction("mute", { minutes: 30 }); flash("🔕 全部安静 30 分钟"); };
$("act-mute2h").onclick = async () => { await postAction("mute", { minutes: 120 }); flash("😴 全部安静 2 小时"); };
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
  box.innerHTML = `<table><tr><th>类别</th><th>数值</th><th>说明</th></tr>${
    (data.logs ?? []).slice(0, 15).map((l) =>
      `<tr><td>${l.category}</td><td class="amount">+${l.amount}</td><td>${escapeHtml(l.note ?? "")}</td></tr>`,
    ).join("")
  }</table>`;
  box.hidden = false;
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
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + "m";
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + "h";
  return d.toLocaleDateString();
}
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

connectCore();
