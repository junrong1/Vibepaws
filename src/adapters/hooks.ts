/**
 * hooks 配置片段生成（架构 §2.1）— Claude Code 与 Codex 差异仅配置格式与事件名。
 * hook_agent.ts 通过 stdin 接收 hook 输入，用固定命令调用。
 */
import { readFileSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { CoreEvent, AgentId } from "../core/events.ts";

/** 仓库根（由本文件位置反推）：读 package.json 拿 adapter 版本，任意 cwd 下都成立 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * hook / statusline 用哪个解释器 —— 写进用户 agent 配置里的那一段前缀。
 *
 * 从前是裸的 `node`，两个问题：
 *   · 它由**agent 自己的 PATH** 解析，而那个 PATH 不一定是你装 Vibepaws 时的那个。
 *     解析到一个 v20 上，hook 会**静默失败** —— 宠物永远停在 idle，界面上没有任何线索。
 *   · 它假定用户机器上有 node。Core 已经不需要了（跑在 app 自带的 Node 上，见
 *     desktop/launch.js 的 coreInterpreter），如果 hook 还需要，那个前提就没真正去掉。
 *
 * 规则是「就用**正在跑我**的这个解释器」，它必然合格 —— 它此刻正在执行这些 .ts：
 *   · 装在普通 node 下（`npm run adapter:install`，今天的路径）→ 写它的绝对路径。
 *     快（实测 151ms / 次，Electron 那条是 215ms），而且绕开了 PATH 解析。
 *   · 装在 Electron 下（将来做成 app 内的一键安装）→ 写 app 自己的二进制 +
 *     ELECTRON_RUN_AS_NODE。用户一个 node 都不用装。
 *
 * 代价：绝对路径会跟着那一个 node 安装一起消失（nvm 卸掉某个版本时）。换成裸 `node` 只是
 * 把这个故障换成另一个更难查的故障（解析到别的版本、静默失败），所以这里选前者 ——
 * 重装 adapter 就修好了，而且 install.ts 的自检当场就会说话。
 */
export function hookInterpreter(
  opts: { execPath?: string; electron?: boolean; realpath?: (p: string) => string } = {},
): string {
  const execPath = opts.execPath ?? process.execPath;
  // process.versions.electron 只在 Electron 里存在 —— 比拿路径去猜可靠
  const electron = opts.electron ?? Boolean((process as { versions?: { electron?: string } }).versions?.electron);
  if (electron) return `ELECTRON_RUN_AS_NODE=1 ${shellQuote(execPath)} --experimental-strip-types`;
  return `${shellQuote(stablePath(execPath, opts.realpath))} --experimental-strip-types`;
}

/**
 * 版本管理器给的 execPath 常常是**带版本号**的真实路径，而不是那条稳定的符号链接：
 * Homebrew 的 node 解析出来是 /opt/homebrew/Cellar/node/25.9.0_2/bin/node，
 * 一次 `brew upgrade node` 就把它删了 —— 于是 hook 静默失效，宠物永远停在 idle，
 * 而这正是这次改动想要根除的那一类故障（nvm / fnm / volta 同理）。
 *
 * 所以：如果某条常见的稳定路径**指向同一个二进制**，就写那条。指向别的（用户的 PATH 里
 * 另有一个 node）就老老实实写 execPath —— 宁可将来随版本失效，也不能现在就写错一个。
 */
const STABLE_NODE_PATHS = [
  "/opt/homebrew/bin/node", // Apple Silicon Homebrew
  "/usr/local/bin/node", // Intel Homebrew / 官方 pkg
  "/usr/bin/node", // 系统自带（少见）
];

function stablePath(execPath: string, realpath: (p: string) => string = defaultRealpath): string {
  let target: string;
  try {
    target = realpath(execPath);
  } catch {
    return execPath;
  }
  for (const candidate of STABLE_NODE_PATHS) {
    try {
      if (realpath(candidate) === target) return candidate;
    } catch {
      /* 这条路径不存在，很正常 */
    }
  }
  return execPath;
}

function defaultRealpath(p: string): string {
  return realpathSync(p);
}

/** agent 的 hook 命令是交给 shell 跑的，而路径里可能有空格（"/Volumes/My Disk/…"） */
function shellQuote(p: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\''`)}'`;
}

/** hook_agent 的调用命令（相对仓库根，运行时由 install.ts 解析为绝对路径） */
export function agentCmd(agent: "claude_code" | "codex", repoRoot: string): string {
  const entry = `${repoRoot}/src/adapters/hook_agent.ts`;
  return `${hookInterpreter()} ${shellQuote(entry)} --agent=${agent}`;
}

/** Claude Code hooks 片段（并入 .claude/settings.json 的 hooks 字段） */
export function claudeHooksConfig(repoRoot: string): Record<string, unknown> {
  const cmd = agentCmd("claude_code", repoRoot);
  return {
    hooks: {
      SessionStart: [{ matcher: "", hooks: [{ type: "command", command: cmd }] }],
      UserPromptSubmit: [
        { matcher: "", hooks: [{ type: "command", command: cmd }] },
      ],
      PreToolUse: [
        { matcher: "Bash|Read|Edit|Write|WebFetch|AskUserQuestion", hooks: [{ type: "command", command: cmd }] },
      ],
      PostToolUse: [
        { matcher: "", hooks: [{ type: "command", command: cmd }] },
      ],
      Notification: [
        { matcher: "", hooks: [{ type: "command", command: cmd }] },
      ],
      // Stop = 主 agent 一轮说完了，「该你了」。Claude Code 里这才是即时信号：
      // SessionEnd 只在会话真正退出时才发，Notification 要么是权限弹窗要么得等 60s 空闲。
      Stop: [{ matcher: "", hooks: [{ type: "command", command: cmd }] }],
      PermissionRequest: [
        { matcher: "", hooks: [{ type: "command", command: cmd }] },
      ],
      PreCompact: [{ matcher: "", hooks: [{ type: "command", command: cmd }] }],
      PostCompact: [{ matcher: "", hooks: [{ type: "command", command: cmd }] }],
      PostToolUseFailure: [{ matcher: "", hooks: [{ type: "command", command: cmd }] }],
      SessionEnd: [{ matcher: "", hooks: [{ type: "command", command: cmd }] }],
      SubagentStart: [{ matcher: "", hooks: [{ type: "command", command: cmd }] }],
      SubagentStop: [{ matcher: "", hooks: [{ type: "command", command: cmd }] }],
    },
  };
}

/** Claude Code statusline 配置（实时 token 通道，与 hooks 一起安装）。
 * 注意：statusLine 是 Claude Code 专属能力，Codex 没有（Codex 走 SessionEnd transcript 提取）。 */
export function claudeStatusLineConfig(repoRoot: string): Record<string, unknown> {
  const entry = `${repoRoot}/src/adapters/statusline.ts`;
  return {
    statusLine: {
      type: "command",
      command: `${hookInterpreter()} ${shellQuote(entry)}`,
      padding: 0,
    },
  };
}

/** Codex hooks 片段（~/.codex/hooks.json，或仓库 .codex/hooks.json）
 * 注意：Codex hooks.json 的事件键为驼峰（SessionStart 等，与 Claude Code 一致），
 * 源码 serde rename 确认：#[serde(rename = "SessionStart")]。
 * 但 hooks 生效还需：① 项目被信任（~/.codex/config.toml projects 表）② 非托管 hooks 经 /hooks 审查
 * 或 exec 加 --dangerously-bypass-hook-trust。 */
export function codexHooksConfig(repoRoot: string): Record<string, unknown> {
  const cmd = agentCmd("codex", repoRoot);
  const hook = { type: "command", command: cmd };
  return {
    hooks: {
      SessionStart: [{ hooks: [hook] }],
      UserPromptSubmit: [{ hooks: [hook] }],
      PreToolUse: [{ hooks: [hook] }],
      PostToolUse: [{ hooks: [hook] }],
      Stop: [{ hooks: [hook] }],
      PermissionRequest: [{ hooks: [hook] }],
      PreCompact: [{ hooks: [hook] }],
      PostCompact: [{ hooks: [hook] }],
      SessionEnd: [{ hooks: [hook] }],
      SubagentStart: [{ hooks: [hook] }],
      SubagentStop: [{ hooks: [hook] }],
    },
  };
}

let statusSeq = 0;

/** adapter 版本跟着 package.json 走 —— 写死常量必然和发布版本漂移 */
export function adapterVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf-8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * adapter 自报家门。
 *
 * 没有这条事件，Core 分不清「装了 adapter，只是 agent 还没干活」和「压根没装 hooks」——
 * 两种情况在界面上都是一只闲着的宠物。整套 adapter_status 通路（events.ts 的类型、
 * ingress 的 upsertAgent、registry、server 的落库分支）本来就是齐的，缺的只是发送方：
 * 安装器把 capabilities() 打进了 console.log，从没发给过 Core。
 */
export function adapterStatusEvent(agent: AgentId, projectId: string): CoreEvent {
  return {
    // 计数器不能省：只用 Date.now() 的话，同一毫秒内的两次上报会拿到同一个
    // event_id，被 ingress 的幂等去重直接吃掉第二条。
    event_id: `adapter-status-${agent}-${Date.now()}-${++statusSeq}`,
    seq: 0,
    agent,
    // 固定 session_id：这不是一次会话，是一条「我在」的声明，重复上报要覆盖同一行
    session_id: `adapter-${agent}`,
    project_id: projectId,
    event_type: "adapter_status",
    severity: "low",
    safe_summary: `Adapter connected: ${agent}`,
    timestamp: new Date().toISOString(),
    payload: { capabilities: capabilities(agent), adapter_version: adapterVersion() },
  };
}

/** pi 能力声明：对齐 src/adapters/pi_extension.ts 插件真实能发的事件
 * （pi 无 statusline 实时通道，token 来自 message_end 的 usage；无 subagent 概念） */
export function piCapabilities(): string[] {
  return [
    "session_started",
    "agent_working",
    "decision_required",
    "token_update",
    "context_update",
    "session_finished",
    "session_error",
    "resume_command",
  ];
}

/** dsh 能力声明：对齐 src/adapters/dsh_plugin.ts 插件真实能发的事件
 * （DeepSeek Harness：token 来自 assistant/message 的 usage，context 来自 compaction 与 token-meter，
 *  approval/asked → permission_required，turn/end blocked → decision_required，subagent/descriptor → subagent_started） */
export function dshCapabilities(): string[] {
  return [
    "session_started",
    "agent_working",
    "decision_required",
    "permission_required",
    "token_update",
    "context_update",
    "session_finished",
    "session_error",
    "subagent_started",
  ];
}

/** 能力声明（adapter_status 用） */
export function capabilities(agent: AgentId): string[] {
  if (agent === "pi") return piCapabilities();
  if (agent === "dsh") return dshCapabilities();
  const base = [
    "session_started",
    "agent_working",
    "decision_required",
    "permission_required",
    "token_update",
    "context_update",
    "session_finished",
    "session_error",
    "subagent_started",
    "subagent_stopped",
  ];
  return [...base, "resume_command"];
}
