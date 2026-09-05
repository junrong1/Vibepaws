#!/usr/bin/env node
/**
 * Vibepaws adapter 安装器。
 *
 * 两个入口，同一套逻辑：
 *   · CLI —— npm run adapter:install -- --agent claude_code|codex|pi|dsh [--global]
 *   · 库  —— installAdapter()，给 Core 的 /api/adapters 用（设置窗口里那个「接上你的 agent」）
 *
 * 会做的事：备份原配置 → 写 hooks 配置（默认项目级，--global 写用户级）→ 自检发测试事件。
 * 安全设计：默认只写入 <repo>/.claude/settings.json、<repo>/.codex/hooks.json 或 <repo>/.pi/extensions/；
 * 显式加 --global 才写 ~/.claude/settings.json、~/.codex/hooks.json 或 ~/.pi/agent/extensions/（所有项目生效），
 * 并同时移除本仓库项目级配置里 Vibepaws 自己的 hooks，避免双重触发。
 * pi 没有配置式 hooks：安装的是 pi 插件（extension）——复制 src/adapters/pi_extension.ts。
 *
 * **两个「根」必须分开**，从前它们都是 process.cwd()，在 CLI 里恰好相同所以看不出来：
 *   · sourceRoot  —— src/adapters/hook_agent.ts 这些**文件自己**在哪。写进 agent 配置的那条
 *     命令指向它。打包后 Core 的 cwd 是 userData，拿 cwd 当它会写出一条指向不存在文件的 hook。
 *     默认由本模块自己的位置反推，任何 cwd、任何打包形态下都成立。
 *   · projectRoot —— 「装到哪个项目里」。只有项目级安装才用得上，CLI 里就是 cwd。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, realpathSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { claudeHooksConfig, claudeStatusLineConfig, codexHooksConfig, capabilities, adapterStatusEvent } from "./hooks.ts";
import { isVibepawsEntry, scan } from "./uninstall.ts";
import { deliver } from "./hook_agent.ts";
import { transpileDshPlugin } from "./dsh_compile.ts";
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

export type InstallAgent = "claude_code" | "codex" | "pi" | "dsh";
export const INSTALL_AGENTS: InstallAgent[] = ["claude_code", "codex", "pi", "dsh"];

/** 素材根：本文件在 <root>/src/adapters/ 下，所以上溯两层。 */
export const SOURCE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export interface InstallOptions {
  agent: InstallAgent;
  /** 默认全局：app 里点的那一下不知道你指的是哪个项目 */
  global?: boolean;
  dryRun?: boolean;
  /** src/ 在哪（默认由本模块位置反推） */
  sourceRoot?: string;
  /** 项目级安装装到哪个项目（默认 cwd） */
  projectRoot?: string;
  /**
   * 用户级配置的根目录（默认真实 home）。与 uninstall.ts 的红线 ④ 同一条理由：
   * 不能注入的话，任何一个测全局安装的用例都会去改开发机上真实的 ~/.claude/settings.json。
   */
  home?: string;
  /**
   * 装完之后发一个测试事件证明链路是通的。默认开。
   * 测试要关掉它：Core 不在时 deliver() 会把事件缓冲到 .vibepaws/events/fallback.jsonl，
   * 于是每跑一次单测都在开发机的真实事件队列里塞几条假的 adapter_status，
   * 等 Core 起来再被 bridge 重放一遍。
   */
  selfCheck?: boolean;
}

interface Ctx {
  agent: InstallAgent;
  global: boolean;
  dry: boolean;
  sourceRoot: string;
  projectRoot: string;
  home: string;
  /** 安装过程里想说的话。CLI 打印它，设置窗口显示它 —— 两边看到的是同一串。 */
  notes: string[];
}

function ctxFrom(opts: InstallOptions): Ctx {
  return {
    agent: opts.agent,
    global: opts.global ?? true,
    dry: opts.dryRun ?? false,
    sourceRoot: opts.sourceRoot ?? SOURCE_ROOT,
    projectRoot: opts.projectRoot ?? process.cwd(),
    home: opts.home ?? homedir(),
    notes: [],
  };
}

/** 同一个文件吗。两边都可能还不存在，所以先比字符串，存在时再用 realpath 兜住符号链接。 */
function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    if (existsSync(a) && existsSync(b)) return realpathSync(a) === realpathSync(b);
  } catch {
    /* 比不了就当不同 —— 顶多是少清理一次，不会误删 */
  }
  return false;
}

function say(ctx: Ctx, line: string): void {
  ctx.notes.push(line);
}

function backup(ctx: Ctx, file: string): void {
  if (!existsSync(file)) return;
  const bak = `${file}.vibepaws.bak`;
  if (!existsSync(bak)) {
    writeFileSync(bak, readFileSync(file, "utf-8"));
    say(ctx, t("cli.backup", { file: bak }));
  }
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

/**
 * 切换到全局时，移除本仓库项目级配置里 Vibepaws 自己的 hooks，避免「项目级 + 用户级」双重触发。
 * 返回移除条数。
 *
 * `justWrote` 是一道必需的闸门，不是保险：项目根**可能就是** home（`cd ~ && 装全局`，
 * 或者 Core 的数据目录恰好在 home 下）。那时项目级路径和刚写完的全局路径是同一个文件，
 * 而这个函数会忠实地把自己刚写进去的 hooks 当成「重复的项目级条目」全部删掉 ——
 * 结果是一份只剩 statusLine、hooks 一条不剩的配置，而安装器还打印着「✓ 写入成功」。
 */
function cleanupProjectHooks(ctx: Ctx, agent: "claude_code" | "codex", justWrote: string): number {
  const file = agent === "claude_code"
    ? join(ctx.projectRoot, ".claude", "settings.json")
    : join(ctx.projectRoot, ".codex", "hooks.json");
  if (samePath(file, justWrote)) return 0;
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
      say(ctx, t("cli.cleanup.project", { file, n: removed }));
    }
  } catch (err) {
    console.error(`[vibepaws] cleanup failed for ${file}: ${String(err)}`);
  }
  return removed;
}

function installClaude(ctx: Ctx): string {
  const dir = ctx.global ? join(ctx.home, ".claude") : join(ctx.projectRoot, ".claude");
  const file = join(dir, "settings.json");
  const existing = existsSync(file) ? (JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>) : {};
  // hooks 与 statusLine 一起装：hooks 是事件流，statusLine 是实时 token 通道（Claude Code 专属）
  const merged = {
    ...mergeHooks(existing, claudeHooksConfig(ctx.sourceRoot)),
    ...claudeStatusLineConfig(ctx.sourceRoot),
  };
  if (ctx.dry) {
    say(ctx, t("cli.dryrun.write", { file, count: Object.keys((merged.hooks ?? {}) as object).length }));
    return file;
  }
  // mkdir 放在 dry 闸门**之后**：dry-run 的承诺是「一个字节都不写」，而建目录也是写。
  // 从前它在闸门之前，于是 --dry-run 会在用户 home 里留下一个空的 .claude/ ——
  // 一个「只是看看会发生什么」的命令不该留下痕迹。
  mkdirSync(dir, { recursive: true });
  backup(ctx, file);
  writeFileSync(file, JSON.stringify(merged, null, 2) + "\n");
  say(ctx, t("cli.claude.written", { file }));
  say(ctx, ctx.global ? t("cli.claude.globalNote") : t("cli.claude.note"));
  if (ctx.global) cleanupProjectHooks(ctx, "claude_code", file);
  return file;
}

/** Codex 项目信任：写 ~/.codex/config.toml（备份已有，只追加 projects 信任条目）。
 *  home 可注入，理由同 InstallOptions.home —— 否则测试会去改开发机上真实的 config.toml。 */
export function trustProjectForCodex(
  projectPath: string,
  home: string = homedir(),
): { ok: boolean; file: string; message: string } {
  const file = join(home, ".codex", "config.toml");
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

function installCodex(ctx: Ctx): string {
  const dir = ctx.global ? join(ctx.home, ".codex") : join(ctx.projectRoot, ".codex");
  const file = join(dir, "hooks.json");
  const existing = existsSync(file) ? (JSON.parse(readFileSync(file, "utf-8")) as Record<string, unknown>) : {};
  const merged = mergeHooks(existing, codexHooksConfig(ctx.sourceRoot));
  if (ctx.dry) {
    say(ctx, t("cli.dryrun.write", { file, count: Object.keys((merged.hooks ?? {}) as object).length }));
    return file;
  }
  mkdirSync(dir, { recursive: true }); // 同上：建目录也是写
  backup(ctx, file);
  writeFileSync(file, JSON.stringify(merged, null, 2) + "\n");
  say(ctx, t("cli.codex.written", { file }));
  if (ctx.global) {
    cleanupProjectHooks(ctx, "codex", file);
  } else {
    // 项目信任（Codex 0.148+：项目未信任则项目级 hooks 被门控跳过）
    const trust = trustProjectForCodex(ctx.projectRoot, ctx.home);
    say(ctx, trust.ok ? `✓ ${trust.message}` : `⚠ ${trust.message}`);
    say(ctx, t("cli.codex.trustNote", { repo: ctx.projectRoot, file }));
  }
  return file;
}

/** pi 安装：复制 src/adapters/pi_extension.ts 到 pi 的插件目录
 * （项目级 .pi/extensions/，--global 写 ~/.pi/agent/extensions/）。
 * 插件由 pi 自动发现（需项目被信任），零配置、无双重触发问题 —— 不需要 cleanup。
 * 迁移清理：旧版装的是 skill（.pi/skills/vibepaws/SKILL.md），已废弃，顺带删除。 */
function installPi(ctx: Ctx): string {
  const dir = ctx.global ? join(ctx.home, ".pi", "agent", "extensions") : join(ctx.projectRoot, ".pi", "extensions");
  const file = join(dir, "vibepaws.ts");
  const source = join(ctx.sourceRoot, "src", "adapters", "pi_extension.ts");
  if (ctx.dry) {
    say(ctx, t("cli.pi.dryrun", { file }));
    return file;
  }
  mkdirSync(dir, { recursive: true });
  backup(ctx, file);
  writeFileSync(file, readFileSync(source, "utf-8"));
  say(ctx, t("cli.pi.written", { file }));
  // 迁移清理：旧 skill 方案产物不再参与上报，删除避免混淆
  for (const skillDir of [join(ctx.projectRoot, ".pi", "skills", "vibepaws"), join(ctx.home, ".pi", "skills", "vibepaws")]) {
    try {
      if (existsSync(skillDir)) {
        rmSync(skillDir, { recursive: true, force: true });
        say(ctx, t("cli.pi.cleanup.skill", { dir: skillDir }));
      }
    } catch {
      // 清理失败不阻断安装
    }
  }
  say(ctx, t("cli.pi.note", { repo: ctx.projectRoot }));
  return file;
}

/** dsh 安装：把 src/adapters/dsh_plugin.ts 转译成 CommonJS 写到 dsh 插件目录，并写一份 cordis patch。
 * dsh 用 require()/internal.import 加载扩展，ESM 的 .ts 会触发 require(esm) 环
 * （ERR_REQUIRE_CYCLE_MODULE）；转译成 .cjs 后 require() 即普通 CJS 加载，绕开该环。
 * 项目级：<repo>/.dsh/extensions/vibepaws.cjs + <repo>/.dsh/vibepaws.cordis.yml
 * 全局：  ~/.dsh/extensions/vibepaws.cjs + ~/.dsh/vibepaws.cordis.yml（所有项目生效）
 * patch 里是绝对路径（dsh 要求绝对路径），用户用 `dsh web --patch <patch>` 加载。 */
function installDsh(ctx: Ctx): string {
  const dir = ctx.global ? join(ctx.home, ".dsh", "extensions") : join(ctx.projectRoot, ".dsh", "extensions");
  const file = join(dir, "vibepaws.cjs");
  const legacyFile = join(dir, "vibepaws.ts");
  const patchFile = ctx.global
    ? join(ctx.home, ".dsh", "vibepaws.cordis.yml")
    : join(ctx.projectRoot, ".dsh", "vibepaws.cordis.yml");
  const source = join(ctx.sourceRoot, "src", "adapters", "dsh_plugin.ts");
  if (ctx.dry) {
    say(ctx, t("cli.dsh.dryrun", { file }));
    return file;
  }
  mkdirSync(dir, { recursive: true });
  backup(ctx, file);
  const cjs = transpileDshPlugin(readFileSync(source, "utf-8"));
  writeFileSync(file, cjs);
  // 迁移清理：旧版装的是 ESM 的 vibepaws.ts，会触发 require(esm) 环，删掉避免混淆。
  if (existsSync(legacyFile)) rmSync(legacyFile, { force: true });
  const patch = `- insert:\n  - id: vibepaws\n    name: '${file.replace(/'/g, "''")}'\n`;
  backup(ctx, patchFile);
  writeFileSync(patchFile, patch);
  say(ctx, t("cli.dsh.written", { file }));
  say(ctx, t("cli.dsh.note", { patch: patchFile }));
  return file;
}

/**
 * 装完之后立刻证明这条链路是通的。
 *
 * 自检发 adapter_status 而不是假的 session_started：既证明 Core 收得到，又让 Core 记住
 * 「这个 agent 的 adapter 装好了」。发假 session 只会在宠物面板里多出一条永远不结束的
 * "install-probe"。
 */
async function selfCheck(ctx: Ctx): Promise<boolean> {
  say(ctx, t("cli.selfcheck.start"));
  const ok = await deliver(adapterStatusEvent(ctx.agent, ctx.projectRoot));
  say(ctx, ok ? t("cli.selfcheck.ok") : t("cli.selfcheck.fail"));
  if (ok) say(ctx, t("cli.selfcheck.next"));
  return ok;
}

export interface InstallReport {
  agent: InstallAgent;
  scope: "project" | "global";
  ok: boolean;
  /** 写到哪个文件（dry-run 下是「本来会写哪个」） */
  file: string;
  /** 自检有没有通。dry-run 下是 null —— 什么都没写，也就没什么可自检的。 */
  selfCheck: boolean | null;
  /** 过程里说的每一句，CLI 和设置窗口显示的是同一串 */
  notes: string[];
  capabilities: string[];
}

/**
 * 装一个 agent 的 adapter。CLI 和 Core 的 /api/adapters 都走这里 —— 一套逻辑两个入口，
 * 而不是让设置窗口里那个按钮走一条自己的、没人测过的路径。
 */
export async function installAdapter(opts: InstallOptions): Promise<InstallReport> {
  const ctx = ctxFrom(opts);
  if (!INSTALL_AGENTS.includes(ctx.agent)) {
    return {
      agent: ctx.agent,
      scope: ctx.global ? "global" : "project",
      ok: false,
      file: "",
      selfCheck: null,
      notes: [t("cli.unknownAgent", { agent: ctx.agent })],
      capabilities: [],
    };
  }
  let file = "";
  let ok = true;
  try {
    if (ctx.agent === "claude_code") file = installClaude(ctx);
    else if (ctx.agent === "codex") file = installCodex(ctx);
    else if (ctx.agent === "pi") file = installPi(ctx);
    else file = installDsh(ctx);
    say(ctx, t("cli.capabilities", { list: capabilities(ctx.agent).join(", ") }));
  } catch (err) {
    ok = false;
    say(ctx, String(err));
  }
  const wantCheck = opts.selfCheck ?? true;
  const checked = ok && !ctx.dry && wantCheck ? await selfCheck(ctx) : null;
  return {
    agent: ctx.agent,
    scope: ctx.global ? "global" : "project",
    ok,
    file,
    selfCheck: checked,
    notes: ctx.notes,
    capabilities: capabilities(ctx.agent),
  };
}

/* ---------------- agent 探测（设置窗口里那张卡要显示什么） ---------------- */

export interface AgentPresence {
  agent: InstallAgent;
  /** 这台机器上有没有这个 agent 的痕迹（配置目录存在） */
  detected: boolean;
  /** Vibepaws 的 adapter 装没装（全局或项目级，任一即算） */
  installed: boolean;
  /** 装在哪些文件里 —— 界面上要说得出，用户才知道自己在改什么 */
  files: string[];
}

/**
 * 每个 agent 的「在不在 / 装没装」。
 *
 * detected 只看配置目录在不在（~/.claude、~/.codex、~/.pi、~/.dsh），不去 PATH 里找可执行文件：
 * 这几个 agent 的装法五花八门（npm 全局、brew、下载的二进制、VS Code 扩展），而它们**一定**
 * 会有配置目录。宁可漏报成「没检测到」也不误报 —— 界面上仍然让你装，只是不主动推荐。
 *
 * installed 直接复用 uninstall.ts 的 scan()：那边已经是「什么算 Vibepaws 的条目」的唯一裁决者，
 * 再写一份判断迟早会和它分家。
 */
export function detectAgents(opts: { projectRoot?: string; home?: string } = {}): AgentPresence[] {
  const projectRoot = opts.projectRoot ?? process.cwd();
  const home = opts.home ?? homedir();
  const homes: Record<InstallAgent, string> = {
    claude_code: join(home, ".claude"),
    codex: join(home, ".codex"),
    pi: join(home, ".pi"),
    dsh: join(home, ".dsh"),
  };
  const live = scan({ repoRoot: projectRoot, home }).filter(
    (target) => target.exists && (target.hooks > 0 || target.status_line),
  );
  return INSTALL_AGENTS.map((agent) => {
    const mine = live.filter((target) => target.agent === agent);
    return {
      agent,
      detected: existsSync(homes[agent]),
      installed: mine.length > 0,
      files: mine.map((target) => target.file),
    };
  });
}

/* ---------------- CLI ---------------- */

async function main(): Promise<void> {
  const agent = (arg("agent") ?? "claude_code") as InstallAgent;
  // CLI 的默认仍然是**项目级**（--global 才写用户级）：这条默认值是安全设计的一部分，
  // 见文件头。app 里那个按钮的默认相反 —— 它不知道你指的是哪个项目。
  const report = await installAdapter({
    agent,
    global: has("global"),
    dryRun: has("dry-run"),
    projectRoot: process.cwd(),
  });
  console.log(
    t("cli.install.header", {
      agent,
      dry: has("dry-run") ? " (dry-run)" : "",
      scope: report.scope,
      repo: process.cwd(),
    }),
  );
  for (const line of report.notes) console.log(line);
  if (!report.ok) process.exit(1);
}

// 只有被当成命令直接跑时才执行 —— 被 Core import 时不能有副作用
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main();
