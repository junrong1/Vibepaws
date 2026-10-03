/**
 * ui/behavior-motion.js 单测 —— 只测纯换算，不碰 DOM / canvas。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { behaviorOverrides, reactionDelayMs, isAwake } from "./behavior-motion.js";
import { MOTION } from "./pets/motion.js";

test("reactionDelayMs：clamp 到 0..900，缺失为 0", () => {
  assert.equal(reactionDelayMs(null), 0);
  assert.equal(reactionDelayMs({ reactionMs: 400 }), 400);
  assert.equal(reactionDelayMs({ reactionMs: 2000 }), 900);
  assert.equal(reactionDelayMs({ reactionMs: -5 }), 0);
});

test("isAwake：普通窗口与跨午夜窗口", () => {
  const at = (h) => new Date(2024, 0, 1, h, 0);
  assert.equal(isAwake([8, 23], at(9)), true);
  assert.equal(isAwake([8, 23], at(7)), false);
  assert.equal(isAwake([8, 23], at(23)), false);

  // night_owl [20,4]：晚 8 点 – 凌晨 4 点醒着
  assert.equal(isAwake([20, 4], at(22)), true);
  assert.equal(isAwake([20, 4], at(3)), true);
  assert.equal(isAwake([20, 4], at(12)), false);

  // 非法窗口保守视为醒着
  assert.equal(isAwake(null, at(3)), true);
});

test("behaviorOverrides(null) 返回空对象（冷启动保持旧默认）", () => {
  assert.deepEqual(behaviorOverrides("idle", null, false), {});
});

test("idleVariant：focused 更稳、bouncy 更快、sleepy 打盹", () => {
  const focused = behaviorOverrides("idle", { idleVariant: "focused", energy: 0.5, fidget: 0 });
  assert.ok(focused.period > MOTION.idle.period, "focused 应更慢更稳");

  const bouncy = behaviorOverrides("idle", { idleVariant: "bouncy", energy: 1.0, fidget: 0 });
  assert.equal(bouncy.period, 1700);
  assert.equal(bouncy.bobY, 0.034);

  const sleepy = behaviorOverrides("idle", { idleVariant: "sleepy", energy: 0.2, fidget: 0 });
  assert.equal(sleepy.fx, "zzz");
  assert.ok(sleepy.droop > 0);
});

test("fidget：低精确度给 idle 叠上横向抖动", () => {
  const calm = behaviorOverrides("idle", { idleVariant: "calm", energy: 0.5, fidget: 0 });
  assert.equal(calm.shakeX, undefined);
  const fidgety = behaviorOverrides("idle", { idleVariant: "calm", energy: 0.5, fidget: 1.0 });
  assert.ok(fidgety.shakeX > 0);
});

test("celebrate：shipper 收工时 hop 更夸张", () => {
  const normal = behaviorOverrides("finished", { celebrate: false });
  const proud = behaviorOverrides("finished", { celebrate: true });
  assert.ok((proud.hopY ?? 0) > (normal.hopY ?? MOTION.finished.hopY));
});

test("asleep：非关键状态打盹，关键状态绝不盖掉告警", () => {
  const dozing = behaviorOverrides("working", { energy: 0.5, fidget: 0 }, true);
  assert.equal(dozing.fx, "zzz");
  assert.ok(dozing.droop > 0);

  const needYou = behaviorOverrides("needs-you", { energy: 0.5, fidget: 0 }, true);
  assert.equal(needYou.fx, undefined, "needs-you 的 exclaim 不能被 zzz 盖掉");

  const finished = behaviorOverrides("finished", { celebrate: false }, true);
  assert.equal(finished.fx, undefined, "finished 的 sparkle 不能被 zzz 盖掉");
  assert.ok(finished.hopY < (MOTION.finished.hopY ?? 0), "睡觉时庆祝动作收敛");
});
