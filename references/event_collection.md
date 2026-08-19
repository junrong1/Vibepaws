以下将 Codex 和 Claude Code 的 Hooks 事件体系及监听方式做完整整理,方便对照参考。

## Codex Hooks 事件清单

| 事件 | 触发时机 | matcher 过滤字段 | 可阻断 |
|---|---|---|---|
| `SessionStart` | 会话/子智能体启动时 | `source`(startup/resume/clear/compact) | 可结束turn(`continue:false`) |
| `SessionEnd` | 主thread结束(不含子智能体) | `reason`(目前仅`other`) | 仅提示性,不阻断 |
| `SubagentStart` | 子智能体启动 | `agent_type` | 不阻止启动 |
| `SubagentStop` | 子智能体停止 | `agent_type` | 可继续(`decision:block`) |
| `PreToolUse` | 工具调用前 | `tool_name`(Bash/apply_patch/MCP等) | 是(deny/allow/改写) |
| `PermissionRequest` | 即将弹出审批时 | `tool_name` | 是(allow/deny) |
| `PostToolUse` | 工具成功执行后 | `tool_name` | 反馈但不撤销副作用 |
| `PreCompact`/`PostCompact` | 压缩聊天前/后 | `trigger`(manual/auto) | `PreCompact`可阻止压缩 |
| `UserPromptSubmit` | 用户提示提交前 | 不支持 | 可阻断(block) |
| `Stop` | 一轮回合结束时 | 不支持 | 可要求继续 |

## Claude Code Hooks 事件清单

Claude Code 的事件更细,官方核心约10余个,社区文档统计的扩展版本可达约30个。核心事件: [claudefa](https://claudefa.st/blog/tools/hooks/hooks-guide)

| 事件 | 触发时机 | matcher 字段 | 可阻断 |
|---|---|---|---|
| `SessionStart`/`SessionEnd` | 会话开始/结束 | 无 | 否 |
| `UserPromptSubmit` | 用户提交prompt后、模型处理前 | 无 | 可block |
| `PreToolUse` | 工具执行前 | `tool_name`(Bash/Edit/Write/Read/Glob/Grep/WebFetch/MCP等) [code.claude](https://code.claude.com/docs/en/hooks) | 是(exit 2 或 JSON deny) |
| `PostToolUse` | 工具成功执行后 | `tool_name` | 反馈但不撤销 |
| `PostToolUseFailure` | 工具执行失败后 | `tool_name` | 否 |
| `PermissionRequest`/`PermissionDenied` | 权限弹窗前/用户拒绝后 | `tool_name` | `PermissionRequest`可 |
| `Notification` | 系统发通知时 | 无 | 否 |
| `PreCompact`/`PostCompact` | 上下文压缩前后 | 无 | 否 |
| `SubagentStart`/`SubagentStop` | 子代理创建/完成 | 无 | `SubagentStop`可继续 |
| `Stop` | 回合结束 | 无 | 可要求继续 |

## 如何监听:配置方式对比

| 维度 | Codex | Claude Code |
|---|---|---|
| 配置文件 | `~/.codex/hooks.json`、`~/.codex/config.toml`(`[hooks]`表)、`<repo>/.codex/hooks.json`/`config.toml` [code.claude](https://code.claude.com/docs/en/hooks) | `~/.claude/settings.json`(用户级)、`.claude/settings.json`(项目级) [blakecrosley](https://blakecrosley.com/blog/claude-code-hooks-tutorial) |
| 结构 | `hooks.<Event>[].matcher` + `hooks[].{type:"command", command, timeout, async}` [code.claude](https://code.claude.com/docs/en/hooks) | `hooks.<Event>[].matcher` + `hooks[].{type:"command", command}` [blakecrosley](https://blakecrosley.com/blog/claude-code-hooks-tutorial) |
| 信任机制 | 非托管钩子需在 `/hooks` 中手动审查信任,否则被跳过 [code.claude](https://code.claude.com/docs/en/hooks) | 官方文档未强调同等信任流程,但企业版有管理策略 |

## 监听事件的输入/输出协议

两者高度相似,都遵循 **stdin 传入 JSON、stdout/退出码传出决策**的模式:

**输入(stdin JSON)**——两家都提供通用字段 `session_id`、`cwd`、`hook_event_name`、`transcript_path`,工具类事件额外带 `tool_name`、`tool_input`(Codex 的 turn 范围事件还带 `turn_id`,Claude Code 带 `permission_mode`/`tool_use_id`)。 [code.claude](https://code.claude.com/docs/en/hooks)

**输出(阻断/放行决策)**——两者都支持两种表达方式:

- 简单方式:退出码 `0`=允许,`2`=阻断(阻断原因写到 stderr) [code.claude](https://code.claude.com/docs/en/hooks)
- 精细方式:退出码 `0` + stdout 输出 JSON,如
```json
{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "..."}}
```
这是两家都采用的统一 `hookSpecificOutput` 结构,支持 `allow`/`deny`/`ask` 三种决策以及 `additionalContext` 注入模型上下文。 [gist.github](https://gist.github.com/FrancisBourre/50dca37124ecc43eaf08328cdcccdb34)

## 实操监听示例(以审计日志为例)

```json
// Claude Code: .claude/settings.json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "jq -r '.tool_input.command' >> /tmp/claude-bash.log" }] }
    ]
  }
}
```
```json
// Codex: ~/.codex/hooks.json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "python3 ~/.codex/hooks/log_bash.py" }] }
    ]
  }
}
```

两者脚本内部都是"读 stdin → 解析 JSON → 按字段分支 → 打印决策或直接退出"这一套逻辑,唯一区别是 Codex 多了一层信任评审(`/hooks` 命令)和异步钩子(`async:true`,最多8个并发)的能力。整体来看,如果你要在两个工具间写通用的事件采集脚本,可以复用同一套 `hookSpecificOutput` JSON 协议,只需针对 Codex 额外处理信任注册和 `turn_id` 字段即可。 [dev](https://dev.to/whoffagents/claude-code-hooks-the-automation-layer-nobody-knows-about-3po0)


