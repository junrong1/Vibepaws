/**
 * 渲染层 —— 唯一碰 canvas 的地方。
 *
 * 两条素材路径（PNG 精灵 / 程序生成兜底）共用同一套动作变换，所以状态在两条路径上
 * 表现一致。变换顺序必须和 motion.spriteAabb 保持一致，否则「会不会画出界」的单测
 * 就测不到真东西。
 */
import { CANVAS, FOOT_MARGIN, motionAt, spriteAabb } from "./motion.js";
import { drawFx, FX_BEHIND } from "./fx.js";
import { drawProcedural, PROCEDURAL_SCALE, PROCEDURAL_SIZE } from "./procedural.js";
import * as registry from "./registry.js";

/** "<帧 URL>:<tint>" → 预先染好色的离屏 canvas。
 *  键必须带上帧 —— 一只宠物现在有 7 个状态帧，只按 slug 建键会让所有状态共用
 *  第一次染色的那一帧。 */
const tintCache = new Map();

/**
 * 染色必须**预先烘一次**。每帧设 ctx.filter 会让浏览器逐帧重跑一遍滤镜 ——
 * 一个 always-on 的桌面宠物没必要拿电池换这个。
 */
function tinted(img, tint) {
  const key = `${img.src}:${tint}`;
  const hit = tintCache.get(key);
  if (hit) return hit;

  const off = document.createElement("canvas");
  off.width = img.width;
  off.height = img.height;
  const c = off.getContext("2d");
  c.imageSmoothingEnabled = false;
  if (tint === "desat") c.filter = "saturate(0.72) brightness(0.96)";
  else if (tint === "glow") c.filter = "brightness(1.22) saturate(1.15)";
  else if (tint === "warn") c.filter = "saturate(1.22)";
  c.drawImage(img, 0, 0);
  c.filter = "none";
  if (tint === "warn") {
    // 深红而不是橙黄，而且是**压暗**的方向：浅色的暖调罩上去会把深色宠物洗成
    // 一团发白的灰（Lunafang 的深紫直接变成灰粉，读起来像「褪色」而不是「告警」）。
    // 有了逐状态立绘之后浓度大幅调低：warning 帧本身就是皱着眉、挂着一滴汗的，
    // 罩太重会把这些细节糊掉，也会把宠物的本色吃干净。同理 desat 从 0.4 提到 0.72。
    // source-atop 只染本体，不把透明区域涂成一个方块。
    c.globalCompositeOperation = "source-atop";
    c.fillStyle = "rgba(176, 38, 18, 0.13)";
    c.fillRect(0, 0, off.width, off.height);
  }
  tintCache.set(key, off);
  return off;
}

/** 位移插值：只插几何量，tint/fx 立刻跟着新状态切（渐隐的「!」很怪） */
function blendMotion(from, to, k) {
  const mix = (a, b) => a + (b - a) * k;
  return {
    ...to,
    ox: mix(from.ox, to.ox),
    oy: mix(from.oy, to.oy),
    sx: mix(from.sx, to.sx),
    sy: mix(from.sy, to.sy),
    rot: mix(from.rot, to.rot),
  };
}

/**
 * 画一帧。
 * @param anim { state, elapsed, prev: {state, elapsed}|null, blend: 0..1 }
 * @returns { done } 一次性动作（finished / level-up）是否放完 —— 由 app.js 决定回落
 */
export function drawPet(canvas, petTypeId, anim) {
  // 后备缓冲区按**设备像素**算，CSS 尺寸恒为 CANVAS（见 ui/style.css 的 #pet）。
  //
  // 这一层从前没有，代价是 canvas 一直以 208 个像素画完再交给合成器放大：Retina 上
  // 是 2 倍，开了 large 档（0.3）之后是 2.6 倍。放大的是**已经画好的位图**，所以
  // 特效那些细线和程序生成兜底宠物的轮廓都会糊，而且糊的程度还随着尺寸档位变 ——
  // 这也正是 landscape 第 17 条「高 DPI 下画面不对」的一半成因。
  // 现在按 dpr 开缓冲区、再把坐标系缩回 CSS 像素，下面所有绘制代码一个字都不用改。
  //
  // dpr 会跟着 zoomFactor 和「宠物搬到另一块缩放倍率不同的屏上」一起变，每帧现读；
  // 封顶 3 是防一块 3x 屏叠上 large 档开出一张 800² 的缓冲区 —— 那点清晰度没人看得出来，
  // 电池倒是真的在掉。
  const dpr = Math.min(Math.max(globalThis.devicePixelRatio || 1, 1), 3);
  const px = Math.round(CANVAS * dpr);
  // 给 canvas.width 赋值会重建整个后备缓冲区，每帧做一次纯属浪费
  if (canvas.width !== px) canvas.width = px;
  if (canvas.height !== px) canvas.height = px;
  const ctx = canvas.getContext("2d");
  // 每帧重设：下面的 save/restore 只还原到这个基准，而 dpr 变了基准本身就得换
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, CANVAS, CANVAS);
  ctx.imageSmoothingEnabled = false;

  const res = registry.get(petTypeId, anim.state);
  // 正在解码：这一帧什么都不画（几十毫秒，比闪一只别的宠物好看）
  if (res.status === "loading") return { done: false };

  const isSprite = res.status === "sprite";
  const w = isSprite ? res.manifest.w : PROCEDURAL_SIZE;
  const h = isSprite ? res.manifest.h : PROCEDURAL_SIZE;
  const feetX = isSprite ? res.manifest.anchor.feetX : 0.5;
  const overrides = isSprite ? res.manifest.motion : null;
  const accent = isSprite ? res.manifest.accent : null;

  let m = motionAt(anim.state, anim.elapsed, h, overrides);
  const done = m.done;
  if (anim.prev && anim.blend < 1) {
    m = blendMotion(motionAt(anim.prev.state, anim.prev.elapsed, h, overrides), m, anim.blend);
  }

  const box = spriteAabb(m, w, h, feetX);
  if (m.fx && FX_BEHIND.has(m.fx)) drawFx(ctx, m.fx, m.phase, box, accent);

  ctx.save();
  // 变换原点是**脚底**，不是画布中心。绕中心做 squash 会看起来像悬在空中扭 ——
  // 旧实现就是绕中心（ui/pets.js:220），因为那时精灵是 16×16 正方形，看不出来。
  ctx.translate(CANVAS / 2 + m.ox, CANVAS - FOOT_MARGIN + m.oy);
  ctx.rotate(m.rot);
  ctx.scale(m.sx, m.sy);
  if (isSprite) {
    const src = m.tint ? tinted(res.img, m.tint) : res.img;
    ctx.drawImage(src, -feetX * w, -h, w, h);
  } else {
    // 兜底路径不染色 —— 它本来就还有表情这条通道
    drawProcedural(ctx, res.pet, anim.state, -0.5 * w, -h, PROCEDURAL_SCALE);
  }
  ctx.restore();

  if (m.fx && !FX_BEHIND.has(m.fx)) drawFx(ctx, m.fx, m.phase, box, accent);
  return { done };
}
