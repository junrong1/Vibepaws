/**
 * hooks 配置片段生成（架构 §2.1）— Claude Code 与 Codex 差异仅配置格式与事件名。
 * hook_agent.ts 通过 stdin 接收 hook 输入，用固定命令调用。
 */

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
        { matcher: "Bash|Read|Edit|Write|WebFetch", hooks: [{ type: "command", command: cmd }] },
      ],
      PostToolUse: [
        { matcher: "", hooks: [{ type: "command", command: cmd }] },
      ],
      Notification: [
        { matcher: "", hooks: [{ type: "command", command: cmd }] },
      ],
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

/** Codex hooks 片段（~/.codex/hooks.json，或仓库 .codex/hooks.json） */
export function codexHooksConfig(repoRoot: string): Record<string, unknown> {
  const cmd = agentCmd("codex", repoRoot);
  return {
    hooks: {
      SessionStart: [{ hooks: [{ type: "command", command: cmd }] }],
      UserPromptSubmit: [{ hooks: [{ type: "command", command: cmd }] }],
      PreToolUse: [{ hooks: [{ type: "command", command: cmd }] }],
      PostToolUse: [{ hooks: [{ type: "command", command: cmd }] }],
      Stop: [{ hooks: [{ type: "command", command: cmd }] }],
      PermissionRequest: [{ hooks: [{ type: "command", command: cmd }] }],
      PreCompact: [{ hooks: [{ type: "command", command: cmd }] }],
      PostCompact: [{ hooks: [{ type: "command", command: cmd }] }],
      SessionEnd: [{ hooks: [{ type: "command", command: cmd }] }],
      SubagentStart: [{ hooks: [{ type: "command", command: cmd }] }],
      SubagentStop: [{ hooks: [{ type: "command", command: cmd }] }],
    },
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
