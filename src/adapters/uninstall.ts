#!/usr/bin/env node
/**
 * Vibepaws adapter 卸载器 —— install.ts 的对称面（gap analysis G09）。
 *
 * 为什么它必须存在：hooks 是我们写进**用户的** agent 配置里的东西。删掉数据目录、
 * 甚至把 App 拖进废纸篓，`~/.claude/settings.json` 里那十几条 hook 仍然在，
 * 于此后每一次工具调用上都去 POST 一个已经没人监听的端口。超时的 command hook
 * 不会阻塞工具调用，但每个事件仍要付出一次进程启动的代价 —— 用户的 agent 会
 * 永久性地变慢，而且他没有任何办法知道为什么。这是最容易招致差评的一类残留。
 *
 * 两个使用面共用本文件的引擎，所以「怎么识别我们自己写的东西」只有一份实现：
 *   · 设置窗口的危险区（Core 的 GET/POST /api/uninstall）—— App 还在的时候
 *   · CLI `npm run adapter:uninstall` —— App 已经不在了的时候（这才是卸载的常态）
 *
 * 三条设计红线：
 *   ① 按标记逐条移除，绝不整段覆盖用户的 hooks —— 同一个文件里可能有别的工具；
 *   ② statusLine 是**替换**式写入（install 的 `...claudeStatusLineConfig()`），
 *      所以卸载要优先从我们留下的 .vibepaws.bak 里把用户原来那条捞回来；
 *   ③ ~/.codex/config.toml 的项目信任条目一律不动 —— 没有 TOML 解析器就去改写
 *      用户的 TOML，是把「清理残留」变成「吃掉配置」。改为报告给用户手动处理。
 *   ④ 用户级路径的根（home）是**参数**，不是 homedir() 的直接调用。
 *      本文件的每个入口都同时覆盖项目级与用户级 —— 只传一个临时 repoRoot 的调用方
 *      会以为自己在沙箱里，实际上照样去清真实的 ~/.claude 与 ~/.vibepaws。
 *      这不是假设出来的风险：本文件的测试第一次跑起来时就删掉了开发机上真实的
 *      ~/.vibepaws，并把全局 hooks 一起卸了。参数化之后，测试再也碰不到它们。
 */
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { t as translate, detectNodeLocale } from "../i18n/messages.js";

export type UninstallAgent = "claude_code" | "codex" | "pi" | "dsh";
export type UninstallScope = "project" | "global";

/** 我们留在用户配置旁边的备份后缀（install.ts 的 backup()） */
const BACKUP_SUFFIX = ".vibepaws.bak";

export interface UninstallOptions {
  /** 项目级配置的根目录（默认 cwd，与安装器一致） */
  repoRoot?: string;
  /** 用户级配置的根目录（默认真实 home）。见文件头红线 ④：测试必须能把它挪走 */
  home?: string;
  /** 只处理这几个 agent（不传 = 全部） */
  agents?: UninstallAgent[];
  /** 一个字节都不写，只算出「会发生什么」 */
  dryRun?: boolean;
}

function roots(opts: UninstallOptions): { repoRoot: string; home: string } {
  return { repoRoot: opts.repoRoot ?? process.cwd(), home: opts.home ?? homedir() };
}

/**
 * hook 条目的识别签名。与 install.ts 的 cleanupProjectHooks 共用同一判定
 * （本文件是唯一实现，install.ts 从这里 import）—— 两处各写一份的话，
 * 安装能认出来的条目卸载可能认不出来，残留就是这么来的。
 */
export function isVibepawsEntry(entry: unknown): boolean {
  const s = (typeof entry === "string" ? entry : JSON.stringify(entry ?? "")).toLowerCase();
  return s.includes("hook_agent.ts") || s.includes("vibepaws");
}

/**
 * statusLine 的识别要比 hooks 严格：用户自己写的 statusline 脚本很可能也叫
 * `statusline.ts`，而这一条是**独占**字段 —— 认错了就是把别人的状态栏删掉。
 * 所以只认我们自己的相对路径。
 */
export function isVibepawsStatusLine(statusLine: unknown): boolean {
  if (!statusLine || typeof statusLine !== "object") return false;
  const cmd = (statusLine as { command?: unknown }).command;
  if (typeof cmd !== "string") return false;
  return cmd.replace(/\\/g, "/").includes("src/adapters/statusline.ts");
}

export interface HookTarget {
  agent: UninstallAgent;
  scope: UninstallScope;
  /** json = 就地改写用户的配置文件；file / dir = 整份删除（那是我们自己的文件） */
  kind: "json" | "file" | "dir";
  file: string;
  exists: boolean;
  /** 我们自己的 hook 条目数（json 目标） */
  hooks: number;
  /** statusLine 是不是我们写的（Claude Code 专属通道） */
  status_line: boolean;
  /** 我们留下的备份还在不在 —— 在的话用户的原始配置就在那里 */
  backup: string | null;
  /** JSON 读不成（用户手改坏了）。必须报出来：静静地跳过等于残留 */
  unreadable: boolean;
}

export interface RemovalResult extends HookTarget {
  removed_hooks: number;
  removed_status_line: boolean;
  /** 从 .vibepaws.bak 里把用户原来的 statusLine 放回去了 */
  restored_status_line: boolean;
  deleted: boolean;
  changed: boolean;
  error: string | null;
}

/** 人工善后项（我们**故意**不动的东西）。带 i18n key，CLI 与设置窗口共用同一句话。 */
export interface UninstallNote {
  key: string;
  params?: Record<string, string | number>;
}

export interface UninstallReport {
  results: RemovalResult[];
  notes: UninstallNote[];
  dry_run: boolean;
}

/* ---------------- 目标清单 ---------------- */

/** 目标位置（还没看过文件系统的那一半信息） */
export type TargetPath = Omit<HookTarget, "exists" | "hooks" | "status_line" | "backup" | "unreadable">;

/**
 * 所有可能被安装器写过的位置。项目级与用户级都在里面：卸载只清一个 scope
 * 等于没卸载 —— 用户装过 `--global` 就会留下一份看不见的全局 hooks。
 */
export function targetPaths(opts: UninstallOptions = {}): TargetPath[] {
  const { repoRoot, home } = roots(opts);
  return [
    { agent: "claude_code", scope: "project", kind: "json", file: join(repoRoot, ".claude", "settings.json") },
    { agent: "claude_code", scope: "global", kind: "json", file: join(home, ".claude", "settings.json") },
    { agent: "codex", scope: "project", kind: "json", file: join(repoRoot, ".codex", "hooks.json") },
    { agent: "codex", scope: "global", kind: "json", file: join(home, ".codex", "hooks.json") },
    { agent: "pi", scope: "project", kind: "file", file: join(repoRoot, ".pi", "extensions", "vibepaws.ts") },
    { agent: "pi", scope: "global", kind: "file", file: join(home, ".pi", "agent", "extensions", "vibepaws.ts") },
    // 迁移残留：0.1.0 之前 pi 装的是 skill，install.ts 现在顺带删，卸载也要覆盖
    { agent: "pi", scope: "project", kind: "dir", file: join(repoRoot, ".pi", "skills", "vibepaws") },
    { agent: "pi", scope: "global", kind: "dir", file: join(home, ".pi", "skills", "vibepaws") },
    // dsh：自包含 Cordis 插件（.cjs，install 转译产物）+ 旧版 ESM 残留（.ts）+ 指向它的 patch
    { agent: "dsh", scope: "project", kind: "file", file: join(repoRoot, ".dsh", "extensions", "vibepaws.cjs") },
    { agent: "dsh", scope: "project", kind: "file", file: join(repoRoot, ".dsh", "extensions", "vibepaws.ts") },
    { agent: "dsh", scope: "project", kind: "file", file: join(repoRoot, ".dsh", "vibepaws.cordis.yml") },
    { agent: "dsh", scope: "global", kind: "file", file: join(home, ".dsh", "extensions", "vibepaws.cjs") },
    { agent: "dsh", scope: "global", kind: "file", file: join(home, ".dsh", "extensions", "vibepaws.ts") },
    { agent: "dsh", scope: "global", kind: "file", file: join(home, ".dsh", "vibepaws.cordis.yml") },
  ];
}

function backupPath(file: string): string | null {
  const bak = file + BACKUP_SUFFIX;
  return existsSync(bak) ? bak : null;
}

/** 检查单个位置：里面有没有我们的东西，有多少 */
export function inspect(target: TargetPath): HookTarget {
  const base: HookTarget = {
    ...target,
    exists: existsSync(target.file),
    hooks: 0,
    status_line: false,
    backup: backupPath(target.file),
    unreadable: false,
  };
  if (!base.exists || target.kind !== "json") return base;
  try {
    const parsed = JSON.parse(readFileSync(target.file, "utf-8")) as Record<string, unknown>;
    const hooks = typeof parsed.hooks === "object" && parsed.hooks ? (parsed.hooks as Record<string, unknown>) : {};
    for (const entries of Object.values(hooks)) {
      if (!Array.isArray(entries)) continue;
      base.hooks += entries.filter((e) => isVibepawsEntry(e)).length;
    }
    base.status_line = isVibepawsStatusLine(parsed.statusLine);
  } catch {
    base.unreadable = true;
  }
  return base;
}

/** 这个位置上还有我们的东西要清吗（读不成的文件也算「要管」——它必须出现在报告里） */
export function pending(t: HookTarget): boolean {
  if (!t.exists) return false;
  if (t.unreadable) return true;
  if (t.kind !== "json") return true; // 我们自己的文件/目录：存在即待删
  return t.hooks > 0 || t.status_line;
}

/**
 * 扫描：返回**还有东西可清**的位置。
 * 没安装过的那六七个位置不进结果 —— 界面上一排「无事可做」只会淹没真正的残留。
 */
export function scan(opts: UninstallOptions = {}): HookTarget[] {
  return targetPaths(opts)
    .filter((t) => !opts.agents || opts.agents.includes(t.agent))
    .map(inspect)
    .filter(pending);
}

/* ---------------- 改写 ---------------- */

export interface JsonRewrite {
  text: string;
  removed_hooks: number;
  removed_status_line: boolean;
  restored_status_line: boolean;
  changed: boolean;
}

/**
 * 纯字符串改写（好测，也让「改成什么样」这件事不依赖文件系统）。
 *
 * @param raw       目标配置文件内容
 * @param backupRaw 我们留下的 .vibepaws.bak 内容（没有则 null）
 */
export function rewriteJson(raw: string, backupRaw: string | null): JsonRewrite {
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  let removedHooks = 0;
  let removedStatusLine = false;
  let restoredStatusLine = false;

  const hooks = typeof parsed.hooks === "object" && parsed.hooks ? (parsed.hooks as Record<string, unknown>) : null;
  if (hooks) {
    const cleaned: Record<string, unknown> = {};
    for (const [event, entries] of Object.entries(hooks)) {
      if (!Array.isArray(entries)) {
        cleaned[event] = entries; // 不是数组就不是我们写的形状，原样留下
        continue;
      }
      const kept = entries.filter((e) => !isVibepawsEntry(e));
      removedHooks += entries.length - kept.length;
      // 空数组不留：`"PreToolUse": []` 是我们制造的垃圾，不是用户的配置
      if (kept.length > 0) cleaned[event] = kept;
    }
    if (Object.keys(cleaned).length > 0) parsed.hooks = cleaned;
    else delete parsed.hooks;
  }

  if (isVibepawsStatusLine(parsed.statusLine)) {
    removedStatusLine = true;
    // 用户原来那条状态栏优先：install 是覆盖式写入，备份是它唯一的存档
    let restored: unknown;
    if (backupRaw) {
      try {
        const prev = JSON.parse(backupRaw) as Record<string, unknown>;
        if (prev.statusLine && !isVibepawsStatusLine(prev.statusLine)) restored = prev.statusLine;
      } catch {
        // 备份也坏了：那就只是删掉我们这条
      }
    }
    if (restored !== undefined) {
      parsed.statusLine = restored;
      restoredStatusLine = true;
    } else {
      delete parsed.statusLine;
    }
  }

  const changed = removedHooks > 0 || removedStatusLine;
  return {
    text: JSON.stringify(parsed, null, 2) + "\n",
    removed_hooks: removedHooks,
    removed_status_line: removedStatusLine,
    restored_status_line: restoredStatusLine,
    changed,
  };
}

function emptyResult(t: HookTarget): RemovalResult {
  return {
    ...t,
    removed_hooks: 0,
    removed_status_line: false,
    restored_status_line: false,
    deleted: false,
    changed: false,
    error: null,
  };
}

/** 清理单个位置。dryRun 下一个字节都不写，只算出「会发生什么」。 */
export function remove(t: HookTarget, opts: { dryRun?: boolean } = {}): RemovalResult {
  const out = emptyResult(t);
  if (!t.exists) return out;
  try {
    if (t.kind !== "json") {
      // 我们自己的文件（pi 插件 / 废弃的 skill 目录）：整份删
      if (!opts.dryRun) rmSync(t.file, { recursive: true, force: true });
      out.deleted = true;
      out.changed = true;
      return out;
    }
    if (t.unreadable) {
      out.error = "unreadable json";
      return out;
    }
    const rewritten = rewriteJson(readFileSync(t.file, "utf-8"), t.backup ? readFileSync(t.backup, "utf-8") : null);
    out.removed_hooks = rewritten.removed_hooks;
    out.removed_status_line = rewritten.removed_status_line;
    out.restored_status_line = rewritten.restored_status_line;
    out.changed = rewritten.changed;
    if (rewritten.changed && !opts.dryRun) writeFileSync(t.file, rewritten.text);
  } catch (err) {
    out.error = String(err);
  }
  return out;
}

/**
 * 人工善后项。我们**故意**不碰的东西要说出来 —— 不说的话，
 * 「已完全卸载」就是一句假话，而用户要到很久以后才会发现。
 */
export function manualNotes(opts: UninstallOptions, results: RemovalResult[]): UninstallNote[] {
  const { repoRoot, home } = roots(opts);
  const notes: UninstallNote[] = [];
  const codexConfig = join(home, ".codex", "config.toml");
  if (existsSync(codexConfig)) {
    try {
      // 只在真的是我们写进去的那条时才提：install.ts 用的是仓库绝对路径
      if (readFileSync(codexConfig, "utf-8").includes(repoRoot)) {
        notes.push({ key: "uninstall.note.codexTrust", params: { file: codexConfig } });
      }
    } catch {
      // 读不到就不提：这条只是提示，不该因为它失败
    }
  }
  const backups = results.filter((r) => r.changed && r.backup).map((r) => r.backup as string);
  if (backups.length > 0) {
    notes.push({ key: "uninstall.note.backups", params: { files: backups.join(", ") } });
  }
  return notes;
}

/** 扫描 + 清理（设置窗口与 CLI 共用的入口） */
export function uninstallAdapters(opts: UninstallOptions = {}): UninstallReport {
  const results = scan(opts).map((t) => remove(t, { dryRun: opts.dryRun }));
  return { results, notes: manualNotes(opts, results), dry_run: Boolean(opts.dryRun) };
}

/* ---------------- 本地数据（CLI 专属） ---------------- */

/** 数据目录：仓库根（dev）与用户级（打包版的 token 双写、pi 插件的离线兜底） */
export function dataDirs(opts: UninstallOptions = {}): string[] {
  const { repoRoot, home } = roots(opts);
  return [join(repoRoot, ".vibepaws"), join(home, ".vibepaws")];
}

export interface PurgeResult {
  dir: string;
  existed: boolean;
  deleted: boolean;
  error: string | null;
}

/**
 * 删数据目录。设置窗口里的「删除全部数据」走的是 Core 的清表实现
 * （src/core/reset.ts）—— Core 正开着库的时候删文件，只会让它继续往一个
 * 已经不在目录树里的 inode 写下去。这里是**没有** Core 时的那条路。
 */
export function purgeDataDirs(opts: UninstallOptions = {}): PurgeResult[] {
  return dataDirs(opts).map((dir) => {
    const out: PurgeResult = { dir, existed: existsSync(dir), deleted: false, error: null };
    if (!out.existed) return out;
    try {
      if (!opts.dryRun) rmSync(dir, { recursive: true, force: true });
      out.deleted = true;
    } catch (err) {
      out.error = String(err);
    }
    return out;
  });
}

/* ---------------- CLI ---------------- */

const LOCALE = detectNodeLocale();
const t = (key: string, params?: Record<string, string | number>): string => translate(LOCALE, key, params);

function agentLabel(agent: UninstallAgent): string {
  return agent === "claude_code" ? "Claude Code" : agent === "codex" ? "Codex" : agent === "pi" ? "pi" : "DeepSeek Harness";
}

/** 一行说清一个位置发生了什么（CLI 与设置窗口的措辞刻意保持一致） */
export function describe(r: RemovalResult): string {
  const who = `${agentLabel(r.agent)} · ${r.scope}`;
  if (r.error) return t("cli.uninstall.error", { who, file: r.file, error: r.error });
  if (r.deleted) return t("cli.uninstall.deleted", { who, file: r.file });
  const parts: string[] = [];
  if (r.removed_hooks > 0) parts.push(t("cli.uninstall.part.hooks", { n: r.removed_hooks }));
  if (r.restored_status_line) parts.push(t("cli.uninstall.part.statusRestored"));
  else if (r.removed_status_line) parts.push(t("cli.uninstall.part.statusRemoved"));
  if (parts.length === 0) return t("cli.uninstall.nothing", { who, file: r.file });
  return t("cli.uninstall.cleaned", { who, file: r.file, what: parts.join(" + ") });
}

async function coreReachable(port = 17893): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(700),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const argv = process.argv;
  const has = (name: string): boolean => argv.includes(`--${name}`);
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const repoRoot = process.cwd();
  const dry = has("dry-run");
  const raw = arg("agent") ?? "all";
  const agents: UninstallAgent[] | undefined =
    raw === "all" ? undefined : (raw.split(",").filter((a) => a === "claude_code" || a === "codex" || a === "pi" || a === "dsh") as UninstallAgent[]);
  if (agents && agents.length === 0) {
    console.error(t("cli.unknownAgent", { agent: raw }));
    process.exit(1);
  }

  console.log(t("cli.uninstall.header", { agent: raw, dry: dry ? " (dry-run)" : "", repo: repoRoot }));

  const report = uninstallAdapters({ repoRoot, agents, dryRun: dry });
  if (report.results.length === 0) console.log(t("cli.uninstall.clean"));
  for (const r of report.results) console.log(`  ${describe(r)}`);

  if (has("purge-data")) {
    // Core 还开着库的时候删目录 = 它继续往一个已经不在目录树里的 inode 写。
    // 「先退出 Core」这件事只有用户能做，所以这里拒绝，而不是删一半。
    if (!dry && (await coreReachable())) {
      console.error(t("cli.uninstall.purge.coreRunning"));
      process.exit(2);
    }
    for (const p of purgeDataDirs({ repoRoot, dryRun: dry })) {
      if (!p.existed) continue;
      console.log(`  ${p.error ? t("cli.uninstall.purge.failed", { dir: p.dir, error: p.error }) : t("cli.uninstall.purge.deleted", { dir: p.dir })}`);
    }
  } else {
    console.log(t("cli.uninstall.purge.hint"));
  }

  for (const n of report.notes) console.log(`  ⚠ ${t(n.key, n.params)}`);
  console.log(dry ? t("cli.uninstall.dryDone") : t("cli.uninstall.done"));
}

// CLI 入口：npm run adapter:uninstall
// 守卫必须在（install.ts 是无条件 main()）：Core 会 import 本文件来服务
// /api/uninstall，import 时顺手把用户的 hooks 全删了可不是「服务端点」。
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
