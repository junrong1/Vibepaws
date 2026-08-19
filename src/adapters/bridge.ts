#!/usr/bin/env node
/**
 * generic bridge — 兜底通道（架构 §2.1 generic bridge）。
 * 监听 .vibepaws/events/*.jsonl（hook_agent 离线兜底写入目录），
 * 逐行解析 → 归一化 → POST Core。支持 --once（处理现有文件后退出）。
 * 任意工具都可往该目录写 JSONL 接入（含未来的 Pi adapter）。
 */
import { readdirSync, readFileSync, renameSync, watch, existsSync, mkdirSync } from "node:fs";
import { join, extname } from "node:path";
import { normalizeHook, deliver, type HookInput } from "./hook_agent.ts";
import type { CoreEvent } from "../core/events.ts";

const EVENTS_DIR = join(".vibepaws", "events");
const DONE_DIR = join(EVENTS_DIR, "done");
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

export async function drainOnce(port: number): Promise<number> {
  if (!existsSync(EVENTS_DIR)) return 0;
  if (!existsSync(DONE_DIR)) mkdirSync(DONE_DIR, { recursive: true });
  let total = 0;
  for (const name of readdirSync(EVENTS_DIR)) {
    const file = join(EVENTS_DIR, name);
    if (extname(file) !== ".jsonl") continue;
    const n = await processFile(file, port);
    total += n;
    if (n > 0) renameSync(file, join(DONE_DIR, name));
  }
  return total;
}

async function main(): Promise<void> {
  if (!existsSync(EVENTS_DIR)) mkdirSync(EVENTS_DIR, { recursive: true });
  if (!existsSync(DONE_DIR)) mkdirSync(DONE_DIR, { recursive: true });
  const initial = await drainOnce(PORT);
  console.log(`[bridge] initial drain: ${initial} events`);
  if (ONCE) process.exit(0);

  console.log(`[bridge] watching ${EVENTS_DIR} …`);
  watch(EVENTS_DIR, async (_event, filename) => {
    if (!filename || !filename.toString().endsWith(".jsonl")) return;
    const file = join(EVENTS_DIR, filename.toString());
    // 等待写入完成（文件可能还在 append）
    setTimeout(async () => {
      try {
        const n = await processFile(file, PORT);
        if (n > 0) {
          renameSync(file, join(DONE_DIR, filename.toString()));
          console.log(`[bridge] forwarded ${n} events from ${filename}`);
        }
      } catch (err) {
        console.error("[bridge] process error:", err);
      }
    }, 300);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
