/**
 * 习惯画像 → 宠物行为参数（docs/handoff-habit-layer.md §6.3）。
 * 纯函数、不碰 DOM，可单测。所有「呈现层」判定都留在这里，Core 只给数字 + 分类标签。
 */

/**
 * @param {object | null | undefined} habit HabitProfile（ready=false 时传 null/undefined → 中立）
 * @returns {{ idleVariant: string, energy: number, wakeWindow: [number, number], reactionMs: number, fidget: number, celebrate: boolean }}
 */
export function behaviorFor(habit) {
  const h = habit ?? {};
  const energy = { burst: 1.0, steady: 0.45, sparse: 0.2 }[h.cadence] ?? 0.5;

  return {
    // depth>0.6 优先于 burst/sparse：深工作进入「心流」姿态，而不是蹦跳
    idleVariant:
      h.depth > 0.6 ? "focused"
        : h.cadence === "burst" ? "bouncy"
          : h.cadence === "sparse" ? "sleepy"
            : "calm",
    energy,
    // 作息窗口（小时，可能跨午夜：night_owl [20,4] 表示晚 8 点 – 凌晨 4 点）
    wakeWindow:
      h.chronotype === "night_owl" ? [20, 4]
        : h.chronotype === "early_bird" ? [5, 21]
          : [8, 23],
    // burst 反应更快（400ms），sparse 更慢（800ms），中立 650ms
    reactionMs: 900 - energy * 500,
    // 精确度低 → 更躁动
    fidget: 1 - (h.precision ?? 0.5),
    celebrate: h.outcome_bias === "shipper",
  };
}
