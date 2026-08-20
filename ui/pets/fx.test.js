/**
 * 特效图形的几何单测。
 *
 * 这些图形是**手算格子**画出来的，而算错的样子在界面上很像「颜色不对」而不是
 * 「坐标不对」—— warning 的三角曾经就是这样：三角只有 5 行，而感叹号从第 3 行画到
 * 第 9 行，于是深色字形一半盖在三角上把它劈成两半、另一半悬在空处变成一根竖条。
 * 看上去像「警示牌只涂了一半色」，实际是越界。
 *
 * 所以这里不测颜色，测**包含关系**：深色字形的每一格都必须落在已填色的区域里。
 * 用一个只记账的假 ctx，不需要 DOM。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { drawFx, FX_BEHIND } from "./fx.js";

/** 记下所有 fillRect 及其当时的 fillStyle */
function recorder() {
  const rects = [];
  const ctx = {
    fillStyle: "#000",
    globalAlpha: 1,
    save() {}, restore() {}, translate() {}, rotate() {},
    fillRect(x, y, w, h) {
      rects.push({ x, y, w, h, fill: String(ctx.fillStyle).toLowerCase() });
    },
  };
  return { ctx, rects };
}

/** 精灵在 canvas 上的包围盒，取自 motion.spriteAabb 的真实量级 */
const BOX = { x0: 24, x1: 184, y0: 44, y1: 204 };

/** 把矩形铺成 1px 网格上的占用集合，键是 "x,y" */
function coverage(rects) {
  const set = new Set();
  for (const r of rects) {
    for (let y = Math.round(r.y); y < Math.round(r.y + r.h); y++) {
      for (let x = Math.round(r.x); x < Math.round(r.x + r.w); x++) set.add(`${x},${y}`);
    }
  }
  return set;
}

test("每个特效都画了东西", () => {
  for (const kind of ["exclaim", "alert", "zzz", "sparkle", "rays", "dust"]) {
    const { ctx, rects } = recorder();
    drawFx(ctx, kind, Math.PI / 2, BOX, "#f89828");
    assert.ok(rects.length > 0, `${kind} 什么都没画`);
  }
});

test("warning 三角：感叹号完全落在三角内部", () => {
  const { ctx, rects } = recorder();
  drawFx(ctx, "alert", Math.PI / 2, BOX, null);

  // 三角是 --warn 橙，字形是 --ink 近黑
  const tri = rects.filter((r) => r.fill === "#f0883e");
  const glyph = rects.filter((r) => r.fill === "#161b22");
  assert.ok(tri.length >= 4, "三角行数太少");
  assert.ok(glyph.length > 0, "没画感叹号");

  const filled = coverage(tri);
  const outside = [];
  for (const g of glyph) {
    for (let y = Math.round(g.y); y < Math.round(g.y + g.h); y++) {
      for (let x = Math.round(g.x); x < Math.round(g.x + g.w); x++) {
        if (!filled.has(`${x},${y}`)) outside.push(`${x},${y}`);
      }
    }
  }
  assert.equal(outside.length, 0,
    `感叹号有 ${outside.length} 个像素落在三角外（会变成悬空的竖条）：${outside.slice(0, 5)}`);
});

test("warning 三角：实心，没有被劈开的空洞", () => {
  const { ctx, rects } = recorder();
  drawFx(ctx, "alert", Math.PI / 2, BOX, null);
  const tri = rects.filter((r) => r.fill === "#f0883e");
  const filled = coverage(tri);

  // 逐行检查：最左到最右之间不能有空格
  const byRow = new Map();
  for (const key of filled) {
    const [x, y] = key.split(",").map(Number);
    const r = byRow.get(y) ?? [Infinity, -Infinity];
    byRow.set(y, [Math.min(r[0], x), Math.max(r[1], x)]);
  }
  for (const [y, [lo, hi]] of byRow) {
    for (let x = lo; x <= hi; x++) {
      assert.ok(filled.has(`${x},${y}`), `三角第 ${y} 行在 x=${x} 处有空洞`);
    }
  }
  // 越往下越宽（三角形该有的样子）
  const rows = [...byRow.entries()].sort((a, b) => a[0] - b[0]);
  const widths = rows.map(([, [lo, hi]]) => hi - lo + 1);
  for (let i = 1; i < widths.length; i++) {
    assert.ok(widths[i] >= widths[i - 1], `第 ${i} 行比上一行窄，不是三角形`);
  }
  assert.ok(widths.at(-1) > widths[0], "上下一样宽，不是三角形");
});

test("rays 画在宠物后面，其余画在前面", () => {
  assert.ok(FX_BEHIND.has("rays"), "升级光芒应该在宠物后面");
  for (const kind of ["exclaim", "alert", "zzz", "sparkle", "dust"]) {
    assert.ok(!FX_BEHIND.has(kind), `${kind} 不该画在宠物后面`);
  }
});

test("特效跟着精灵的包围盒走，不会画到 canvas 外", () => {
  const CANVAS = 208;
  for (const kind of ["exclaim", "alert", "zzz", "sparkle", "dust"]) {
    for (const phase of [0, Math.PI / 3, Math.PI / 2, Math.PI, 4.7]) {
      const { ctx, rects } = recorder();
      drawFx(ctx, kind, phase, BOX, "#f89828");
      for (const r of rects) {
        assert.ok(r.x >= -8 && r.x + r.w <= CANVAS + 8,
          `${kind} 在 phase=${phase.toFixed(1)} 横向出界: x=${r.x} w=${r.w}`);
        assert.ok(r.y >= -8, `${kind} 在 phase=${phase.toFixed(1)} 顶部出界: y=${r.y}`);
      }
    }
  }
});
