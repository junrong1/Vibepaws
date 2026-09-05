<div align="center">

<img src="ui/pets/embercub/idle.png" width="120" alt="Embercub" />
<img src="ui/pets/lunafang/needs-you.png" width="120" alt="Lunafang" />
<img src="ui/pets/voltroc/working.png" width="120" alt="Voltroc" />
<img src="ui/pets/circuit-witch/level-up.png" width="120" alt="Circuit Witch" />
<img src="ui/pets/sporewick/tired.png" width="120" alt="Sporewick" />

# Vibepaws

**一个可爱的编程宠物：帮你看着 AI agents，在它们需要你时提醒你，并从健康的 vibe-coding session 中成长。**

本地运行 · always-on-top · 永远不读你的代码

[快速开始](#快速开始3-分钟) · [接入你的 agent](#接入你的-coding-agent) · [宠物怎么成长](#宠物怎么成长) · [隐私](#隐私什么会离开你的机器) · [English](README.md)

</div>

---

## 问题

你开着 Claude Code，它跑了四分钟，然后停下来 —— 在等你批准一次文件写入。你在另一个窗口里。六分钟后你才发现。

或者：这个 session 一直很顺，你正投入其中，直到 agent 开始忘掉你二十条消息前设下的约束，你才注意到 context 已经 94%。

coding agent 很擅长干活，很不擅长引起你的注意，而在「它什么时候已经不再有用」这件事上，几乎完全不会告诉你。

## Vibepaws 做什么

一只小宠物待在你的桌面上，浮在全屏终端之上。它读取 coding agent 发出的事件，转成你余光就能捕捉到的东西：

- **agent 需要你** → 宠物抬头看着你，气泡在几秒内出现
- **context 快满了** → 70%、85%、95% 各报一次，不复读
- **token 预算里程碑** → 你设定预算的 25% / 50% / 75% / 90%
- **agent 出错或卡住** → 现在就知道，而不是下次切窗口时
- **session 结束** → 宠物获得 EXP、升级，最终进化

宠物也会成长 —— 但这条成长循环是**刻意设计成「烧 token 不会让宠物升级」**的。糊涂的 session（context 96%、反复来回改）拿到的 EXP 只有干净 session 的一小部分。健康的使用方式是唯一的快车道。见[宠物怎么成长](#宠物怎么成长)。

而它永远看不到你的代码。prompt、diff、文件路径、工具入参在 adapter 那一层就被丢掉，落库前再丢一次。见[隐私](#隐私什么会离开你的机器)。

它也花不掉你的 token：里面没有任何 API key，也没有任何模型客户端，而 hook 不往 stdout 写一个字节 —— stdout 是 hook 通往 agent 上下文的唯一通道。这不是一句保证，是一个你可以自己读的计数器：见[它会花我的 token 吗？](#它会花我的-token-吗)

## 当前状态

**MVP alpha 0.1** —— 核心循环在 Claude Code、Codex、pi-coding-agent、DeepSeek Harness (dsh) 上已经端到端跑通。实话实说：

| | |
| --- | --- |
| ✅ **今天可用** | 七状态桌面宠物 · 决策/权限气泡 · context 警告 · EXP / 等级 · 静音（30m / 2h / 项目 / session）· 设置窗口（预算、警告阈值、session 目标、宠物名、语言）· 三档宠物大小 · 每块屏各记一个位置，可跟随可固定 · hook 开销计数器 · 崩溃会话回收 · Claude Code + Codex + pi + dsh adapter · 通用 JSONL bridge · 事件模拟器 · 隐私白名单 · 已签名 + 已公证的 macOS 发布流水线（Apple 凭据自备） |
| ⚠️ **部分完成** | 计划 12 只 starter pet，目前 5 只 · topic drift 通路已通但规则还薄 · 进化规则会触发，但进化形态素材还没画 |
| ❌ **还没有** | 语音命令（STT）· 图形化首启动向导 · 任何社交功能（画廊、排行榜、交易） |

逐条需求的对账：[PRD §15](docs/prd_mvp_zh.md#15-实现状态截至-2026-08-21)。

---

## 快速开始（3 分钟）

### 环境要求

**Node ≥ 22.6。** 这是硬性下限，不是建议值。Core、UI server 和写进 agent hook 配置里的采集命令全都跑 `node --experimental-strip-types`，这个 flag 在 22.6 之前不存在。Node 20 上什么都起不来 —— 而且 hook 那条路径是**静默失败**的：宠物只是一直闲着，不会告诉你有任何问题。

```bash
node --version   # 必须 ≥ v22.6.0
npm install
```

目前测试过的平台是 macOS。Windows 和 Linux 在设计上没有被排除，但也没有被验证过。

### 1. 启动

```bash
npm start        # 透明 always-on-top 窗口，右下角，带托盘图标
```

一条命令。其余的事都由这个托盘应用负责：找到机器上一个 ≥ 22.6 的 Node，在 `127.0.0.1:17893` 上拉起 **Core**（收事件、管 session、跑通知与 EXP 引擎、持有 SQLite 数据库的那个守护进程），拉起本机 UI server，退出时把两个都收掉。

首次启动会初始化 `.vibepaws/vibepaws.db`，**随机分配一只 starter pet**，并把 API token 写入 `.vibepaws/api_token`。Core 只监听 localhost，除 `/health` 外所有路由都要带这个 token。

Core 崩了会自动重拉（5 次，指数退避），当前状态就写在托盘菜单第一行。如果 Core **本来就在跑**（你自己在另一个终端里 `npm run core`），应用会直接用那一个，退出时也不会去关它。

> `npm run core` 和 `npm run desktop` 仍然在，也仍然分得开跑 —— 那是开发流程：`core:watch` 改完即重载，而分开跑是唯一能单独看 Core 日志、不被壳的日志盖住的方式。

### 2. 开机自启

**设置 → 启动 →「登录时启动 Vibepaws」**，或者托盘菜单里那一项。一条登录项同时拉起宠物和 Core。

这一项需要打包后的 `.app`（见[打包](#打包-app)）—— `npm start` 跑起来的那个进程注册进去的会是 `node_modules` 里的 Electron，所以开关是禁用的，并且会就地说明原因。另外先把 app 拖进 `/应用程序`：指向已挂载 `.dmg` 里的登录项，映像一弹出就失效了。

### 3. 不接真实 agent 也能先看效果

模拟器往 Core 里发的是真实事件，所以你可以在接任何东西之前，先把全部行为看一遍：

```bash
npm run sim -- --scenario normal              # 正常会话 → working → finished
npm run sim -- --scenario frequent_decisions  # 多次需要你 → needs-you 气泡
npm run sim -- --scenario context_overload    # context 88% → 96% → 警告 + EXP 倍率下降
npm run sim -- --scenario correction_loop     # 反复改同一文件 → correction 计数
npm run sim -- --scenario multi_session       # 3 个 session 并行 → 聚合状态 + 轮播
npm run sim -- --scenario crashed_session     # agent 卡在提问上崩掉 → 一分钟内被回收
```

如果宠物对 `normal` 有反应，说明安装没问题。接下来接真实 agent。

---

## 接入你的 coding agent

每个 agent 一条命令。安装器会备份你原有的配置、写入 hook 条目，并发一个自检事件 —— 通道通不通当场就知道。

```bash
# Claude Code —— hooks + statusLine（实时 token 通道）
npm run adapter:install -- --agent claude_code            # 仅本仓库 → <repo>/.claude/settings.json
npm run adapter:install -- --agent claude_code --global   # 所有项目 → ~/.claude/settings.json

# Codex
npm run adapter:install -- --agent codex                  # 仅本仓库 → <repo>/.codex/hooks.json
npm run adapter:install -- --agent codex --global         # 所有项目 → ~/.codex/hooks.json

# pi-coding-agent —— 装成 pi 插件，不是 hook 配置
npm run adapter:install -- --agent pi                     # 仅本仓库 → <repo>/.pi/extensions/vibepaws.ts
npm run adapter:install -- --agent pi --global            # 所有项目 → ~/.pi/agent/extensions/vibepaws.ts

# DeepSeek Harness (dsh) —— 装成 Cordis 插件
npm run adapter:install -- --agent dsh                    # 仅本仓库 → <repo>/.dsh/extensions/vibepaws.cjs
npm run adapter:install -- --agent dsh --global           # 所有项目 → ~/.dsh/extensions/vibepaws.cjs
```

**全局与项目级二选一。** 切到 `--global` 会自动移除本仓库项目级配置里 Vibepaws 的 hooks —— 两边都装意味着事件重复：重复 EXP、重复气泡。

**各 agent 说明：**

- **Claude Code** —— 实时 token 数字来自 `statusLine`。这是 Claude 专属能力，也正是 token 通道能做到实时而非会话结束才汇总的原因。
- **Codex** —— 首次需要在 codex 里运行 `/hooks` 授权。token 从 SessionEnd 的 transcript 提取，所以是会话结束时才到，不是持续更新。
- **pi-coding-agent** —— pi 没有配置式 hooks，稳定的集成方式是 **pi 插件（extension）**。安装器把 `src/adapters/pi_extension.ts` 复制到 pi 的插件目录，插件挂到 pi 生命周期事件上确定性上报状态 —— 和 Claude/Codex 的 hooks 同一层级，不依赖模型自觉。插件里任何异常都会被吞掉，绝不会打断 pi。**安装后要新开 `pi` 会话（或 `/reload`）才生效。** 项目级插件还要求项目被 pi 信任（首次启动时确认即可）。

  其他 harness、或者没有插件机制的环境，可以用手动兜底发射器：

  ```bash
  node --experimental-strip-types src/adapters/pi_agent.ts --event=decision_required
  ```

- **DeepSeek Harness** —— dsh 是 Cordis 架构，稳定的集成方式是 **Cordis 插件**（`src/adapters/dsh_plugin.ts`），和 Claude/Codex 的 hooks、pi 的插件同一层级。安装器把插件复制进 dsh 的插件目录并写一份 patch 文件；插件挂到 dsh 生命周期事件（`agent/created`、`session/event` 等）上确定性上报状态。**加载方式是带着 patch 启动 dsh**（`dsh web --patch <repo>/.dsh/vibepaws.cordis.yml`，或把 insert 持久化进 `~/.dsh/profiles/web/cordis.patch.yml`），然后**重启 dsh** —— 插件只在启动时加载。错误走 `turn/end` 上报，token 用真实的 `usage` 计数，context 用 token-meter ÷ `contextWindow`。完整指南：[docs/dsh_integration.zh-CN.md](docs/dsh_integration.zh-CN.md)。

<details>
<summary><strong>各 agent 事件映射</strong></summary>

| Vibepaws 事件 | Claude Code | Codex | pi | dsh |
| --- | --- | --- | --- | --- |
| `session_started` | `SessionStart` | `SessionStart` | `session_start`（startup/resume/fork/reload） | `agent/created` |
| `agent_working` | `UserPromptSubmit`、`PreToolUse` | `UserPromptSubmit`、`PreToolUse` | `before_agent_start`、`tool_execution_start` | `turn/start`、`user/message`、`tool/call` |
| `decision_required` | `Stop`、`Notification` | `Stop` | `agent_settled`（agent 忙完在等你） | `turn/end`（blocked） |
| `permission_required` | `PermissionRequest` | `PermissionRequest` | 工具批准路径 | `approval/asked` |
| `token_update` | **statusLine（实时）**、`PostToolUse` | `SessionEnd` transcript 提取 | `message_end` usage（**真实 token/cost**） | `assistant/message` usage（**真实 token**） |
| `context_update` | statusLine `used_percentage`、`PreCompact`/`PostCompact` | `PreCompact`/`PostCompact` | `session_compact` | token-meter ÷ `contextWindow` |
| `session_error` | `PostToolUseFailure`、`PostToolUse`（error） | `PostToolUse`（error） | `tool_execution_end`（isError） | `turn/end`（error）、`tool/result`（error） |
| `session_finished` | `SessionEnd` | `SessionEnd` | `session_shutdown` | `agent/disposed` |

Claude Code 里 `Stop` 是最关键的一条：它才是即时的「该你了」信号。`SessionEnd` 只在会话真正退出时才发，而 `Notification` 要么是权限弹窗，要么得等 60s 空闲。

两个 hook 类 agent 上还会采集 `SubagentStart` / `SubagentStop`。

缺事件只降级，不会崩：某个 agent 版本不再发某个事件时，Vibepaws 跳过那个信号或用近似信号，核心循环照常跑。

</details>

### Core 没启动的时候

adapter 永远不会阻塞你的 agent，也不会丢事件。Core 连不上时，事件被追加到本地 JSONL：

- Claude/Codex hooks → `.vibepaws/events/fallback.jsonl`（仓库根）
- pi 插件 → `~/.vibepaws/events/pi_*.jsonl`（用户级 —— 插件自包含，不知道你的仓库路径也能写）
- dsh 插件 → `~/.vibepaws/events/dsh_*.jsonl`（用户级，同理）

之后补收：

```bash
npm run bridge   # 同时监听两处目录，归一化后转发给 Core
```

这个 bridge 同时也是**通用集成路径**：任何不是 Claude/Codex/pi/dsh 的工具，只要把归一化后的 JSON 行写进 `.vibepaws/events/`，就能变成宠物状态。信封格式：

```json
{
  "event": "decision_required",
  "agent": "my_tool",
  "session_id": "local-session-id",
  "project_id": "/Users/me/my-app",
  "severity": "high",
  "safe_summary": "Tool permission needed",
  "timestamp": "2026-08-21T10:00:00Z"
}
```

合法 `event` 取值：`session_started` · `agent_working` · `decision_required` · `permission_required` · `token_update` · `context_update` · `topic_drift_warning` · `session_finished` · `session_error`

---

## 怎么用这只宠物

### 七个状态，七张立绘

每个状态都是同一只宠物的一张独立立绘，靠 image-to-image 保证是同一只。这是刻意的：姿态和表情这条通道，位移抖动和角标替代不了。`tired` 是耷着眼皮塌下去，`needs-you` 是抬起头看着你。

<table>
<tr>
<td align="center"><img src="ui/pets/embercub/idle.png" width="76"><br><code>idle</code></td>
<td align="center"><img src="ui/pets/embercub/working.png" width="76"><br><code>working</code></td>
<td align="center"><img src="ui/pets/embercub/needs-you.png" width="76"><br><code>needs-you</code></td>
<td align="center"><img src="ui/pets/embercub/warning.png" width="76"><br><code>warning</code></td>
<td align="center"><img src="ui/pets/embercub/finished.png" width="76"><br><code>finished</code></td>
<td align="center"><img src="ui/pets/embercub/tired.png" width="76"><br><code>tired</code></td>
<td align="center"><img src="ui/pets/embercub/level-up.png" width="76"><br><code>level-up</code></td>
</tr>
</table>

多个 session 并行时，宠物显示的是所有 session 里**最紧急**的那个状态；浮层里再逐条展开。

### 点击宠物

窗口会**向上**展开 —— 宠物本身不动 —— 你会看到：

- **session 列表** —— 点击行复制那个 session 的 jump-to 恢复命令。`needs-you` 的行会显示 agent 已经等了你多久。
- **全部静音** —— 带时长
- **EXP 明细** —— 这些数字是怎么来的
- **⚙ 设置** —— 打开设置窗口（见下）

关闭：再点宠物 / 点空白处 / `Esc` / 右上角 ×。

### 设置

托盘菜单 → **设置…**，或浮层里的 ⚙ 按钮。它是一扇**独立**窗口而不是浮层里的一页 —— 宠物窗口只有三百来点宽，还要放过桌面的点击，那里放不了表单。

| 分区 | 内容 |
| --- | --- |
| **宠物** | 起名字。留空回落物种名。 |
| **预算与警告** | 默认 token 预算（单位 k tokens，填 `0` 就是关掉里程碑）· 上下文警告阈值（关 / 早 / 默认 / 晚）· 每日 EXP 上限 |
| **Token 与开销** | 宠物自己花掉什么：模型 API 调用（`0`）、出网字节（`0`），以及采集通道的实时字节 / 延迟计数器 —— 见[它会花我的 token 吗？](#它会花我的-token-吗) |
| **闲置 session** | 一个 session 静默多久之后算它结束了（默认 15 分钟）—— 见 [agent 没打招呼就没了](#agent-没打招呼就没了) |
| **在跑的 session** | 给每个当前活跃的 session 单独设**目标**与**预算** |
| **窗口** | 在所有桌面显示 · 点击穿透 · **宠物大小（三档）** · **多显示器行为** · 界面语言 · 把宠物放回右下角 |
| **重置与卸载** | 换一只新宠物 · 删除全部本地数据 · 把 adapter hooks 从你的 agent 配置里移除 |

其中两件事值得单独说：

**session 目标不是装饰。** 它是漂移判定的基准，也直接换算成 1.1× EXP（见 [宠物怎么成长](#宠物怎么成长)）。session 是在终端里诞生的，所以设置窗口是唯一能给它挂上目标的地方 —— 开始一件你在意的事情时就填一句。

**改动立刻生效，包括改到一半的 session。** 给一个已经烧掉 60% 的 session 填上预算，下一次 token 上报就会给你 50% 那一档里程碑，而不是安静到明天。每一格离焦即保存；超出范围的值会被收敛，并且当场把真正存进去的数字显示回来。

这扇窗里属于 Core 的那一半（预算、阈值、目标、宠物名）在浏览器预览里也能改：http://127.0.0.1:5173/settings.html 。窗口那一段需要桌面壳，连不上时它会直接说出来。

### 重置、删除、卸载

Vibepaws 知道的一切都在你这台机器上，所以把它收回来不该需要一句得先去查的 `rm -rf`。设置窗口底部有三个按钮，每一个都是按第一下武装、按第二下才动手（六秒没有第二下就自己解除）。

| 按钮 | 会做什么 | 不动什么 |
| --- | --- | --- |
| **换一只新宠物** | 重新抽一只 starter，清掉等级、EXP 流水与 memories | session、设置、hooks |
| **删除全部本地数据** | session、事件、通知、EXP 流水、预算与阈值 —— 删完压缩数据库文件 | adapter hooks，以及 API token（把它删了，正在跑的 hook 会立刻 401） |
| **移除 adapter hooks** | 把 Vibepaws 从 `.claude/settings.json`、`.codex/hooks.json` 与 pi 的插件目录里拿出来，项目级**与**用户级一起 | 那些文件里的其他一切，包括别的工具的 hooks |

两个值得知道的细节：

**删就是真的删。** SQLite 删行只是把页标记为可复用，`DELETE` 之后你的 session 标题原文其实还留在文件里。Core 会紧跟着跑一次 `VACUUM` —— 那才是真的把它们扔掉。

**卸载 hooks 比听起来重要。** 残留的 hook 条目会在此后每一次工具调用上都启动一个进程，去 POST 一个已经没人监听的端口。它不会阻塞你的 agent，但会让 agent 永久性地变慢，而配置里没有任何东西会告诉你原因。删应用之前请先做这一步。

应用已经不在了的情况有 CLI：

```bash
npm run adapter:uninstall -- --dry-run     # 只打印会动哪些文件，一个字节都不写
npm run adapter:uninstall                  # 三个 agent、两个 scope 全清
npm run adapter:uninstall -- --agent pi    # 或者只清一个（claude_code | codex | pi，可用逗号分隔）
npm run adapter:uninstall -- --purge-data  # 连 .vibepaws 目录一起删（先退出 Core）
```

它刻意留了两样东西不动，并且在运行时说出来：你原来的配置仍在旁边的 `*.vibepaws.bak` 里；`~/.codex/config.toml` 的项目信任条目不碰 —— 没有 TOML 解析器就去改写别人的 TOML，是把「清理残留」变成「吃掉配置」。

### agent 没打招呼就没了

`kill -9`、崩溃、直接关掉终端窗口、合上笔记本 —— 这些情况都不会发出任何「结束了」的事件。没有办法察觉的话，一个已经不存在的 session 会永远显示成「在跑」；而如果它恰好是**卡在权限询问上**死掉的，宠物就会为一个你永远回答不了的会话一直红着。

Core 每 60 秒扫一轮，启动时先扫一次 —— 上一次 Core 退出时还留着「在跑」的那些 session，恰恰是最可能的僵尸。两条出路：

| | 怎么发现的 | 需要多久 |
| --- | --- | --- |
| **进程没了** | adapter 上报 agent 的进程号，Core 去看那个进程还在不在 | 一个 sweep 周期 —— 是秒，不是分钟 |
| **没声了** | 超过你设的时长完全没有任何事件（设置 → 闲置 session，默认 15 分钟） | 就是那个时长 |

两种情况都**不发 EXP** —— 崩溃不是胜利，奖励它等于把成长回路教反了 —— 宠物也不会播庆祝动画，并且这个 session 还挂在屏幕上的气泡会一起撤掉。浮层里它们显示成一个空心圆点，写着「进程没了」或「没声了」，让你能把「它干完了」和「它死了」分开。

进程判定是刻意保守的：一个进程号只有在**同一个**号码出现在两条不同事件上之后才会被采信。hook 是 agent 起的子进程，所以它的父进程通常就是 agent 本身 —— 但万一中间夹进了一层转瞬即逝的包装 shell，那个号码一分钟后看起来就是「已死」，于是 Vibepaws 会去杀一个还在干活的 session。真正的 agent 进程整个会话只有一个号码，包装 shell 每次都是新的。完全没有可信号码时（通用 JSONL bridge、或者这个功能上线之前的老库），就只靠静默超时那一条。

### 静音是可见状态，不是静默开关

静音期间宠物脚边有一个 🔕 徽章，显示剩余时间。点徽章（或再点一次按钮）恢复通知。看不见的静音，就是你会忘掉自己设过的静音。

### 连接指示灯

| 灯 | 含义 |
| --- | --- |
| 🟢 绿 | 事件流正常 |
| 🟠 橙（闪烁） | 状态还在轮询，但事件流已断 —— **气泡不会来** |
| 🔴 红 | 完全连不上 Core |

橙色是最重要的一档：没有它，一个坏掉的 hook 看起来和一个安静的下午一模一样。

### 窗口行为

- **拖拽** —— 按住宠物窗口的空白处拖动。位置会记住，且始终夹在屏幕可见区域内。
- **点击穿透** —— 宠物身体以外的空白区域点击会直接落到下面的应用上。浮层要占宠物上方的空间，那块空间平时是空的。
- **宠物大小** —— 小 / 中 / 大。宠物、气泡、浮层一起缩放，而且缩放时宠物脚下那一点不动，所以换档不会把它挪走。
- **多显示器** —— 每块屏各自记住你上次把宠物放在哪；键是显示器本身（型号 + 分辨率 + 缩放倍率）而不是系统给的 display id，所以拔下来再插回去还认得出。在此之上二选一：
  - **跟随当前显示器**（默认）—— 光标在另一块屏上停住约一秒，宠物才搬过去；一次划过去不会把它拽走。
  - **固定在一块屏上** —— 宠物不会自己移动；想换位置直接拖过去，它就留在那儿。

  位置存的是工作区里的**比例**，所以改分辨率、改缩放档位之后宠物还在同一个角落，而不是跑到屏幕外面。宠物待着的那块屏被拔掉时，它会移到一块还在的屏上。
- **托盘菜单** —— Core 状态与重启 · 点击穿透开关 · 所有桌面显示 · 宠物大小 · 显示器行为 · 开机自启 · 显示 · 设置 · 放回右下角 · 退出
- **浮在全屏应用之上** —— 全屏 iTerm2、全屏编辑器之上宠物依然可见，这一条不受托盘开关影响。为此壳进程不占 Dock 图标，**出口在托盘菜单里** —— 这是 macOS 的硬性要求：占 Dock 的进程无法浮在别人的全屏 Space 上。「所有桌面显示」只管「你换桌面时它跟不跟过来」。
- **浏览器预览**（可选）—— `npm run ui` 后打开 http://127.0.0.1:5173。5173 被占用时桌面壳会自动改用空闲端口（它是 Vite 默认端口，你手边随时可能有个前端 dev server 占着）。

> 桌面壳当前用 Electron（环境无 Rust 工具链）。Tauri v2 待 Rust 就绪后替换 —— 仅换壳层，渲染与 SSE 协议不变。

### 界面语言

跟随操作系统语言自动选择：中文（任意变体）走简体中文，其余一律英文。托盘菜单、宠物界面、通知气泡、设置窗口与 adapter 安装向导共用同一份文案目录（`src/i18n/messages.js`），不会出现中英混排。

想显式指定，用**设置 → 语言**：托盘菜单、宠物窗口、设置窗口会当场一起换，不用重启。环境变量的优先级仍然高于这个选项，方便脚本化启动：

```bash
VIBEPAWS_LOCALE=en npm start      # 或 zh-CN
```

---

## 宠物怎么成长

塑造了其他一切的那条设计约束：**token 可以喂养宠物，但浪费 token 不能让它升级。**

```text
session_exp = capped_token_exp
            × context_health_multiplier
            × topic_consistency_multiplier
            + outcome_bonus
            + daily_care_bonus
```

**基础速率** —— 每 1,000 tokens 给 1 EXP，每只宠物**每日上限 200 EXP**。到顶之后，再烧 token 也换不到东西。

**质量倍率** —— 糊涂的 session 在这里开始变贵：

| 信号 | 倍率 |
| --- | --- |
| Context 低于 70% | **1.10×** |
| Context 70–85% | 1.00× |
| Context 85–95% | 0.75× |
| Context 超过 95% | **0.50×** |
| Topic 与 session goal 一致 | 1.10× |
| 重复 correction loop | 0.80× |
| accepted diff · 测试通过 · commit · 明确 "shipped" | **+20 到 +100 EXP** |

**等级** —— Lv1 需要 100 EXP，之后每级 +50（Lv2 → 150，Lv3 → 200…）。

**没有永久死亡。** 不健康的使用方式会让宠物变 `tired`，EXP 增长变慢；休息一下、开个新 session、或者 ship 了点东西，它就恢复。宠物每天还会缓慢自我成长 —— 一周不用 agent 不是一种惩罚。

**通知阈值：**

| 类型 | 触发点 |
| --- | --- |
| Context 警告 | 70% · 85% · 95%（可配置，也可关掉） |
| Token 预算里程碑 | 预算的 25% · 50% · 75% · 90% |

每一档都有闩锁 —— 70% 只报一次，不是每 60 秒复读。但 70% 和 95% 是完全不同的两句话（「留意一下」和「赶紧收尾」），所以两档都必须报到。

里程碑需要一个分母，而预算默认是没有的 —— 在[设置](#设置)里填，全局或按 session 都行。context 警告不需要预算也能工作。

---

## 隐私：什么会离开你的机器

什么都不会。没有 cloud sync，没有 telemetry，除 `127.0.0.1` 之外没有任何网络目的地。

在你的机器内部，有两道彼此独立的闸：

1. **adapter 采集侧** —— 按白名单提取字段。`tool_input`、prompt 文本、`transcript_path` 在发出去之前就被丢掉。
2. **Core 落库前** —— 按 schema 再丢一次未知字段。原始 hook JSON 永不写入数据库。

具体意味着：气泡绝不显示原始 prompt、源代码、secret path 或文件内容。`safe_summary` 用的是固定措辞（`"需要工具权限"`），不是 agent 的输出。这一条由测试保证 —— 见 `src/core/privacy.test.ts`。

白名单里有一个字段值得单独点名，因为它是新加的：agent 的**进程号**。它是一个本机整数，只用来回答「那个进程还活着吗」（见 [agent 没打招呼就没了](#agent-没打招呼就没了)），永远不出 `127.0.0.1`，也没法还原成你敲过的任何东西。

想全部删掉，用**设置 → 重置与卸载**（见[重置、删除、卸载](#重置删除卸载)）—— 它在库里就地清空并压缩文件，而在 Core 还开着的时候删目录做不到这一点。没有应用时，`npm run adapter:uninstall -- --purge-data` 在命令行里做同一件事。一切都在 `.vibepaws/`：数据库、你的宠物、它的 EXP 历史和 API token。

### 它会花我的 token 吗？

不会。Vibepaws 里没有任何 API key，也没有任何模型客户端 —— 它没有一条代码路径通向模型，也就没有任何东西可以计费。

这件事值得单独占一节，因为 [clawd #102](https://github.com/rullerzhou-afk/clawd-on-desk/issues/102)：有用户来问，为什么**他的 agent 告诉他**这个桌宠消耗了很多 token。那是 agent 自己编的，而用户合情合理地信了。任何基于 hook 的宠物最后都会碰到这个问题，而对一句语言模型凭空编出来的话，「相信我」是很差的回答。

所以这里给的是机制。hook 通往模型的通道只有一条：**stdout**。Claude Code 会把其中一部分回喂进对话 —— `UserPromptSubmit` 的 stdout 会变成上下文，非零退出码会把 stderr 当反馈送回去。Vibepaws 的 hook 不往 stdout 写任何东西，并且永远以 `0` 退出。这两条都由 `src/adapters/hook_agent.test.ts` 里的测试钉住：一句调试时随手加上的 `console.log` 真的会开始花掉真钱，而它在 review 里看起来完全无害。（statusLine 命令确实会打印一行 —— 那是你终端的状态栏，由 Claude Code 自己渲染，不会发给模型。）

它**确实**花掉的东西，在这台机器上实测（M 系列 Mac，Node v25）：

| | |
| --- | --- |
| 模型 API 调用 | **0** |
| 离开这台机器的字节 | **0** |
| 每条事件 | 约 310 字节 JSON，经 `127.0.0.1` |
| Core 收一条 | 约 0.4 ms（p50） |
| hook 进程自身 | 约 75–80 ms 墙上时间，其中绝大部分是 Node 自己的启动 |

最后一行是 hook 式设计诚实的价码：每次工具调用多出大约 80 ms，付的是延迟，不是 token。它也是这几个数里最值得盯的一个 —— 所以它在界面上，而不是在脚注里。

实时数字在**设置 → Token 与开销**，浮层的 EXP 明细下面还有一行简版。也别只信那扇窗口 —— 同一份 JSON 一条命令就能拿到：

```bash
curl -s -H "x-vibepaws-token: $(cat ~/.vibepaws/api_token)" \
  http://127.0.0.1:17893/api/hookstats
```

计数从 Core 启动时开始。字节数是 Core 真的读进来的请求体；hook 耗时由每个 hook 进程自报，量的是「进程启动 → 发出这一条」。

---

## 它怎么工作

```
你的 agents                          Vibepaws Core（Node 守护进程）            宠物壳
─────────────                        ───────────────────────────              ─────────
claude_code hooks ─┐                 ┌──────────────────────────┐
codex hooks ───────┤  HTTP + token   │ Event ingress             │             ┌───────────┐
pi extension ──────┼───────────────► │  ↓ 校验 / 去重            │    SSE      │ 宠物状态   │
generic JSONL ─────┤  127.0.0.1      │ Session registry          │ ──────────► │ 气泡      │
simulator ─────────┘                 │  ↓ 聚合 7 状态            │             │ 浮层      │
                                     │ 通知引擎                  │             │ EXP 条    │
      （Core 离线？                  │ EXP / 健康 / 进化引擎     │             └───────────┘
       → JSONL + bridge）            │ SQLite: pets / sessions / │
                                     │  events / notifications / │
                                     │  exp_logs / memories      │
                                     └──────────────────────────┘
```

Core 是独立守护进程，可以 headless 运行。宠物壳只是一个客户端 —— 未来可能有好几个。adapter 彼此独立、允许缺失；缺一个 adapter 只是降级一个信号，不会打断循环。

Core 的 HTTP 接口（除 `/health` 外都要 `X-Vibepaws-Token`）：

| 路由 | 用途 |
| --- | --- |
| `POST /events` | 收事件 |
| `GET /sse` | 事件流（pet state / notification / event 三类推送） |
| `GET /api/state` | 当前聚合状态 |
| `GET /api/sessions` | session 列表 |
| `GET /api/exp` | EXP 明细 |
| `POST /api/action` | mute / unmute / dismiss / actioned |
| `GET /api/hookstats` | 采集通道的开销 —— 事件数、字节数、延迟，以及两个 0 |

设计决策与模块级细节：[`docs/mvp_architecture.md`](docs/mvp_architecture.md)。

---

## 宠物们

目前发布 5 只 starter pet，每只都有全部七张状态立绘。注册表从第一天起就支持 100 个 ID，带 rarity 与 evolution metadata。

| 宠物 | 稀有度 |
| --- | --- |
| <img src="ui/pets/embercub/idle.png" width="52"> **Embercub** | common |
| <img src="ui/pets/sporewick/idle.png" width="52"> **Sporewick** | common |
| <img src="ui/pets/lunafang/idle.png" width="52"> **Lunafang** | uncommon |
| <img src="ui/pets/voltroc/idle.png" width="52"> **Voltroc** | uncommon |
| <img src="ui/pets/circuit-witch/idle.png" width="52"> **Circuit Witch** | rare |

首次启动随机分配一只。

### 加一只自己的宠物

`ui/pets/` 里的构建产物**已提交进仓库** —— 跑应用、装依赖都不需要 Python。只有**加新宠物**时才需要这条 pipeline。

```bash
# 1. 把原图丢进 pet_assests/，在 pet_assests/roster.json 里加一行
#    （id / slug / name / rarity / starter / src）

export POE_API_KEY=...                      # 只从环境变量读，不写进仓库
npm run states -- --dry-run                 # 只打印要生成什么
npm run states                              # 生成 7 个状态的立绘；已存在的自动跳过

npm run assets -- --check                   # 只体检：抠底结果、连通域、锚点、主色，不写盘
npm run assets                              # 写 ui/pets/<slug>/*.png 与 ui/pets/index.json
npm run db:init                             # 让 pet_types 表跟上
```

`ui/pets/index.json` 是运行时唯一的真相来源 —— 渲染层（`ui/pets/registry.js`）和 `src/db/seed.ts` 读的都是它。

**记得看联络表。** `npm run assets` 会顺手拼一张 `output/imagegen/pet-states/contact-sheet.png`（棋盘垫底）—— **每次生成后过一眼。** 模型偶尔会在脚下画一片提示词里明令禁止的地面阴影，而它在数值上和宠物自身的大片浅色分不开（饱和度 / alpha / 平坦度三种判据都试过，非漏报即误报）。所以这里不做自动质检：脏的那一帧在联络表上一眼可见，删掉重新生成就好。

模型默认 `nano-banana-pro`。`gpt-image-2` 目前不可用 —— Poe 的 Images API 在这个账号上没开通（`403 Images API is not enabled for this user`，对所有图像模型一视同仁），而 `gpt-image-*` 走 chat/completions 会直接断连。开通之后 `--model gpt-image-2` 即可。

素材缺失、解码失败或 `pet_type_id` 没有对应素材时，宠物回落到程序生成的兜底形象（`ui/pets/procedural.js`）—— 界面上永远是一只宠物，不会是一扇空窗。

状态到动作的映射集中在 `ui/pets/motion.js` 的 `MOTION` 配方表里。想直接验收某个状态，给宠物窗口的 URL 加 `?petstate=<state>` 即可，不必用模拟器复现。

---

## 打包 .app

```bash
npm run dist:mac                       # 产物在 dist/
npm run verify:release -- --preflight   # 打包前：证书和公证凭据齐不齐
npm run verify:release                  # 打包后：到底签上没有、公证过没有
```

签名和公证这条链已经接好了 —— hardened runtime、授权清单，以及 `.app` 和 `.dmg`
两份产物各自的公证。**缺的是凭据，不是配置。**
没有凭据时构建照样成功，产出未签名的 `.app`，
本地开发一直走的就是这条路。

> **未签名产物在 macOS 上会被判定为「已损坏」**（[#1](https://github.com/junrong1/Vibepaws/issues/1)）。这不是产物坏了，而是 Gatekeeper 对没有 Apple 开发者签名 + 公证的 app 一律隔离。两条路：
>
> - **自己用** —— 装好后解除隔离标记：
>   `xattr -dr com.apple.quarantine /Applications/Vibepaws.app`
> - **要分发给别人** —— 配好 Apple 凭据，同一句 `npm run dist:mac` 就会签名、公证、装订。打 `v*` tag 则由 CI 完成。完整手册：[`docs/release_signing.zh-CN.md`](docs/release_signing.zh-CN.md)。

`npm run verify:release` 是唯一诚实的检查。签名出问题在自己机器上是看不见的 ——
自己构建的产物没有 quarantine 标记，Gatekeeper 根本不评估它，所以「我这儿能打开」
什么都证明不了。验收脚本直接去问 macOS：签名、hardened runtime、授权、公证票，
以及包里每一个 Mach-O 是不是都签到了。

---

## 排查

| 现象 | 原因与解法 |
| --- | --- |
| agent 明显在干活，宠物却一直 `idle` | 几乎总是 Node < 22.6 —— hook 那条路径静默失败。先看 `node --version`。 |
| 连接指示灯是橙色 | 轮询还活着但事件流断了，所以气泡来不了。重启 Core，然后重跑 adapter 安装器让它重发自检事件。 |
| 装完 pi adapter 什么都没发生 | 要**新开**一个 `pi` 会话或 `/reload`。项目级插件还要求项目被 pi 信任。 |
| Codex 什么都不发 | 在 codex 里运行一次 `/hooks` 授权。 |
| 重复 EXP、重复气泡 | 全局和项目级 hooks 都装了。用 `--global` 重跑一次，它会清掉项目级条目。 |
| token 一直是 0 | Claude Code 的 token 来自 `statusLine` —— 重装 adapter 让它被配上。Codex 的 token 只在 SessionEnd 才到。 |
| 没有 token 里程碑气泡 | 没设预算 —— 在设置里填一个（托盘 → 设置…），全局或只给那个 session。里程碑是相对预算算的；context 警告不需要预算。 |
| 宠物在全屏终端上消失了 | 不该发生 —— 请提 issue。注意「所有桌面显示」只管换桌面时跟不跟过来。 |
| 换了显示器之后宠物跑到屏幕外了 | 它会自己回来 —— 拔掉显示器时宠物会移到一块还在的屏上。如果没回来，托盘 → **把宠物放回右下角**。 |
| 宠物老是跟着我在几块屏之间跳 | 那是**显示器 → 跟随当前显示器**。改成**固定在一块屏上**（托盘或设置 → 窗口）它就不动了；想换位置直接拖过去，它会留在那儿。 |
| 宠物不跟我换到另一块屏 | 跟随要等光标停住约一秒，一次划过去不会把它拽走。如果始终不跟，确认没有选在**固定在一块屏上**。 |
| 换了显示器后宠物跑到屏幕外 | 托盘 → 放回右下角。 |
| 启动时弹「Vibepaws 需要 Node 22.6 或更高版本」 | 应用会依次找 `PATH`、Homebrew、`/usr/local`、`/usr/bin`、Volta、nvm、fnm、`n`。都不在的话设 `VIBEPAWS_NODE=/path/to/node` —— 从登录项启动时几乎没有 `PATH`，这个场景要特别留意。 |
| 托盘里写着 **Core：未运行** | 连着 5 次重拉都失败了。托盘 → **重启 Core**；原因在日志里（打包版是 `~/Library/Application Support/Vibepaws/vibepaws.log`，dev 模式在 stdout）。 |

---

## 开发

```bash
npm test          # registry 状态机 · 通知引擎 · EXP 引擎 · 聚合状态 · 迁移 · hook 归一化 ·
                  # bridge · 隐私 · i18n · 宠物类型种子 · 动作配方（含越界与切换连续性）
npm run typecheck
npm run core:watch    # 只跑 Core，改完即重载 —— 配合 `npm start`，它会直接沿用这一个
```

目录结构：

```
src/core/        守护进程：ingress、session registry、通知、EXP、settings、HTTP + SSE
src/adapters/    claude/codex hook 模板、pi 插件、statusline、通用 bridge、安装器
src/db/          SQLite schema、迁移、宠物类型种子
src/simulator/   场景驱动的事件生成器（QA 用）
src/i18n/        一份共用文案目录（zh-CN / en）
ui/              宠物渲染层：canvas、动作配方、fx、宠物注册表、程序生成兜底
                 以及设置页面（settings.html / .js / .css）
desktop/         Electron 壳：透明窗口、托盘、点击穿透、设置窗口、尺寸档位与多显示器落位，
                 以及 Core 的监护（找 node → 拉起 → 重拉 → 收摊）和登录项
scripts/         Python 素材 pipeline（只有加宠物时才需要）
docs/            PRD（中/英）与技术架构
```

测试用 Node 内置 runner 直接跑 `--experimental-strip-types` 的 TypeScript —— 没有构建步骤，没有测试框架。

---

## 路线图

**MVP 窗口剩下的部分** —— 补齐 starter pet（5 → 12）· 进化形态素材 · 音效 · drift 规则调优 · STT 语音命令作为 P1 实验。

**之后**，以 retention 而不是宠物数量为闸 —— 可导出的 pet card、有审核的社区宠物投稿、skin pack、public profile。

**刻意推迟** —— 排行榜、PVP、交易、稀有宠物售卖。每一项都带来防作弊、IP、审核和信任问题，而在日活被验证之前，没有一项值得接。

完整推理、指标与发布标准：**[PRD（中文）](docs/prd_mvp_zh.md)** · **[PRD（English）](docs/prd_mvp_en.md)**

## 文档

| 文档 | 内容 |
| --- | --- |
| [`docs/prd_mvp_zh.md`](docs/prd_mvp_zh.md) | 产品需求、范围决策、指标、路线图、实现状态 |
| [`docs/prd_mvp_en.md`](docs/prd_mvp_en.md) | 同上，英文 |
| [`docs/mvp_architecture.md`](docs/mvp_architecture.md) | 技术架构：决策记录、模块设计、事件 schema、数据模型、降级策略 |
| [`docs/release_signing.zh-CN.md`](docs/release_signing.zh-CN.md) | 发布签名与公证：凭据、一次性配置、CI、验收、排查 |
| [`docs/release_signing.md`](docs/release_signing.md) | 同上，英文 |
| [`references/event_collection.md`](references/event_collection.md) | Claude Code / Codex hook 事件体系调研 |
| [`references/cc-session.md`](references/cc-session.md) | pi / Claude Code / Codex 的 session 管理机制对比 |
| [`references/desktop_pet_landscape.zh-CN.md`](references/desktop_pet_landscape.zh-CN.md) | 竞品研究：35 个桌宠、跨 8 个 tracker 的 1,300+ 个 issue，以及一份 39 项的功能路线图 |
| [`references/desktop_pet_landscape.md`](references/desktop_pet_landscape.md) | 同上，英文 |

## 参与贡献

MVP 在快速推进，范围冻结到 2026-09-01，所以现在最有用的贡献是**来自真实 agent session 的 bug 报告** —— 特别是这里没测过的 agent 版本上 adapter 挂掉的情况。请附上 agent 名称、版本和 `node --version`。

宠物素材投稿在计划中但还没开放：需要先有审核、版权和素材质量规则（PRD §16）。

## License

尚未选定。在 license 文件落地之前，作者保留一切权利 —— 请把这个仓库当作可供评估的 source-available 项目，而不是开源项目。

<div align="center">

**[English →](README.md)**

</div>
