/**
 * 「永远允许」—— 权限授予规则（U9 / R20）。
 *
 * 一条授予 = 一个工具 × 一个项目（Bash 再 × 一个命令前缀），写进**那个项目**的
 * `.claude/settings.local.json` 的 `permissions.allow`，让 Claude Code 自己的权限流程也认它。
 * 不写 `.claude/settings.json`：那个文件 git 跟踪（install.ts 的 hooks 也在那儿），
 * 凌晨两点按下的一次「永远允许」不该出现在队友的 checkout 里。
 *
 * **两份记录，谁说了算要说清楚：**
 *   · `rules` 表是权威 —— Vibepaws 列出的、能撤销的、将来（U11）会替你自动回答的，只有表里的行；
 *   · 文件是镜像 —— 写进去只是为了让 agent 原生的流程也照办。
 * 文件里有、表里没有的规则会被列成「不是经由 Vibepaws 授予的」警告，**且不被当作授予**。
 * 这是一个检测面，不是一道闸：agent 用它自己的 Write 工具就能改这个文件，这里拦不住；
 * 这里能保证的只是 Vibepaws 不会把那样一次改动洗成「是人批准过的」。
 * 也因为规则一旦进了文件，Claude Code 就直接放行、根本不再发 PermissionRequest ——
 * 既没有气泡可以拦，也没有事件可以数，所以 `use_count` 现在恒为 0（见 listRules）。
 *
 * **谁能创建一条授予（KTD13）：** 只有桌面壳。授予是一个永久的权限裁决，而 bearer token
 * 写在 cwd/.vibepaws/api_token（agent 自己的 hook 就在读它），UI server 又把 /api/* 原样代理、
 * 替调用方盖上 token —— 所以「持有 token」或「够得着 UI 端口」都不能等于「能授予」。
 * 创建端点额外要一个 grant secret：壳每次拉起 Core 时现生成、经子进程 **stdin** 递过去
 * （不走环境变量 —— 同一用户的进程在 macOS 上能读别人的初始环境；不走命令行参数，ps 看得见），
 * 从不落盘、从不打日志、从不进任何 SSE / 状态推送。渲染层只能经 preload 的 IPC 请求
 * 「对第几号通知按了永远允许」，主进程核对发送方是宠物窗口之后自己去打 Core。
 * 请求里只有通知 id：工具、项目、命令前缀全部由 Core 从它**自己**存的那一行推出来。
 * 撤销（收回权限）走普通的 token 端点 —— 收窄权限不需要比读状态更高的门槛。
 *
 * 另一份规则目录 —— 辅导类警告的阈值与「没用」（U10）—— 在 core/coaching.ts：
 * 两者都叫「规则」，但一个是权限裁决、一个是提醒的灵敏度，安全边界完全不同，不放在一个文件里。
 */
import type Database from "better-sqlite3";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, sep } from "node:path";
import { isGrantableCommand } from "./bash_allowlist.ts";
import { hasCommandPrefixShape } from "./events.ts";
import { projectShortName } from "./registry.ts";

/* ================= 能授予什么（允许表）与危险类（第二道保险） ================= */

/** 可授予的 Bash 命令是一张允许表（core/bash_allowlist.ts）：表外的一律没有「永远允许」 */
export { GRANTABLE_COMMANDS, isGrantableCommand } from "./bash_allowlist.ts";

/**
 * 永远不给「永远允许」的 Bash 命令族 —— **第二道保险**。主闸是上面那张允许表；这张表防的是
 * 将来有人往允许表里加了一项、却没意识到它会执行任意东西。按**前缀**比较、按词对齐：
 * 一条授予 `Bash(git *)` 覆盖了 `git push --force`，所以 `git` 本身也在拒绝之列；
 * 反过来 `git push origin` 落在 `git push` 里面，同样拒绝。
 *
 * 列表宁宽勿窄：少列一项的代价是一条永久的、用户多半记不得的授权；多列一项的代价只是
 * 那条命令每次还要在终端里点一下。
 */
export const DESTRUCTIVE_COMMANDS: ReadonlyArray<{ prefix: string; why: string }> = Object.freeze([
  // 删除 / 覆写
  { prefix: "rm", why: "deletes files (rm -rf)" },
  { prefix: "rmdir", why: "deletes directories" },
  { prefix: "unlink", why: "deletes files" },
  { prefix: "shred", why: "destroys file contents" },
  { prefix: "dd", why: "overwrites devices and files" },
  { prefix: "mkfs", why: "formats a filesystem" },
  { prefix: "truncate", why: "empties files" },
  { prefix: "find", why: "can -delete / -exec anything" },
  // 提权 / 改权限
  { prefix: "sudo", why: "runs as root" },
  { prefix: "su", why: "switches user" },
  { prefix: "doas", why: "runs as root" },
  { prefix: "chmod", why: "changes permissions" },
  { prefix: "chown", why: "changes ownership" },
  { prefix: "chgrp", why: "changes ownership" },
  // 「替你跑任何东西」的外壳 —— 前缀说明不了会执行什么（curl … | sh 的后一半就在这里）
  { prefix: "sh", why: "runs an arbitrary script" },
  { prefix: "bash", why: "runs an arbitrary script" },
  { prefix: "zsh", why: "runs an arbitrary script" },
  { prefix: "fish", why: "runs an arbitrary script" },
  { prefix: "dash", why: "runs an arbitrary script" },
  { prefix: "ksh", why: "runs an arbitrary script" },
  { prefix: "eval", why: "runs an arbitrary string" },
  { prefix: "exec", why: "runs an arbitrary command" },
  { prefix: "source", why: "runs an arbitrary script" },
  { prefix: "xargs", why: "runs an arbitrary command" },
  { prefix: "env", why: "runs an arbitrary command" },
  { prefix: "nohup", why: "runs an arbitrary command" },
  { prefix: "command", why: "runs an arbitrary command" },
  { prefix: "osascript", why: "runs an arbitrary script" },
  { prefix: "timeout", why: "runs an arbitrary command" },
  { prefix: "nice", why: "runs an arbitrary command" },
  { prefix: "ionice", why: "runs an arbitrary command" },
  { prefix: "time", why: "runs an arbitrary command" },
  { prefix: "caffeinate", why: "runs an arbitrary command" },
  { prefix: "stdbuf", why: "runs an arbitrary command" },
  { prefix: "watch", why: "runs an arbitrary command repeatedly" },
  { prefix: "script", why: "runs an arbitrary command" },
  { prefix: "sandbox-exec", why: "runs an arbitrary command" },
  { prefix: "arch", why: "runs an arbitrary command" },
  { prefix: "open", why: "launches any application or URL" },
  { prefix: "awk", why: "can system() / write files" },
  { prefix: "sed", why: "can -i overwrite / e-execute" },
  { prefix: "node", why: "runs arbitrary code (-e)" },
  { prefix: "python", why: "runs arbitrary code (-c)" },
  { prefix: "python3", why: "runs arbitrary code (-c)" },
  { prefix: "ruby", why: "runs arbitrary code (-e)" },
  { prefix: "perl", why: "runs arbitrary code (-e)" },
  { prefix: "php", why: "runs arbitrary code (-r)" },
  { prefix: "deno", why: "runs arbitrary code" },
  { prefix: "bun", why: "runs arbitrary code" },
  { prefix: "npx", why: "downloads and runs any package" },
  { prefix: "pnpx", why: "downloads and runs any package" },
  { prefix: "bunx", why: "downloads and runs any package" },
  { prefix: "npm exec", why: "downloads and runs any package" },
  { prefix: "npm x", why: "downloads and runs any package" },
  { prefix: "npm install", why: "runs package lifecycle scripts" },
  { prefix: "pnpm dlx", why: "downloads and runs any package" },
  { prefix: "pnpm exec", why: "runs an arbitrary command" },
  { prefix: "yarn dlx", why: "downloads and runs any package" },
  { prefix: "yarn exec", why: "runs an arbitrary command" },
  { prefix: "uvx", why: "downloads and runs any package" },
  { prefix: "uv run", why: "runs an arbitrary command" },
  { prefix: "pipx", why: "downloads and runs any package" },
  { prefix: "docker run", why: "runs a container (can mount /)" },
  { prefix: "docker exec", why: "runs a command in a container" },
  // 覆写 / 挪走文件
  { prefix: "tee", why: "overwrites files" },
  { prefix: "mv", why: "overwrites files" },
  { prefix: "cp", why: "overwrites files" },
  { prefix: "ln", why: "redirects files via links" },
  // 网络取回（curl … | sh 的前一半；-o 覆写文件）与远程
  { prefix: "curl", why: "downloads (curl | sh) and overwrites (-o)" },
  { prefix: "wget", why: "downloads and overwrites" },
  { prefix: "ssh", why: "runs commands on another machine" },
  { prefix: "scp", why: "overwrites remote files" },
  { prefix: "rsync", why: "can --delete" },
  // git 里改写 / 丢弃历史与工作区的那些
  { prefix: "git push", why: "can --force" },
  { prefix: "git reset", why: "can --hard" },
  { prefix: "git clean", why: "deletes untracked files" },
  { prefix: "git checkout", why: "discards changes" },
  { prefix: "git restore", why: "discards changes" },
  { prefix: "git rebase", why: "rewrites history" },
  { prefix: "git branch", why: "can -D" },
  { prefix: "git stash", why: "can drop / clear" },
  { prefix: "git rm", why: "deletes files" },
  { prefix: "git filter-branch", why: "rewrites history" },
  { prefix: "git update-ref", why: "rewrites refs" },
  { prefix: "git reflog", why: "can expire history" },
  { prefix: "git gc", why: "can prune history" },
  { prefix: "git config", why: "aliases and hooksPath run arbitrary code" },
  { prefix: "git worktree", why: "can remove worktrees" },
  { prefix: "git tag", why: "can delete / move tags" },
  // 发布 / 删除远端东西 —— 不可撤回
  { prefix: "npm publish", why: "publishes irreversibly" },
  { prefix: "npm unpublish", why: "deletes a published package" },
  { prefix: "gh repo", why: "can delete a repository" },
  { prefix: "gh release", why: "can delete a release" },
  { prefix: "gh api", why: "any GitHub API call, including deletes" },
  { prefix: "gh secret", why: "changes repository secrets" },
  { prefix: "gh auth", why: "changes / prints credentials" },
  { prefix: "docker rm", why: "deletes containers" },
  { prefix: "docker rmi", why: "deletes images" },
  { prefix: "docker system", why: "can prune everything" },
  { prefix: "docker volume", why: "can delete volumes" },
  // 进程与机器
  { prefix: "kill", why: "kills processes" },
  { prefix: "killall", why: "kills processes" },
  { prefix: "pkill", why: "kills processes" },
  { prefix: "launchctl", why: "changes system services" },
  { prefix: "security", why: "reads / changes the keychain" },
  { prefix: "crontab", why: "schedules arbitrary commands" },
  { prefix: "defaults", why: "changes system and app settings" },
  { prefix: "shutdown", why: "powers off" },
  { prefix: "reboot", why: "restarts the machine" },
  { prefix: "halt", why: "powers off" },
]);

/**
 * 带参数的工具：必须有一个推得出来的参数模式才给授予。只有 Bash 的前缀推得出来（command_prefix）；
 * 其余的整个放行等于放行它能碰到的一切（WebFetch = 任何域名），所以一律不给。
 */
export const ARGUMENT_TOOLS: ReadonlySet<string> = new Set(["Bash", "WebFetch", "PowerShell"]);

/**
 * 能以**工具名本身**授予的工具：只读的那几个（Claude Code 内建工具名）。
 * 别的一律不给 —— Edit / Write / MultiEdit / NotebookEdit 整个放行等于让 agent 能不经询问地
 * 改 `.claude/settings*.json`，给自己加上 `Bash(rm *)` 或一个 hook，把上面两张表一起绕开；
 * AskUserQuestion / ExitPlanMode 放行会替用户答掉问题与计划；mcp__* 的效果是第三方定的，这里说不清；
 * 认不得的名字同样不给。
 */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead", "WebSearch"]);

/** 工具名的形状：Claude Code 内建工具 + mcp__server__tool。括号、通配符、空格进不来 */
const TOOL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;

function words(s: string): string[] {
  return s.trim().split(/\s+/);
}

/** a 按词是 b 的前缀（`git` 是 `git push` 的前缀；`gi` 不是） */
function wordPrefix(a: string[], b: string[]): boolean {
  return a.length <= b.length && a.every((w, i) => w === b[i]);
}

/** 这个前缀的授予会不会碰到危险类：互为前缀即相交（`git` 覆盖 `git push`；`git push origin` 落在 `git push` 里） */
export function destructiveMatch(prefix: string): { prefix: string; why: string } | null {
  const p = words(prefix);
  return DESTRUCTIVE_COMMANDS.find((d) => {
    const dw = words(d.prefix);
    return wordPrefix(p, dw) || wordPrefix(dw, p);
  }) ?? null;
}

export type GrantRefusal =
  | "not_found"
  | "not_permission"
  | "resolved"
  | "unsupported_agent"
  | "bad_tool"
  | "no_pattern"
  | "destructive"
  | "not_allowlisted"
  | "bad_project"
  /** 按下去的时候推出来的规则 / 项目跟气泡上显示的（pinGrantPreview 钉住的）不一样，或者根本没钉过 */
  | "changed";

export type GrantSpec = { ok: true; tool: string; pattern: string | null; rule: string } | { ok: false; reason: GrantRefusal };

/**
 * 从一个权限请求自己的字段拼出那条规则 —— 没有范围选择器，用户看到的就是会写进去的那条。
 * 纯函数：允许表、危险类、带参工具、agent 支持与否全在这里判。
 */
export function grantFor(input: { agent: string; tool: unknown; commandPrefix?: unknown }): GrantSpec {
  // 只有 Claude Code 有一个「项目本地、不进 git」的规则文件可写
  if (input.agent !== "claude_code") return { ok: false, reason: "unsupported_agent" };
  const tool = input.tool;
  if (typeof tool !== "string" || !TOOL_NAME.test(tool)) return { ok: false, reason: "bad_tool" };
  if (tool === "Bash") {
    if (!hasCommandPrefixShape(input.commandPrefix)) return { ok: false, reason: "no_pattern" };
    if (destructiveMatch(input.commandPrefix)) return { ok: false, reason: "destructive" };
    if (!isGrantableCommand(input.commandPrefix)) return { ok: false, reason: "not_allowlisted" };
    return { ok: true, tool, pattern: input.commandPrefix, rule: `Bash(${input.commandPrefix} *)` };
  }
  if (ARGUMENT_TOOLS.has(tool)) return { ok: false, reason: "no_pattern" };
  if (!READ_ONLY_TOOLS.has(tool)) return { ok: false, reason: "not_allowlisted" };
  return { ok: true, tool, pattern: null, rule: tool };
}

/* ================= 规则文件（镜像） ================= */

/** 授予写到哪：那个项目自己的 `.claude/settings.local.json`（不进 git，不是 install.ts 写的那份） */
export function ruleFilePath(projectRoot: string): string {
  return join(projectRoot, ".claude", "settings.local.json");
}

export type RuleFileRead =
  | { ok: true; exists: boolean; json: Record<string, unknown>; allow: string[] }
  | { ok: false; reason: "malformed" | "unreadable" };

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * 读规则文件。读不成（截断、手改坏了、形状不对）→ malformed，调用方**不许**覆盖它：
 * 把一个坏文件「修好」的唯一办法是重写，而重写会把用户那些我们解析不了的条目一起抹掉。
 */
export function readRuleFile(file: string): RuleFileRead {
  if (!existsSync(file)) return { ok: true, exists: false, json: {}, allow: [] };
  let text: string;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  let json: unknown;
  try {
    json = text.trim() === "" ? {} : JSON.parse(text);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!isPlainObject(json)) return { ok: false, reason: "malformed" };
  const perms = json.permissions;
  if (perms !== undefined && !isPlainObject(perms)) return { ok: false, reason: "malformed" };
  const allow = perms?.allow;
  if (allow !== undefined && !Array.isArray(allow)) return { ok: false, reason: "malformed" };
  return { ok: true, exists: true, json, allow: (allow ?? []).filter((x): x is string => typeof x === "string") };
}

/** 路径上是不是有东西（包括一个指向不存在目标的符号链接 —— existsSync 对它说 false） */
function lexists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

function isSymlink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * 写之前的符号链接检查：`<project>/.claude` 或规则文件本身是链接 → 拒绝。
 * 项目目录是 agent 能写的地方（一个克隆下来的仓库也可能自带这样的链接），而一次「永远允许」
 * 不该变成写穿到项目外（~/.zshrc）的一次覆写。
 */
function symlinkedTarget(file: string): boolean {
  return isSymlink(dirname(file)) || isSymlink(file);
}

/**
 * 与 install.ts 同一个习惯：第一次改之前留一份 `.vibepaws.bak`，之后不再覆盖它（它是「我们来之前」的样子）。
 * 那个位置上已经有任何东西（包括一个悬空的链接）就不写；写用 `wx`，不跟随链接、不覆盖。
 */
function backupOnce(file: string): void {
  if (!existsSync(file)) return;
  const bak = `${file}.vibepaws.bak`;
  if (lexists(bak)) return;
  try {
    writeFileSync(bak, readFileSync(file, "utf-8"), { flag: "wx", mode: 0o600 });
  } catch {
    // 备份是锦上添花：抢不到那个名字（EEXIST）不妨碍写规则本身
  }
}

/**
 * 先写临时文件再 rename：写到一半崩掉不会留下一个截断的配置。
 * 临时文件名带随机后缀、用 `wx` 独占创建 —— 预先放好的同名链接不会被跟随；rename 替换的是
 * 目录项本身，也不会写穿到链接指向的地方。
 */
function writeJsonAtomic(file: string, json: Record<string, unknown>): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(6).toString("hex")}.vibepaws.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(json, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* 没建出来 / 已经 rename 走了 */
    }
    throw e;
  }
}

export type RuleFileWrite = { ok: true; changed: boolean } | { ok: false; reason: "malformed" | "unreadable" };

/**
 * 在 permissions.allow 里加一条（已有则不动）。文件里别的键、别的条目、非字符串条目原样保留。
 * 文件不存在就建；读不成、或 `.claude` / 文件本身是符号链接就报错、一个字节都不写。
 */
export function addRuleToFile(file: string, rule: string): RuleFileWrite {
  if (symlinkedTarget(file)) return { ok: false, reason: "unreadable" };
  const read = readRuleFile(file);
  if (!read.ok) return read;
  if (read.allow.includes(rule)) return { ok: true, changed: false };
  const json = read.json;
  const perms = isPlainObject(json.permissions) ? json.permissions : {};
  const allow = Array.isArray(perms.allow) ? [...perms.allow] : [];
  allow.push(rule);
  backupOnce(file);
  writeJsonAtomic(file, { ...json, permissions: { ...perms, allow } });
  return { ok: true, changed: true };
}

/** 从 permissions.allow 里拿掉这一条（只拿掉完全相同的那一条）；文件不在 / 本来就没有 → 没变化 */
export function removeRuleFromFile(file: string, rule: string): RuleFileWrite {
  if (symlinkedTarget(file)) return { ok: false, reason: "unreadable" };
  const read = readRuleFile(file);
  if (!read.ok) return read;
  if (!read.exists || !read.allow.includes(rule)) return { ok: true, changed: false };
  const json = read.json;
  const perms = json.permissions as Record<string, unknown>;
  const allow = (perms.allow as unknown[]).filter((x) => x !== rule);
  backupOnce(file);
  writeJsonAtomic(file, { ...json, permissions: { ...perms, allow } });
  return { ok: true, changed: true };
}

/* ================= grant secret（只在壳里） ================= */

/** 创建端点额外要的那个头。UI server 永远不转发它（src/ui/server.ts 的代理只转 content-type） */
export const GRANT_SECRET_HEADER = "x-vibepaws-grant";
/** 壳告诉 Core「secret 从 stdin 来」的标记。它本身不是秘密，只是一个开关 */
export const GRANT_CHANNEL_ENV = "VIBEPAWS_GRANT_CHANNEL";
const GRANT_SECRET_SHAPE = /^[0-9a-f]{64}$/;

export function isGrantSecret(v: unknown): v is string {
  return typeof v === "string" && GRANT_SECRET_SHAPE.test(v);
}

/** 常数时间比较。Core 没有 secret（不是壳拉起来的）→ 永远 false：那种 Core 上根本没有授予这回事 */
export function grantSecretMatches(expected: string | null, got: unknown): boolean {
  if (!expected || typeof got !== "string" || got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(got));
}

/* ================= rules 表（权威） ================= */

export interface GrantDerived {
  notification_id: number;
  agent: string;
  project_id: string;
  tool: string;
  pattern: string | null;
  rule: string;
  file: string;
}

/**
 * 从**库里那一行**推出这次授予 —— 渲染层只给了一个 id，别的一概不信。
 * 必须是一条还挂着的 permission 通知（已经结束的请求没有「这一次」可言），
 * 它的 tool_name / command_prefix 来自那条事件落库的白名单 payload，项目来自 session 行。
 */
export function deriveGrant(db: Database.Database, notificationId: number): { ok: true; grant: GrantDerived } | { ok: false; reason: GrantRefusal } {
  const row = db
    .prepare(
      `SELECT n.id, n.agent, n.type, n.resolution, e.payload_json, s.project_id
         FROM notifications n
         LEFT JOIN events e ON e.event_id = n.event_id
         LEFT JOIN sessions s ON s.agent = n.agent AND s.agent_session_id = n.session_id
        WHERE n.id = ?`,
    )
    .get(notificationId) as
    | { id: number; agent: string; type: string; resolution: string | null; payload_json: string | null; project_id: string | null }
    | undefined;
  if (!row) return { ok: false, reason: "not_found" };
  if (row.type !== "permission") return { ok: false, reason: "not_permission" };
  if (row.resolution !== null) return { ok: false, reason: "resolved" };
  let payload: Record<string, unknown> = {};
  try {
    payload = JSON.parse(row.payload_json ?? "{}") as Record<string, unknown>;
  } catch {
    payload = {};
  }
  const spec = grantFor({ agent: row.agent, tool: payload.tool_name, commandPrefix: payload.command_prefix });
  if (!spec.ok) return spec;
  const project = row.project_id;
  if (!project || !isAbsolute(project) || !isDirectory(project)) return { ok: false, reason: "bad_project" };
  if (isUnsafeProjectRoot(project)) return { ok: false, reason: "bad_project" };
  return {
    ok: true,
    grant: {
      notification_id: row.id,
      agent: row.agent,
      project_id: project,
      tool: spec.tool,
      pattern: spec.pattern,
      rule: spec.rule,
      file: ruleFilePath(project),
    },
  };
}

/**
 * 不像一个项目的目录：`/`、用户 home、home 的任何上级（按 realpath 比，链接绕不过去）。
 * project_id 是 agent 报上来的；一条伪造的请求把它设成 $HOME，授予就会写进 ~/.claude/ ——
 * 那是用户级的配置，不是「这一个项目」。
 */
export function isUnsafeProjectRoot(project: string, home: string = homedir()): boolean {
  let real: string;
  let realHome: string;
  try {
    real = realpathSync(project);
  } catch {
    return true;
  }
  try {
    realHome = realpathSync(home);
  } catch {
    realHome = home;
  }
  if (real === sep || dirname(real) === real) return true;
  if (real === realHome) return true;
  return realHome.startsWith(real.endsWith(sep) ? real : real + sep);
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 气泡上要显示「永远允许 X 于 Y」的那一刻，把推出来的 {规则, 项目} 钉在这条通知上。
 * 按下去的时候 createGrant 会再推一遍，跟钉住的对不上就拒 —— session 行里的 project_id 是 agent
 * 报的、resume 事件能改它；用户读到的是哪一条，写进去的就只能是那一条。
 * 已经钉过、这次推出来的又不一样 → 不给预览（null），也不改钉住的值。
 */
export function pinGrantPreview(db: Database.Database, notificationId: number): GrantDerived | null {
  const d = deriveGrant(db, notificationId);
  if (!d.ok) return null;
  const pinned = readPin(db, notificationId);
  if (pinned) return pinned.rule === d.grant.rule && pinned.project_id === d.grant.project_id ? d.grant : null;
  db.prepare("UPDATE notifications SET grant_rule=?, grant_project=? WHERE id=?").run(
    d.grant.rule,
    d.grant.project_id,
    notificationId,
  );
  return d.grant;
}

function readPin(db: Database.Database, notificationId: number): { rule: string; project_id: string } | null {
  const row = db.prepare("SELECT grant_rule, grant_project FROM notifications WHERE id=?").get(notificationId) as
    | { grant_rule: string | null; grant_project: string | null }
    | undefined;
  if (!row?.grant_rule || !row.grant_project) return null;
  return { rule: row.grant_rule, project_id: row.grant_project };
}

export type CreateGrantResult =
  | { ok: true; id: number; rule: string; project: string; created: boolean }
  | { ok: false; reason: GrantRefusal | "malformed" | "unreadable" };

/**
 * 写一条授予：先写文件（镜像），成功了才落行。顺序是刻意的 —— 反过来的话，文件写不进去时
 * 表里会多出一条 agent 并不认的「授予」，设置窗口里显示着一条其实不生效的规则。
 * 同一条规则再按一次是幂等的：不新增行，文件里缺了就补回去。
 * 只授予气泡上显示过的那一条：没有钉住的预览、或者此刻推出来的规则 / 项目跟钉住的不一样 → changed。
 */
export function createGrant(db: Database.Database, notificationId: number, now = new Date()): CreateGrantResult {
  const d = deriveGrant(db, notificationId);
  if (!d.ok) return d;
  const g = d.grant;
  const pinned = readPin(db, notificationId);
  if (!pinned || pinned.rule !== g.rule || pinned.project_id !== g.project_id) return { ok: false, reason: "changed" };
  const written = addRuleToFile(g.file, g.rule);
  if (!written.ok) return written;
  const existing = db
    .prepare("SELECT id FROM rules WHERE agent=? AND project_id=? AND rule=?")
    .get(g.agent, g.project_id, g.rule) as { id: number } | undefined;
  if (existing) return { ok: true, id: existing.id, rule: g.rule, project: projectShortName(g.project_id), created: false };
  const info = db
    .prepare(
      `INSERT INTO rules(agent, project_id, tool, pattern, rule, origin, notification_id, created_at)
       VALUES(?, ?, ?, ?, ?, 'bubble', ?, ?)`,
    )
    .run(g.agent, g.project_id, g.tool, g.pattern, g.rule, g.notification_id, now.toISOString());
  return { ok: true, id: Number(info.lastInsertRowid), rule: g.rule, project: projectShortName(g.project_id), created: true };
}

export type RevokeResult = { ok: true; rule: string } | { ok: false; reason: "not_found" | "malformed" | "unreadable" };

/** 撤销：从文件里拿掉，再删行。文件读不成就停下 —— 行还在，设置窗口照旧能看到它、照旧能再试 */
export function revokeGrant(db: Database.Database, id: number): RevokeResult {
  const row = db.prepare("SELECT project_id, rule FROM rules WHERE id=?").get(id) as
    | { project_id: string; rule: string }
    | undefined;
  if (!row) return { ok: false, reason: "not_found" };
  const removed = removeRuleFromFile(ruleFilePath(row.project_id), row.rule);
  if (!removed.ok) return removed;
  db.prepare("DELETE FROM rules WHERE id=?").run(id);
  return { ok: true, rule: row.rule };
}

/**
 * 这条规则算不算一次授予：**只看表**。文件里有、表里没有的（agent 自己写的、手加的）一律不算 ——
 * 将来 U11 的自动回答只能从这里问。
 */
export function isGranted(db: Database.Database, agent: string, projectId: string, rule: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM rules WHERE agent=? AND project_id=? AND rule=?").get(agent, projectId, rule));
}

export interface RuleView {
  id: number;
  rule: string;
  tool: string;
  pattern: string | null;
  /** 项目短名 —— 原始 project_id 是绝对路径，永远不出 Core */
  project: string;
  origin: "bubble";
  /** 创建它的那条气泡（notifications.id） */
  notification_id: number | null;
  /**
   * 恒为 0，而且不是 bug：规则一旦进了文件，Claude Code 直接放行、不再发 PermissionRequest，
   * Vibepaws 看不到那次使用（PreToolUse 里没有保留命令前缀，数不出是哪条规则放的行）。
   */
  use_count: number;
  created_at: string;
  /** 文件里还有没有它（false = 被手动删掉了；表仍然权威，撤销会把行一起清掉） */
  in_file: boolean;
}

export interface RulesSnapshot {
  rules: RuleView[];
  /** 文件里有、表里没有：不是经由 Vibepaws 授予的，不被当作授予 */
  external: Array<{ rule: string; project: string }>;
  /** 读不成的规则文件：不覆盖、只报告 */
  problems: Array<{ project: string; reason: "malformed" | "unreadable" }>;
}

/** 扫哪些项目：有授予的 + 最近出现过的 Claude Code 项目。上限是为了一次轮询别去读几百个文件 */
const SCAN_PROJECTS_MAX = 50;

/** 设置窗口的规则列表（GET /api/rules） */
export function listRules(db: Database.Database): RulesSnapshot {
  const rows = db
    .prepare(
      `SELECT id, project_id, rule, tool, pattern, origin, notification_id, use_count, created_at
         FROM rules ORDER BY created_at DESC, id DESC`,
    )
    .all() as Array<{
    id: number;
    project_id: string;
    rule: string;
    tool: string;
    pattern: string | null;
    origin: "bubble";
    notification_id: number | null;
    use_count: number;
    created_at: string;
  }>;
  const sessionProjects = (
    db
      .prepare(
        `SELECT project_id FROM sessions WHERE agent='claude_code'
          GROUP BY project_id ORDER BY MAX(last_event_at) DESC LIMIT ?`,
      )
      .all(SCAN_PROJECTS_MAX) as Array<{ project_id: string }>
  ).map((r) => r.project_id);
  const projects = [...new Set([...rows.map((r) => r.project_id), ...sessionProjects])].filter((p) => isAbsolute(p));

  const files = new Map<string, RuleFileRead>();
  for (const p of projects) files.set(p, readRuleFile(ruleFilePath(p)));

  const rules: RuleView[] = rows.map((r) => {
    const f = files.get(r.project_id);
    return {
      id: r.id,
      rule: r.rule,
      tool: r.tool,
      pattern: r.pattern,
      project: projectShortName(r.project_id),
      origin: r.origin,
      notification_id: r.notification_id,
      use_count: r.use_count,
      created_at: r.created_at,
      in_file: Boolean(f?.ok && f.allow.includes(r.rule)),
    };
  });
  const external: RulesSnapshot["external"] = [];
  const problems: RulesSnapshot["problems"] = [];
  for (const [p, f] of files) {
    if (!f.ok) {
      problems.push({ project: projectShortName(p), reason: f.reason });
      continue;
    }
    const owned = new Set(rows.filter((r) => r.project_id === p).map((r) => r.rule));
    for (const rule of f.allow) if (!owned.has(rule)) external.push({ rule, project: projectShortName(p) });
  }
  return { rules, external, problems };
}
