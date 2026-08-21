/**
 * 状态 → 动作。纯函数，不碰 DOM —— 所以能被 ui/pets/motion.test.js 直接单测。
 *
 * 换成 PNG 之后，「表情」这条通道没了：程序生成的宠物每个状态能重画一次眼睛和嘴
 * （旧 ui/pets.js 的 applyExpression），一张 PNG 只有一张脸。状态的可读性因此全部
 * 压到三条不需要逐宠物美术的通道上：**动作 + 叠加特效 + 染色**。
 */

/** canvas 边长。舞台 210x250 扣掉 EXP 条/名牌/内边距还剩约 214，取 208。 */
export const CANVAS = 208;
/** 脚底离 canvas 底边留的余量 */
export const FOOT_MARGIN = 4;
/** sprite 最大边（build_assets.py 里烘死的） */
export const SPRITE_MAX = 160;

/**
 * 动作配方。
 *
 * 振幅一律是**精灵高度的比例**，不是旧代码里的 `scale * k`（ui/pets.js:213-217）——
 * 那种写法只在「所有精灵都恰好 16x16」时成立，现在每只宠物尺寸都不同。
 *
 * period 是一个完整周期的毫秒数。once 表示放几遍就结束（true = 1 遍），
 * 结束后由 app.js 回落到聚合态 —— 庆祝动作不该无限循环。
 */
export const MOTION = {
  idle:        { period: 3100, bobY: 0.020, squash: 0.015 },
  working:     { period:  620, bobY: 0.055, squash: 0.045 },
  "needs-you": { period:  560, shakeX: 0.045,              fx: "exclaim" },
  warning:     { period:  380, shakeX: 0.040, rot: 0.035,  fx: "alert",   tint: "warn" },
  finished:    { period:  900, hopY: 0.090,  once: 3,      fx: "sparkle" },
  tired:       { period: 4200, bobY: 0.010,  droop: 0.030, fx: "zzz",     tint: "desat" },
  "level-up":  { period: 1260, hopY: 0.130,  once: true,   fx: "rays",    tint: "glow" },
};

/** 状态切换时位移插值的时长：不插值的话 working→warning 会瞬移十几个像素 */
export const BLEND_MS = 150;

const TAU = Math.PI * 2;

/**
 * 某一时刻的变换量。
 *
 * `elapsed` 是**进入该状态以来**的毫秒数，不是全局 rAF 时间戳。旧实现所有状态共用
 * 一条连续的 t，于是切状态时正弦相位不重置，同一帧里位移能跳十几个像素；一次性
 * 动作（庆祝、升级）也无从判断「放完了」。
 */
export function motionAt(state, elapsed, spriteH, overrides) {
  const base = MOTION[state] ?? MOTION.idle;
  const m = overrides ? { ...base, ...overrides } : base;
  const h = spriteH || SPRITE_MAX;
  const cycles = m.once === true ? 1 : typeof m.once === "number" ? m.once : Infinity;
  const t = Math.max(0, elapsed);
  const done = t >= m.period * cycles;
  // 放完就停在中立姿态，别把最后一帧的位移留在屏幕上
  const phase = done ? 0 : (t / m.period) * TAU;

  let ox = 0, oy = 0, sx = 1, sy = 1;
  const s = Math.sin(phase);
  /** 0..1 的平滑起落。位移一律**只往上** —— 变换原点在脚底，往下位移就是把脚
   *  插进地板里，同时也会顶破 canvas 下边缘。 */
  const rise = (1 - Math.cos(phase)) / 2;

  if (m.bobY) oy -= rise * m.bobY * h;
  // hop 比 bob 弹：|sin| 的尖峰，落回原地算一次
  if (m.hopY) oy -= Math.abs(s) * m.hopY * h;
  if (m.shakeX) ox += s * m.shakeX * h;
  // squash & stretch 跟起落同相：贴地时压扁、腾空时拉长，横向反向缩放近似保体积。
  // 这是让一张静态图「活起来」最省的一招。
  if (m.squash) {
    const k = rise * 2 - 1; // -1（贴地压扁）..+1（腾空拉长）
    sy = 1 + m.squash * k;
    sx = 1 - m.squash * k;
  }
  // tired 是持续下垂，不是周期动作：竖向压扁，脚仍然踩在基线上
  if (m.droop) { sy -= m.droop; }

  return {
    ox, oy, sx, sy,
    rot: m.rot ? s * m.rot : 0,
    tint: m.tint ?? null,
    fx: m.fx ?? null,
    phase,
    done,
  };
}

/**
 * 变换后精灵在 canvas 上的包围盒。渲染层（ui/pets/render.js）和单测共用这一份
 * 几何，所以「会不会画出界」这件事测出来的就是真的。
 *
 * 变换顺序必须和 render.js 一致：translate(中心+ox, 基线+oy) → rotate → scale，
 * 精灵局部矩形是 x ∈ [-feetX*w, (1-feetX)*w]，y ∈ [-h, 0]（脚在原点）。
 */
export function spriteAabb(m, w, h, feetX = 0.5) {
  const cx = CANVAS / 2 + m.ox;
  const cy = CANVAS - FOOT_MARGIN + m.oy;
  const x0 = -feetX * w, x1 = (1 - feetX) * w;
  const cos = Math.cos(m.rot), sin = Math.sin(m.rot);
  const xs = [], ys = [];
  for (const [lx, ly] of [[x0, -h], [x1, -h], [x1, 0], [x0, 0]]) {
    const px = lx * m.sx, py = ly * m.sy;
    xs.push(cx + px * cos - py * sin);
    ys.push(cy + px * sin + py * cos);
  }
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}
