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
    "ui.panel.more": "+{count} older sessions",
    "ui.action.mute30": "Mute everything for 30 minutes",
    "ui.action.mute2h": "Mute everything for 2 hours",
    "ui.action.unmute": "Muted · {time} left — click to turn notifications back on",
    "ui.action.exp": "EXP breakdown",
    "ui.btn.mute30": "🔕 30m",
    "ui.btn.unmute": "🔔 On",
    "ui.badge.muted": "🔕 {time}",
    "ui.mute.remaining": "Everything muted · {time} left — click to undo",
    "ui.bubble.dismiss": "Dismiss",
    "ui.toast.muted30": "🔕 Muted everything for 30 minutes",
    "ui.toast.muted2h": "😴 Muted everything for 2 hours",
    "ui.toast.unmuted": "🔔 Notifications are back on",
    "ui.toast.actionfailed": "Couldn't reach Core — nothing changed",
    "ui.toast.copied": "Copied: {cmd}",
    "ui.toast.command": "Copy this: {cmd}",
    "ui.session.tooltip": "{project} · last activity {time}",

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

    // ---- 时间 ----
    "ui.time.justnow": "just now",
    "ui.time.seconds": "{n}s",
    "ui.time.minutes": "{n}m",
    "ui.time.hours": "{n}h",
    "ui.time.unknown": "—",

    // ---- 托盘（Electron 主进程）----
    "tray.tooltip": "Vibepaws — your coding pet",
    "tray.clickthrough": "Click-through: {state}",
    "tray.allspaces": "Show on all Spaces: {state}",
    "tray.state.on": "on",
    "tray.state.off": "off",
    "tray.show": "Show pet",
    "tray.reset": "Reset pet position",
    "tray.quit": "Quit Vibepaws",
    "tray.startfailed.title": "Vibepaws could not start",
    "tray.startfailed.body": "The pet window needs its local UI server.\n\n{error}",

    // ---- 通知气泡 ----
    "notif.decision.title": "{agent} needs you",
    "notif.decision.body": "Waiting for your decision",
    "notif.decision.body_kind": "Waiting for your decision ({kind})",
    "notif.decision.body_question": "Waiting for your answer",
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
    "cli.install.header": "[vibepaws] adapter install — agent={agent}{dry} repo={repo}",
    "cli.backup": "  ↳ Backed up your existing config → {file}",
    "cli.dryrun.write": "[dry-run] would write {file} — {count} hook events after merge",
    "cli.capabilities": "  Capabilities: {list}",
    "cli.claude.written": "✓ Claude Code hooks written to {file}",
    "cli.claude.note": "  Claude Code loads .claude/settings.json automatically (you must trust the directory once)",
    "cli.codex.written": "✓ Codex hooks written to {file}",
    "cli.codex.trust.written": "Project trust written to {file}",
    "cli.codex.trust.exists": "Project trust already present ({file})",
    "cli.codex.trust.failed": "Could not write project trust (configure it manually): {error}",
    "cli.codex.trustNote":
      "\n  ⚠ Hook trust (required once before hooks fire — pick one):\n" +
      "    ① Interactive:  cd {repo} && codex, then run /hooks and approve vibepaws\n" +
      "    ② Headless:     codex exec --dangerously-bypass-hook-trust …\n" +
      "  💡 Global install (optional): merge {file} into ~/.codex/hooks.json",
    "cli.selfcheck.start": "\n[self-check] sending a test event to Core…",
    "cli.selfcheck.ok": "✓ Core received the test event (session_started)",
    "cli.selfcheck.next": "  Next: start your coding agent and the pet will come alive 🐾",
    "cli.selfcheck.fail":
      "✗ Core did not respond — run `npm run core` first (the event was buffered to .vibepaws/events/fallback.jsonl and the generic bridge replays it once Core is up)",
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
    "ui.panel.more": "还有 {count} 个较早的 session",
    "ui.action.mute30": "全部安静 30 分钟",
    "ui.action.mute2h": "全部安静 2 小时",
    "ui.action.unmute": "安静中 · 还剩 {time} — 点一下恢复通知",
    "ui.action.exp": "EXP 明细",
    "ui.btn.mute30": "🔕 30分",
    "ui.btn.unmute": "🔔 恢复",
    "ui.badge.muted": "🔕 {time}",
    "ui.mute.remaining": "全部安静中 · 还剩 {time} — 点一下恢复",
    "ui.bubble.dismiss": "关闭",
    "ui.toast.muted30": "🔕 已安静 30 分钟",
    "ui.toast.muted2h": "😴 已安静 2 小时",
    "ui.toast.unmuted": "🔔 通知已恢复",
    "ui.toast.actionfailed": "连不上 Core — 这次操作没有生效",
    "ui.toast.copied": "已复制：{cmd}",
    "ui.toast.command": "手动复制：{cmd}",
    "ui.session.tooltip": "{project} · 最后活动 {time}",

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

    // ---- 时间 ----
    "ui.time.justnow": "刚刚",
    "ui.time.seconds": "{n} 秒",
    "ui.time.minutes": "{n} 分钟",
    "ui.time.hours": "{n} 小时",
    "ui.time.unknown": "—",

    // ---- 托盘（Electron 主进程）----
    "tray.tooltip": "Vibepaws — 你的 coding pet",
    "tray.clickthrough": "点击穿透：{state}",
    "tray.allspaces": "在所有桌面显示：{state}",
    "tray.state.on": "开",
    "tray.state.off": "关",
    "tray.show": "显示宠物",
    "tray.reset": "把宠物放回右下角",
    "tray.quit": "退出 Vibepaws",
    "tray.startfailed.title": "Vibepaws 启动失败",
    "tray.startfailed.body": "宠物窗口依赖本机 UI 服务。\n\n{error}",

    // ---- 通知气泡 ----
    "notif.decision.title": "{agent} 需要你",
    "notif.decision.body": "等待你的决定",
    "notif.decision.body_kind": "等待你的决定（{kind}）",
    "notif.decision.body_question": "等待你的回答",
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
    "cli.install.header": "[vibepaws] adapter install — agent={agent}{dry} repo={repo}",
    "cli.backup": "  ↳ 已备份你原来的配置 → {file}",
    "cli.dryrun.write": "[dry-run] 将写入 {file} — 合并后共 {count} 个 hook 事件",
    "cli.capabilities": "  能力声明：{list}",
    "cli.claude.written": "✓ Claude Code hooks 已写入 {file}",
    "cli.claude.note": "  Claude Code 会自动加载 .claude/settings.json（首次需信任该目录）",
    "cli.codex.written": "✓ Codex hooks 已写入 {file}",
    "cli.codex.trust.written": "项目信任已写入 {file}",
    "cli.codex.trust.exists": "项目信任已存在（{file}）",
    "cli.codex.trust.failed": "写入项目信任失败（需手动配置）：{error}",
    "cli.codex.trustNote":
      "\n  ⚠ hooks 信任注册（首次生效需授权，二选一）：\n" +
      "    ① 交互模式：cd {repo} && codex，然后运行 /hooks 批准 vibepaws\n" +
      "    ② headless：codex exec --dangerously-bypass-hook-trust …\n" +
      "  💡 全局安装（可选）：把 {file} 的内容合并到 ~/.codex/hooks.json",
    "cli.selfcheck.start": "\n[自检] 发送测试事件到 Core…",
    "cli.selfcheck.ok": "✓ Core 已收到测试事件（session_started）",
    "cli.selfcheck.next": "  下一步：启动 coding agent 开始干活，宠物就会动起来 🐾",
    "cli.selfcheck.fail":
      "✗ Core 未响应 — 请先运行 `npm run core`（事件已写入 .vibepaws/events/fallback.jsonl，Core 启动后由 generic bridge 补收）",
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
