/**
 * statusline token 提取单测（Claude Code statusLine 输入结构）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractStatusLineTokens } from "./statusline.ts";

test("context_window.total_input_tokens + total_output_tokens", () => {
  const r = extractStatusLineTokens({
    session_id: "s1",
    cwd: "/p",
    context_window: {
      context_window: 200000,
      total_input_tokens: 12345,
      total_output_tokens: 678,
      used_percentage: 6.5,
    },
  });
  assert.equal(r?.total, 12345 + 678);
  assert.equal(r?.context_window, 200000);
});

test("current_usage 兜底（input 含缓存）", () => {
  const r = extractStatusLineTokens({
    current_usage: { input_tokens: 100, output_tokens: 20 },
  });
  assert.equal(r?.total, 120);
  assert.equal(r?.input_tokens, 100);
});

test("无 token 字段 → null", () => {
  assert.equal(extractStatusLineTokens({ session_id: "s1" }), null);
  assert.equal(extractStatusLineTokens(null), null);
  assert.equal(extractStatusLineTokens("x"), null);
});

test("token 为 0 → null（尚未开始消耗）", () => {
  assert.equal(extractStatusLineTokens({ context_window: { total_input_tokens: 0, total_output_tokens: 0 } }), null);
});
