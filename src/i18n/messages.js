/**
 * Vibepaws 文案目录 —— 唯一来源（issue #3 多语言 / #6 语言一致性）。
 *
 * 纯 ESM JavaScript：Core（node --experimental-strip-types）、Electron 主进程与浏览器渲染层
 * 共用同一份文案，避免「Core 发中文标题 + adapter 发英文正文」这类混排。
 * 渲染层通过 UI server 的 /i18n.js 路由加载本文件（见 src/ui/server.ts）。
 *
 * 约定：Core 不做本地化渲染 —— 通知只携带 key + params，由渲染层按用户 locale 出字；
 * 落库的 title/body 固定用英文，保证 DB 内容与用户界面语言无关、可稳定检索。
 */

/** @typedef {"en" | "zh-CN"} Locale */

/** @type {Locale} */
export const DEFAULT_LOCALE = "en";

/** @type {Locale[]} */
export const SUPPORTED_LOCALES = ["en", "zh-CN"];

/**
 * BCP-47（`zh-Hans-CN`）或 POSIX（`zh_CN.UTF-8`）标签 → 支持的 locale。
 * issue #3 的规则：中文一律走简体中文，其余一律走英文。
 * @param {string | null | undefined} tag
 * @returns {Locale}
 */
export function normalizeLocale(tag) {
  const s = String(tag ?? "").toLowerCase().replace(/_/g, "-");
  return s.startsWith("zh") ? "zh-CN" : DEFAULT_LOCALE;
}

/**
 * Node 侧探测（CLI / 主进程兜底）：显式覆盖 > POSIX 环境变量 > ICU 默认 locale。
 * @param {Record<string, string | undefined>} [env]
 * @returns {Locale}
 */
export function detectNodeLocale(env) {
  const e = env ?? (typeof process !== "undefined" ? process.env : {});
  if (e.VIBEPAWS_LOCALE) return normalizeLocale(e.VIBEPAWS_LOCALE);
  const posix = e.LC_ALL || e.LC_MESSAGES || e.LANG;
  // "C" / "POSIX" 是「无区域」的占位值，不能当成英文偏好之外的信号
  if (posix && !/^(c|posix)(\.|$)/i.test(posix)) return normalizeLocale(posix.split(".")[0]);
  try {
    return normalizeLocale(new Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    return DEFAULT_LOCALE;
  }
}

/** @type {Record<Locale, Record<string, string>>} */
export const MESSAGES = {
  en: {
    // ---- 宠物窗口 ----
    "ui.drag": "Drag me",
    "ui.pet.aria": "Pet — click to open the session panel",
    "ui.conn.title": "Core connection",
    "ui.conn.ok": "Core connected",
    "ui.conn.off": "Core offline",
    "ui.conn.degraded": "Session list is live, but the event stream is down — bubbles won't arrive",

    // ---- 浮层 ----
    "ui.panel.close": "Close",
    "ui.panel.empty": "No sessions yet — start your coding agent",
    "ui.panel.offline": "Can't reach Vibepaws Core — session list unavailable",
    "ui.panel.noAdapter":
      "No coding agent connected — run `npm run adapter:install -- --agent claude_code --global`, then restart your agent",
    "ui.panel.more": "+{count} older sessions",
    "ui.action.mute30": "Mute everything for 30 minutes",
    "ui.action.mute2h": "Mute everything for 2 hours",
    "ui.action.unmute": "Muted · {time} left · click to undo",
    "ui.action.exp": "EXP breakdown",
    "ui.action.settings": "Settings — budget, goals, language",
    "ui.btn.mute30": "🔕 30m",
    "ui.btn.mute2h": "😴 2h",
    "ui.btn.settings": "⚙",
    "ui.badge.muted": "🔕 {time}",
    "ui.mute.remaining": "Muted · {time} left · click to undo",
    "ui.bubble.dismiss": "Dismiss",
    "ui.toast.muted30": "🔕 Muted everything for 30 minutes",
    "ui.toast.muted2h": "😴 Muted everything for 2 hours",
    "ui.toast.unmuted": "🔔 Notifications are back on",
    "ui.toast.actionfailed": "Couldn't reach Core — nothing changed",
    "ui.toast.copied": "Copied: {cmd}",
    "ui.toast.command": "Copy this: {cmd}",
    "ui.session.tooltip": "{project} · last activity {time}",
    // 僵尸回收的两种归因（G10）。措辞要让用户知道下一步：进程没了 → 去看发生了什么；
    // 只是没声了 → 大概是你走开了，resume 就行。
    "ui.session.orphaned": "process gone",
    "ui.session.timeout": "went quiet",

    // ---- EXP 明细表 ----
    "ui.exp.col.category": "Category",
    "ui.exp.col.amount": "Amount",
    "ui.exp.col.note": "Note",
    "ui.exp.cat.token": "Tokens",
    "ui.exp.cat.context": "Context",
    "ui.exp.cat.topic": "Focus",
    "ui.exp.cat.outcome": "Outcome",
    "ui.exp.cat.care": "Care",
    "ui.exp.cat.self": "Self growth",
    "ui.exp.cat.level": "Level up",
    // exp_logs.note 里的散文式说明（键 = Core 写库时的原文，见 ui/app.js 的 expNote）
    "ui.exp.note.self growth": "idle tick",
    "ui.exp.note.new session after rest": "came back after a break",
    // EXP 明细的页脚。放在这里是因为这一屏正是用户想着 token 的时刻（landscape 0.12 / clawd #102）
    "ui.cost.claim": "Vibepaws itself spends 0 tokens — it never talks to a model.",
    "ui.cost.meter": "{calls} events · {bytes} → 127.0.0.1 · Settings has the details",

    // ---- 时间 ----
    "ui.time.justnow": "just now",
    "ui.time.seconds": "{n}s",
    "ui.time.minutes": "{n}m",
    "ui.time.hours": "{n}h",
    "ui.time.hoursminutes": "{h}h{m}m",
    "ui.time.unknown": "—",

    // ---- 托盘（Electron 主进程）----
    "tray.tooltip": "Vibepaws — your coding pet",
    "tray.clickthrough": "Click-through: {state}",
    "tray.allspaces": "Show on all Spaces: {state}",
    "tray.state.on": "on",
    "tray.state.off": "off",
    "tray.show": "Show pet",
    "tray.settings": "Settings…",
    "tray.reset": "Reset pet position",
    "tray.quit": "Quit Vibepaws",
    "tray.startfailed.title": "Vibepaws could not start",
    "tray.startfailed.body": "The pet window needs its local UI server.\n\n{error}",

    // ---- 设置窗口 ----
    "settings.title": "Vibepaws Settings",
    "settings.status.saved": "Saved",
    "settings.status.failed": "Couldn't reach Core — nothing changed",
    "settings.status.invalid": "Vibepaws couldn't read that value — nothing changed",
    "settings.status.clamped": "Out of range — saved as {value}",
    "settings.status.gone": "That session isn't running any more — nothing changed",
    "settings.status.offline": "Can't reach Vibepaws Core — start it, then reopen this window",

    "settings.section.pet": "Pet",
    "settings.pet.name": "Name",
    "settings.pet.name.hint": "Leave it empty to go back to the species name.",
    "settings.pet.meta": "Lv.{level} · {exp}/{next} EXP",

    "settings.section.budget": "Budget & warnings",
    "settings.budget.label": "Default token budget",
    "settings.budget.unit": "k tokens",
    "settings.budget.hint":
      "Milestone bubbles fire at 25 / 50 / 75 / 90% of the budget. 0 turns them off. An active session can override this below.",
    "settings.warn.label": "Context warnings",
    "settings.warn.hint": "The pet warns you when a session's context window fills past these marks.",
    "settings.warn.off": "Off",
    "settings.warn.early": "Early — 60 / 75 / 90%",
    "settings.warn.default": "Default — 70 / 85 / 95%",
    "settings.warn.late": "Late — 80 / 90 / 97%",
    "settings.warn.custom": "Custom — {pcts}%",
    "settings.cap.label": "Daily EXP cap",
    "settings.cap.unit": "EXP / day",
    "settings.cap.hint": "How much EXP tokens can earn per day — keeps one long session from farming levels.",

    // ---- Token 与开销（landscape 0.12 / clawd #102）----
    // 这一段回答的是一个**被 agent 幻觉出来的**指控，所以它必须给机制而不是保证：
    // 说清 token 唯一可能被花掉的那条路（hook 的 stdout 会进上下文），再说清我们不走它。
    "settings.section.cost": "Tokens & overhead",
    "settings.cost.claim":
      "Vibepaws never talks to a model. There is no API key and no model client anywhere in it; the hook prints nothing on stdout and always exits 0, so nothing it does can enter your agent's context. It cannot spend your tokens — if your agent tells you this plugin is burning them, it is guessing about a program it cannot see.",
    "settings.cost.meter": "{calls} events · {bytes} to 127.0.0.1 · 0 bytes off this machine · 0 model calls",
    "settings.cost.latency": "Median {hook} in the hook process and {core} in Core (p95 {hookP95} / {coreP95}, last {sample})",
    "settings.cost.latency.core":
      "Median {core} in Core (p95 {coreP95}, last {sample}) — no hook has reported its own timing yet",
    "settings.cost.empty": "Nothing counted yet — the numbers start on your agent's first hook call.",
    "settings.cost.hint":
      "Counted since Core started ({since}). Bytes are the JSON bodies the hooks POSTed; hook timing is self-reported by each hook process, measured from its own start to the moment it sends — most of it is Node's startup, not our work. Don't take this window's word for any of it:",

    "settings.section.cleanup": "Idle sessions",
    "settings.zombie.label": "Give up on a silent session after",
    "settings.zombie.unit": "minutes",
    "settings.zombie.hint":
      "A crashed agent never says goodbye, so a session that goes quiet this long is closed out — no EXP, no celebration. If the agent's process is gone, that's detected in seconds and this wait doesn't apply.",

    "settings.section.sessions": "Active sessions",
    "settings.sessions.hint":
      "A goal pays 1.1× EXP and gives drift detection something to compare against. A budget here overrides the default above.",
    "settings.sessions.empty": "No active sessions — start your coding agent",
    "settings.session.goal.placeholder": "What is this session for?",
    // 这一行在 session 卡片里，说的是「这个 session 的预算」——
    // 借用上面那句「默认 token 预算」会读成「默认预算：默认」，自相矛盾
    "settings.session.budget": "Budget",
    "settings.session.budget.placeholder": "default",
    "settings.session.meta": "{used}k tokens · context {pct}%",
    "settings.session.state.working": "Working",
    "settings.session.state.ready": "Ready",
    "settings.session.state.needs-you": "Needs you",
    "settings.session.state.warning": "Warning",
    "settings.session.state.idle": "Idle",
    "settings.session.state.finished": "Finished",

    "settings.section.window": "Window",
    "settings.window.allspaces": "Show on all Spaces",
    "settings.window.clickthrough": "Click-through (let clicks pass to what's underneath)",
    "settings.window.clickthrough.hint": "Not remembered — click-through starts off again after a restart.",
    "settings.window.reset": "Reset pet position",
    "settings.window.reset.done": "Pet moved back to the bottom-right corner",
    "settings.language.label": "Language",
    "settings.language.auto": "Follow the system ({locale})",
    "settings.language.en": "English",
    "settings.language.zh": "简体中文",
    "settings.shellonly": "Window and language settings live in the Vibepaws desktop app — this page is open in a browser.",

    // ---- 危险区（重置 / 删除 / 卸载）----
    "settings.section.danger": "Reset & uninstall",
    "settings.danger.hint":
      "Everything Vibepaws knows sits on this machine. These are the ways to take it back — each button asks for a second click.",
    "settings.danger.footprint": "{sessions} sessions · {events} events · {notifications} notifications · {size} on disk",
    "settings.danger.footprint.nosize": "{sessions} sessions · {events} events · {notifications} notifications",
    "settings.danger.pet": "Start over with a new pet",
    "settings.danger.pet.hint":
      "Rolls a new starter and drops its level, EXP history and memories. Sessions, settings and hooks stay. Health follows the last 24 hours of activity, so a rough day still shows on the new pet.",
    "settings.danger.data": "Delete all local data",
    "settings.danger.data.hint":
      "Sessions, events, notifications, EXP history, budgets and thresholds — and the file is compacted afterwards, so deleted rows are really gone rather than just unlinked. Back to first launch with a new random pet. Adapter hooks are left alone.",
    "settings.danger.uninstall": "Remove adapter hooks",
    "settings.danger.uninstall.hint":
      "Takes Vibepaws out of your agent's config. Do this before deleting the app: a leftover hook fires on every single tool call, forever, paying a process launch to POST a port nobody is listening on — and you would never guess why your agent got slower.",
    "settings.danger.uninstall.none": "No Vibepaws hooks in any agent config — nothing to remove.",
    "settings.danger.confirm": "Click again to confirm",
    "settings.danger.target": "{agent} · {scope} — {what}",
    "settings.danger.part.hooks": "{n} hooks",
    "settings.danger.part.statusline": "status line",
    "settings.danger.part.plugin": "plugin file",
    "settings.danger.part.broken": "can't read this file — clean it up by hand",
    "settings.danger.scope.project": "this repo",
    "settings.danger.scope.global": "all projects",
    "settings.danger.done.pet": "Meet {name} — Lv.1, no history",
    "settings.danger.done.data": "Deleted {n} rows — back to first launch",
    "settings.danger.done.uninstall": "Cleaned {n} file(s) — restart your coding agent",
    "settings.danger.done.nothing": "Nothing to remove",

    // ---- 通知气泡 ----
    "notif.decision.title": "{agent} needs you",
    "notif.decision.body_question": "Waiting for your answer",
    "notif.ready.title": "{agent} is ready",
    "notif.ready.body": "Finished a turn — waiting for you",
    "notif.permission.title": "Permission request",
    "notif.permission.body": "{agent} wants to run {tool}",
    "notif.permission.body_unknown": "{agent} is waiting for approval",
    "notif.context.title": "Context {pct}% used",
    "notif.context.body.critical": "Wrap up or start a new session soon",
    "notif.context.body.high": "Keep an eye on token usage",
    "notif.context.body.warn": "Context is starting to fill up",
    "notif.error.title": "{agent} hit an error",
    "notif.error.body": "Something went wrong — check your terminal",
    "notif.error.body_kind": "{kind} — check your terminal",
    "notif.drift.title": "Topic drift",
    "notif.drift.body": "This task may have drifted off goal — consider a new session",
    "notif.milestone.title": "{pct}% of budget used",
    "notif.milestone.body": "{used}k tokens · budget {budget}k",

    // ---- adapter 安装器 CLI ----
    "cli.install.header": "[vibepaws] adapter install — agent={agent}{dry} scope={scope} repo={repo}",
    "cli.backup": "  ↳ Backed up your existing config → {file}",
    "cli.dryrun.write": "[dry-run] would write {file} — {count} hook events after merge",
    "cli.capabilities": "  Capabilities: {list}",
    "cli.claude.written": "✓ Claude Code hooks written to {file}",
    "cli.claude.note": "  Claude Code loads .claude/settings.json automatically (you must trust the directory once)",
    "cli.claude.globalNote": "  Global scope — Claude Code loads ~/.claude/settings.json for every project (no per-directory trust prompt)",
    "cli.cleanup.project": "  Removed {n} project-level Vibepaws hook(s) from {file} to avoid double-firing in this repo",
    "cli.codex.written": "✓ Codex hooks written to {file}",
    "cli.codex.trust.written": "Project trust written to {file}",
    "cli.codex.trust.exists": "Project trust already present ({file})",
    "cli.codex.trust.failed": "Could not write project trust (configure it manually): {error}",
    "cli.codex.trustNote":
      "\n  ⚠ Hook trust (required once before hooks fire — pick one):\n" +
      "    ① Interactive:  cd {repo} && codex, then run /hooks and approve vibepaws\n" +
      "    ② Headless:     codex exec --dangerously-bypass-hook-trust …\n" +
      "  💡 Global install (optional): merge {file} into ~/.codex/hooks.json",
    "cli.pi.dryrun": "[dry-run] would write {file} — pi extension (vibepaws adapter)",
    "cli.pi.written": "✓ Pi extension written to {file}",
    "cli.pi.cleanup.skill": "  ↳ Removed obsolete skill dir (old skill-based adapter): {dir}",
    "cli.pi.note":
      "  Project-local extensions load after the project is trusted — start a NEW `pi` session\n" +
      "  in this repo (or run /reload) to pick it up.\n" +
      "  💡 Global install: re-run with --global → ~/.pi/agent/extensions/vibepaws.ts (all projects)",
    "cli.dsh.dryrun": "[dry-run] would write {file} — DeepSeek Harness plugin (vibepaws adapter)",
    "cli.dsh.written": "✓ DeepSeek Harness plugin written to {file}",
    "cli.dsh.note":
      "  Load the plugin by starting dsh with the patch overlay:\n" +
      "    dsh web --patch {patch}\n" +
      "  💡 Global install: re-run with --global → ~/.dsh/extensions/vibepaws.cjs (all projects)",
    "cli.selfcheck.start": "\n[self-check] sending a test event to Core…",
    "cli.selfcheck.ok": "✓ Core registered this adapter (adapter_status)",
    "cli.selfcheck.next":
      "  Next: RESTART your coding agent — hooks are read once at session start,\n" +
      "        so a session that is already running will not pick them up 🐾",
    "cli.selfcheck.fail":
      "✗ Core did not respond — run `npm run core` first (the event was buffered to .vibepaws/events/fallback.jsonl and the generic bridge replays it once Core is up)",
    // ---- adapter 卸载器（CLI + 设置窗口共用 note）----
    "cli.uninstall.header": "[vibepaws] adapter uninstall — agent={agent}{dry} repo={repo}",
    "cli.uninstall.clean": "Nothing to remove — no Vibepaws hooks in any agent config",
    "cli.uninstall.cleaned": "✓ {who} — removed {what} from {file}",
    "cli.uninstall.deleted": "✓ {who} — deleted {file}",
    "cli.uninstall.nothing": "· {who} — nothing of ours in {file}",
    "cli.uninstall.error": "✗ {who} — {file}: {error}",
    "cli.uninstall.part.hooks": "{n} hook(s)",
    "cli.uninstall.part.statusRemoved": "the status line",
    "cli.uninstall.part.statusRestored": "the status line (yours put back)",
    "cli.uninstall.purge.hint":
      "  💡 Local data (pet, EXP, sessions) was left alone — add --purge-data to delete the .vibepaws directories too",
    "cli.uninstall.purge.deleted": "✓ Deleted local data: {dir}",
    "cli.uninstall.purge.failed": "✗ Could not delete {dir}: {error}",
    "cli.uninstall.purge.coreRunning":
      "✗ Core is still running — quit it first. Deleting the data directory under a live Core leaves it writing to a file that is no longer in the directory tree. Nothing was deleted.",
    "cli.uninstall.dryDone": "\n[dry-run] nothing was written",
    "cli.uninstall.done": "\nDone. Restart your coding agent — hooks are read once, at session start.",
    "uninstall.note.codexTrust":
      "Left alone on purpose: the project trust entry in {file}. Vibepaws does not rewrite your TOML — remove the [projects.\"…\"] block yourself if you want it gone.",
    "uninstall.note.backups": "Your original config is still backed up at {files} — delete that once you are happy with the result.",
    "cli.unknownAgent": "Unknown agent: {agent}",
  },

  "zh-CN": {
    // ---- 宠物窗口 ----
    "ui.drag": "拖动我",
    "ui.pet.aria": "宠物 — 点击打开 session 浮层",
    "ui.conn.title": "Core 连接状态",
    "ui.conn.ok": "Core 已连接",
    "ui.conn.off": "Core 未连接",
    "ui.conn.degraded": "session 列表在刷新，但事件流已断 — 气泡不会再来",

    // ---- 浮层 ----
    "ui.panel.close": "关闭",
    "ui.panel.empty": "还没有 session — 启动你的 coding agent 试试",
    "ui.panel.offline": "连不上 Vibepaws Core — session 列表暂不可用",
    "ui.panel.noAdapter":
      "还没有接入 coding agent — 先跑 `npm run adapter:install -- --agent claude_code --global`，然后重启 agent",
    "ui.panel.more": "还有 {count} 个较早的 session",
    "ui.action.mute30": "全部安静 30 分钟",
    "ui.action.mute2h": "全部安静 2 小时",
    "ui.action.unmute": "安静中 · 还剩 {time} · 点一下恢复",
    "ui.action.exp": "EXP 明细",
    "ui.action.settings": "设置 —— 预算、目标、语言",
    "ui.btn.mute30": "🔕 30分",
    "ui.btn.mute2h": "😴 2小时",
    "ui.btn.settings": "⚙",
    "ui.badge.muted": "🔕 {time}",
    "ui.mute.remaining": "安静中 · 还剩 {time} · 点一下恢复",
    "ui.bubble.dismiss": "关闭",
    "ui.toast.muted30": "🔕 已安静 30 分钟",
    "ui.toast.muted2h": "😴 已安静 2 小时",
    "ui.toast.unmuted": "🔔 通知已恢复",
    "ui.toast.actionfailed": "连不上 Core — 这次操作没有生效",
    "ui.toast.copied": "已复制：{cmd}",
    "ui.toast.command": "手动复制：{cmd}",
    "ui.session.tooltip": "{project} · 最后活动 {time}",
    "ui.session.orphaned": "进程没了",
    "ui.session.timeout": "没声了",

    // ---- EXP 明细表 ----
    "ui.exp.col.category": "类别",
    "ui.exp.col.amount": "数值",
    "ui.exp.col.note": "说明",
    "ui.exp.cat.token": "Token",
    "ui.exp.cat.context": "上下文",
    "ui.exp.cat.topic": "专注",
    "ui.exp.cat.outcome": "成果",
    "ui.exp.cat.care": "照料",
    "ui.exp.cat.self": "自我成长",
    "ui.exp.cat.level": "升级",
    // exp_logs.note 里的散文式说明（键 = Core 写库时的原文，见 ui/app.js 的 expNote）
    "ui.exp.note.self growth": "空闲滴答",
    "ui.exp.note.new session after rest": "休息后回来了",
    // EXP 明细的页脚。放在这里是因为这一屏正是用户想着 token 的时刻（landscape 0.12 / clawd #102）
    "ui.cost.claim": "Vibepaws 自己花 0 token —— 它从不与模型对话。",
    "ui.cost.meter": "{calls} 条事件 · {bytes} → 127.0.0.1 · 详情在设置里",

    // ---- 时间 ----
    "ui.time.justnow": "刚刚",
    "ui.time.seconds": "{n} 秒",
    "ui.time.minutes": "{n} 分钟",
    "ui.time.hours": "{n} 小时",
    "ui.time.hoursminutes": "{h} 小时 {m} 分",
    "ui.time.unknown": "—",

    // ---- 托盘（Electron 主进程）----
    "tray.tooltip": "Vibepaws — 你的 coding pet",
    "tray.clickthrough": "点击穿透：{state}",
    "tray.allspaces": "在所有桌面显示：{state}",
    "tray.state.on": "开",
    "tray.state.off": "关",
    "tray.show": "显示宠物",
    "tray.settings": "设置…",
    "tray.reset": "把宠物放回右下角",
    "tray.quit": "退出 Vibepaws",
    "tray.startfailed.title": "Vibepaws 启动失败",
    "tray.startfailed.body": "宠物窗口依赖本机 UI 服务。\n\n{error}",

    // ---- 设置窗口 ----
    "settings.title": "Vibepaws 设置",
    "settings.status.saved": "已保存",
    "settings.status.failed": "连不上 Core — 这次修改没有生效",
    "settings.status.invalid": "这个值读不出来 — 什么都没改",
    "settings.status.clamped": "超出范围 — 已按 {value} 保存",
    "settings.status.gone": "这个 session 已经不在跑了 — 什么都没改",
    "settings.status.offline": "连不上 Vibepaws Core — 先把它跑起来，再重新打开本窗口",

    "settings.section.pet": "宠物",
    "settings.pet.name": "名字",
    "settings.pet.name.hint": "留空就回到物种名。",
    "settings.pet.meta": "Lv.{level} · {exp}/{next} EXP",

    "settings.section.budget": "预算与警告",
    "settings.budget.label": "默认 token 预算",
    "settings.budget.unit": "k tokens",
    "settings.budget.hint":
      "里程碑气泡在预算的 25 / 50 / 75 / 90% 触发；填 0 就是关掉。下面每个活跃的 session 可以单独覆盖。",
    "settings.warn.label": "上下文警告",
    "settings.warn.hint": "某个 session 的上下文越过这几道线时，宠物会提醒你。",
    "settings.warn.off": "关闭",
    "settings.warn.early": "早提醒 —— 60 / 75 / 90%",
    "settings.warn.default": "默认 —— 70 / 85 / 95%",
    "settings.warn.late": "晚提醒 —— 80 / 90 / 97%",
    "settings.warn.custom": "自定义 —— {pcts}%",
    "settings.cap.label": "每日 EXP 上限",
    "settings.cap.unit": "EXP / 天",
    "settings.cap.hint": "token 每天最多换多少 EXP —— 免得一个长会话把等级刷出来。",

    // ---- Token 与开销（landscape 0.12 / clawd #102）----
    "settings.section.cost": "Token 与开销",
    "settings.cost.claim":
      "Vibepaws 从不与模型对话。它里面没有任何 API key，也没有任何模型客户端；hook 不往 stdout 写一个字节，并且永远以 0 退出 —— 所以它做的任何事都进不了 agent 的上下文。它花不掉你的 token。如果你的 agent 说这个插件在烧 token，那是它在猜一个自己看不见的程序。",
    "settings.cost.meter": "{calls} 条事件 · {bytes} 发往 127.0.0.1 · 出网 0 字节 · 模型调用 0 次",
    "settings.cost.latency": "中位数：hook 进程 {hook} + Core {core}（p95 {hookP95} / {coreP95}，最近 {sample} 条）",
    "settings.cost.latency.core": "中位数：Core {core}（p95 {coreP95}，最近 {sample} 条）—— 还没有 hook 报过自己的耗时",
    "settings.cost.empty": "还没有数到东西 —— agent 第一次触发 hook 时它就开始了。",
    "settings.cost.hint":
      "从 Core 启动（{since}）起算。字节数是 hook POST 上来的 JSON 本体；hook 耗时由每个 hook 进程自报，量的是「进程启动 → 发出这一条」，其中大头是 Node 自己的启动，而不是我们干的活。别信这扇窗口说的，自己核对：",

    "settings.section.cleanup": "闲置 session",
    "settings.zombie.label": "静默多久算它结束了",
    "settings.zombie.unit": "分钟",
    "settings.zombie.hint":
      "崩掉的 agent 不会跟你道别，所以静默超过这个时长的 session 会被收掉 —— 不发 EXP，也不庆祝。如果 agent 进程已经没了，秒级就能发现，不用等这个时长。",

    "settings.section.sessions": "活跃的 session",
    "settings.sessions.hint": "填了目标能拿 1.1× EXP，漂移判定也才有基准。这里的预算会覆盖上面的默认值。",
    "settings.sessions.empty": "没有活跃的 session —— 启动你的 coding agent 试试",
    "settings.session.goal.placeholder": "这次要做什么？",
    "settings.session.budget": "预算",
    "settings.session.budget.placeholder": "默认",
    "settings.session.meta": "{used}k tokens · 上下文 {pct}%",
    "settings.session.state.working": "干活中",
    "settings.session.state.ready": "待命",
    "settings.session.state.needs-you": "等你",
    "settings.session.state.warning": "告警",
    "settings.session.state.idle": "空闲",
    "settings.session.state.finished": "已结束",

    "settings.section.window": "窗口",
    "settings.window.allspaces": "在所有桌面显示",
    "settings.window.clickthrough": "点击穿透（让点击落到下面的窗口）",
    "settings.window.clickthrough.hint": "不会记住 —— 重启后点击穿透又是关着的。",
    "settings.window.reset": "把宠物放回右下角",
    "settings.window.reset.done": "宠物已回到右下角",
    "settings.language.label": "语言",
    "settings.language.auto": "跟随系统（{locale}）",
    "settings.language.en": "English",
    "settings.language.zh": "简体中文",
    "settings.shellonly": "窗口与语言设置属于 Vibepaws 桌面应用 —— 当前这个页面是在浏览器里打开的。",

    // ---- 危险区（重置 / 删除 / 卸载）----
    "settings.section.danger": "重置与卸载",
    "settings.danger.hint": "Vibepaws 知道的一切都在这台机器上。这几个按钮就是把它收回来的出口 —— 每一个都要按第二下才生效。",
    "settings.danger.footprint": "{sessions} 个 session · {events} 条事件 · {notifications} 条通知 · 占用 {size}",
    "settings.danger.footprint.nosize": "{sessions} 个 session · {events} 条事件 · {notifications} 条通知",
    "settings.danger.pet": "换一只新宠物",
    "settings.danger.pet.hint":
      "重新抽一只 starter，清掉等级、EXP 流水与 memories。session、设置与 hooks 都留着。健康分看的是最近 24 小时的活动，所以糟糕的一天在新宠物身上依然看得见。",
    "settings.danger.data": "删除全部本地数据",
    "settings.danger.data.hint":
      "session、事件、通知、EXP 流水、预算与阈值一起清掉，并在删完后压缩数据库文件 —— 被删的行是真的没了，而不只是从索引里摘掉。回到首次启动的样子，附带一只新抽的宠物。adapter hooks 不动。",
    "settings.danger.uninstall": "移除 adapter hooks",
    "settings.danger.uninstall.hint":
      "把 Vibepaws 从你的 agent 配置里拿出来。删应用之前请先做这一步：残留的 hook 会在此后每一次工具调用上都启动一个进程，去 POST 一个已经没人监听的端口 —— 而你没有任何办法知道 agent 为什么变慢了。",
    "settings.danger.uninstall.none": "没有在任何 agent 配置里发现 Vibepaws hooks —— 无需清理。",
    "settings.danger.confirm": "再按一次确认",
    "settings.danger.target": "{agent} · {scope} — {what}",
    "settings.danger.part.hooks": "{n} 条 hooks",
    "settings.danger.part.statusline": "状态栏",
    "settings.danger.part.plugin": "插件文件",
    "settings.danger.part.broken": "这个文件读不出来 —— 需要手工清理",
    "settings.danger.scope.project": "本仓库",
    "settings.danger.scope.global": "所有项目",
    "settings.danger.done.pet": "认识一下 {name} —— Lv.1，没有历史",
    "settings.danger.done.data": "已删除 {n} 行 —— 回到首次启动的样子",
    "settings.danger.done.uninstall": "已清理 {n} 个文件 —— 请重启你的 coding agent",
    "settings.danger.done.nothing": "没有需要清理的东西",

    // ---- 通知气泡 ----
    "notif.decision.title": "{agent} 需要你",
    "notif.decision.body_question": "等待你的回答",
    "notif.ready.title": "{agent} 待命",
    "notif.ready.body": "已完成一轮，待命中",
    "notif.permission.title": "权限请求",
    "notif.permission.body": "{agent} 想要使用 {tool}",
    "notif.permission.body_unknown": "{agent} 正在等待批准",
    "notif.context.title": "上下文已用 {pct}%",
    "notif.context.body.critical": "建议尽快收尾或新开会话",
    "notif.context.body.high": "注意 token 消耗",
    "notif.context.body.warn": "上下文开始紧张",
    "notif.error.title": "{agent} 出错了",
    "notif.error.body": "出了点问题 — 回终端看看",
    "notif.error.body_kind": "{kind} — 回终端看看",
    "notif.drift.title": "话题漂移提醒",
    "notif.drift.body": "任务可能偏离目标，建议新开一个会话",
    "notif.milestone.title": "已用 {pct}% 预算",
    "notif.milestone.body": "{used}k tokens · 预算 {budget}k",

    // ---- adapter 安装器 CLI ----
    "cli.install.header": "[vibepaws] adapter install — agent={agent}{dry} scope={scope} repo={repo}",
    "cli.backup": "  ↳ 已备份你原来的配置 → {file}",
    "cli.dryrun.write": "[dry-run] 将写入 {file} — 合并后共 {count} 个 hook 事件",
    "cli.capabilities": "  能力声明：{list}",
    "cli.claude.written": "✓ Claude Code hooks 已写入 {file}",
    "cli.claude.note": "  Claude Code 会自动加载 .claude/settings.json（首次需信任该目录）",
    "cli.claude.globalNote": "  全局生效 —— Claude Code 会在所有项目加载 ~/.claude/settings.json（无需逐目录信任）",
    "cli.cleanup.project": "  已从 {file} 移除 {n} 条项目级 Vibepaws hooks，避免在本仓库内重复触发",
    "cli.codex.written": "✓ Codex hooks 已写入 {file}",
    "cli.codex.trust.written": "项目信任已写入 {file}",
    "cli.codex.trust.exists": "项目信任已存在（{file}）",
    "cli.codex.trust.failed": "写入项目信任失败（需手动配置）：{error}",
    "cli.codex.trustNote":
      "\n  ⚠ hooks 信任注册（首次生效需授权，二选一）：\n" +
      "    ① 交互模式：cd {repo} && codex，然后运行 /hooks 批准 vibepaws\n" +
      "    ② headless：codex exec --dangerously-bypass-hook-trust …\n" +
      "  💡 全局安装（可选）：把 {file} 的内容合并到 ~/.codex/hooks.json",
    "cli.pi.dryrun": "[dry-run] 将写入 {file} — pi 插件（vibepaws adapter）",
    "cli.pi.written": "✓ Pi 插件已写入 {file}",
    "cli.pi.cleanup.skill": "  ↳ 已移除废弃的 skill 目录（旧 skill 版 adapter）：{dir}",
    "cli.pi.note":
      "  项目级插件在项目被信任后加载 —— 请在本仓库新开一个 `pi` 会话（或运行 /reload）生效。\n" +
      "  💡 全局安装：加 --global 重装 → ~/.pi/agent/extensions/vibepaws.ts（所有项目生效）",
    "cli.dsh.dryrun": "[dry-run] 将写入 {file} — DeepSeek Harness 插件（vibepaws adapter）",
    "cli.dsh.written": "✓ DeepSeek Harness 插件已写入 {file}",
    "cli.dsh.note":
      "  用 patch overlay 启动 dsh 加载插件：\n" +
      "    dsh web --patch {patch}\n" +
      "  💡 全局安装：加 --global 重装 → ~/.dsh/extensions/vibepaws.cjs（所有项目生效）",
    "cli.selfcheck.start": "\n[自检] 发送测试事件到 Core…",
    "cli.selfcheck.ok": "✓ Core 已记录这个 adapter（adapter_status）",
    "cli.selfcheck.next":
      "  下一步：重启你的 coding agent —— hooks 只在会话开始时读一次，\n" +
      "          已经在跑的会话不会生效 🐾",
    "cli.selfcheck.fail":
      "✗ Core 未响应 — 请先运行 `npm run core`（事件已写入 .vibepaws/events/fallback.jsonl，Core 启动后由 generic bridge 补收）",
    // ---- adapter 卸载器（CLI + 设置窗口共用 note）----
    "cli.uninstall.header": "[vibepaws] adapter 卸载 — agent={agent}{dry} repo={repo}",
    "cli.uninstall.clean": "无需清理 —— 任何 agent 配置里都没有 Vibepaws hooks",
    "cli.uninstall.cleaned": "✓ {who} — 已从 {file} 移除 {what}",
    "cli.uninstall.deleted": "✓ {who} — 已删除 {file}",
    "cli.uninstall.nothing": "· {who} — {file} 里没有我们的东西",
    "cli.uninstall.error": "✗ {who} — {file}：{error}",
    "cli.uninstall.part.hooks": "{n} 条 hooks",
    "cli.uninstall.part.statusRemoved": "状态栏",
    "cli.uninstall.part.statusRestored": "状态栏（已还原你原来那条）",
    "cli.uninstall.purge.hint": "  💡 本地数据（宠物、EXP、session）未动 —— 加 --purge-data 会连 .vibepaws 目录一起删",
    "cli.uninstall.purge.deleted": "✓ 已删除本地数据：{dir}",
    "cli.uninstall.purge.failed": "✗ 无法删除 {dir}：{error}",
    "cli.uninstall.purge.coreRunning":
      "✗ Core 还在运行 —— 请先退出它。在 Core 开着库的时候删数据目录，只会让它继续往一个已经不在目录树里的文件写下去。本次什么都没删。",
    "cli.uninstall.dryDone": "\n[dry-run] 一个字节都没有写入",
    "cli.uninstall.done": "\n完成。请重启你的 coding agent —— hooks 只在会话开始时读一次。",
    "uninstall.note.codexTrust":
      "刻意没动：{file} 里的项目信任条目。Vibepaws 不会去改写你的 TOML —— 如果要清掉，请自己删掉那个 [projects.\"…\"] 段。",
    "uninstall.note.backups": "你原来的配置仍备份在 {files} —— 确认结果无误后可以自行删除。",
    "cli.unknownAgent": "未知 agent：{agent}",
  },
};

/**
 * 取文案。缺 key 时回落英文，再缺则原样返回 key（便于发现漏译，而不是显示空白）。
 * @param {Locale | string} locale
 * @param {string} key
 * @param {Record<string, string | number>} [params]
 * @returns {string}
 */
export function t(locale, key, params) {
  const loc = /** @type {Locale} */ (SUPPORTED_LOCALES.includes(/** @type {Locale} */ (locale)) ? locale : DEFAULT_LOCALE);
  const raw = MESSAGES[loc][key] ?? MESSAGES[DEFAULT_LOCALE][key] ?? key;
  return params ? interpolate(raw, params) : raw;
}

/**
 * @param {string} s
 * @param {Record<string, string | number>} params
 * @returns {string}
 */
function interpolate(s, params) {
  return s.replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));
}
