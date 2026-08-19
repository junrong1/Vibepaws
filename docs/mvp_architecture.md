# Vibepaws MVP 技术架构（v1）

> 状态：定稿草案 v1 · 对应 README MVP 范围（P0）
> 参考：`README.md`（P0 需求）、`references/event_collection.md`（Claude Code / Codex hooks 事件体系）
> 形态：插件化（adapter 采集插件 + 内容插件 + 可选宿主集成）· 本地优先 · 单用户桌面

---

## 0. 关键决策记录

| # | 决策 | 理由 |
|---|---|---|
| D1 | 一只主宠物管全部 session（方案 A） | 符合 README「随机分配一个 starter pet」；单一宠物情感连接；面板内用状态图标区分 session |
| D2 | 跨 session 管理：**功能全要，形式宠物化** | 参考 pi-gui 的能力（全局发现/切换/记住最后 session/keep-alive），但 UI 不做面板/树形列表，全部用宠物 + 气泡 + 轻量浮层承载 |
| D3 | **Adapter 顺序：Claude Code + Codex 第一梯队** | 两者事件/session 模型同构（同一 stdin JSON 协议、同一 `hookSpecificOutput` 结构、事件清单高度重合），共享一个采集模板即可覆盖两个 agent |
| D4 | 不假设 adapter 完美适配 → 能力声明 + 降级 | hooks 随版本漂移；缺事件只降级（跳过对应信号/用近似信号），不阻塞核心循环 |
| D5 | Core 独立守护进程，UI 只是客户端 | 插件化哲学：桌面壳、pi-gui、未来的 pi extension 都只是 Core 的消费者；Core 可 headless 运行 |
| D6 | 技术栈：Core = Node ≥20 + better-sqlite3；UI 壳 = **Electron（MVP 已落地）→ Tauri v2（待 Rust 就绪）**；渲染 = Canvas 2D | Electron 已实现透明桌宠窗+托盘+点击穿透，壳与渲染层/SSE 协议解耦，换 Tauri 仅改壳层；打包 electron-builder 产出 .app/dmg/zip（GitHub 100MB 限制已通过历史清理规避） |
| D7 | 隐私双闸：adapter 采集侧白名单 + Core 落库前 schema 丢弃 | 原始 prompt/代码/secret 不进 Core、不进 UI、不落库 |

---

## 1. 总体架构

```
┌──────────── Agent 侧：采集插件（随 agent 运行，各自独立，可缺失）─────────────┐
│                                                                          │
│  claude_adapter ─── codex_adapter ───── generic_bridge ─── simulator     │
│  (.claude/settings.json) (~/.codex/hooks.json)  (JSONL/socket) (QA 注入)  │
│                                                                          │
│  统一模板 hook_agent.ts：读 stdin JSON → 白名单提取元数据 → safe_summary    │
│  → POST localhost:PORT/events（失败降级：写 JSONL 文件 + fs.watch 兜底）    │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │ HTTP POST + API token
┌──────────────────────────────▼───────────────────────────────────────────┐
│  Vibepaws Core（Node 守护进程，常驻，headless 可运行）                     │
│                                                                          │
│  ┌────────────────┐   ┌─────────────────────┐   ┌─────────────────────┐  │
│  │ Event Ingress   │──▶│ Session Registry    │──▶│ 通知引擎             │  │
│  │ 校验/去重/落库   │   │ 全局发现/聚合/分组    │   │ 5s 气泡/轮播/去重/   │  │
│  └────────────────┘   │ 按 project 分组       │   │ mute(30m/2h/proj)   │  │
│                       │ 最后活跃记忆          │   └─────────┬───────────┘  │
│                       │ 状态机(7 状态聚合)     │             │ SSE 推送
│                       └──────────┬──────────┘   ┌─────────▼───────────┐  │
│  ┌────────────────┐   ┌──────────▼──────────┐   │ UI 客户端             │  │
│  │ 宠物内容注册表   │   │ EXP/健康/进化引擎     │   │ (气泡/状态/浮层/EXP条) │  │
│  │ 100 ID · rarity │   │ 公式+质量倍率+daily  │   └─────────────────────┘  │
│  │ · evolution meta│   │ cap · tired · 自成长  │                          │
│  └────────────────┘   └──────────────────────┘                          │
│  ┌───────────────────────────────────────────────────────────────────┐  │
│  │ SQLite: pets / pet_types / sessions / events / notifications /     │  │
│  │         exp_logs / memories / agents / settings                     │  │
│  └───────────────────────────────────────────────────────────────────┘  │
└───────────────┬────────────────────────────────┬────────────────────────┘
                │ SSE + HTTP (localhost:PORT)     │
     ┌──────────▼───────────┐        ┌────────────▼────────────┐
     │ Tauri 宠物壳（P0）     │        │ 宿主集成（P1，可选）       │
     │ 宠物(聚合状态)         │        │ pi-gui 风格客户端 /        │
     │ 气泡(轮播)             │        │ pi extension —— 只消费    │
     │ 轻量浮层(切换/静音/新会话)│        │ Core 事件，零耦合          │
     └──────────────────────┘        └─────────────────────────┘
```

**跨 session 管理的位置**：全部在 Core 的 Session Registry（功能层），UI 只是按宠物化的方式展示。pi-gui 的技术资产（`lib/pi-client.js`、`lib/sessions.js`、`lib/agent-manager.js` 的 keep-alive 思路）在 P1 接入 Pi 时直接复用。

---

## 2. 模块设计

### 2.1 Adapter 采集插件（P0，Claude Code + Codex 共享模板）

**差异与关键坑（实测 2026-08）：**

| 维度 | Claude Code | Codex（v0.148） |
|---|---|---|
| hooks 配置 | `.claude/settings.json`（驼峰事件键） | `.codex/hooks.json`（**驼峰事件键**，源码 serde rename 确认） |
| 项目信任 | 目录信任后生效 | **项目级 hooks 被「项目信任」门控**：未信任时项目层整体 disabled，hooks 被跳过；需 `~/.codex/config.toml` 的 `[projects."<path>"] trust_level="trusted"`（install.ts 自动配置，含备份） |
| hooks 信任 | 无需单独审查 | 非托管 hooks 需 `/hooks` 审查信任，否则被跳过；headless 自动化用 `--dangerously-bypass-hook-trust` |
| token 通道 | **statusLine 实时**（stdin JSON 含 context_window.total_input_tokens/total_output_tokens）+ SessionEnd transcript 提取 | 无 statusline；hooks stdin 无 token 字段；SessionEnd 时从 `~/.codex/sessions/*.jsonl` 提取（best-effort） |

**token 采集（详见 §2.8）**：Claude Code statusLine → 实时 token_update；SessionEnd → transcript 汇总兜底（实测 53218 tokens）。

| 维度 | Claude Code | Codex |
|---|---|---|
| 配置位置 | `.claude/settings.json`、`~/.claude/settings.json` | `~/.codex/hooks.json`、`~/.codex/config.toml`、`<repo>/.codex/` |
| 输入协议 | stdin JSON（`session_id`/`cwd`/`hook_event_name`/`tool_name`/`transcript_path`） | 同左（turn 事件多 `turn_id`） |
| 输出协议 | 退出码 0=放行 2=阻断；或 stdout `hookSpecificOutput` JSON | 同左 |
| 事件 | SessionStart/End、UserPromptSubmit、Pre/PostToolUse、PermissionRequest、Pre/PostCompact、Stop | 同左 + SubagentStart/Stop |

差异仅在于：配置格式、事件 matcher 名、个别字段名。因此：

```
adapters/
  hook_agent.ts        ← 通用模板（读 stdin → 白名单 → safe_summary → POST）
  claude.hooks.json    ← 生成 .claude/settings.json 的 hooks 片段（事件 matcher 清单）
  codex.hooks.json     ← 生成 ~/.codex/hooks.json 的 hooks 片段
  install.ts           ← 写配置（先备份原文件）、Codex 引导 /hooks 信任注册、自检发测试事件
```

模板逻辑（单文件，约 150 行）：
1. 读 stdin JSON（一次一个事件）
2. `hook_event_name + matcher` → 标准化事件类型（映射表见 §3）
3. 白名单提取：`session_id / cwd / tool_name / severity / 时长`；**丢弃 `tool_input`、`prompt`、`cwd` 中的敏感路径值、任何代码/文本内容**
4. 构造 `safe_summary`（固定措辞模板，如 `Tool permission needed: Bash`）
5. `POST http://127.0.0.1:PORT/events`，失败则 append 到 `events/*.jsonl`（Core `fs.watch` 兜底）
6. 非阻断事件直接 `exit 0`；**不改变 agent 行为**（MVP 只监听，不做 allow/deny 决策）

**generic bridge（P0）**：监听一个本地目录/端口，接受任意 JSONL/JSON 事件，字段按 §3 schema 归一。任何工具（含未来的 Pi adapter）都能接入。

**simulator（P0，QA 关键件）**：CLI 按场景（正常会话/频繁决策/context 超限/correction loop/多 session 并行）注入全部核心事件，用于开发与验收。

### 2.2 Event Ingress（Core）

- API token 校验（安装时随机生成，写入 hooks 命令参数，防本机其他进程伪造）
- schema 校验：未知字段 drop（第二道隐私闸）
- 幂等：`event_id` 去重；同一 `(agent, session_id)` 归并到同一 session
- 落库 `events` 表 → 分发到 Session Registry

### 2.3 Session Registry（Core，跨 session 管理的核心）

```
session 主键: (agent, agent_session_id)      ← 跨 agent 天然隔离
聚合键:       project_id（cwd 归一化）        ← 按项目分组
树:           parent_id / branch             ← subagent、fork、compact 链（P0 alpha，尽力而为）
状态机:       idle/working/needs-you/warning/finished/tired/level-up
聚合宠物状态: 所有活跃 session 按优先级合并: needs-you > warning > working > idle
最后活跃记忆: 每 agent 记录最近有事件的 session，Core 重启后恢复焦点
```

**数据源：事件流为主，transcript 文件解析为辅**（研究结论，详见附录 A）：

- 主数据源 = hooks 事件流（session_id / cwd / 时间 / token / context 全部来自事件）
- **不解析 transcript 文件做元数据**：Claude Code 官方明示 JSONL 为内部格式、随版本变化，直接解析会坏；pi（P1）与 Codex（可选）的存档相对稳定，可做补充兜底
- 显示名策略：用户手动命名（Vibepaws 本地维护）> cwd 目录名 > agent 短 id。hooks 输入不含 session 名；AI title / 用户命名只对 pi（P1 读 JSONL header）可用

**Session 生命周期（用 session_started 的 source 字段推断，不依赖文件）**：

| source | Registry 动作 |
|---|---|
| startup | 新建 session，parent=null |
| resume / continue | 同一 (agent, session_id) 复用并标记活跃（跨项目查找由 agent 自身处理） |
| fork / branch | 新 session_id，parent=原 session |
| clear | 同一 session 内 context 重置（状态回 working，不新建） |
| compact | 同一 session 内里程碑（context_pct 100% → 压缩后回落） |

**jump-to（恢复/切换动作表，写入 adapter 能力声明）**：

| agent | 恢复命令 | MVP 动作 |
|---|---|---|
| claude_code | `claude --resume <session-id>`（官方支持跨目录） | 复制命令到剪贴板 + 唤起终端（P1） |
| codex | `cd <project> && codex resume <session-id>` | 同上 |
| pi | RPC `switch_session`（P1，复用 pi-gui lib） | 直接切换 |
| generic | 打开 project 目录 | 打开目录 |

### 2.4 通知引擎（Core）

- 判定在 Core（保证 5 秒验收：adapter <100ms + HTTP <10ms + 判定 <5ms + SSE <50ms）
- 多 session 需要你：**气泡轮播**（逐条显示）或**聚合气泡**（「3 个 session 需要你，最近：codex」）
- 去重：同 session 同类型 60s 合并；mute：全局 30min/2h、按 project、按 session 的 warning
- 气泡内容只用 `safe_summary` + `agent 徽标 + session 短名`，无敏感数据
- 点击气泡 → 浮层定位到对应 session；dismiss → 记 `notifications` 历史

### 2.5 EXP / 健康 / 进化引擎（Core）

按 README 6.4/6.5 原文实现：

```
session_exp = capped_token_exp × context_multiplier × topic_multiplier
            + outcome_bonus + daily_care_bonus

capped_token_exp: 每 1000 tokens = 1 EXP，每宠物每日 cap（防 token farming）
context_multiplier: <70%→1.10 · 70–85%→1.00 · 85–95%→0.75 · >95%→0.50
topic_multiplier:   goal 一致→1.10 · correction loop→0.80
outcome_bonus:      accepted diff / test pass / commit / shipped → +20~100
daily_care_bonus:   休息/新 session 恢复时的少量奖励
self_growth:        每小时 +0.1 EXP（tired 时暂停）——避免「不用 agent 就被惩罚」
```

- 质量信号全部来自事件元数据（不读 prompt）：session goal（用户设置）、context 使用量、correction 计数（同文件高频 PreToolUse/Stop 近似）、commit/test（PostToolUse 工具名元数据）
- 每笔 EXP 写 `exp_logs`，支撑「EXP 为什么变了」面板
- 进化：纯配置 `{from_level, conditions, to_stage}`；Level 10+ 按健康分选 evolved / calm / tired variant

### 2.6 Tauri 宠物壳（P0 UI）

```
主窗口: 宠物（always-on-top、可拖拽、click-through 开关、DND、reduced-motion）
气泡层: 透明 overlay 子窗口（轮播/聚合气泡）
浮层:   点击宠物弹出的 pixel 风小卡片 —— 唯一的 session 管理入口：
        · 活跃 session 列表（agent 徽标 + 短名 + token/context 条 + 状态点）
        · 点击行 = jump-to（对 Codex/Claude：聚焦其终端窗口 / 打开 session 目录）
        · 「全部安静 2h」「开新会话」「查看 EXP」动作
        · 明确不做：树形列表、按 agent 的完整历史管理（MVP Non-goal）
```

- 渲染：Canvas 2D + `image-rendering: pixelated`；sprite 数据驱动
- 状态动画（idle 呼吸/working 敲击/needs-you 抖动/warning 变红/finished 庆祝/level-up 光效）集中在壳内
- 壳零业务逻辑：状态、气泡内容、浮层数据全部来自 Core 的 SSE 推送

### 2.7 宠物内容注册表（数据驱动插件）

```
pet_types: { id, name, rarity(common/uncommon/rare/legendary),
             sprite_pack, evolution_meta[], starter }
- schema 支持 ≥100 个 ID；MVP 交付 6 个 sprite（程序化生成）+ Spark/Flare/Nova 进化家族（seed.ts）
- 首次启动随机分配一个 starter pet（README 6.1 验收）
```

### 2.8 token 采集通道（实时 + 兜底，2026-08 新增）

**调研结论（实测 + 源码确认）**：Claude Code / Codex 的 **hooks stdin 输入均不含 token/usage 字段**（PostToolUse/SessionEnd 实测无；codex PostToolUseRequest 结构确认无）。token 只能间接获取：

| 通道 | 机制 | 状态 |
|---|---|---|
| **statusLine（Claude Code）** | `settings.json` 配 `statusLine.command`，每次状态刷新 stdin JSON 含 `context_window.total_input_tokens/total_output_tokens`（官方口径 input 含缓存读写）；headless `-p` 不触发（TUI 特性） | ✅ 已实现 `src/adapters/statusline.ts`（token 未变去重、静默失败） |
| **SessionEnd transcript（Claude Code）** | hook 输入带 `transcript_path` → 解析 assistant message.usage（input+output+cache_creation）→ 一次性 token_update | ✅ 已实现（实测 53218 tokens） |
| **SessionEnd 存档（Codex）** | `transcript_path` → `~/.codex/sessions/*.jsonl`（session 存档）；提取逻辑通用覆盖，格式不符自动降级 | ✅ 已实现（best-effort，完整验证待认证环境） |
| 降级（D4） | 全部缺失时 EXP 只算 outcome + daily care | 默认行为 |

隐私：只提取 token 数字，不读代码/文本内容；解析失败不阻塞核心循环。

---

## 3. 事件 Schema（标准化）

### 3.1 事件信封

```json
{
  "event_id": "uuid",
  "seq": 128,
  "agent": "claude_code",          // claude_code | codex | generic | pi
  "session_id": "agent-session-id",
  "project_id": "cwd-归一化",
  "event_type": "decision_required",
  "severity": "high",              // low | medium | high
  "safe_summary": "Tool permission needed",
  "timestamp": "2026-08-18T10:00:00Z",
  "payload": { }                   // 仅白名单字段，见下表
}
```

### 3.2 事件类型与 adapter 映射

| 标准化事件 | payload（白名单） | Claude Code 来源 | Codex 来源 | 触发 |
|---|---|---|---|---|
| `session_started` | title, cwd | SessionStart | SessionStart | 宠物→working |
| `agent_working` | tool_name | PreToolUse / UserPromptSubmit | PreToolUse / UserPromptSubmit | 宠物→working |
| `decision_required` | kind, turn_id | Notification / Stop | Stop | 宠物→needs-you + 气泡 |
| `permission_required` | tool_name | PermissionRequest | PermissionRequest | 宠物→needs-you + 气泡 |
| `token_update` | tokens, cost | Notification(usage) | PostToolUse 汇总 | EXP 滚动 + 里程碑气泡(25/50/75/90%) |
| `context_update` | context_pct | PreCompact/PostCompact | PreCompact/PostCompact | warning 气泡(70/85/95%) |
| `topic_drift_warning` | signal_kind | Core 启发式（见 §3.3） | 同左 | warning 气泡 + 新会话建议 |
| `session_finished` | reason, outcome | SessionEnd | SessionEnd | EXP 结算 + finished |
| `session_error` | error_kind | PostToolUseFailure | — | warning + 气泡 |
| `subagent_started/stopped` | kind | SubagentStart/Stop | SubagentStart/Stop | 树结构（尽力而为） |
| `adapter_status` | capabilities[] | 安装时上报 | 同左 | 能力声明/降级路由 |

### 3.3 Topic drift（P0 alpha，保守启发式，不读 prompt）

信号仅来自：用户定义的 session goal、context 使用量、correction 计数、文件区域突变幅度（PostToolUse 文件路径前缀变化）、session 时长 vs token 增速。任一超阈值 → `topic_drift_warning`，**只建议新会话，不强制**。

---

## 4. 数据模型（SQLite）

```sql
pet_types(id, name, rarity, sprite_pack, evolution_meta, starter)      -- 内容注册表
pets(id, pet_type_id, level, exp, state, health_score,
     daily_exp, daily_reset_at, assigned_at)                            -- 方案 A：单宠物
agents(agent, adapter_version, capabilities, connected_at, last_event_at)
sessions(id, agent, agent_session_id, project_id, title, goal,
         budget_tokens, token_used, context_pct, correction_count,
         parent_id, branch, is_active, last_event_at,
         started_at, finished_at, outcome,
         UNIQUE(agent, agent_session_id))
events(id, event_id, seq, agent, session_id, event_type, severity,
       safe_summary, payload_json, received_at)
notifications(id, event_id, agent, session_id, type, title, body,
              status, shown_at, actioned_at)                            -- dismissed/muted/actioned
exp_logs(id, session_id, amount, category, note, created_at)            -- token/ctx/topic/outcome/care/self
memories(id, session_id, kind, safe_summary, created_at)                -- session finish 时生成
settings(key, value)                                                    -- budget 默认值、mute 状态、DND 等
```

- 本地优先；「删除本地数据」= 清空 vibepaws 数据目录（README 发布标准）
- `events` 仅存 safe_summary + 白名单 payload；原始 hook JSON 永不落库

---

## 5. 容错与降级（D4）

| 缺失信号 | 降级策略 |
|---|---|
| `context_update` | 跳过 context warning；EXP 用 token 速率估算 |
| `decision_required` | 不显示决策气泡（仍显示 working） |
| `token_update` | EXP 只算 outcome + daily care |
| adapter 断线 | Core 保留最后状态；宠物显示连接灰点；generic JSONL 兜底继续收 |
| hooks 版本漂移 | 模板集中维护；simulator 常驻回归；`adapter_status` 上报能力差异 |

核心原则：**adapter 只报事件，所有判定在 Core**；缺任何单一信号都不阻塞宠物循环。

---

## 6. 两周实施路线图（对齐 README）

| 天 | 交付 | 验证 |
|---|---|---|
| D1 | event schema + Core 骨架 + simulator + Tauri 空壳 | simulator 全事件注入→状态机正确 |
| D2 | 宠物表层：7 状态渲染、拖拽、click-through、DND、6 pets | 宠物展示模拟状态 |
| D3 | 通知引擎：气泡 UI、轮播/聚合、dismiss/mute、历史 | 5 秒内出气泡（计时测试） |
| D4 | usage/context/EXP：budget、阈值、公式、daily cap、exp_logs 面板 | 模拟 usage 驱动升级 |
| D5 | hook_agent.ts 模板 + **Claude Code 挂载** + generic bridge | 真实 Claude 事件→宠物状态 |
| D6–7 | 缓冲：12 pets、onboarding、delete/reset | internal alpha build |
| W2 D1 | **Codex adapter**（信任注册引导） | 双 agent 路径 |
| W2 D2 | topic drift 规则 + 新会话建议 + mute/feedback | 不健康时宠物提醒 |
| W2 D3 | 进化家族 + tired/自成长 + memory | 一条路径 level/recover/evolve |
| W2 D4–7 | QA（onboarding/延迟/隐私/删数据）+ alpha 发布 | README 发布标准全绿 |

---

## 7. 主要风险

| 风险 | 对策 |
|---|---|
| hooks 事件随版本漂移 | 模板集中 + simulator 回归 + generic fallback + `adapter_status` 能力上报 |
| Codex 信任评审流程（/hooks）增加 setup 摩擦 | install.ts 一键写配置（先备份）+ onboarding 引导信任注册 |
| always-on-top 跨平台差异 | macOS NSWindow level / Windows tool window / Linux override-redirect，壳内集中 |
| 气泡 5s 验收 | 判定全在 Core，UI 零逻辑 |
| token farming | daily cap + 质量倍率 + outcome 导向 |
| 隐私信任 | 双闸 + 事件仅存 safe_summary + 一键删除 |

---

## 8. Non-goals（MVP）

独立 session 管理面板/树形列表 · marketplace/PVP/排行榜 · 永久死亡 · 默认云同步 · STT（P1 隐藏 flag） · 完整 100 宠物素材（架构支持，内容后补）

---

## 附录 A：session 管理机制研究对比（pi / Claude Code / Codex）

> 来源：pi-gui（pi）、code.claude.com/docs/en/sessions（Claude Code，见 references/cc-session.md）、github.com/coramba/codex-sessions-manager（Codex）

| 维度 | pi | Claude Code | Codex |
|---|---|---|---|
| 存储位置 | `<sessionDir>/--<cwd>--/*.jsonl`，按项目分目录 | `~/.claude/projects/<cwd编码>/*.jsonl`，按项目分目录 | `~/.codex/sessions/` |
| 文件格式 | JSONL tree v3（pi-gui 实证可解析） | JSONL（**官方警告：内部格式随版本变化，勿直接解析**） | JSONL pretty-printed 块（社区项目直接解析，较稳） |
| session 标识 | session id（文件名） | session id（UUID）+ 用户命名 + AI title | session id |
| 恢复方式 | RPC `switch_session` | `claude --continue` / `--resume <id|name>` / `/resume` picker | `codex resume <id>`（`cd <cwd> && codex resume <id>`） |
| 跨项目查找 | 按项目目录检索 | 按 ID 全局唯一匹配（当前项目 → worktree → 全机） | 需知道 cwd + id |
| 分支 | fork | `/branch`、`--fork-session`（新 ID，原保留） | — |
| hooks 附带字段 | — | session_id / cwd / transcript_path | session_id / cwd / turn_id / source |
| 会话内切换 | switch_session | `/resume` picker | — |
| 元数据 | name / 首条消息 / 消息数 / compact、branch 摘要 | name / title / 最后活动 / git branch / 文件大小 | 首条请求 / 命令数 / 时长 / 项目 |

**影响架构的 4 条结论**：

1. **session 列表与元数据一律以事件流维护**；transcript 文件仅在 pi（P1）与 Codex（可选）做兜底补充，Claude Code 永不解析（官方警告）
2. **session 树 / 父子关系用 session_started 的 source 字段推断**（startup/resume/fork/clear/compact），不解析文件
3. **jump-to = 各 agent 原生恢复命令**（`claude --resume <id>` / `codex resume <id>` / pi RPC switch_session），写进能力声明，按 agent 路由
4. **Codex「丢 session ID 就找不到会话」是真实痛点**（codex-sessions-manager 的起源）→ Vibepaws 事件流天然记录 id+cwd，浮层一键恢复，这正是跨 session 管理的价值点

**实测补充（2026-08，v0.1）**：

- Codex v0.148 项目级 hooks 被「项目信任」门控（未信任 → 项目层 disabled，hooks 全部跳过）；`install.ts` 已自动写 `~/.codex/config.toml` 信任（带备份）
- Codex hooks.json 事件键为驼峰（SessionStart），与 Claude Code 一致（源码 `#[serde(rename = "SessionStart")]` 确认）
- Claude Code / Codex 的 hooks stdin 均不含 token 字段；token 经 statusLine（CC 实时）+ SessionEnd transcript/存档提取（§2.8）
- 打包：electron-builder 产出 .app/dmg/zip；自动拉起 Core（系统 node 探测，ABI 兼容）；历史 100MB+ 文件已清理，`.git` 415MB→336KB
