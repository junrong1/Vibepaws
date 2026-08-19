/**
 * token 提取单测：SessionEnd transcript → token 总量。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { extractTokensFromTranscript } from "./hook_agent.ts";

const DIR = join(".vibepaws", "token_test");
const TXT = join(DIR, "session.jsonl");

function setup(lines: string[]): void {
  rmSync(DIR, { recursive: true, force: true });
  mkdirSync(DIR, { recursive: true });
  writeFileSync(TXT, lines.join("\n") + "\n");
}

test("从 assistant message.usage 汇总 token（input+output+cache_creation）", () => {
  setup([
    JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 999 } },
    }),
    JSON.stringify({
      type: "assistant",
      message: { role: "assistant", usage: { input_tokens: 200, output_tokens: 20, cache_read_input_tokens: 500 } },
    }),
  ]);
  const total = extractTokensFromTranscript(TXT);
  assert.equal(total, 100 + 50 + 10 + 200 + 20); // 380（cache_read 不计）
});

test("无 transcript_path → null", () => {
  assert.equal(extractTokensFromTranscript(undefined), null);
});

test("文件不存在/不可读 → null（降级）", () => {
  assert.equal(extractTokensFromTranscript(join(DIR, "nope.jsonl")), null);
});

test("无 usage 条目 → null", () => {
  setup([
    JSON.stringify({ type: "user", message: { role: "user", content: "hi" } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: "ok" } }),
  ]);
  assert.equal(extractTokensFromTranscript(TXT), null);
});

test("坏行跳过不中断", () => {
  setup(["not-json", JSON.stringify({ type: "assistant", message: { role: "assistant", usage: { input_tokens: 7 } } })]);
  assert.equal(extractTokensFromTranscript(TXT), 7);
});
