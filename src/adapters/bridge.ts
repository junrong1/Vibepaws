#!/usr/bin/env node
/**
 * generic bridge — 兜底通道（架构 §2.1 generic bridge）。
 * 监听两处 *.jsonl 缓冲目录，逐行解析 → 归一化 → POST Core。支持 --once。
 *   · <cwd>/.vibepaws/events  —— hook_agent / pi_agent 手动发射器的 fallback.jsonl
 *   · ~/.vibepaws/events        —— pi 插件（自包含、不知道仓库路径）的离线兜底
 * 任意工具都可往这两处写 JSONL 接入。
 */
import { readdirSync, readFileSync, renameSync, watch, existsSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";
import { homedir } from "node:os";
import { normalizeHook, deliver, type HookInput } from "./hook_agent.ts";
import type { CoreEvent } from "../core/events.ts";

const ONCE = process.argv.includes("--once");
const portIdx = process.argv.indexOf("--port");
const PORT = portIdx >= 0 ? Number(process.argv[portIdx + 1]) : 17893;

function isStandardEvent(line: unknown): line is CoreEvent {
  const o = line as Record<string, unknown>;
  return typeof o?.event_type === "string" && typeof o?.event_id === "string" && typeof o?.agent === "string";
}

/** 任意 JSONL 行 → CoreEvent（标准事件直通，hook 原始输入走 normalizeHook） */
export function normalizeLine(raw: unknown): CoreEvent | null {
  if (isStandardEvent(raw)) {
    return raw as CoreEvent;
  }
  const hook = raw as HookInput;
  if (!hook || typeof hook !== "object") return null;
  const agent = typeof hook.agent === "string" && ["claude_code", "codex"].includes(hook.agent)
    ? (hook.agent as "claude_code" | "codex")
    : "generic";
  return normalizeHook(hook, agent);
}

export async function processFile(file: string, port: number): Promise<number> {
  if (extname(file) !== ".jsonl") return 0;
  const lines = readFileSync(file, "utf-8").split("\n").filter((l) => l.trim());
  let sent = 0;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      const ev = normalizeLine(parsed);
      if (ev && (await deliver(ev, port))) sent++;
    } catch {
      // 跳过坏行
    }
  }
  return sent;
}

/** 缓冲目录（去重；cwd 可能就是 home 目录本身） */
function eventDirs(): string[] {
  return [...new Set([
    join(process.cwd(), ".vibepaws", "events"),
    join(homedir(), ".vibepaws", "events"),
  ])];
}

export async function drainOnce(port: number): Promise<number> {
  let total = 0;
  for (const dir of eventDirs()) {
    if (!existsSync(dir)) continue;
    const doneDir = join(dir, "done");
    if (!existsSync(doneDir)) mkdirSync(doneDir, { recursive: true });
    for (const name of readdirSync(dir)) {
      const file = join(dir, name);
      if (extname(file) !== ".jsonl") continue;
      const n = await processFile(file, port);
      total += n;
      if (n > 0) renameSync(file, join(doneDir, name));
    }
  }
  return total;
}

async function main(): Promise<void> {
  for (const dir of eventDirs()) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (!existsSync(join(dir, "done"))) mkdirSync(join(dir, "done"), { recursive: true });
  }
  const initial = await drainOnce(PORT);
  console.log(`[bridge] initial drain: ${initial} events`);
  if (ONCE) process.exit(0);

  for (const dir of eventDirs()) {
    console.log(`[bridge] watching ${dir} …`);
    watch(dir, async (_event, filename) => {
      if (!filename || !filename.toString().endsWith(".jsonl")) return;
      const file = join(dir, filename.toString());
      const doneDir = join(dir, "done");
      // 等待写入完成（文件可能还在 append）
      setTimeout(async () => {
        try {
          const n = await processFile(file, PORT);
          if (n > 0) {
            renameSync(file, join(doneDir, filename.toString()));
            console.log(`[bridge] forwarded ${n} events from ${filename}`);
          }
        } catch (err) {
          console.error("[bridge] process error:", err);
        }
      }, 300);
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
