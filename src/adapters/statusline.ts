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

/** context 占用百分比。Claude Code 直接给 context_window.used_percentage；
 * 缺失时用 total_input_tokens / context_window 兜底（input 才占 context，output 不占）。
 * 注意 Core 的 token_update 只写 token_used，context_pct 必须走独立的 context_update 事件。 */
export function extractContextPct(input: unknown): number | undefined {
  if (!input || typeof input !== "object") return undefined;
  const cw = ((input as Record<string, unknown>).context_window ?? {}) as Record<string, unknown>;
  const direct = num(cw.used_percentage);
  if (direct !== undefined) return clampPct(direct);
  const window = num(cw.context_window);
  const used = num(cw.total_input_tokens);
  if (window !== undefined && window > 0 && used !== undefined) return clampPct((used / window) * 100);
  return undefined;
}

function clampPct(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v)));
}

/** 状态栏那一行。statusLine 的 stdout 就是用户看到的内容，所以这行必须先写出去：
 * Core 掉线、token 还没开始烧，用户也不该盯着一条空状态栏。 */
export function renderStatusLine(total: number | null, pct?: number): string {
  const ctx = pct === undefined ? "" : ` · ${pct}% ctx`;
  return `🐾 ${fmtTokens(total ?? 0)}${ctx}`;
}

function fmtTokens(n: number): string {
  if (n < 1000) return `${n}`;
  const k = n / 1000;
  return k < 100 ? `${k.toFixed(1)}k` : `${Math.round(k)}k`;
}

let lastTotal = -1;

export async function handleStatusLine(stdin: string, corePort = 17893): Promise<void> {
  let input: unknown = null;
  try {
    input = JSON.parse(stdin);
  } catch {
    // 坏 JSON 不该把状态栏打空
  }
  const info = extractStatusLineTokens(input);
  const pct = extractContextPct(input);

  // 先写状态栏，再上报：网络那一步失败也不影响用户看到的那一行
  process.stdout.write(renderStatusLine(info?.total ?? null, pct));

  if (!info || info.total <= 0) return;
  // 去重：token 未变化不重复上报
  if (info.total === lastTotal) return;
  lastTotal = info.total;

  const o = (input ?? {}) as Record<string, unknown>;
  const sessionId = String(o.session_id ?? o.project ?? "statusline");
  const base = {
    seq: 0,
    agent: "claude_code" as const,
    session_id: sessionId,
    project_id: String(o.cwd ?? process.cwd()),
    severity: "low" as const,
    timestamp: new Date().toISOString(),
  };
  const stamp = Date.now();
  const events: CoreEvent[] = [
    {
      ...base,
      event_id: `sl-${sessionId}-${info.total}-${stamp}`,
      event_type: "token_update",
      safe_summary: `Statusline tokens: ${info.total} (in ${info.input_tokens} / out ${info.output_tokens})`,
      payload: { tokens: info.total },
    },
  ];
  // context_pct 只有 context_update 会落库（registry.ts），所以单独发一条
  if (pct !== undefined) {
    events.push({
      ...base,
      event_id: `sl-ctx-${sessionId}-${pct}-${stamp}`,
      event_type: "context_update",
      safe_summary: `Statusline context: ${pct}%`,
      payload: { context_pct: pct },
    });
  }

  await Promise.all(
    events.map((ev) =>
      fetch(`http://127.0.0.1:${corePort}/events`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-vibepaws-token": readApiToken() },
        body: JSON.stringify(ev),
      }).catch(() => {
        // 静默失败（statusline 高频调用，不刷屏）
      }),
    ),
  );
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
