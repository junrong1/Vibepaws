#!/usr/bin/env node
/**
 * Vibepaws adapter 安装器 — npm run adapter:install -- --agent claude_code|codex [--global]
 * 功能：备份原配置 → 写 hooks 配置（默认项目级，--global 写用户级）→ 自检发测试事件。
 * 安全设计：默认只写入 <repo>/.claude/settings.json 或 <repo>/.codex/hooks.json；
 * 显式加 --global 才写 ~/.claude/settings.json 或 ~/.codex/hooks.json（所有项目生效），
 * 并同时移除本仓库项目级配置里 Vibepaws 自己的 hooks，避免双重触发。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { claudeHooksConfig, claudeStatusLineConfig, codexHooksConfig, capabilities, adapterStatusEvent } from "./hooks.ts";
import { deliver } from "./hook_agent.ts";
import { t as translate, detectNodeLocale } from "../i18n/messages.js";

/** 安装向导是 onboarding 的第一屏，跟着系统语言走（issue #3）；VIBEPAWS_LOCALE 可覆盖。 */
const LOCALE = detectNodeLocale();
const t = (key: string, params?: Record<string, string | number>): string => translate(LOCALE, key, params);

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
const GLOBAL = has("global");

function backup(file: string): void {
  if (!existsSync(file)) return;
  const bak = `${file}.vibepaws.bak`;
  if (!existsSync(bak)) {
    writeFileSync(bak, readFileSync(file, "utf-8"));
    console.log(t("cli.backup", { file: bak }));
  }
}

/** 是否为 Vibepaws 自己的 hook 条目（按 command 里的 hook_agent.ts 签名识别） */
function isVibepawsEntry(entry: unknown): boolean {
  const s = typeof entry === "string" ? entry : JSON.stringify(entry ?? "");
  return s.includes("hook_agent.ts") || s.includes("vibepaws");
}

/**
 * 按事件在数组层合并：追加新条目、按 JSON 序列化去重。
 * 这样写全局配置（~/.claude/settings.json）时不会清掉用户已有/其他工具的 hooks。
 */
function mergeHooks(existing: Record<string, unknown>, newHooks: Record<string, unknown>): Record<string, unknown> {
  const out = { ...existing };
  const existingHooks =
    typeof existing.hooks === "object" && existing.hooks ? (existing.hooks as Record<string, unknown>) : {};
  const incoming = (newHooks.hooks as Record<string, unknown>) ?? {};
  const mergedHooks: Record<string, unknown> = { ...existingHooks };
  for (const [event, entries] of Object.entries(incoming)) {
    const prev = Array.isArray(mergedHooks[event]) ? (mergedHooks[event] as unknown[]) : [];
    const add = Array.isArray(entries) ? entries : [];
    const seen = new Set(prev.map((e) => JSON.stringify(e)));
    for (const e of add) {
      const key = JSON.stringify(e);
      if (!seen.has(key)) {
        prev.push(e);
        seen.add(key);
      }
    }
    mergedHooks[event] = prev;
  }
  out.hooks = mergedHooks;
  return out;
}

/** 切换到全局时，移除本仓库项目级配置里 Vibepaws 自己的 hooks，避免「项目级 + 用户级」双重触发。返回移除条数。 */
function cleanupProjectHooks(agent: "claude_code" | "codex"): number {
  const file = agent === "claude_code"
    ? join(REPO, ".claude", "settings.json")
    : join(REPO, ".codex", "hooks.json");
  if (!existsSync(file)) return 0;
  let removed = 0;
  try {
    const existing = JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>;
    const hooks =
      typeof existing.hooks === "object" && existing.hooks ? (existing.hooks as Record<string, unknown>) : {};
    const cleaned: Record<string, unknown> = {};
    for (const [event, entries] of Object.entries(hooks)) {
      if (!Array.isArray(entries)) {
        cleaned[event] = entries;
        continue;
      }
      const kept = entries.filter((e) => !isVibepawsEntry(e));
      removed += entries.length - kept.length;
      if (kept.length > 0) cleaned[event] = kept;
    }
    if (removed > 0) {
      if (Object.keys(cleaned).length > 0) existing.hooks = cleaned;
      else delete existing.hooks;
      writeFileSync(file, JSON.stringify(existing, null, 2) + "\n");
      console.log(t("cli.cleanup.project", { file, n: removed }));
    }
  } catch (err) {
    console.error(`[vibepaws] cleanup failed for ${file}: ${String(err)}`);
  }
  return removed;
}

function installClaude(): void {
  const dir = GLOBAL ? join(homedir(), ".claude") : join(REPO, ".claude");
  const file = join(dir, "settings.json");
  mkdirSync(dir, { recursive: true });
  const existing = existsSync(file) ? (JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>) : {};
  // hooks 与 statusLine 一起装：hooks 是事件流，statusLine 是实时 token 通道（Claude Code 专属）
  const merged = { ...mergeHooks(existing, claudeHooksConfig(REPO)), ...claudeStatusLineConfig(REPO) };
  if (DRY) {
    console.log(t("cli.dryrun.write", { file, count: Object.keys((merged.hooks ?? {}) as object).length }));
    return;
  }
  backup(file);
  writeFileSync(file, JSON.stringify(merged, null, 2) + "\n");
  console.log(t("cli.claude.written", { file }));
  console.log(GLOBAL ? t("cli.claude.globalNote") : t("cli.claude.note"));
  if (GLOBAL) cleanupProjectHooks("claude_code");
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
      return { ok: true, file, message: t("cli.codex.trust.written", { file }) };
    }
    return { ok: true, file, message: t("cli.codex.trust.exists", { file }) };
  } catch (err) {
    return { ok: false, file, message: t("cli.codex.trust.failed", { error: String(err) }) };
  }
}

function installCodex(): void {
  const dir = GLOBAL ? join(homedir(), ".codex") : join(REPO, ".codex");
  const file = join(dir, "hooks.json");
  mkdirSync(dir, { recursive: true });
  const existing = existsSync(file) ? (JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>) : {};
  const merged = mergeHooks(existing, codexHooksConfig(REPO));
  if (DRY) {
    console.log(t("cli.dryrun.write", { file, count: Object.keys((merged.hooks ?? {}) as object).length }));
    return;
  }
  backup(file);
  writeFileSync(file, JSON.stringify(merged, null, 2) + "\n");
  console.log(t("cli.codex.written", { file }));
  if (GLOBAL) {
    cleanupProjectHooks("codex");
  } else {
    // 项目信任（Codex 0.148+：项目未信任则项目级 hooks 被门控跳过）
    const trust = trustProjectForCodex(REPO);
    console.log(trust.ok ? `✓ ${trust.message}` : `⚠ ${trust.message}`);
    console.log(t("cli.codex.trustNote", { repo: REPO, file }));
  }
}

async function selfCheck(): Promise<void> {
  console.log(t("cli.selfcheck.start"));
  // 自检发 adapter_status 而不是假的 session_started：既证明 Core 收得到，
  // 又让 Core 记住「这个 agent 的 adapter 装好了」。发假 session 只会在
  // 宠物面板里多出一条永远不结束的 "install-probe"。
  const ok = await deliver(adapterStatusEvent(AGENT, REPO));
  if (ok) {
    console.log(t("cli.selfcheck.ok"));
    console.log(t("cli.selfcheck.next"));
  } else {
    console.log(t("cli.selfcheck.fail"));
  }
}

async function main(): Promise<void> {
  console.log(t("cli.install.header", { agent: AGENT, dry: DRY ? " (dry-run)" : "", scope: GLOBAL ? "global" : "project", repo: REPO }));
  if (AGENT === "claude_code") {
    installClaude();
    console.log(t("cli.capabilities", { list: capabilities("claude_code").join(", ") }));
  } else if (AGENT === "codex") {
    installCodex();
    console.log(t("cli.capabilities", { list: capabilities("codex").join(", ") }));
  } else {
    console.error(t("cli.unknownAgent", { agent: AGENT }));
    process.exit(1);
  }
  if (!DRY) await selfCheck();
}

main();
