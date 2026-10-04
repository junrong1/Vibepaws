/**
 * 习惯画像 → 气泡语气（docs/handoff-habit-layer.md §6.4）。
 * 纯函数、不碰 DOM、不含文案 —— i18n key 仍是语言的权威来源；这里只选 emoji + 节奏。
 */

/**
 * @param {string} type 通知类型（decision/permission/context/error/drift/milestone/ready）
 * @param {object | null | undefined} habit HabitProfile
 * @returns {{ emoji: string, pacing: "punchy" | "quiet" | "gentle" | "proud" | "normal" }}
 */
export function voiceVariant(type, habit) {
  const h = habit ?? {};
  // 注意：payload 白名单只有 tool_name，没有 command text，所以 tool_affinity 里
  // 只会有 "Bash"/"Edit"/"Read" 这类工具名。没有 commit/test 信号时这条不触发。
  if (type === "milestone" && (h.tool_affinity ?? []).includes("test")) {
    return { emoji: "✅", pacing: "proud" };
  }
  if (type === "drift") return { emoji: "🤔", pacing: "gentle" };
  if (h.depth > 0.6) return { emoji: "", pacing: "quiet" };
  if (h.cadence === "burst") return { emoji: "⚡", pacing: "punchy" };
  return { emoji: "", pacing: "normal" };
}

/**
 * 按习惯语气渲染气泡正文。t 是可选的翻译函数（app.js 传入；测试传 identity）。
 * @param {object} notif Core 推送的 notification（含 i18n.body 与英文兜底 body）
 * @param {object | null | undefined} habit HabitProfile
 * @param {(key: string, params?: object) => string} [t]
 */
export function renderBubble(notif, habit, t) {
  const variant = voiceVariant(notif?.type, habit);
  const spec = notif?.i18n?.body;
  const text = spec && typeof t === "function" ? t(spec.key, spec.params) : (notif?.body ?? "");
  return variant.emoji ? `${variant.emoji} ${text}` : text;
}
