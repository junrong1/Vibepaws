/**
 * ui/voice.js 单测 —— 只测语气映射，不碰 DOM / i18n 目录。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { voiceVariant, renderBubble } from "./voice.js";

test("drift → gentle + 🤔", () => {
  assert.deepEqual(voiceVariant("drift", {}), { emoji: "🤔", pacing: "gentle" });
});

test("deep work → quiet（无 emoji，不打扰）", () => {
  assert.deepEqual(voiceVariant("milestone", { depth: 0.8, tool_affinity: [] }), { emoji: "", pacing: "quiet" });
});

test("burst → punchy + ⚡", () => {
  assert.deepEqual(voiceVariant("ready", { cadence: "burst", depth: 0.4 }), { emoji: "⚡", pacing: "punchy" });
});

test("milestone + test affinity → proud + ✅", () => {
  assert.deepEqual(voiceVariant("milestone", { tool_affinity: ["Bash", "test"] }), { emoji: "✅", pacing: "proud" });
});

test("未知类型 / 空画像 → normal", () => {
  assert.deepEqual(voiceVariant("permission", {}), { emoji: "", pacing: "normal" });
});

test("renderBubble 用 emoji 前缀 + 可选的 t 本地化正文", () => {
  const notif = { type: "drift", i18n: { body: { key: "notif.drift.body", params: {} } }, body: "drift fallback" };
  const t = (key) => (key === "notif.drift.body" ? "Consider a new session" : key);
  assert.equal(renderBubble(notif, {}, t), "🤔 Consider a new session");
  assert.equal(renderBubble({ type: "ready", body: "ready" }, {}, t), "ready");
});
