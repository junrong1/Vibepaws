#!/usr/bin/env node
/**
 * statusline 采集脚本（Claude Code）— 实时 token 通道。
 * .claude/settings.json 配置 statusLine.command 指向本脚本；
 * stdin 每次状态更新收到 JSON（含 context_window.total_input_tokens 等）。
 * 职责：提取 token 数字 → 发 token_update 到 Core（实时，非 SessionEnd 汇总）。
 */
import { readApiToken } from "../core/token.ts";
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { CoreEvent } from "../core/events.ts";

/** 仓库根（由本文件位置反推）：probe 调试日志写回仓库，任意 cwd 下都能找到 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 从 statusLine 输入提取 token 总量（与 Claude 官方口径对齐：input 含缓存读写 + output） */
export function extractStatusLineTokens(input: unknown): {
  input_tokens: number;
  output_tokens: number;
  total: number;
  context_window?: number;
} | null {
  if (!input || typeof input !== "object") return null;
  const o = input as Record<string, unknown>;
  const cw = (o.context_window ?? {}) as Record<string, unknown>;
  const input_tokens = num(cw.total_input_tokens) ?? num(o.total_input_tokens) ?? 0;
  const output_tokens = num(cw.total_output_tokens) ?? num(o.total_output_tokens) ?? 0;
  if (input_tokens <= 0 && output_tokens <= 0) {
    // 再试 current_usage（官方口径：input 含 cache，不含 output）
    const cu = (o.current_usage ?? {}) as Record<string, unknown>;
    const ci = num(cu.input_tokens) ?? 0;
    const co = num(cu.output_tokens) ?? 0;
    if (ci <= 0 && co <= 0) return null;
    return { input_tokens: ci, output_tokens: co, total: ci + co, context_window: num(cw.context_window) };
  }
  return {
    input_tokens,
    output_tokens,
    total: input_tokens + output_tokens,
    context_window: num(cw.context_window),
  };
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

let lastTotal = -1;

export async function handleStatusLine(stdin: string, corePort = 17893): Promise<void> {
  const input = JSON.parse(stdin) as unknown;
  const info = extractStatusLineTokens(input);
  if (!info || info.total <= 0) return;
  // 去重：token 未变化不重复上报
  if (info.total === lastTotal) return;
  lastTotal = info.total;

  const o = input as Record<string, unknown>;
  const sessionId = String(o.session_id ?? o.project ?? "statusline");
  const ev: CoreEvent = {
    event_id: `sl-${sessionId}-${info.total}-${Date.now()}`,
    seq: 0,
    agent: "claude_code",
    session_id: sessionId,
    project_id: String(o.cwd ?? process.cwd()),
    event_type: "token_update",
    severity: "low",
    safe_summary: `Statusline tokens: ${info.total} (in ${info.input_tokens} / out ${info.output_tokens})`,
    timestamp: new Date().toISOString(),
    payload: { tokens: info.total },
  };
  const res = await fetch(`http://127.0.0.1:${corePort}/events`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-vibepaws-token": readApiToken() },
    body: JSON.stringify(ev),
  });
  if (!res.ok) {
    // 静默失败（statusline 高频调用，不刷屏）
  }
}

// CLI 入口：读 stdin 一次
if (import.meta.url === `file://${process.argv[1]}`) {
  const probe = process.argv.includes("--probe");
  let stdin = "";
  process.stdin.on("data", (c) => (stdin += c));
  process.stdin.on("end", () => {
    if (probe) {
      try {
        const dir = join(REPO_ROOT, ".vibepaws", "events");
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        appendFileSync(join(dir, "statusline_probe.log"), `${new Date().toISOString()} ${stdin}\n`);
      } catch {
        // 忽略
      }
      process.exit(0);
    }
    handleStatusLine(stdin).catch(() => process.exit(0));
  });
}
