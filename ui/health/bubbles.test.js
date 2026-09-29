/**
 * 常驻气泡的撤除判定单测。
 *
 * 守两个方向：一个不存在的会话不该继续在屏幕上求人回答（R17），
 * 一个还在等你的会话，气泡一条都不能丢。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { stickyBubbleStale, STALE_PUSH_GRACE_MS } from "./bubbles.js";

const NOW = 1_800_000_000_000;
const old = { agent: "claude_code", session: "s1", createdAt: NOW - STALE_PUSH_GRACE_MS - 1 };
const session = (state, extra = {}) => ({ agent: "claude_code", session_id: "s1", state, ...extra });

test("session 已经不在推送列表里（掉出 LIMIT 50 / 被回收）→ 撤掉", () => {
  assert.equal(stickyBubbleStale(old, [], NOW), true);
  assert.equal(stickyBubbleStale(old, [session("working", { session_id: "other" })], NOW), true);
});

test("session 还在、仍然在等你 → 留着", () => {
  assert.equal(stickyBubbleStale(old, [session("needs-you")], NOW), false);
});

test("session 还在、但不再等你 → 撤掉（老行为不变）", () => {
  assert.equal(stickyBubbleStale(old, [session("working")], NOW), true);
  assert.equal(stickyBubbleStale(old, [session("idle")], NOW), true);
});

test("同 session_id 不同 agent 不算同一个会话", () => {
  const codex = session("needs-you", { agent: "codex" });
  assert.equal(stickyBubbleStale(old, [codex], NOW), true);
});

test("刚出生的气泡不被一份过期的轮询快照撤掉（session 还没进列表 / 还是 working）", () => {
  const fresh = { ...old, createdAt: NOW - 1000 };
  assert.equal(stickyBubbleStale(fresh, [], NOW), false);
  assert.equal(stickyBubbleStale(fresh, [session("working")], NOW), false);
  // 过了宽限期，同一份列表就该生效
  assert.equal(stickyBubbleStale(fresh, [], NOW + STALE_PUSH_GRACE_MS), true);
});
