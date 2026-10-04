/**
 * 习惯画像 → 动作参数（docs/handoff-habit-layer.md §6.3 的渲染层实现）。
 *
 * behavior.js 只把 profile 映射成「语义」参数（energy/idleVariant/fidget/reactionMs/
 * wakeWindow/celebrate）；本模块把这些语义换算成 motion.js 能吃的**具体 overrides**。
 * 纯函数、不碰 DOM、可单测。behavior 为 null 时返回 {}（= 与旧默认完全一致）。
 */
import { MOTION } from "./pets/motion.js";

function clamp01(n) {
  return Math.min(1, Math.max(0, n));
}

/** 反应延迟：把 reactionMs 收敛到 0..900ms。 */
export function reactionDelayMs(behavior) {
  const ms = behavior?.reactionMs;
  if (typeof ms !== "number" || !Number.isFinite(ms)) return 0;
  return Math.min(900, Math.max(0, ms));
}

/**
 * 是否处于「醒着」窗口。wakeWindow 形如 [startHour, endHour]，可跨午夜（night_owl [20,4]）。
 * 用本地小时（含分钟小数）判定；窗口非法时视为醒着（保守，不把宠物钉死在睡眠态）。
 */
export function isAwake(wakeWindow, date = new Date()) {
  if (!Array.isArray(wakeWindow) || wakeWindow.length !== 2) return true;
  const [start, end] = wakeWindow;
  if (typeof start !== "number" || typeof end !== "number") return true;
  const h = date.getHours() + date.getMinutes() / 60;
  if (start <= end) return h >= start && h < end;
  return h >= start || h < end;
}

/** idleVariant → idle 配方（focused 更稳、bouncy 更快、sleepy 更慢 + 打盹）。 */
function idleVariantMotion(variant) {
  switch (variant) {
    case "focused": return { period: 4600, bobY: 0.006, squash: 0.004 };
    case "bouncy": return { period: 1700, bobY: 0.034, squash: 0.024 };
    case "sleepy": return { period: 6200, bobY: 0.004, droop: 0.03, fx: "zzz" };
    default: return {};
  }
}

/**
 * 计算某个状态的行为 overrides（会与 manifest.motion 合并，行为个性化优先）。
 * @param {string} state 宠物状态（idle/working/needs-you/warning/ready/finished/…）
 * @param {object | null} behavior behaviorFor() 的产物；null = 中立，返回 {}
 * @param {boolean} asleep 是否处于 wakeWindow 之外（打盹）
 */
export function behaviorOverrides(state, behavior, asleep = false) {
  if (!behavior) return {};
  const energy = typeof behavior.energy === "number" ? behavior.energy : 0.5;
  const amp = 0.5 + energy * 0.5; // energy 1.0 → 1.0x，0.2 → 0.6x
  const fidget = clamp01(typeof behavior.fidget === "number" ? behavior.fidget : 0.5);
  const out = {};

  if (state === "idle" || state === "ready") {
    Object.assign(out, idleVariantMotion(behavior.idleVariant));
    const baseBob = out.bobY ?? MOTION.idle.bobY ?? 0;
    const baseSquash = out.squash ?? MOTION.idle.squash ?? 0;
    out.bobY = baseBob * amp;
    out.squash = baseSquash * amp;
    // 精确度低 → 更躁动：给 idle 叠一个低频横向抖动
    if (fidget > 0.02) out.shakeX = 0.02 * fidget;
  } else if (state === "working") {
    out.bobY = (MOTION.working.bobY ?? 0) * amp;
    out.squash = (MOTION.working.squash ?? 0) * amp;
    if (fidget > 0.02) out.shakeX = 0.03 * fidget;
  }

  // shipper 收工时更得意：finished 的 hop 更夸张（sparkle 特效仍由 MOTION.finished 提供）
  if (state === "finished" && behavior.celebrate) {
    out.hopY = (MOTION.finished.hopY ?? 0) * 1.35;
  }

  // 在 wakeWindow 之外打盹：非关键状态趴低 + zzz；关键状态（needs-you/warning）绝不盖掉告警
  if (asleep) {
    if (state === "idle" || state === "working" || state === "ready") {
      out.droop = (out.droop ?? 0) + 0.03;
      out.fx = "zzz";
      out.bobY = (out.bobY ?? 0) * 0.5;
      out.shakeX = (out.shakeX ?? 0) * 0.5;
    } else if (state === "finished") {
      out.hopY = (out.hopY ?? 0) * 0.5;
    }
  }

  return out;
}
