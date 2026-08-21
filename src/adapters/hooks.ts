/**
 * hooks 配置片段生成（架构 §2.1）— Claude Code 与 Codex 差异仅配置格式与事件名。
 * hook_agent.ts 通过 stdin 接收 hook 输入，用固定命令调用。
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { CoreEvent } from "../core/events.ts";

/** 仓库根（由本文件位置反推）：读 package.json 拿 adapter 版本，任意 cwd 下都成立 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** hook_agent 的调用命令（相对仓库根，运行时由 install.ts 解析为绝对路径） */
export function agentCmd(agent: "claude_code" | "codex", repoRoot: string): string {
  const entry = `${repoRoot}/src/adapters/hook_agent.ts`;
  return `node --experimental-strip-types ${entry} --agent=${agent}`;
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
      command: `node --experimental-strip-types ${entry}`,
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
export function adapterStatusEvent(agent: "claude_code" | "codex", projectId: string): CoreEvent {
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

/** 能力声明（adapter_status 用） */
export function capabilities(agent: "claude_code" | "codex"): string[] {
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
