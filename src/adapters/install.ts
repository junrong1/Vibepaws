#!/usr/bin/env node
/**
 * Vibepaws adapter 安装器 — npm run adapter:install -- --agent claude_code|codex
 * 功能：备份原配置 → 写项目级 hooks 配置（隐私：不写用户主目录）→ 自检发测试事件。
 * 安全设计：只写入 <repo>/.claude/settings.json 或 <repo>/.codex/hooks.json；
 * 全局配置（~/.claude、~/.codex）需要用户手动合并（打印引导文案）。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { claudeHooksConfig, codexHooksConfig, capabilities } from "./hooks.ts";
import { deliver } from "./hook_agent.ts";
import type { CoreEvent } from "../core/events.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const REPO = process.cwd();
const AGENT = (arg("agent") ?? "claude_code") as "claude_code" | "codex";
const DRY = has("dry-run");

function backup(file: string): void {
  if (!existsSync(file)) return;
  const bak = `${file}.vibepaws.bak`;
  if (!existsSync(bak)) {
    writeFileSync(bak, readFileSync(file, "utf-8"));
    console.log(`  ↳ 已备份原配置 → ${bak}`);
  }
}

function mergeHooks(existing: Record<string, unknown>, newHooks: Record<string, unknown>): Record<string, unknown> {
  const out = { ...existing };
  const mergedHooks = {
    ...(typeof existing.hooks === "object" && existing.hooks ? (existing.hooks as Record<string, unknown>) : {}),
    ...(newHooks.hooks as Record<string, unknown>),
  };
  out.hooks = mergedHooks;
  return out;
}

function installClaude(): void {
  const dir = join(REPO, ".claude");
  const file = join(dir, "settings.json");
  mkdirSync(dir, { recursive: true });
  const existing = existsSync(file) ? (JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>) : {};
  const merged = mergeHooks(existing, claudeHooksConfig(REPO));
  if (DRY) {
    console.log(`[dry-run] 将写入 ${file}，合并后 hooks 键：${Object.keys((merged.hooks ?? {}) as object).length} 个事件`);
    return;
  }
  backup(file);
  writeFileSync(file, JSON.stringify(merged, null, 2) + "\n");
  console.log(`✓ Claude Code hooks 已写入 ${file}`);
  console.log("  Claude Code 会在项目目录自动加载 .claude/settings.json（首次需信任该目录）");
}

/** Codex 项目信任：写 ~/.codex/config.toml（备份已有，只追加 projects 信任条目） */
export function trustProjectForCodex(projectPath: string): { ok: boolean; file: string; message: string } {
  const file = join(homedir(), ".codex", "config.toml");
  try {
    mkdirSync(dirname(file), { recursive: true });
    let existing = "";
    if (existsSync(file)) existing = readFileSync(file, "utf-8");
    if (!existing.includes(`trust_level`)) {
      if (existsSync(file)) writeFileSync(`${file}.vibepaws.bak`, existing);
      const entry = `[projects."${projectPath}"]\ntrust_level = "trusted"\n`;
      writeFileSync(file, existing + "\n" + entry);
      return { ok: true, file, message: `项目信任已写入 ${file}` };
    }
    return { ok: true, file, message: `项目信任已存在（${file}）` };
  } catch (err) {
    return { ok: false, file, message: `写入项目信任失败（需手动配置）：${String(err)}` };
  }
}

function installCodex(): void {
  const dir = join(REPO, ".codex");
  const file = join(dir, "hooks.json");
  mkdirSync(dir, { recursive: true });
  const existing = existsSync(file) ? (JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>) : {};
  const merged = mergeHooks(existing, codexHooksConfig(REPO));
  if (DRY) {
    console.log(`[dry-run] 将写入 ${file}，合并后 hooks 键：${Object.keys((merged.hooks ?? {}) as object).length} 个事件`);
    return;
  }
  backup(file);
  writeFileSync(file, JSON.stringify(merged, null, 2) + "\n");
  console.log(`✓ Codex hooks 已写入 ${file}`);
  // 项目信任（Codex 0.148+：项目未信任则项目级 hooks 被门控跳过）
  const trust = trustProjectForCodex(REPO);
  console.log(trust.ok ? `✓ ${trust.message}` : `⚠ ${trust.message}`);
  console.log(`
  ⚠ hooks 信任注册（首次生效需授权，二选一）：
    ① 交互模式：cd ${REPO} && codex，然后运行 /hooks 批准 vibepaws
    ② headless/自动化：codex exec --dangerously-bypass-hook-trust …
  💡 全局安装（可选）：把 ${file} 的内容合并到 ~/.codex/hooks.json`);
}

async function selfCheck(): Promise<void> {
  console.log("\n[自检] 发送测试事件到 Core…");
  const testEvent: CoreEvent = {
    event_id: `install-test-${Date.now()}`,
    seq: 0,
    agent: AGENT,
    session_id: "install-probe",
    project_id: REPO,
    event_type: "session_started",
    severity: "low",
    safe_summary: "Adapter install self-check",
    timestamp: new Date().toISOString(),
    payload: { source: "startup", cwd: REPO, title: "install-probe" },
  };
  const ok = await deliver(testEvent);
  if (ok) {
    console.log("✓ Core 已收到测试事件（session_started）");
    console.log("  下一步：启动 coding agent 开始干活，宠物就会动起来 🐾");
  } else {
    console.log("✗ Core 未响应 — 请先运行 npm run core（若 Core 未启动，事件已写入 .vibepaws/events/fallback.jsonl，启动后自动补收由 generic bridge 负责）");
  }
}

async function main(): Promise<void> {
  console.log(`[vibepaws] adapter install — agent=${AGENT}${DRY ? " (dry-run)" : ""} repo=${REPO}`);
  if (AGENT === "claude_code") {
    installClaude();
    console.log(`  能力声明：${capabilities("claude_code").join(", ")}`);
  } else if (AGENT === "codex") {
    installCodex();
    console.log(`  能力声明：${capabilities("codex").join(", ")}`);
  } else {
    console.error(`未知 agent: ${AGENT}`);
    process.exit(1);
  }
  if (!DRY) await selfCheck();
}

main();
