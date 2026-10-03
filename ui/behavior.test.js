/**
 * ui/behavior.js 单测 —— 只测纯映射，不碰 DOM。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { behaviorFor } from "./behavior.js";

test("night_owl + burst → bouncy / 高精力 / 夜间窗口", () => {
  const b = behaviorFor({ chronotype: "night_owl", cadence: "burst", depth: 0.5, precision: 0.8, outcome_bias: null });
  assert.equal(b.idleVariant, "bouncy");
  assert.equal(b.energy, 1.0);
  assert.deepEqual(b.wakeWindow, [20, 4]);
  assert.equal(b.reactionMs, 400);
  assert.ok(Math.abs(b.fidget - 0.2) < 1e-9);
  assert.equal(b.celebrate, false);
});

test("deep work → focused（depth 优先于 burst）", () => {
  const b = behaviorFor({ chronotype: "day", cadence: "steady", depth: 0.8, precision: 0.9, outcome_bias: null });
  assert.equal(b.idleVariant, "focused");
  assert.equal(b.energy, 0.45);
  assert.deepEqual(b.wakeWindow, [8, 23]);
});

test("sparse → sleepy / 低精力", () => {
  const b = behaviorFor({ cadence: "sparse", depth: 0.4, precision: 0.5 });
  assert.equal(b.idleVariant, "sleepy");
  assert.equal(b.energy, 0.2);
  assert.equal(b.reactionMs, 800);
});

test("shipper → celebrate", () => {
  assert.equal(behaviorFor({ outcome_bias: "shipper" }).celebrate, true);
  assert.equal(behaviorFor({ outcome_bias: "explorer" }).celebrate, false);
});

test("cold-start / null → 中立", () => {
  const b = behaviorFor(null);
  assert.equal(b.idleVariant, "calm");
  assert.equal(b.energy, 0.5);
  assert.deepEqual(b.wakeWindow, [8, 23]);
  assert.equal(b.reactionMs, 650);
  assert.equal(b.fidget, 0.5);
  assert.equal(b.celebrate, false);
});
