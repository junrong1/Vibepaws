/**
 * 把「习惯 → 动画」渲染成 PNG 预览图，用来肉眼验证最终效果。
 * 复用纯渲染函数（procedural / motion / fx / behavior / behavior-motion），不碰 DOM。
 *
 * 运行：node scripts/render_habit_preview.js
 * 输出：habit_preview.png（项目根目录）
 */
import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { makePetFrame, applyExpression, PETS } from "../ui/pets/procedural.js";
import { MOTION, motionAt, spriteAabb } from "../ui/pets/motion.js";
import { drawFx } from "../ui/pets/fx.js";
import { behaviorFor } from "../ui/behavior.js";
import { behaviorOverrides } from "../ui/behavior-motion.js";

/* ---------------- PNG 编码（无依赖） ---------------- */
let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePng(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const stride = w * 4 + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0; // filter none
    rgba.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/* ---------------- 光栅化工具 ---------------- */
function hexColor(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function fillOpaque(dst, W, H, x0, y0, x1, y1, hex) {
  const [r, g, b] = hexColor(hex);
  const cx0 = Math.max(0, Math.floor(x0));
  const cy0 = Math.max(0, Math.floor(y0));
  const cx1 = Math.min(W - 1, Math.ceil(x1));
  const cy1 = Math.min(H - 1, Math.ceil(y1));
  for (let y = cy0; y <= cy1; y++) for (let x = cx0; x <= cx1; x++) {
    const i = (y * W + x) * 4;
    dst[i] = r; dst[i + 1] = g; dst[i + 2] = b; dst[i + 3] = 255;
  }
}
function fillBlend(dst, W, H, x0, y0, x1, y1, hex, a) {
  const [r, g, b] = hexColor(hex);
  const cx0 = Math.max(0, Math.floor(x0));
  const cy0 = Math.max(0, Math.floor(y0));
  const cx1 = Math.min(W - 1, Math.ceil(x1));
  const cy1 = Math.min(H - 1, Math.ceil(y1));
  for (let y = cy0; y <= cy1; y++) for (let x = cx0; x <= cx1; x++) {
    const i = (y * W + x) * 4;
    dst[i] = Math.round(r * a + dst[i] * (1 - a));
    dst[i + 1] = Math.round(g * a + dst[i + 1] * (1 - a));
    dst[i + 2] = Math.round(b * a + dst[i + 2] * (1 - a));
    dst[i + 3] = 255;
  }
}

/** fx.js 的假 ctx：记录 fillRect（含 fillStyle / globalAlpha），save/restore 正确还原。 */
function recorder() {
  const rects = [];
  const ctx = {
    fillStyle: "#000",
    globalAlpha: 1,
    _stack: [],
    save() { this._stack.push({ fillStyle: this.fillStyle, globalAlpha: this.globalAlpha }); },
    restore() { const s = this._stack.pop(); if (s) { this.fillStyle = s.fillStyle; this.globalAlpha = s.globalAlpha; } },
    translate() {},
    rotate() {},
    fillRect(x, y, w, h) { rects.push({ x, y, w, h, fill: String(this.fillStyle).toLowerCase(), alpha: this.globalAlpha }); },
  };
  return { ctx, rects };
}

/* ---------------- 单帧渲染 ---------------- */
const CANVAS = 208; // 与 motion.js 一致；之后统一缩放到目标尺寸
const EXPR = { idle: "normal", working: "normal", finished: "happy", tired: "closed", ready: "normal", "needs-you": "alert", warning: "angry" };

function petGrid(state) {
  return applyExpression(makePetFrame(PETS[0].palette, PETS[0].shape), EXPR[state] ?? "normal");
}

/**
 * 渲染一帧到 dst（在 (ox,oy) 处，边长 C）。
 * 全部按 motion.js 的 208 坐标系计算，再乘以 k=C/208 缩放。
 */
function renderFrame(dst, W, H, ox, oy, C, state, behavior, asleep, phase) {
  const k = C / CANVAS;
  const overrides = behaviorOverrides(state, behavior, asleep);
  const base = MOTION[state] ?? MOTION.idle;
  const period = overrides.period ?? base.period ?? 1000;
  const elapsed = (phase / (Math.PI * 2)) * period;
  const m = motionAt(state, elapsed, 160, overrides); // 160 = PROCEDURAL_SIZE，208 坐标
  const box = spriteAabb(m, 160, 160, 0.5);

  const centerX = CANVAS / 2 + m.ox;
  const baselineY = CANVAS - 4 + m.oy; // FOOT_MARGIN = 4
  const cell = 10; // 16×16 网格每格 10px（208 坐标）
  const grid = petGrid(state);

  for (let gy = 0; gy < 16; gy++) {
    for (let gx = 0; gx < 16; gx++) {
      const c = grid[gy][gx];
      if (!c) continue;
      const lx = (gx - 8 + 0.5) * cell;
      const ly = (gy - 16 + 0.5) * cell;
      const cx = centerX + lx * m.sx;
      const cy = baselineY + ly * m.sy;
      const hw = (cell * m.sx) / 2;
      const hh = (cell * m.sy) / 2;
      fillOpaque(dst, W, H, ox + cx * k, oy + cy * k, ox + (cx + hw) * k, oy + (cy + hh) * k, c);
    }
  }

  if (m.fx) {
    const { ctx, rects } = recorder();
    drawFx(ctx, m.fx, m.phase, box, null);
    for (const r of rects) {
      fillBlend(dst, W, H, ox + r.x * k, oy + r.y * k, ox + (r.x + r.w) * k, oy + (r.y + r.h) * k, r.fill, r.alpha);
    }
  }
}

/* ---------------- 组合图 ---------------- */
const C = 104;          // 每帧边长
const GAP = 8;          // 帧间距
const MARGIN = 10;      // 外边距
const FRAMES = 3;       // 每行 3 帧（相位 0 / π/2 / π）
const PHASES = [0, Math.PI / 2, Math.PI];

const ROWS = [
  { label: "cold-start · idle (neutral)", profile: null, state: "idle", asleep: false },
  { label: "night_owl + burst · idle (bouncy)", profile: { chronotype: "night_owl", cadence: "burst", depth: 0.5, precision: 0.8, outcome_bias: "shipper", tool_affinity: ["Bash", "Edit"] }, state: "idle", asleep: false },
  { label: "sparse · idle (sleepy zzz)", profile: { cadence: "sparse", depth: 0.4, precision: 0.7 }, state: "idle", asleep: false },
  { label: "deep work · idle (focused)", profile: { cadence: "steady", depth: 0.8, precision: 0.95 }, state: "idle", asleep: false },
  { label: "low precision · idle (fidget)", profile: { cadence: "steady", depth: 0.4, precision: 0.3 }, state: "idle", asleep: false },
  { label: "shipper · finished (celebrate)", profile: { cadence: "burst", depth: 0.5, precision: 0.8, outcome_bias: "shipper", tool_affinity: ["Bash", "Edit"] }, state: "finished", asleep: false },
  { label: "night_owl at noon · idle (asleep)", profile: { chronotype: "night_owl", cadence: "burst", depth: 0.5, precision: 0.8, outcome_bias: "shipper", tool_affinity: ["Bash", "Edit"] }, state: "idle", asleep: true },
];

const W = MARGIN * 2 + FRAMES * C + (FRAMES - 1) * GAP;
const H = MARGIN * 2 + ROWS.length * C + (ROWS.length - 1) * GAP;
const dst = Buffer.alloc(W * H * 4);
// 浅色背景
for (let i = 0; i < W * H; i++) { dst[i * 4] = 0xe6; dst[i * 4 + 1] = 0xed; dst[i * 4 + 2] = 0xf3; dst[i * 4 + 3] = 255; }

ROWS.forEach((row, r) => {
  const behavior = row.profile ? behaviorFor(row.profile) : null;
  PHASES.forEach((phase, f) => {
    const ox = MARGIN + f * (C + GAP);
    const oy = MARGIN + r * (C + GAP);
    renderFrame(dst, W, H, ox, oy, C, row.state, behavior, row.asleep, phase);
  });
});

writeFileSync("habit_preview.png", encodePng(W, H, dst));
console.log(`[render] 写出 habit_preview.png（${W}×${H}）`);
console.log("[render] 行序（每行 3 帧 = 相位 0 / π/2 / π）：");
ROWS.forEach((row, i) => console.log(`  ${i + 1}. ${row.label}`));
