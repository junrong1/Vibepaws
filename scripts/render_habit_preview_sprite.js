/**
 * 把「习惯 → 动画」套到**你自己的 PNG 宠物**上，渲染成预览图。
 * 默认渲染 index.local.json 里的 denia；`node scripts/render_habit_preview_sprite.js [slug]`。
 * 无 DOM 依赖：内置最小 PNG 解码器（RGBA/8bit/无隔行）+ 复用纯 motion/fx/behavior 函数。
 */
import { deflateSync, inflateSync } from "node:zlib";
import { readFileSync, writeFileSync } from "node:fs";
import { MOTION, motionAt, spriteAabb } from "../ui/pets/motion.js";
import { drawFx } from "../ui/pets/fx.js";
import { behaviorFor } from "../ui/behavior.js";
import { behaviorOverrides } from "../ui/behavior-motion.js";

const slug = process.argv[2] ?? "denia";

/* ---------------- 读取素材清单 ---------------- */
const manifest = JSON.parse(readFileSync("ui/pets/index.local.json", "utf8")).pets
  .concat(JSON.parse(readFileSync("ui/pets/index.json", "utf8")).pets)
  .find((p) => p.slug === slug);
if (!manifest) {
  console.error(`找不到 slug=${slug}`);
  process.exit(1);
}
const framePath = (state) => manifest.frames?.[state] ?? manifest.base;

/* ---------------- PNG 解码（最小实现：RGBA/8bit/无隔行） ---------------- */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}
function decodePng(buf) {
  let pos = 8, width = 0, height = 0, colorType = 0, bitDepth = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.slice(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9];
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (colorType !== 6 || bitDepth !== 8) throw new Error(`不支持 colorType=${colorType} bitDepth=${bitDepth}`);
  const raw = inflateSync(Buffer.concat(idat));
  const bpp = 4, stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  let prev = Buffer.alloc(stride);
  let off = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[off++];
    const cur = Buffer.from(raw.slice(off, off + stride));
    off += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = cur[x];
      if (filter === 1) v = (v + a) & 0xff;
      else if (filter === 2) v = (v + b) & 0xff;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) v = (v + paeth(a, b, c)) & 0xff;
      out[y * stride + x] = v;
      cur[x] = v;
    }
    prev = cur;
  }
  return { width, height, data: out };
}

/* ---------------- PNG 编码 ---------------- */
let crcTable = null;
function crc32(buf) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c; }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePng(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const stride = w * 4 + 1, raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) { raw[y * stride] = 0; rgba.copy(raw, y * stride + 1, y * w * 4, (y + 1) * w * 4); }
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

/* ---------------- 光栅化 ---------------- */
function hexColor(hex) { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function blendPixel(dst, W, H, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  dst[i] = Math.round(r * a + dst[i] * (1 - a));
  dst[i + 1] = Math.round(g * a + dst[i + 1] * (1 - a));
  dst[i + 2] = Math.round(b * a + dst[i + 2] * (1 - a));
  dst[i + 3] = 255;
}
function recorder() {
  const rects = [];
  const ctx = {
    fillStyle: "#000", globalAlpha: 1, _stack: [],
    save() { this._stack.push({ fillStyle: this.fillStyle, globalAlpha: this.globalAlpha }); },
    restore() { const s = this._stack.pop(); if (s) { this.fillStyle = s.fillStyle; this.globalAlpha = s.globalAlpha; } },
    translate() {}, rotate() {},
    fillRect(x, y, w, h) { rects.push({ x, y, w, h, fill: String(this.fillStyle).toLowerCase(), alpha: this.globalAlpha }); },
  };
  return { ctx, rects };
}

function renderFrame(dst, W, H, ox, oy, C, state, behavior, asleep, phase, img) {
  const k = C / 208;
  const overrides = behaviorOverrides(state, behavior, asleep);
  const base = MOTION[state] ?? MOTION.idle;
  const period = overrides.period ?? base.period ?? 1000;
  const elapsed = (phase / (Math.PI * 2)) * period;
  const m = motionAt(state, elapsed, 160, overrides);
  const box = spriteAabb(m, 160, 160, manifest.anchor.feetX ?? 0.5);
  const centerX = 104 + m.ox, baselineY = 204 + m.oy;
  const { width: w, height: h, data } = img;
  const feetX = manifest.anchor.feetX ?? 0.5;

  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const si = (py * w + px) * 4;
      const a = data[si + 3];
      if (a === 0) continue;
      const lx = px - feetX * w + 0.5;
      const ly = py - h + 0.5;
      const dx = Math.round(ox + (centerX + lx * m.sx) * k);
      const dy = Math.round(oy + (baselineY + ly * m.sy) * k);
      blendPixel(dst, W, H, dx, dy, data[si], data[si + 1], data[si + 2], a / 255);
    }
  }

  if (m.fx) {
    const { ctx, rects } = recorder();
    drawFx(ctx, m.fx, m.phase, box, manifest.accent ?? null);
    for (const r of rects) {
      const [rr, gg, bb] = hexColor(r.fill);
      const x0 = ox + r.x * k, y0 = oy + r.y * k, x1 = ox + (r.x + r.w) * k, y1 = oy + (r.y + r.h) * k;
      for (let y = Math.floor(y0); y <= Math.ceil(y1); y++)
        for (let x = Math.floor(x0); x <= Math.ceil(x1); x++)
          blendPixel(dst, W, H, x, y, rr, gg, bb, r.alpha);
    }
  }
}

/* ---------------- 组合图 ---------------- */
const C = 208, GAP = 8, MARGIN = 10, PHASES = [0, Math.PI / 2, Math.PI];
const ROWS = [
  { label: "cold-start · idle (neutral)", profile: null, state: "idle", asleep: false },
  { label: "night_owl + burst · idle (bouncy)", profile: { chronotype: "night_owl", cadence: "burst", depth: 0.5, precision: 0.8, outcome_bias: "shipper", tool_affinity: ["Bash", "Edit"] }, state: "idle", asleep: false },
  { label: "sparse · idle (sleepy zzz)", profile: { cadence: "sparse", depth: 0.4, precision: 0.7 }, state: "idle", asleep: false },
  { label: "deep work · idle (focused)", profile: { cadence: "steady", depth: 0.8, precision: 0.95 }, state: "idle", asleep: false },
  { label: "low precision · idle (fidget)", profile: { cadence: "steady", depth: 0.4, precision: 0.3 }, state: "idle", asleep: false },
  { label: "shipper · finished (celebrate)", profile: { cadence: "burst", depth: 0.5, precision: 0.8, outcome_bias: "shipper", tool_affinity: ["Bash", "Edit"] }, state: "finished", asleep: false },
  { label: "night_owl at noon · idle (asleep)", profile: { chronotype: "night_owl", cadence: "burst", depth: 0.5, precision: 0.8, outcome_bias: "shipper", tool_affinity: ["Bash", "Edit"] }, state: "idle", asleep: true },
];

const frames = { idle: decodePng(readFileSync(`ui/pets/${framePath("idle")}`)), finished: decodePng(readFileSync(`ui/pets/${framePath("finished")}`)) };

const W = MARGIN * 2 + PHASES.length * C + (PHASES.length - 1) * GAP;
const H = MARGIN * 2 + ROWS.length * C + (ROWS.length - 1) * GAP;
const dst = Buffer.alloc(W * H * 4);
for (let i = 0; i < W * H; i++) { dst[i * 4] = 0xe6; dst[i * 4 + 1] = 0xed; dst[i * 4 + 2] = 0xf3; dst[i * 4 + 3] = 255; }

ROWS.forEach((row, r) => {
  const behavior = row.profile ? behaviorFor(row.profile) : null;
  const img = frames[row.state] ?? frames.idle;
  PHASES.forEach((phase, f) => {
    renderFrame(dst, W, H, MARGIN + f * (C + GAP), MARGIN + r * (C + GAP), C, row.state, behavior, row.asleep, phase, img);
  });
});

const out = `${slug}_habit_preview.png`;
writeFileSync(out, encodePng(W, H, dst));
console.log(`[render] 写出 ${out}（${W}×${H}，pet=${slug}）`);
ROWS.forEach((row, i) => console.log(`  ${i + 1}. ${row.label}`));
