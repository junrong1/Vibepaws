/**
 * Vibepaws 设置窗口的逻辑。
 *
 * 两个数据源，泾渭分明：
 *   · Core（/api/settings、/api/session）—— 预算、阈值、每日上限、宠物名、session goal。
 *     它们是守护进程的状态，宠物窗口和引擎都在读。
 *   · 壳（window.vibepaws，由 desktop/preload-settings.cjs 暴露）—— 窗口怎么摆、界面语言。
 *     这些必须在 Core 之前就能决定（Core 可能没跑），所以存在壳的 window-prefs.json 里。
 *
 * 保存策略是「改完即存」而不是底部一个 Save 按钮：本地小工具里，攒一批改动再统一
 * 提交只会多出一个「我到底存了没有」的状态。校验在 Core 那边做，响应里带回**真正
 * 生效**的值，界面照着回填 —— 于是被收进区间的输入会当场变成它实际的样子，
 * 而不是留着一个用户以为生效了的数字。
 */
import { t as translate, normalizeLocale } from "/i18n.js";

const $ = (id) => document.getElementById(id);

/** locale 来源与宠物窗口一致：主进程传的 ?locale= > 浏览器语言 */
const LOCALE = normalizeLocale(new URLSearchParams(location.search).get("locale") ?? navigator.language);
const t = (key, params) => translate(LOCALE, key, params);
document.documentElement.lang = LOCALE;

/** 壳桥（preload）；纯浏览器里为 null —— 那时窗口那一段整体不可用 */
const shell = window.vibepaws ?? null;

const POLL_MS = 5000;
const SAVED_MS = 1800;
/** 预算一律以 k tokens 计：里程碑气泡说的也是 "12.5k tokens · budget 200k" */
const K = 1000;

/**
 * context 阈值预设。设置窗口只提供这几档，理由是三个自由输入框既难填也难解释；
 * API 仍然接受任意数组（1..99、最多 3 档），所以手改过库的人不会被这里锁住 ——
 * 那种值会以「自定义」出现在下拉里。
 */
const WARN_PRESETS = [
  { id: "off", pcts: [], key: "settings.warn.off" },
  { id: "early", pcts: [60, 75, 90], key: "settings.warn.early" },
  { id: "default", pcts: [70, 85, 95], key: "settings.warn.default" },
  { id: "late", pcts: [80, 90, 97], key: "settings.warn.late" },
];

const LANGUAGES = [
  { id: "auto", key: "settings.language.auto" },
  { id: "en", key: "settings.language.en" },
  { id: "zh-CN", key: "settings.language.zh" },
];

/** 最近一次从 Core 拿到的视图（limits / defaults 都在里面） */
let view = null;
let lastSessionsSignature = null;

/* ---------------- i18n ---------------- */
function applyStaticI18n() {
  for (const el of document.querySelectorAll("[data-i18n]")) el.textContent = t(el.dataset.i18n);
  document.title = t("settings.title");
}

/* ---------------- 状态行 ---------------- */
let statusTimer = null;
function status(message, tone) {
  const el = $("status");
  el.textContent = message;
  el.className = tone;
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = null;
  // 成功提示自己走；失败留在原地 —— 它是「刚才为什么没生效」的唯一解释
  if (tone === "ok") {
    statusTimer = setTimeout(() => {
      el.textContent = "";
      el.className = "";
    }, SAVED_MS);
  }
}

/* ---------------- HTTP ---------------- */
async function getJson(path) {
  try {
    const r = await fetch(path, { cache: "no-store" });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

async function postJson(path, body) {
  try {
    const r = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, ok: r.ok, data: await r.json().catch(() => null) };
  } catch {
    // fetch 本身失败 = UI server 都没了；status 0 与 502（Core 不在）走同一句话
    return { status: 0, ok: false, data: null };
  }
}

/**
 * 把一次写入的结果说清楚。几种失败要分开，因为用户该做的事完全不同：
 *   连不上     → 去看 Core 起没起
 *   值非法     → 改一下再填（什么都没写进去）
 *   session 没了 → 它刚刚结束了，这次修改无处可去
 *   被收敛     → 存下来了，但不是你填的那个数
 */
function report(res, effectiveText) {
  if (res.status === 400) {
    status(t("settings.status.invalid"), "err");
    return false;
  }
  if (res.status === 404) {
    status(t("settings.status.gone"), "err");
    lastSessionsSignature = null; // 让下一次轮询把这一行去掉
    return false;
  }
  if (!res.ok) {
    status(t("settings.status.failed"), "err");
    return false;
  }
  const clamped = res.data?.clamped ?? [];
  if (clamped.length > 0 && effectiveText) status(t("settings.status.clamped", { value: effectiveText }), "err");
  else status(t("settings.status.saved"), "ok");
  return true;
}

/* ---------------- 全局设置 ---------------- */
async function load() {
  const data = await getJson("/api/settings");
  if (!data) {
    status(t("settings.status.offline"), "err");
    return;
  }
  apply(data);
}

/** 正在编辑的框不许被轮询覆盖 —— 不然每 5 秒吞掉一次用户刚打的字 */
function editing(el) {
  return el === document.activeElement || el.dataset.dirty === "1";
}

/**
 * `forced` 是刚刚保存过的那个元素：它必须被生效值覆盖，哪怕光标还在里面。
 *
 * 「别动正在编辑的框」这条规则是为了防**轮询**吞字，而不是防用户自己那次保存的
 * 响应。分不清这两个来源的话，回车提交一个超范围的数字就会留下「提示说存成了
 * 100000k、框里还写着 999999999」——界面在撒谎。
 */
function setValue(el, value, forced) {
  if (el !== forced && editing(el)) return;
  el.value = value;
}

function markDirty(el) {
  el.dataset.dirty = "1";
}

function clearDirty(el) {
  delete el.dataset.dirty;
}

/** tokens → k（整数就不带小数点：200000 显示成 200，不是 200.000） */
function toK(tokens) {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0;
  return Number((tokens / K).toFixed(3));
}

function apply(data, forced) {
  view = data;
  const { settings, limits, pet } = data;

  const nameEl = $("pet-name");
  nameEl.maxLength = limits.pet_name_max;
  nameEl.placeholder = pet.species ?? "vibepaws";
  setValue(nameEl, pet.custom_name ?? "", forced);
  $("pet-meta").textContent = t("settings.pet.meta", {
    level: pet.level,
    exp: pet.exp,
    next: pet.next_level_exp,
  });

  const budgetEl = $("budget");
  budgetEl.max = toK(limits.budget_tokens_max);
  setValue(budgetEl, String(toK(settings.budget_tokens)), forced);

  const capEl = $("cap");
  capEl.max = limits.daily_exp_cap_max;
  setValue(capEl, String(settings.daily_exp_cap), forced);

  renderWarnOptions(settings.context_warn_pcts, forced);
  renderSessions(data.sessions ?? []);
}

/** 阈值下拉：预设 + （必要时）一条反映库里真实值的「自定义」 */
function renderWarnOptions(pcts, forced) {
  const el = $("warn");
  if (el !== forced && editing(el)) return;
  const current = pcts.join(",");
  const preset = WARN_PRESETS.find((p) => p.pcts.join(",") === current);
  el.replaceChildren();
  for (const p of WARN_PRESETS) {
    const option = document.createElement("option");
    option.value = p.pcts.join(",");
    option.textContent = t(p.key);
    el.appendChild(option);
  }
  if (!preset) {
    const option = document.createElement("option");
    option.value = current;
    option.textContent = t("settings.warn.custom", { pcts: pcts.join(" / ") });
    el.appendChild(option);
  }
  el.value = current;
}

/** 被收敛后的实际值，用人话写出来（提示里要说的就是这个） */
function effectiveText(fields, data) {
  return fields
    .map((field) => {
      if (field === "budget_tokens") return `${toK(data.settings.budget_tokens)}k`;
      if (field === "daily_exp_cap") return String(data.settings.daily_exp_cap);
      if (field === "context_warn_pcts") return `${data.settings.context_warn_pcts.join(" / ")}%`;
      if (field === "pet_name") return data.pet.custom_name ?? "";
      return field;
    })
    .join(" · ");
}

async function patchSettings(patch, el) {
  const res = await postJson("/api/settings", patch);
  if (res.ok && res.data) {
    if (el) clearDirty(el);
    report(res, effectiveText(res.data.clamped ?? [], res.data));
    // 用生效值回填，包括刚保存过的那一格：被收敛的输入要当场变成它真实的样子
    apply(res.data, el ?? undefined);
    return;
  }
  report(res, null);
}

/* ---------------- 在跑的 session（G17） ---------------- */
function shortAgent(agent) {
  return agent === "claude_code" ? "Claude" : agent === "codex" ? "Codex" : agent === "pi" ? "Pi" : String(agent ?? "?");
}

function renderSessions(sessions) {
  const box = $("sessions");
  // 有人正在这一段里打字就整段不重建：重建会连输入框一起换掉，字和焦点都没了
  if (box.contains(document.activeElement) || box.querySelector('[data-dirty="1"]')) return;
  const signature = JSON.stringify(
    sessions.map((s) => [
      s.agent,
      s.session_id,
      s.title,
      s.goal,
      s.budget_tokens,
      Math.round((s.token_used ?? 0) / K),
      Math.round(s.context_pct ?? 0),
    ]),
  );
  if (signature === lastSessionsSignature) return;
  lastSessionsSignature = signature;
  box.replaceChildren();

  if (sessions.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sessions-empty";
    empty.textContent = t("settings.sessions.empty");
    box.appendChild(empty);
    return;
  }
  for (const s of sessions) box.appendChild(sessionRow(s));
}

function sessionRow(s) {
  const wrap = document.createElement("div");
  wrap.className = "session";

  const head = document.createElement("div");
  head.className = "session-head";
  const badge = document.createElement("span");
  badge.className = "agent-badge";
  badge.textContent = shortAgent(s.agent);
  const title = document.createElement("span");
  title.className = "session-title";
  // textContent：title / project_id 来自 hook 上报的外部数据，绝不拼进 HTML
  title.textContent = s.title ?? "";
  title.title = s.project_id ?? "";
  const meta = document.createElement("span");
  meta.className = "session-meta";
  meta.textContent = t("settings.session.meta", {
    used: Math.round((s.token_used ?? 0) / K),
    pct: Math.round(s.context_pct ?? 0),
  });
  head.append(badge, title, meta);
  wrap.appendChild(head);

  const goal = document.createElement("input");
  goal.type = "text";
  goal.maxLength = view?.limits?.goal_max ?? 200;
  goal.placeholder = t("settings.session.goal.placeholder");
  goal.value = s.goal ?? "";
  goal.setAttribute("aria-label", t("settings.session.goal.placeholder"));
  goal.addEventListener("input", () => markDirty(goal));
  goal.addEventListener("change", () => patchSession(s, { goal: goal.value }, goal));
  // goal 那行不给标签：placeholder 已经把「这次要做什么」问出来了
  wrap.appendChild(labelled("", goal));

  const budget = document.createElement("input");
  budget.type = "number";
  budget.min = "0";
  budget.step = "1";
  budget.max = String(toK(view?.limits?.budget_tokens_max ?? 100_000_000));
  budget.placeholder = t("settings.session.budget.placeholder");
  budget.value = s.budget_tokens ? String(toK(s.budget_tokens)) : "";
  budget.setAttribute("aria-label", t("settings.session.budget"));
  budget.addEventListener("input", () => markDirty(budget));
  budget.addEventListener("change", () =>
    // 空框 = 跟随全局默认（Core 会把它写成 NULL），不是 0
    patchSession(s, { budget_tokens: budget.value === "" ? null : Number(budget.value) * K }, budget),
  );
  const budgetField = document.createElement("span");
  budgetField.className = "field";
  const unit = document.createElement("span");
  unit.className = "unit";
  unit.textContent = t("settings.budget.unit");
  budgetField.append(budget, unit);
  wrap.appendChild(labelled(t("settings.session.budget"), budgetField));

  return wrap;
}

/** 一行「标签 + 控件」。标签为空就只放控件（goal 那行靠 placeholder 说明自己） */
function labelled(text, control) {
  const row = document.createElement("div");
  row.className = "row";
  if (text) {
    const label = document.createElement("label");
    label.textContent = text;
    row.appendChild(label);
  }
  row.appendChild(control);
  return row;
}

async function patchSession(s, patch, el) {
  const res = await postJson("/api/session", { agent: s.agent, session_id: s.session_id, ...patch });
  if (!res.ok || !res.data?.session) {
    report(res, null);
    return;
  }
  clearDirty(el);
  const updated = res.data.session;
  const clamped = res.data.clamped ?? [];
  report(
    res,
    clamped
      .map((f) => (f === "budget_tokens" ? `${toK(updated.budget_tokens ?? 0)}k` : (updated.goal ?? "")))
      .join(" · "),
  );
  // 回填生效值（goal 会被去掉控制字符与首尾空格）；本行之外的数据等下一次轮询
  if (el.type === "number") el.value = updated.budget_tokens ? String(toK(updated.budget_tokens)) : "";
  else el.value = updated.goal ?? "";
  Object.assign(s, updated);
  lastSessionsSignature = null; // 让下一次轮询重算这一段
}

/* ---------------- 壳设定（窗口 / 语言） ---------------- */
function renderLanguageOptions(prefs) {
  const el = $("language");
  el.replaceChildren();
  for (const lang of LANGUAGES) {
    const option = document.createElement("option");
    option.value = lang.id;
    option.textContent =
      lang.id === "auto"
        ? t(lang.key, { locale: t(prefs.osLocale === "zh-CN" ? "settings.language.zh" : "settings.language.en") })
        : t(lang.key);
    el.appendChild(option);
  }
  el.value = LANGUAGES.some((l) => l.id === prefs.locale) ? prefs.locale : "auto";
}

function applyPrefs(prefs) {
  if (!prefs) return;
  $("allspaces").checked = Boolean(prefs.allSpaces);
  $("clickthrough").checked = Boolean(prefs.clickThrough);
  renderLanguageOptions(prefs);
}

async function initShell() {
  const controls = [$("allspaces"), $("clickthrough"), $("language"), $("reset-pos")];
  if (!shell?.getPrefs) {
    // 浏览器里打开：把这一段禁掉并说明原因，而不是留一排点了没反应的开关
    $("shell-only").hidden = false;
    for (const el of controls) el.disabled = true;
    renderLanguageOptions({ locale: "auto", osLocale: LOCALE });
    return;
  }
  applyPrefs(await shell.getPrefs());

  $("allspaces").addEventListener("change", async () => {
    applyPrefs(await shell.setPrefs({ allSpaces: $("allspaces").checked }));
    status(t("settings.status.saved"), "ok");
  });
  $("clickthrough").addEventListener("change", async () => {
    applyPrefs(await shell.setPrefs({ clickThrough: $("clickthrough").checked }));
    status(t("settings.status.saved"), "ok");
  });
  // 语言改完由主进程重载本窗口（连托盘菜单一起换语言），所以这里不用自己重绘
  $("language").addEventListener("change", () => shell.setPrefs({ locale: $("language").value }));
  $("reset-pos").addEventListener("click", async () => {
    await shell.resetPosition();
    status(t("settings.window.reset.done"), "ok");
  });
}

/* ---------------- 危险区（重置 / 删除 / 卸载） ----------------
 *
 * 确认走「按一下武装、再按一下执行」，而不是 confirm() 弹窗：弹窗在 Electron 里
 * 会阻塞整个渲染进程（连 SSE 一起停），而且这扇窗口在浏览器预览里也要能用。
 * 武装状态 6 秒后自动解除 —— 一个一直红着的按钮，下次误触时看起来跟没武装一样。
 */
const ARM_MS = 6000;

const DANGER = [
  { id: "reset-pet", label: "settings.danger.pet", run: () => resetLocal("pet") },
  { id: "reset-data", label: "settings.danger.data", run: () => resetLocal("data") },
  { id: "uninstall", label: "settings.danger.uninstall", run: runUninstall },
];

let armedId = null;
let armTimer = null;

function disarm() {
  if (armTimer) clearTimeout(armTimer);
  armTimer = null;
  armedId = null;
  for (const entry of DANGER) {
    const el = $(entry.id);
    el.textContent = t(entry.label);
    el.classList.remove("armed");
  }
}

function arm(entry) {
  disarm(); // 一次只武装一个：两个红按钮同时亮着，点错的代价太大
  armedId = entry.id;
  const el = $(entry.id);
  el.textContent = `${t(entry.label)} — ${t("settings.danger.confirm")}`;
  el.classList.add("armed");
  armTimer = setTimeout(disarm, ARM_MS);
}

function humanBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** 「会删掉多少东西」必须写在按钮旁边 —— 说不出数量的删除按钮没人敢按 */
function renderFootprint(footprint) {
  if (!footprint) return;
  const params = {
    sessions: footprint.sessions ?? 0,
    events: footprint.events ?? 0,
    notifications: footprint.notifications ?? 0,
  };
  const size = humanBytes(footprint.db_bytes);
  $("footprint").textContent = size
    ? t("settings.danger.footprint", { ...params, size })
    : t("settings.danger.footprint.nosize", params);
}

function scopeLabel(scope) {
  return t(scope === "global" ? "settings.danger.scope.global" : "settings.danger.scope.project");
}

/** 一个卸载目标里有什么（与 CLI 的措辞刻意保持一致） */
function targetParts(target) {
  if (target.unreadable) return [t("settings.danger.part.broken")];
  const parts = [];
  if (target.hooks > 0) parts.push(t("settings.danger.part.hooks", { n: target.hooks }));
  if (target.status_line) parts.push(t("settings.danger.part.statusline"));
  if (target.kind !== "json") parts.push(t("settings.danger.part.plugin"));
  return parts;
}

function renderTargets(targets) {
  const box = $("targets");
  box.replaceChildren();
  if (targets.length === 0) {
    const empty = document.createElement("div");
    empty.className = "target";
    empty.textContent = t("settings.danger.uninstall.none");
    box.appendChild(empty);
    $("uninstall").disabled = true;
    return;
  }
  $("uninstall").disabled = false;
  for (const target of targets) {
    const row = document.createElement("div");
    row.className = target.unreadable ? "target broken" : "target";
    const what = document.createElement("span");
    what.className = "target-what";
    // textContent：这些路径来自文件系统，绝不拼进 HTML
    what.textContent = t("settings.danger.target", {
      agent: shortAgent(target.agent),
      scope: scopeLabel(target.scope),
      what: targetParts(target).join(" + "),
    });
    const file = document.createElement("div");
    file.textContent = target.file;
    row.append(what, file);
    box.appendChild(row);
  }
}

/** 善后提示：我们故意没动的东西 + 出错的文件。不说出来，「已卸载」就是假话。 */
function renderNotes(notes, results) {
  const box = $("uninstall-notes");
  box.replaceChildren();
  const lines = notes.map((n) => t(n.key, n.params));
  for (const r of results ?? []) if (r.error) lines.push(`${r.file}: ${r.error}`);
  for (const line of lines) {
    const el = document.createElement("div");
    el.className = "note";
    el.textContent = `⚠ ${line}`;
    box.appendChild(el);
  }
}

async function loadDanger() {
  // 两个 GET 都是只读预览（一次行数统计 + 一次配置扫描），不进 5 秒轮询：
  // 每 5 秒去翻一遍用户的 ~/.claude 是没有理由的开销
  const [footprint, uninstall] = await Promise.all([getJson("/api/reset"), getJson("/api/uninstall")]);
  if (footprint) renderFootprint(footprint.footprint);
  if (uninstall) renderTargets(uninstall.targets ?? []);
}

async function resetLocal(scope) {
  const res = await postJson("/api/reset", { scope, confirm: true });
  if (!res.ok || !res.data) {
    report(res, null);
    return;
  }
  const data = res.data;
  const rows = Object.values(data.deleted ?? {}).reduce((sum, n) => sum + (Number(n) || 0), 0);
  status(
    scope === "pet"
      ? t("settings.danger.done.pet", { name: data.pet?.name ?? "" })
      : t("settings.danger.done.data", { n: rows }),
    "ok",
  );
  lastSessionsSignature = null; // session 段整段没了，signature 必须失效才会重绘
  apply(data);
  renderFootprint(data.footprint);
}

async function runUninstall() {
  const res = await postJson("/api/uninstall", { confirm: true });
  if (!res.ok || !res.data) {
    report(res, null);
    return;
  }
  const results = res.data.results ?? [];
  const touched = results.filter((r) => r.changed).length;
  status(touched > 0 ? t("settings.danger.done.uninstall", { n: touched }) : t("settings.danger.done.nothing"), "ok");
  renderTargets(res.data.targets ?? []);
  renderNotes(res.data.notes ?? [], results);
}

for (const entry of DANGER) {
  $(entry.id).addEventListener("click", () => {
    if (armedId === entry.id) {
      disarm();
      entry.run();
      return;
    }
    arm(entry);
  });
}

/* ---------------- 绑定 ---------------- */
for (const id of ["pet-name", "budget", "cap"]) {
  $(id).addEventListener("input", () => markDirty($(id)));
}
$("pet-name").addEventListener("change", () => patchSettings({ pet_name: $("pet-name").value }, $("pet-name")));
$("budget").addEventListener("change", () => {
  const raw = $("budget").value;
  patchSettings({ budget_tokens: raw === "" ? 0 : Number(raw) * K }, $("budget"));
});
$("cap").addEventListener("change", () => patchSettings({ daily_exp_cap: Number($("cap").value) }, $("cap")));
$("warn").addEventListener("change", () => {
  const raw = $("warn").value;
  // "" = 「关闭」那一项：空数组，而不是「没选」
  patchSettings({ context_warn_pcts: raw === "" ? [] : raw.split(",").map(Number) }, $("warn"));
});

applyStaticI18n();
disarm(); // 顺带给三个危险按钮写上初始标签（它们的文案由武装状态决定，不能走 data-i18n）
initShell();
load();
loadDanger();
setInterval(load, POLL_MS);
