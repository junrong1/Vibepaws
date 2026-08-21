# Vibepaws MVP 产品需求文档（PRD）

> **一句话定位** —— 一个可爱的编程宠物：帮你看着 AI agents，在它们需要你时提醒你，并从健康的 vibe-coding session 中成长。

| 项 | 值 |
| --- | --- |
| 文档版本 | v0.2（范围冻结，实现进行中） |
| 产品版本 | MVP alpha 0.1 |
| 发布窗口 | 2026-08-18 → 2026-09-01（两周） |
| 工作名 | AI 编程宠物 / AI Coding Pet |
| 技术架构 | [`docs/mvp_architecture.md`](./mvp_architecture.md) |
| 英文版本 | [`docs/prd_mvp_en.md`](./prd_mvp_en.md) |
| 使用文档 | [`README.zh-CN.md`](../README.zh-CN.md) |

**本文档的边界**：PRD 描述**要做什么、为什么、做到什么算完成**。怎么安装、怎么跑、命令行怎么写，在 README 里。第 15 节记录截至 2026-08-21 各需求的实现状态 —— PRD 是目标，那一节是现实，两者故意分开放。

---

## 1. 产品概述

Vibepaws 是一个本地运行、always-on-top 的桌面宠物。它读取你的 coding agent（Claude Code、Codex、pi-coding-agent，以及通过 generic bridge 接入的其他工具）发出的事件，把 agent 状态转成一眼能看懂的信息。

MVP 刻意做成**「带成长系统的 agent 注意力宠物」**，而不是宠物市场。桌面宠物、编程宠物、状态反应型 mascot 已经很常见 —— 差异化不在于「有一个可爱的宠物」。真正的切入点是：宠物能帮你抓住 AI agent session 里的关键时刻，奖励健康的 agent 使用方式，并逐渐成为你工作成果的长期记录。

## 2. 问题描述

coding agent 用户经常运行长会话，同时切换窗口、等待工具授权、关注 token/context 使用量，并靠感觉判断什么时候该开新会话。结果是：

- **错过决策** —— agent 停在一个需要批准的工具调用上，用户在另一个窗口里，几分钟后才发现
- **上下文窗口浪费** —— 直到 agent 开始遗忘早期约定，用户才意识到 context 已经满了
- **主题漂移** —— 一个 session 从「修这个 bug」滑到三件不相关的事，没人喊停
- **空等时间** —— agent 已经跑完了，用户不知道

Vibepaws 把这些状态显性化：agent 需要你时提醒你，在 context 变得不健康前给出警告，并从你的 AI 编程活动中成长。

## 3. 目标用户

**主要用户**

- 每天使用 AI coding agent 的 vibe coder
- 同时运行 1 到 4 个 agent session 的 solo builder / indie hacker
- 能接受安装本地桌面工具的人
- 喜欢有趣反馈，但仍然需要真实工作流价值的人

**次要用户**

- 管理多个 session 的 coding-agent power user
- 希望展示进度的 streamer 或 build-in-public 创作者

**MVP 暂不服务**

- 企业团队
- 只手写代码、不使用 coding agent 的用户
- 想要完整 AI 聊天伴侣的用户
- 主要想玩完整游戏经济系统的用户

## 4. MVP 目标与验证问题

在两周内发布一个可用 alpha，验证四件事：

1. 用户在 vibe coding 时是否愿意一直开着宠物？
2. 用户是否能更快注意到并处理 agent 决策通知？
3. 升级循环是否有趣，同时**不**鼓励浪费 token？
4. 产品是否能通过统一事件桥接支持多个 coding agent？

## 5. 产品定位

**推荐定位**

> 「一个可爱的编程宠物：帮你看着 AI agents，在它们需要你时提醒你，并从健康的 vibe-coding session 中成长。」

**避免这样定位**

| 说法 | 为什么不用 |
| --- | --- |
| 「AI companion」 | 暗示聊天和情感依赖，与产品实际做的事不符 |
| 「coding 版 Pokemon」 | 有 IP 风险，也会制造我们不打算满足的游戏期待 |
| 「token-burning game」 | 鼓励我们正要限制的坏行为 |

## 6. 基于研究的范围决策

| 功能 | MVP 决策 | 原因 |
| --- | --- | --- |
| 常见 coding pet 行为 | P0 | 桌面宠物的基础门槛。宠物必须「活着」。 |
| 决策通知气泡 | P0 | 核心工作流价值最高。 |
| 使用量 / token 通知 | P0 | 支撑 token feeding 循环，也帮助用户控制成本。 |
| context window 过大警告 | P0 | 对 agent 用户很有差异化。 |
| 主题漂移 / 建议新会话 | P0 alpha | 有价值，但第一版应使用保守启发式规则。 |
| 100 个可爱 pixel pet | P0 架构，P1 内容 | 两周内做 100 个高质量宠物不现实。支持 100 个 ID，先发布少量完成度高的宠物。 |
| 随机分配宠物 | P0 | 成本低，惊喜感强。 |
| 等级和 EXP 进度条 | P0 | 核心留存循环。 |
| token cost feeding pet | P0，但必须加上限 | 主题很好，但不能奖励浪费 token。 |
| 隐藏质量 EXP 机制 | P0 | 让成长循环更健康的关键。 |
| 宠物死亡 | MVP 不做 | 容易制造焦虑。改为 tired / hibernation 状态。 |
| 自我成长 | P0 轻量版 | 减少焦虑，提供被动惊喜。 |
| 进化 | P0 限量版 | 先做一个完整进化家族，架构上支持更多。 |
| STT 语音命令 | P1 alpha | 有用，但集成和安全风险高于通知核心循环。 |
| Claude Code + Codex 支持 | P0 | 前两个 agent adapter。 |
| pi-coding-agent 支持 | P0（从 P1 提前） | pi 的稳定集成方式是 extension 插件，与 hooks 同层级，可直接落地。 |
| DeepSeek Harness 支持 | P1 / generic bridge | 除非有稳定 hook，否则先通过通用事件桥支持。 |
| 社区贡献宠物 | P1.5 | 重要，但需要审核、版权和素材质量规则。 |
| 排行榜 / PVP / 稀有宠物售卖 | 后续 | 范围大，并带来经济系统、信任、防作弊和审核问题。 |

## 7. MVP 功能需求

### 7.1 桌面宠物表层 — P0

> 作为 vibe coder，我希望在 AI agent 工作时看到一个可爱的宠物，这样 coding 过程不那么冷冰冰，并且我能一眼看出状态。

**需求**

- always-on-top 桌面宠物窗口，pixel style 视觉语言
- 可拖拽位置、click-through mode、Do Not Disturb mode、reduced-motion mode
- 七种状态：`idle`、`working`、`needs-you`、`warning`、`finished`、`tired`、`level-up`
- 点击宠物可以打开当前活跃 session 或 notification panel
- 在全屏应用之上依然可见（coding agent 用户基本都活在全屏终端里）

**内容要求**

- 至少发布 **12 个**高质量 starter pets
- 数据模型必须支持至少 **100 个** pet ID
- 用户首次启动时随机分配一个 starter pet
- 从第一天开始包含 rarity metadata：`common`、`uncommon`、`rare`、`legendary`
- MVP 不做 marketplace 或 trading

第一版更重要的是完成度，而不是宠物数量。

**验收标准**：宠物可在桌面常驻显示；七种状态各有可辨识的视觉表达；素材缺失时回落到程序生成形象，界面上永远是一只宠物，不会是一扇空窗。

### 7.2 通知气泡 — P0

> 作为 coding-agent 用户，我希望当 agent 需要我时，宠物显示气泡提醒，这样我做别的事情时不会错过决策。

**通知类型**

需要决策 · 需要工具权限 · usage/token 达到阈值 · context window 过大 · topic drift / 建议开启新 session · session 完成 · agent 错误或卡住

**气泡行为**

- 气泡出现在宠物附近，包含短状态标签和一行原因
- 点击气泡打开相关 session 或 panel
- 气泡**绝不**显示原始 prompt、源代码、secret path 或私有文件内容
- 用户可以 mute 所有气泡 30 分钟、2 小时，或当前 project
- mute 必须是**可见且可撤销的状态**，不能是一个静默开关

**验收标准**：事件进入后 **5 秒内**显示决策气泡；用户可以 dismiss 气泡；用户可以从气泡跳转到 session；通知记录在本地 event history。

### 7.3 使用量与 Context 健康 — P0

> 作为 agent 用户，我希望宠物在 token 使用量或 context 不健康时提醒我，这样我可以控制成本和 session 质量。

**Usage notification** —— 显示 token/cost 里程碑通知，默认阈值为配置 session budget 的 **25%、50%、75%、90%**。用户可以按 session 设置 budget。

**Context warning**

| Context 使用量 | 提醒文案 |
| --- | --- |
| 70% | 「上下文开始紧张。」 |
| 85% | 「注意 token 消耗，考虑总结或新开会话。」 |
| 95% | 「建议尽快收尾或新开会话。」 |

每一档只报一次（闩锁），不能每 60 秒复读同一档；但 70% → 95% 是完全不同的一件事，必须分别报到。

**Topic consistency warning** —— MVP 默认**不**读取完整 prompt history，只使用安全的本地信号：用户定义的 session goal、project path 变化、文件区域突然大幅变化、重复 correction、context 使用量，以及用户 opt in 后的新任务关键词。只建议，不强制开启新 session。

**验收标准**：用户可以看到当前 token budget 和 context health；当 context 不健康时宠物状态会变化；warning 可以按 session mute。

### 7.4 等级与 EXP 系统 — P0

> 作为用户，我希望宠物从 AI coding 活动中成长，让 vibe-coding session 更有奖励感。

**核心原则**：token 可以喂养宠物，但产品不能奖励浪费 token。

```text
session_exp =
  capped_token_exp
  * context_health_multiplier
  * topic_consistency_multiplier
  + outcome_bonus
  + daily_care_bonus
```

**基础 token EXP**：每 **1,000 tokens 给 1 EXP**，每只宠物有 **daily token EXP cap**（默认 200），防止用户通过浪费 token 刷等级。

**质量倍率**

| 信号 | 倍率 |
| --- | --- |
| Context 低于 70% | 1.10× |
| Context 70–85% | 1.00× |
| Context 85–95% | 0.75× |
| Context 超过 95% | 0.50× |
| Topic 与 session goal 一致 | 1.10× |
| 重复 correction loop | 0.80× |
| Session 产生 accepted diff、test pass、commit 或明确 "shipped" | +20 到 +100 EXP |

**等级曲线**：Lv1 → 100 EXP，之后每级 +50（Lv2 → 150，Lv3 → 200…）。

**宠物健康**：**MVP 不做永久死亡。** 如果使用方式不健康，宠物变成 `tired`，EXP 增长变慢；如果用户休息、开启新 session 或 ship 了东西，宠物恢复。宠物每天还会缓慢自我成长，避免用户因为不用 agent 而感到被惩罚。

**验收标准**：EXP bar 可见；用户可以查看 EXP 为什么变化；有 level-up 动画；有 tired 状态；没有永久死亡。

### 7.5 进化 — P0 限量版

> 作为用户，我希望宠物在健康使用 agent 后进化，这样它更像长期陪伴。

发布**一个完整进化家族**：基础形态、进化形态，以及质量阈值高时出现的 rare alternate form。所有 pet ID 都支持 evolution metadata。进化由 level 和质量条件**共同**触发。

| 条件 | 结果 |
| --- | --- |
| Level 1–9 | starter form |
| Level 10+ | evolved form |
| Level 10+ 且 context-health score 高 | clean / calm evolution |
| Level 10+ 且使用量高但 session hygiene 差 | tired variant（不是死亡） |

**不在范围内**：100 条完整进化线、trading evolution、battle stats。

### 7.6 STT 语音命令 — P1 Alpha

> 作为用户，当 agent 需要决策时，我希望可以直接对宠物说话，而不需要切换窗口。

- push-to-talk 按钮或 hotkey，面向短命令的 speech-to-text
- 支持命令：`approve`、`reject`、`continue`、`open session`、`new session`、`mute`、`summarize`
- 对 destructive 或 permission-sensitive 命令，**必须**先显示确认

**隐私**：优先使用本地 / 设备端 transcription；如果使用 cloud STT，用户必须明确 opt in；**永远不要**把代码或 prompt context 发送给 STT provider。

**验收标准**：语音命令可以 dismiss 或打开一个 decision notification；危险决策需要确认；用户可以完全关闭 STT。

### 7.7 Agent 集成 — P0 / P1

先构建统一本地 event bridge。各工具的 adapter 只负责把事件转成标准格式后发入 bridge。

**标准事件信封**

```json
{
  "event": "decision_required",
  "agent": "claude_code",
  "session_id": "local-session-id",
  "project_id": "local-project-id",
  "severity": "high",
  "safe_summary": "Tool permission needed",
  "timestamp": "2026-08-18T10:00:00Z"
}
```

**必要事件**

`session_started` · `agent_working` · `decision_required` · `permission_required` · `token_update` · `context_update` · `topic_drift_warning` · `session_finished` · `session_error`

**集成优先级**

| 优先级 | 集成 | 形式 |
| --- | --- | --- |
| P0 | Claude Code adapter | `.claude/settings.json` hooks + statusLine（实时 token 通道） |
| P0 | Codex adapter | `.codex/hooks.json`（token 走 SessionEnd transcript 提取） |
| P0 | pi-coding-agent adapter | pi extension 插件（挂 pi 生命周期事件） |
| P0 | Generic bridge | JSON / file / socket，给其他任意工具 |
| P1 | DeepSeek Harness adapter | 如果有可靠 hooks/logs，否则走 generic bridge |

**降级原则（不假设 adapter 完美适配）**：hooks 随 agent 版本漂移；缺事件只降级（跳过对应信号，或用近似信号），不阻塞核心循环。Core 离线时 adapter 把事件写成本地 JSONL，bridge 之后补收。

**验收标准**：alpha 中至少两个真实 adapter 可用，**或**一个真实 adapter 加一个 generic bridge 可用；simulator 可以发出所有核心事件用于 QA；事件不包含原始代码、prompt text 或 secrets。

## 8. 隐私要求（贯穿全部功能）

隐私不是一个功能，是一条贯穿所有模块的硬约束。

| 层 | 约束 |
| --- | --- |
| Adapter 采集侧 | 白名单提取字段，丢弃 `tool_input` / prompt / `transcript_path` |
| Core 落库前 | 按 schema 再丢一次未知字段，原始 hook JSON 永不落库 |
| UI 展示 | `safe_summary` 使用固定措辞，不透传 agent 原文 |
| 网络 | 默认无 cloud sync；Core 只监听 `127.0.0.1`，带 API token 校验 |
| 数据所有权 | 用户可以随时删除全部本地 pet data |

## 9. 用户体验流程

**首次启动** → 用户打开 Vibepaws → 获得一个随机 starter pet → 连接 Claude Code、Codex、pi 或 generic bridge → 设置可选 token budget → 宠物进入 `idle` 状态。

**Coding 中** → Agent 开始工作 → 宠物切换到 `working` → Agent 需要决策 → 宠物显示气泡 → 用户点击气泡或使用语音命令 → Agent 继续 → Token/context 使用量更新宠物 EXP 和 health → Session 完成 → 宠物获得 EXP，并可能获得 memory。

**Level-up** → 用户获得足够 EXP → 宠物显示 level-up 动画 → 用户可以查看 EXP explanation → 如果满足进化条件，宠物进化。

## 10. MVP 指标

| 类别 | 目标 |
| --- | --- |
| Activation | 60% alpha 用户至少连接一个 agent |
| Activation | 50% 用户至少收到一个有用通知 |
| Activation | 40% 用户设置或查看 token/context budget |
| Utility | Decision notification 在 5 秒内出现 |
| Utility | 70% decision notifications 从宠物处被处理 |
| Utility | false positive warning rate 低于 20% |
| Retention | D7 active usage 达到 25% |
| Retention | 40% retained users 查看过宠物 level 或 EXP history |
| Retention | 30% retained users 表示宠物帮助他们注意到了 agent state |

**Monetization signal**：两周 alpha 不建议收费，除非 onboarding 已经稳定。alpha 后，对至少返回 3 个 session 的用户测试 **$19 founder lifetime license**。

## 11. Non-Goals

两周 MVP **不做**：

完整 100 个高质量宠物素材 · public pet marketplace · PVP · leaderboard · rare pet selling · trading · 完整 LLM chat companion · mobile app · hardware pet · team dashboard · enterprise admin · 默认 cloud sync

## 12. 发布标准

满足以下条件时，MVP 可以发布到 alpha：

- [ ] 桌面宠物可以本地运行
- [ ] 随机 pet assignment 可用
- [ ] EXP bar 和 level-up 可用
- [ ] Decision bubble 可用
- [ ] Usage notification 可用
- [ ] Context warning 可用
- [ ] 基础 topic drift / new session recommendation 可用
- [ ] Claude Code 或 Codex adapter 可用
- [ ] Generic bridge 可用于其他 agents
- [ ] 默认不存储原始代码或 prompt text
- [ ] 用户可以 mute notifications
- [ ] 用户可以删除本地 pet data
- [ ] App 有简单 onboarding flow

## 13. 两周路线图

### Week 1：构建核心循环

| 日期 | 重点 | 交付物 |
| --- | --- | --- |
| 8/18 周二 | 锁定范围与架构：冻结 MVP 范围、最终确定 normalized event schema、定义 pet / EXP / sessions / notifications / memories 的本地数据模型、决定 desktop framework 和 local storage、创建 agent events simulator | Technical spec、Event simulator、初始 app shell |
| 8/19 周三 | 宠物表层：always-on pet window、draggable position 和 click-through toggle、七种状态、前 6 个高质量 pet sprites、支持 100 pet IDs 的 pet registry format | 宠物可以在桌面显示，并能展示模拟状态 |
| 8/20 周四 | 通知系统：notification bubble UI、decision-needed bubble、dismiss / mute / click-to-session action、本地 notification history | 宠物可以显示并处理模拟 decision notifications |
| 8/21 周五 | Usage、Context 与 EXP：token budget 设置、usage thresholds、context thresholds、带 daily token cap 的 EXP 公式、EXP explanation panel | 宠物可以基于模拟 usage 和质量信号升级 |
| 8/22 周六 | Agent Bridge：实现本地 event bridge、支持 JSON/file/socket event ingestion、将 simulator 接入 bridge、根据最快最可靠的 hook 开始 Claude Code 或 Codex adapter | 真实或接近真实的 agent events 可以更新宠物状态 |
| 8/23 周日 | 恢复日 / Buffer：修复前五天问题、如果 art pipeline 顺利则完成前 12 个 starter pets、打磨 onboarding 文案、添加 local delete/reset | internal alpha build |

### Week 2：集成、打磨与 Alpha 发布

| 日期 | 重点 | 交付物 |
| --- | --- | --- |
| 8/24 周一 | 第一个真实 adapter（Claude Code 或 Codex）；确认 decision、working、token/context 和 finish events；当 agent hooks 不完整时添加 manual fallback event trigger | 一个 agent 可以端到端工作 |
| 8/25 周二 | 第二个 adapter 或 generic integration；补齐 Codex/Claude 和 generic bridge 的 setup instructions；如果没有稳定 hooks，将 Pi Agent 和 DeepSeek Harness 先作为 generic bridge configs 准备 | 双 agent 路径，或一个真实 agent 加 generic bridge 路径 |
| 8/26 周三 | Topic Drift 与新 Session 警告：实现 session-goal 字段、添加保守 drift warning rules、添加 "open new session" recommendation、添加 mute 和 "not useful" feedback | 当 context 和 session direction 看起来不健康时，宠物可以提醒用户 |
| 8/27 周四 | 进化与自我成长：添加一个完整 evolution family、passive self-growth、tired/hibernation recovery、session finish 时的 memory earned | 宠物可以在一条路径上 level、recover、evolve |
| 8/28 周五 | STT Alpha 与安全：核心循环稳定则添加 push-to-talk prototype、支持 approve/reject/open/mute commands、对敏感命令添加 confirmation；如果 STT 不稳定，作为 hidden experimental flag 发布 | Voice command alpha，或有记录的延期决定 |
| 8/29 周六 | Alpha QA：测试 onboarding、notification latency、不存储 raw prompt/code、mute / DND / click-through / reset / delete、两种屏幕尺寸和 light/dark mode | Release candidate |
| 8/30 周日 | Private Alpha：把 build 发给 5–10 个目标用户；收集 activation、notification usefulness、annoyance、pet attachment feedback；观察 adapter setup 失败的位置 | Alpha feedback report |
| 8/31 周一 | 修复与 Cut：修复关键 onboarding 和 adapter 问题、调整 notification thresholds、调整 EXP formula、移除或隐藏不稳定 STT 路径 | MVP alpha build |
| 9/1 周二 | 发布决策：如果发布标准通过，ship alpha 给更广的 beta list；如果没通过，只为 adapter reliability 和 notification quality 延长一周 | Ship / hold decision |

## 14. 最大产品风险

| 风险 | 控制方式 |
| --- | --- |
| **Token farming** —— 用户为了升级宠物而浪费 token | daily caps、quality multipliers、outcome bonuses |
| **通知焦虑** —— warning 让 agent 使用变得紧张 | 柔和文案、mute、DND、无永久死亡 |
| **内容范围** —— 100 个宠物压垮第一版 | 先发布更少但完成度高的宠物，用架构支持 100 个 |
| **Adapter 脆弱性** —— Agent hooks 可能变化或不完整 | generic bridge 和 simulator |
| **隐私不信任** —— 用户担心宠物读取代码或 prompt | local-first architecture 和可见 data boundaries |

## 15. 实现状态（截至 2026-08-21）

发布窗口过了一半。下表是 PRD 需求对代码的对账，**不是**目标的重述。

| 需求 | 状态 | 备注 |
| --- | --- | --- |
| 7.1 桌面宠物表层 | ✅ 已实现 | Electron 透明窗口、七状态、拖拽、点击穿透、托盘、全屏 Space 之上可见 |
| 7.1 12 个 starter pets | ⚠️ 部分（5 / 12） | Embercub、Lunafang、Sporewick、Voltroc、Circuit Witch，每只 7 张状态立绘 |
| 7.1 100 pet ID 架构 | ✅ 已实现 | `ui/pets/index.json` + `pet_types` 表，含 rarity 与 evolution metadata |
| 7.1 随机分配 starter | ✅ 已实现 | Core 首启动分配 |
| 7.2 通知气泡 | ✅ 已实现 | 决策 / 权限 / context / 错误 / token 里程碑；60s 去重；每档闩锁 |
| 7.2 Mute（30m / 2h / project / session） | ✅ 已实现 | 可见徽章 + 剩余时间，可撤销 |
| 7.2 5 秒内出现 | ✅ 判定在 Core | 待 alpha QA 实测确认 |
| 7.3 Context warning 70/85/95 | ✅ 已实现 | 默认阈值在 `src/core/settings.ts`；可在设置窗口里调整或关闭 |
| 7.3 Token budget 里程碑 25/50/75/90 | ✅ 已实现 | 引擎、per-session budget 字段，以及设置窗口（全局默认 + 按 session 覆盖）|
| 7.3 Topic drift 警告 | ⚠️ 部分 | 事件类型、通知路径与 session goal 的录入口（设置窗口）已通；保守启发式规则待补齐（原计划 8/26） |
| 7.4 EXP 引擎 | ✅ 已实现 | 1 EXP/1k tokens、daily cap 200（设置里可调）、context/topic 倍率、等级曲线 100+50(n−1) |
| 7.4 Tired 状态 / 无永久死亡 | ✅ 已实现 | 状态机含 `tired` |
| 7.4 EXP explanation | ✅ 已实现 | 浮层内 EXP 明细 |
| 7.5 进化 | ⚠️ 部分 | `evolution_meta` 规则引擎已通（Lv5/Lv10 + health 条件）；**进化形态素材未做** |
| 7.6 STT 语音命令 | ❌ 未开始 | P1，按计划排在核心循环之后（8/28） |
| 7.7 Claude Code adapter | ✅ 已实现 | hooks + statusLine 实时 token 通道 |
| 7.7 Codex adapter | ✅ 已实现 | `.codex/hooks.json`，首次需 `/hooks` 授权 |
| 7.7 pi adapter | ✅ 已实现 | extension 插件（P1 提前到 P0）+ 手动兜底发射器 |
| 7.7 Generic bridge | ✅ 已实现 | JSONL 目录监听，兼作 Core 离线兜底 |
| 7.7 Simulator | ✅ 已实现 | 5 个场景，覆盖全部核心事件 |
| 8 隐私双闸 | ✅ 已实现 | adapter 白名单 + Core schema 丢弃，`src/core/privacy.test.ts` 验收 |
| 9 Onboarding flow | ⚠️ 部分 | 安装器有自检与提示；无图形化首启动向导 |
| 12 删除本地 pet data | ⚠️ 部分 | 删 `.vibepaws/` 即可；无界面按钮 |

**当前主要缺口**（决定 9/1 ship / hold 的三件事）：

1. **宠物数量** 5 / 12 —— 素材 pipeline 已通（image-to-image 逐状态生成），是产能问题不是技术问题
2. **Budget 与 drift 的用户可见面** —— 引擎在，入口不在，指标里两条 Activation 目标依赖它
3. **进化形态素材** —— 规则引擎已经会触发，但触发后没有新形态可换

## 16. 社区与游戏经济路线（Post-MVP）

社区很重要，但不是 MVP 核心。

- **MVP** —— 本地 pet assignment、本地 pet profile、milestone 后可导出的 pet card
- **Post-MVP** —— 社区 pet submission form、有审核的 pet gallery、skin packs、public profile pages
- **后续** —— leaderboard、PVP、rare pet selling、trading、seasonal events

> ⚠️ marketplace、leaderboard、PVP 和稀有宠物售卖会带来防作弊、IP、审核和信任问题。**不要在 retention 和 daily usage 被验证前加入这些功能。**

## 17. 最终建议

两周 alpha 应发布：

一个高完成度 desktop pet loop · 5–12 个 starter pets（而不是 100 个）· 支持 100-pet registry 的架构 · decision bubbles · usage/context/topic warnings · EXP bar 和 level-up · healthy-session multipliers · 无永久死亡 · 一个 evolution family · Claude Code + Codex + pi adapter · 用于其他 agents 的 generic bridge · 只有在核心循环稳定时，才把 STT 作为 P1 alpha。

两周后的下一次决策，应基于 **retention 和 notification usefulness**，而不是宠物数量。
