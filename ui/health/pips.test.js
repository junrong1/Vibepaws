/**
 * pip 条单测（R12）。
 *
 * 整套编码压在一条线上：亮着的一串碰到宽缝 = 70。守的是那条线两侧的每一格，
 * 以及「不知道」的两种写法和「0 分」三者互相分得开。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PIP_CELLS,
  PIP_GAP_AFTER,
  NEUTRAL_AT,
  scoreStrip,
  litCells,
  pipBand,
  nameplateStrip,
  healthSurfaces,
} from "./pips.js";

const today = (mean) => ({ mean, health: mean === null ? null : 1, unknown: mean === null, segments: mean === null ? 0 : 1 });

test("格数与缝的位置就是 70 这条线", () => {
  assert.equal(PIP_CELLS, 10);
  assert.equal(PIP_GAP_AFTER * 10, NEUTRAL_AT);
});

test("82 → 8 格亮、中性色、缝闭合", () => {
  const s = scoreStrip(82);
  assert.equal(s.lit, 8);
  assert.equal(s.band, "neutral");
  assert.equal(s.gapClosed, true);
  assert.deepEqual(s.cells, [true, true, true, true, true, true, true, true, false, false]);
});

test("正好 70 → 7 格、缝闭合（整套编码靠的就是这一格）", () => {
  const s = scoreStrip(70);
  assert.equal(s.lit, 7);
  assert.equal(s.gapClosed, true);
  assert.equal(s.band, "neutral");
});

test("69 → 6 格、缝前那一格是暗的、琥珀", () => {
  const s = scoreStrip(69);
  assert.equal(s.lit, 6);
  assert.equal(s.cells[PIP_GAP_AFTER - 1], false, "缝前那一格必须是暗的");
  assert.equal(s.gapClosed, false);
  assert.equal(s.band, "amber");
});

test("49 → 红；50 → 琥珀；100 → 十格全亮", () => {
  assert.equal(pipBand(49), "red");
  assert.equal(pipBand(50), "amber");
  const full = scoreStrip(100);
  assert.equal(full.lit, 10);
  assert.ok(full.cells.every(Boolean));
});

test("小数向下取整：79.9 永远不读成 80", () => {
  assert.equal(litCells(79.9), 7);
  assert.equal(litCells(69.99), 6);
  assert.equal(scoreStrip(79.9).lit, 7);
});

test("越界与脏值收进 0..10", () => {
  assert.equal(litCells(-5), 0);
  assert.equal(litCells(250), 10);
  assert.equal(litCells(NaN), 0);
  assert.equal(pipBand(null), null);
});

test("真的 0 分（有样本）→ 0 格亮，但它是一个分数，和「不知道」分得开", () => {
  const zero = nameplateStrip(today(0), "ok");
  assert.equal(zero.kind, "score");
  assert.equal(zero.lit, 0);
  assert.equal(zero.band, "red");
  const empty = nameplateStrip(today(null), "ok");
  assert.equal(empty.kind, "empty");
  assert.notEqual(zero.kind, empty.kind);
});

test("今天还没有样本 → 十个空心格（empty）", () => {
  const s = nameplateStrip(today(null), "ok");
  assert.equal(s.kind, "empty");
  assert.equal(s.cells.length, 10);
  assert.ok(s.cells.every((c) => c === false));
  assert.equal(s.score, null);
  // 老 Core 不发 health_today
  assert.equal(nameplateStrip(undefined, "ok").kind, "empty");
});

test("Core 连不上 → offline，和「没样本」长得不一样；哪怕手里还有上一个分数也不画它", () => {
  for (const conn of ["off", "degraded", "unknown"]) {
    const s = nameplateStrip(today(82), conn);
    assert.equal(s.kind, "offline", `${conn} 下不该继续挂着 82`);
    assert.equal(s.lit, 0);
    assert.notEqual(s.kind, nameplateStrip(today(null), "ok").kind);
  }
  assert.equal(nameplateStrip(today(82), "ok").kind, "score");
});

test("可见性三档：默认（以及认不出的值）只在浮层；off 两处都不画", () => {
  assert.deepEqual(healthSurfaces("off"), { nameplate: false, flyout: false });
  assert.deepEqual(healthSurfaces("flyout"), { nameplate: false, flyout: true });
  assert.deepEqual(healthSurfaces("everywhere"), { nameplate: true, flyout: true });
  assert.deepEqual(healthSurfaces(undefined), { nameplate: false, flyout: true });
  assert.deepEqual(healthSurfaces("loud"), { nameplate: false, flyout: true });
});
