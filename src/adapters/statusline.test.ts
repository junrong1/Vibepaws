/**
 * statusline token 提取单测（Claude Code statusLine 输入结构）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { extractStatusLineTokens, extractContextPct, renderStatusLine } from "./statusline.ts";

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

test("context_pct 优先用 used_percentage", () => {
  assert.equal(extractContextPct({ context_window: { used_percentage: 6.5, context_window: 200000 } }), 7);
});

test("context_pct 兜底：input / context_window（output 不占 context）", () => {
  const pct = extractContextPct({
    context_window: { context_window: 200000, total_input_tokens: 50000, total_output_tokens: 9999 },
  });
  assert.equal(pct, 25);
});

test("context_pct 缺字段 → undefined，不伪造 0", () => {
  assert.equal(extractContextPct({ context_window: { total_input_tokens: 100 } }), undefined);
  assert.equal(extractContextPct({}), undefined);
  assert.equal(extractContextPct(null), undefined);
});

test("context_pct 夹在 0..100（脏数据不越界）", () => {
  assert.equal(extractContextPct({ context_window: { used_percentage: 150 } }), 100);
  assert.equal(extractContextPct({ context_window: { used_percentage: -3 } }), 0);
});

test("状态栏文案：token 缩写 + context", () => {
  assert.equal(renderStatusLine(42300, 21), "🐾 42.3k · 21% ctx");
  assert.equal(renderStatusLine(950), "🐾 950");
  assert.equal(renderStatusLine(1_250_000, 88), "🐾 1250k · 88% ctx");
});

test("状态栏永不为空：没 token 也给一行", () => {
  assert.equal(renderStatusLine(null), "🐾 0");
});
