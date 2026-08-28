# Vibepaws × DeepSeek Harness 集成指南

Vibepaws 通过一个 **Cordis 插件**（`src/adapters/dsh_plugin.ts`）接入 DeepSeek Harness（以下简称 dsh）。插件挂在 dsh 的生命周期事件上，把 dsh 的真实状态确定性地上报给 Vibepaws Core（`agent="dsh"`）——与 Claude Code / Codex 的 hooks、pi 的 extension 同一层级，都是**机器级事件钩子**，不依赖模型自觉调用任何 skill。

> 兼容性（已对照发布源码逐条验证）：`@deepseek-ai/dsh@0.1.1-rc.2`；Node ≥ 22.18。
>
> 插件以 **CommonJS（`.cjs`）** 形式安装：dsh 的 loader 用 `require()` 加载扩展，ESM 的 `.ts` 会触发 `ERR_REQUIRE_CYCLE_MODULE`（`require(esm)` 环），转译成 `.cjs` 后绕开。

---

## 1. 安装

```bash
npm run adapter:install -- --agent dsh             # 仅本仓库 → <repo>/.dsh/extensions/vibepaws.cjs
npm run adapter:install -- --agent dsh --global    # 所有项目 → ~/.dsh/extensions/vibepaws.cjs
```

安装器做三件事：

1. 把 `src/adapters/dsh_plugin.ts`（ESM）**转译成 CommonJS** 写到 dsh 的插件目录（自包含、零外部依赖，可独立 typecheck）；
2. 写一份 patch 文件 `<repo>/.dsh/vibepaws.cordis.yml`（全局是 `~/.dsh/vibepaws.cordis.yml`），内容是：
   ```yaml
   - insert:
     - id: vibepaws
       name: '/绝对/路径/vibepaws.cjs'
   ```
3. 发一条 `adapter_status` 自检事件（Core 没跑时会缓冲到 JSONL，不影响安装结果）。

> 旧版安装的 `vibepaws.ts` 会被安装器自动删除。
>
> ⚠️ 如果你用的是**方式 B**（把 insert 合并进了 `~/.dsh/cordis.patch.yml` 或 `~/.dsh/profiles/*/cordis.patch.yml`），重装**不会**改那些 profile 文件——需要手动把里面的 `name:` 从 `vibepaws.ts` 改成 `vibepaws.cjs`，否则重装后仍指向旧的 `.ts`。

**全局与项目级二选一**，两边都装会双发事件。

---

## 2. 加载插件（二选一）

插件在 **dsh boot 时**通过 patch 机制注入 loader 条目树，运行时不会自动加载。

### 方式 A：一次性 `--patch`（不持久）

```bash
dsh web --patch <repo>/.dsh/vibepaws.cordis.yml
# 源码 checkout 方式（dsh 不在 PATH 时）：
pnpm dsh web --patch ~/.dsh/vibepaws.cordis.yml
# npx 缓存方式：
/Users/<你>/.npm/_npx/<缓存>/node_modules/.bin/dsh web --patch ~/.dsh/vibepaws.cordis.yml
```

`--patch` 可重复（`--patch a.yml --patch b.yml`），按顺序叠加在 profile 层之后。

### 方式 B：写进 profile 层（持久，推荐）

把同一段 insert 合并进以下任一文件，之后裸跑 `dsh web` 即可，无需每次带 `--patch`：

| 文件 | 生效范围 |
| --- | --- |
| `$DSH_HOME/profiles/web/cordis.patch.yml` | 仅 web profile（`$DSH_HOME` 默认 `~/.dsh`） |
| `$DSH_HOME/cordis.patch.yml` | 所有 profile（home 层，机器级） |

⚠️ **需要重启 dsh web 才生效**：插件在启动时加载。如果当前正有实例占着端口（比如 3080），重启会替换掉那个会话。

---

## 3. 事件映射

与 `src/core/events.ts` 的 `CoreEvent` 对齐：

| Vibepaws 事件 | dsh 信号 |
| --- | --- |
| `session_started` + `adapter_status` | `agent/created`（每次注册都补发 `adapter_status`，换机/清库后自动重连） |
| `agent_working` | `turn/start`、`user/message`（仅 `source.kind === "user"` 的直接提示）、`tool/call`、`approval/decided` |
| `decision_required` | `turn/end` 的 `reason.kind === "blocked"`（agent 忙完在等你）；`tool/call` 的 `ask_user_question`（问用户问题） |
| `permission_required` | `approval/request`（cordis 实时审批，等用户；`approval/asked` 是 session 审计日志、不上报） |
| `token_update` | `assistant/message` 的 `usage`（input+output+cache，按 session **累计**，Core 的 token_used 是「见过的最大值」，需要累计值才对里程碑生效） |
| `context_update` | `assistant/message` / `compaction/start` 时用 token-meter 压力 ÷ `requestContext().contextWindow` 算百分比 |
| `session_error` | `turn/end` 的 `reason.kind === "error"`（`tool/result` 出错也报） |
| `session_finished` | `agent/disposed` |
| `subagent_started` | `subagent/descriptor` |

隐私：payload 只进白名单字段，`safe_summary` 固定措辞，绝不带 prompt / 代码 / 路径 / tool arguments / message content；token 只发数字，context 只发百分比。

---

## 4. 设计决策与已知边界

- **错误只走 `turn/end error` 一条路。** dsh 对同一次 turn 失败会先发 out-of-band 的 `agent/error`（`{turn, step, error, agent}`，不在 session 事件流里），随后必然补一条 `turn/end reason.kind === "error"`。两个都监听会对同一次失败双发 `session_error`（重复报警）。`session/event` 是单一事实来源且自带 session（cwd 准确），所以插件**有意不监听 `agent/error`**（`mapAgentError` 保留为可复用映射）。
- **`cwdOf` 兼容两种真实对象。** `agent/created` / `agent/disposed` / `agent/error` 的 `payload.agent` 是 ReactLoopAgent 实例（有 `.id` 和 `.session`，自身没有 `.header`），cwd 在 `.session.header.cwd` 上；`session/event` 的 session 则是 dsh Session（`header.cwd` 在自身上）。`cwdOf` 依次尝试两者，都取不到才回退 `process.cwd()`。
- **`sessionIdOf` 归一到同一个 session id。** ReactLoopAgent 自身 `.id` 是 agent id，真正的 session id 在 `.session.id` 上；`session/event` 的 Session 则直接是 `.id`。`sessionIdOf` 优先取 `.session.id`，否则 `agent/created`（ReactLoopAgent）与 `session/event`（Session）会各拿一个 id，宠物面板出现两个 dsh 会话。
- **context 百分比取不到就降级。** `requestContext()` 返回 `undefined`（`request/context` 事件还没发过）或 token-meter 不可用时，不发 `context_update`，不阻塞其他信号。
- **插件永不打断 dsh。** 每个 listener 的异常都被吞掉，deliver 失败只降级到 JSONL。

---

## 5. Core 离线兜底

Core 没启动时插件把事件追加到 `~/.vibepaws/events/dsh_*.jsonl`（用户级，插件自包含、不知道仓库路径），之后补收：

```bash
npm run bridge            # 监听 <repo>/.vibepaws/events 和 ~/.vibepaws/events，归一化后转发 Core
npm run bridge -- --once  # 只补收一次就退出
```

---

## 6. 验证

```bash
# 单测（纯映射层，不依赖 dsh 运行时）
node --test --experimental-strip-types src/adapters/dsh_plugin.test.ts

# 端到端：Core + 桌面宠物跑起来后，用 dsh 跑一个会话
npm run core
npm run desktop
# 另开终端：pnpm dsh web（持久化 patch 已生效时）
# 宠物面板应出现 dsh 的 adapter_status / session_started，agent 干活时出现 working / 气泡
```

也可以用 `--dump-config` 在**不启动** web 服务的情况下确认插件行已被合成：

```bash
pnpm dsh web --dump-config | grep -A1 vibepaws
# - id: vibepaws
#   name: /…/extensions/vibepaws.cjs
```

---

## 7. 排查

| 现象 | 原因 / 处理 |
| --- | --- |
| `zsh: command not found: dsh` | dsh 不是全局命令。源码 checkout 里用 `pnpm dsh …`；发布版用 npx 缓存里的 `…/node_modules/.bin/dsh …` |
| 插件没生效（Core 里没有 `dsh` 的 adapter_status） | ① 确认 patch 已进 profile 层或带了 `--patch`；② **重启** dsh web（插件只在 boot 加载）；③ 看 dsh 启动日志里有没有 `patch insert: entry %C not found` 之类的警告 |
| 安装器自检 `✗ Core did not respond` | 正常，Core 没跑而已。事件已缓冲到 fallback.jsonl，Core 起来后 `npm run bridge -- --once` 补收 |
| 插件加载报 `ERR_REQUIRE_CYCLE_MODULE`（`Cannot require() ES Module … in a cycle`） | 装的是 ESM 的 `vibepaws.ts`。重新 `npm run adapter:install -- --agent dsh [--global]` 装成 `.cjs`，并确认 patch 里 `name` 指向 `vibepaws.cjs` |
| 插件加载报 `ERR_UNKNOWN_FILE_EXTENSION` | Node < 22.18 且装了旧 `.ts`。重装成 `.cjs` 或升级 Node |
| `--dump-config` 报 EPERM 写 `cordis.yml` | dsh 会例行把 profile 根 `cordis.yml` 重写为 `[]`（幂等），确认 dsh 进程有 `~/.dsh` 写权限即可 |
