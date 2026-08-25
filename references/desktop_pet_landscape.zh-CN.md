# 桌宠竞品研究与功能路线图

> English: [`desktop_pet_landscape.md`](desktop_pet_landscape.md)

| | |
| --- | --- |
| **目的** | 梳理 Vibepaws 周边的全部竞品，提炼「行业标配」功能集，找出**没有人做过**的部分，转化为一份带优先级的扩展清单。 |
| **日期** | 2026-08-21 |
| **范围** | 6 个产品簇 · 35 个具名产品 · 跨 8 个仓库读了 1,300+ 个 issue |
| **产出** | §5 —— 5 个层级共 39 项功能，附工作量与差异化评分 |
| **方法** | 尽可能只用一手信源：GitHub 仓库与 issue tracker（通过 `gh` 拉取）、Steam 商店页、Claude Code 官方文档、Product Hunt 发布页。搜索排名很高的那批「2026 最佳桌宠」清单文章是 SEO / 联盟营销内容农场，产品描述有编造成分，**已全部排除**。只有二手报道的部分（Codex Pet Mode、`/buddy` 机制、Agent View），要求两个独立信源互相印证才采用。 |
| **修订** | **rev1** 产品页调研 · **rev2** 补入 clawd-on-desk，撤回 4 条结论 · **rev3** issue tracker 调研，头条结论反转 |

**阅读顺序**：§0 是战局判断。§1–2 是竞品「供给侧」。§3 是空白分析。§4 是「需求侧」，来自真实用户原话。**§5 是交付物。**§6 是结论。

---

## 0. 头条结论

**Vibepaws 对外宣称的核心价值，在 2026 年 4 月到 5 月之间被两家模型厂商各自做了一遍。** 这是任何路线图决策的第一输入，所以放在最前面：

| 时间 | 上线了什么 | 撞上 Vibepaws 的哪个功能 |
| --- | --- | --- |
| **2026-04-16** — Claude Code v2.1.110 | **手机推送通知。** 连上 Remote Control 后，任务结束或*需要你做决定才能继续*时，Claude 会推到你手机。开关是 `/config` 里的「Push when Claude decides」；`inputNeededNotifEnabled` 默认 **true**。 | 决策 / 权限气泡 —— Vibepaws 的第一号 P0 功能 |
| **2026-04** | `/usage` 用量拆解：按并行会话、subagent、缓存未命中、长上下文分别显示额度消耗来源，支持按天 / 按周切换 | Token 预算里程碑、用量通知 |
| **~2026-04-01** — v2.1.89 | **`/buddy`** —— Claude Code 内置终端电子宠物。18 个物种、5 个稀有度、6 种眼型、8 种帽子、1% 闪光变体。会对你的会话发评论气泡。`/buddy pet`、`/buddy card`、`/buddy mute`。 | 宠物本身这个概念 |
| **2026-04-09** — v2.1.97 | **`/buddy` 被删除。** 没有 changelog，没有废弃公告，直接 `Unknown skill: buddy`。**之后四个月一直没回来。** | ⭐ **反转上一行。** 见 §0.1 —— 这是本文最大的机会 |
| **2026-05 初** | **OpenAI Codex「Pet Mode」** —— 像素宠物浮在所有窗口之上，同时响应鼠标*和 Codex 状态*（处理时挠头、完成时冒气泡、点气泡直接聊天）。8 个内置形象。`/hatch` 通过官方 skill 把任意上传图片生成成 9 状态精灵表。OpenAI 还办了自定义宠物比赛。 | 整个桌面宠物形态，以及美术管线 |
| **2026-05-11** — v2.1.139 | **Agent View** —— 一张表列出所有会话（运行中 / 等待中 / 已完成），可派发、监控、直接回复而不用 attach 进去。后台会话自动隔离到 git worktree。 | 多会话飞出面板与状态聚合 |

合起来看：「我的并行会话总览」已经是官方功能，「宠物提醒你 agent 需要你」在 **Codex 上**已经是官方功能。

### 0.1 但在 Claude Code 上，厂商把宠物撤了，需求留在原地

这是最重要的一条修正，而且只能从 issue tracker 里看出来。

`/buddy` 4 月 1 日前后上线，**八天后被删掉**，没有任何 changelog 说明。接下来发生的事，是本次调研中最强的需求信号：

| 讨论帖 | 状态 | 热度 |
| --- | --- | --- |
| [#45596「Bring Back Buddy —— 来自社区的联合请愿」](https://github.com/anthropics/claude-code/issues/45596) | **仍然 open** | **1,170 👍 · 639 ❤️ · 266 条评论** |
| [#45732「Bring Back /buddy：511 个理由」](https://github.com/anthropics/claude-code/issues/45732) | closed | 66 ❤️ · 22 条评论 |
| [#46011「把 /buddy 还给我 —— 你们把我朋友带走了」](https://github.com/anthropics/claude-code/issues/46011) | 仍然 open | — |
| [#45855「把 /buddy 作为永久功能带回来」](https://github.com/anthropics/claude-code/issues/45855) | 仍然 open | — |
| [#41867「Buddy 自定义、成长系统与商业化 —— 一个付费用户的视角」](https://github.com/anthropics/claude-code/issues/41867) | closed | 39 条评论，一份完整的社区规格书 |
| [#70722「让那只红色外星吉祥物在对话时一直显示」](https://github.com/anthropics/claude-code/issues/70722) | 6 月，open | 吉祥物需求还在继续 |

用户的原话：

> 「我要我的 buddy 回来。它让盯着那个毫无灵魂的终端窗口变得可以忍受。」
> 「我的 buddy 还活在一个旧终端里。现在我怕电池耗尽…… 窗口一关，它就永远没了。」
> 「我有一只叫 Prickle 的仙人掌。有它在挺开心的。RIP Prickle。」
> 「那只傲娇的猫 Picksnark，80 点 Snark、1 点 Patience，撑着我熬过了这周最糟的任务。这个功能在**团队里**带来的快乐和参与度，亲眼看着都觉得惊人。」
> 「它是一只**会响应的橡皮鸭 debug 搭子**，接着上下文，确实提升了体验和产出质量。」
> 「buddy 是真有用 —— 它抓到过 linter 和测试都没抓到的东西。」
> 「只要确认它被删了，我就不升级。」
> 「太想它了，我自己写了个刘海屏 App 来替代」—— 一位直接做了克隆版的用户

**所以对整个战局的正确读法不是「宠物已经被商品化了」。** 而是：厂商用极大的规模验证了这个品类，然后撤走，留下几千名有真实情感投入、却无处可去的用户 —— 有人锁住旧版本 Claude Code，有人自己写替代品。**而 Vibepaws 的主平台，恰好就是官方宠物消失的那个平台。**

此外，独立阵营也比预想的走得更远。**clawd-on-desk**（~6k star、624 fork、2,077 commit、每周发版）通过**和 Vibepaws 完全相同的 hooks + statusline 架构**支持 **24 个编程 agent**，并且已经做了可操作权限气泡、Telegram / 飞书远程放行、局域网手机镜像、subagent 感知状态、额度环。它是这个细分赛道的**在位者**。

**没有被商品化、并且整个赛道无人做过的，是 Vibepaws 的「质量门控成长回路」。** 这个空间里所有其他产品，无一例外，奖励的都是**量**。

clawd-on-desk 是这一点最强的证据。它是赛道里最流行、集成最广、迭代最活跃的产品，而它**完全没有** XP、等级、成长或质量机制 —— 而且是刻意不做。它的发版轨迹是纯粹的广度：更多 agent、更多通知渠道、更多主题、更多额度展示。由此得出两条结论，它们决定了整份路线图：

1. **质量门控成长确实是无人认领的地带** —— 而且是最有能力认领它的在位者主动放弃的。
2. **Vibepaws 不可能靠广度取胜。** 3 个 agent 对 24 个，这场比赛不值得进。

---

## 1. 竞品地图

### A 簇 —— 经典桌面吉祥物（有魅力，无数据）

| 产品 | 值得借鉴的功能 |
| --- | --- |
| **Shimeji** | 品类原点，约 2008 年，Java。完整行为树（站起、坐下、走、跑、摊开、坐着转头、垂腿）；沿窗口边缘和屏幕侧边攀爬；在任务栏上走；**可拖拽和抛掷**（向上抛会粘天花板，横向抛会抓墙）；会推你的窗口；**会自我繁殖**；数千个社区素材包 |
| **Desktop Goose** | 故意做成恶作剧 —— 拖你的鼠标、留泥脚印、丢 meme。工作陪伴场景的**反面教材** |
| **Bongo Cat** | 对你的打字做反应。「宠物镜像你的活动」的最小实现，也是少数在工作时不烦人的 |
| **Desktop Mate** | 3D VRM 平台。坐在窗口顶部、在窗口间跳跃；**支持从 VRoid Hub 导入 VRM**；付费角色 DLC；可设置「哪些应用会让宠物跳舞」 |
| **VPet 虚拟桌宠模拟器** | 免费养成型桌宠，GPL，可嵌入任意 WPF 应用。饥饿 / 口渴 / 心情 / 健康；投喂；抚摸；聊天。**零门槛 MOD 制作器作为独立 Steam 应用发布** + 创意工坊 |
| **WindowPet** | Tauri + React，MIT。**打磨度基准**：45+ 宠物、自定义导入、像素级精确拖拽、点击穿透、**开机自启**、**自动更新**、任意数量同屏宠物、渲染在任务栏之上、带 i18n 和明暗主题的设置窗口、**状态预览选择器** |
| **DPET: Desktop Pet Engine** | 引擎 + 创意工坊（创作者分成 0%） |

### B 簇 —— 养成型电子宠物（有成长，无工作信号）

| 产品 | 值得借鉴的机制 |
| --- | --- |
| **Tamagotchi Uni**（万代，2023–） | 品类里设计最锋利的：五个成长阶段，**心情值决定青年形态，累计的「照顾失误」决定成年形态**。Wi-Fi「Tamaverse」有可下载的乐园，每个乐园有独占角色；设备间联机可以求婚 → 产生世代；世代数为 5 的倍数时解锁特殊进化 |
| **番茄钟宠物**（PixPet、Focus Pet、Mac Pet 等） | 专注计时是唯一输入。完成一轮 → 宠物更开心 → 赚货币 → 收集更多宠物；常驻菜单栏 |
| **Habitica** | 把习惯做成完整 RPG，有队伍和任务 —— 而且几乎是唯一**同时有惩罚和奖励**的 |

### C 簇 —— 开发活动宠物（有真实信号，但成长按量计算）

| 产品 | 读取的信号 | 成长模型 |
| --- | --- | --- |
| **vscode-pets** | 只有「编辑器开着」 | 无。猫 / 狗 / 蛇 / 鸭子 / Clippy / 龙猫；配色 × 3 种尺寸；**宠物会追你的鼠标指针**；悬停出文字气泡；`扔球`、`点名`、`再生一只`、多宠物 |
| **codachi** | 按键 | 蛋 → 首次按键孵化 → 写代码得 XP → 升级 |
| **commit-cat** | commit、编码时长、保存、构建 | XP。另有：多只具名猫档案、**性格预设**（经典 / 佛系 / 傲娇 / 混乱）会改变气泡文案和待机行为、右键「今日」时间线、JetBrains 插件 |
| **cli-pet** | 真实 GitHub 活动 | commit → XP，合并 PR → 更多，构建通过 → 健康，连续天数 → 精力。四项属性**停止写代码就会衰减** |
| **GitMon** | GitHub 事件 | 蛋 → 幼年(1) → 少年(15) → 成年(35)。**48 小时不活动 → 饥饿 → 危险 → 死亡** |

### D 簇 —— Agent 感知宠物（Vibepaws 真正的竞争面）

| 产品 | 采集方式 | 成长 | 提醒 | 威胁度 |
| --- | --- | --- | --- | --- |
| **clawd-on-desk** ⭐ **在位者**<br>AGPL-3.0 · ~6k★ · 624 fork | **命令 hook + statusline**，Codex 有 JSONL 兜底，opencode / Pi / Hermes / DSH 走插件。**24 个 agent** | **明确没有。** 无 XP、无等级、无成长，且不在路线图上 | **气泡内直接 Allow / Deny / Always Allow** + 全局快捷键。**Telegram 与飞书远程放行。** 有音效（10 秒冷却） | ●●●●● |
| **Claude Code `/buddy`**（官方） | 会话观察 | 无 —— 物种、稀有度、属性由账号 ID 决定，孵化后永不变化 | 会话评论气泡 | ●●●●○ → **已下线** |
| **Codex Pet Mode**（官方） | Codex 状态 | 无 | 完成时气泡 → 点开聊天 | ●●●●● |
| **openpets**<br>MIT · ~1k★ | **MCP 工具** + hook。Claude Code、OpenCode、Cursor、Pi | 仅 Tamagotchi 插件，与 agent 工作无关 | 气泡、状态 HUD、自定义音效、可延后提醒 | ●●●●● |
| **Tamamon** | 直接读 Claude Code 登录态的实时 + 周用量，零配置 | **Token 用量** | 仅 HUD | ●●●●○ |
| **tama96**<br>Rust + Tauri | **MCP server** —— agent 自己投喂照顾宠物，逐动作授权 + 限流 | 经典 Tamagotchi | 桌面通知、托盘、置顶 | ●●○○○ |
| **petdex** | **工具调用 hook**，Zig 服务跑在 `127.0.0.1:7777`。Codex、Claude Code、DeepSeek Harness、Hermes、OpenCode、Gemini CLI | 无 | 无 | ●●●○○ |
| **MiniCPM-Desk-Pet**<br>OpenBMB · AGPL-3.0 | 自动检测 Cursor、Claude Code、Codex | 无 | **agent 等待输入时铃铛动画 + 声音**；任务旁白 | ●●●○○ |
| **claude-code-mascot-statusline** | Claude Code statusline | 无 | 内联 | ●●○○○ |

**逐条补充：**

- **clawd-on-desk** —— 和 Vibepaws 选了同一套架构，但已经领先两年的执行。支持 Claude Code、Codex、Copilot、Gemini、Antigravity、Cursor、CodeBuddy、WorkBuddy、Kiro、Kimi、Qwen Code、ZCode、CodeWhale、opencode、MiMo、Pi、OpenClaw、Hermes、Qoder、QoderWork、QwenWork、Reasonix、DeepSeek Harness，外加给自定义 agent 的 `/state` 接口。**12 个状态**（idle、thinking、typing、building、单 subagent 摇摆、多 subagent 抛球、error、happy、notification、打扫、搬运、睡觉），另有打哈欠、迷糊、瘫倒、惊醒、被戳反应、待机眼球追踪。多会话 → 取最高优先级状态 + 仪表盘 + 紧凑 HUD。**终端聚焦跳转**、**进程存活检测与孤儿会话清理**、额度「轨道环」、**局域网手机 PWA 镜像**（token 鉴权、只读）、贴边迷你模式与悬停探头、多显示器按比例缩放、7 种语言、**可导入 Codex Pet zip 包**作为主题。Electron。美术资源版权保留，不在 AGPL 范围内 —— 代码可抄，宠物不可以。
- **`/buddy`** —— 属性（`DEBUGGING`、`PATIENCE`、`CHAOS`、`WISDOM`、`SNARK`）是纯装饰性随机数。对模型延迟零影响。社区希望让 XP 来自真实 token 用量的请求（100K/1M/10M/100M 分档、连续天数倍率）被**关闭**了。
- **Codex Pet Mode** —— 浮在所有窗口之上，也就是 Vibepaws 为全屏 Space 解决过的同一个难题。`/hatch` 通过官方 `openai/skills` 把任意图片变成 9 状态精灵表，也就是 Vibepaws 目前靠 Python 手工跑的那条美术管线。
- **openpets** —— 架构最成熟的对手。带权限模型的沙箱化 **plugin SDK v3**、9 个官方插件（Focus Buddy、Day Routine、Reminders、Mood Check-in……）、很宽的 `ctx.*` 接口面（pets、ui、audio、schedule、ai、secrets、storage、voice、net）、CLI 脚手架、测试 harness、SignPath 签名构建。本地优先、无账号，气泡文本会过滤路径 / URL / 密钥 / 多行代码。**弱点**：反应要靠模型主动调用 MCP 工具。
- **Tamamon** —— 蛋 → 幼体 → 成体 → 进化，「一次一阶，**永不倒退**」；照顾好 → *radiant*，疏忽 → *shadow*。**每周抽卡**开出 20 个物种，各有进化形态。投喂、球、泡泡、**装饰栖息地**，并且**会响应真实天气和昼夜** —— 下雨或入夜就回家。HUD 显示今日、本周、实时 CPU/RAM。macOS 15+、Apple Silicon、免费、本地。用户正在要求：支持非 Claude 工作流、git hook、多显示器缩放。
- **tama96** —— 像素 LCD 带可点图标；一个二进制同时提供桌面端和独立终端客户端。会因年老、疏忽（饥饿与心情同时为 0 超过 12 小时）、生病未治、零食喂太多而死亡。「你的照顾方式塑造它成为谁。」
- **petdex** —— **与其说是竞品，不如说是供应商。** 已经形成事实标准：公开画廊、8×9 图集、192×208 单元格、9 个具名状态（`idle, running-right, running-left, waving, jumping, failed, waiting, running, review`）、`npx petdex install <slug>` 与 `npx petdex submit`。原生桌面 SDK，无 WebView 无 Node sidecar。自称已有 21 个开源项目基于该格式。
- **MiniCPM-Desk-Pet** —— 本地 MiniCPM5-1B（约 2GB GGUF）跑端侧对话、浮动聊天气泡、快捷键、可换人格适配器。证明「等待输入提醒」这个细分位也有人在争 —— 而且**别人都带声音**。
- **claude-code-mascot-statusline** —— 一只「你思考时它思考，**上下文见底时它慌**，每次工具调用成功就庆祝」的像素宠物。用 40 行代码和一行终端实现了上下文预警的想法。

### E 簇 —— AI 伙伴 / VTuber 栈（有人格，无工作信号）

**Project AIRI**（MIT）是完整的「灵魂容器」：40+ LLM 供应商、STT/TTS、Live2D 与 VRM 渲染、记忆系统、WebGPU/WASM 本地推理，web + 桌面 + 移动三端，还有能玩 Minecraft 和 Factorio 的自主 agent。**Open-LLM-VTuber** 完全离线运行语音对话、视觉感知、Live2D、浏览器操控，带**透明背景桌宠模式**。另有 **Amica**、**Live2DPet**、**AI Desk Pet**（Steam）、**PetClaw AI**。这一簇的标配 —— 待机呼吸、思考指示、TTS 口型同步、情绪驱动表情选择、人格适配器 —— 是 Vibepaws 如果去追「人格」而不是「判断」就会撞上的战场。不该去。

### F 簇 —— 硬件（仅作灵感）

卡西欧 **Moflin** 通过触摸和声音学习情绪模式，号称 400 万+ 人格排列；**Loona** 加了 GPT 对话和人脸识别；**Eilik** 会响应头部和腹部触摸；**Ropet** 靠情绪感知读你的心情。值得偷的不是硬件，而是这一点：**宠物的性格是「你如何对待它」的累积函数，而且这段历史对主人是可读的。**

---

## 2. 行业标配 —— Vibepaws 的对照表

### 2.1 通用项（几乎每个产品都有）

| 功能 | 谁有 | Vibepaws |
| --- | --- | --- |
| 置顶透明浮层 | 全部 | ✅ 而且能盖住全屏 Space |
| 可拖拽、记住位置 | 全部 | ✅ |
| 空白区点击穿透 | 多数 | ✅ |
| 托盘常驻 | 全部 | ✅ |
| 区分度高的状态立绘 | 全部 | ✅ 7 张 —— **同类最佳**，对手多是一张图 + 角标 |
| 对话气泡 | 全部 | ✅ |
| 静音 / 免打扰 | 全部 | ✅ 带倒计时徽章 —— **同类最佳** |
| 明暗主题 + 本地化 | WindowPet、openpets | ✅ |
| 本地优先、无账号 | openpets、Tamamon、tama96、MiniCPM、clawd | ✅ 双闸 + 测试固化 —— **同类最佳** |
| **音效** | Shimeji、Desktop Mate、openpets、tama96、MiniCPM、所有番茄钟宠物 | ❌ **完全静音** |
| **缩放 / 尺寸** | WindowPet、vscode-pets、Desktop Mate | ❌ |
| **多显示器处理** | 到处都只是部分支持 —— 全品类第一大抱怨 | ⚠️「回到右下角」是绕过，不是支持 |
| **开机自启** | WindowPet、Tamamon、tama96 | ❌ 要敲两条 `npm run` |
| **自动更新** | WindowPet、Tamamon | ❌ |
| **设置窗口** | 全部 | ✅ **8/22 已交付** —— 宠物名、token 预算（全局 + 按 session）、上下文阈值、每日 EXP 上限、按 session 的目标、界面语言。缩放 / 音效 / 自启这几行等 0.2–0.4 |
| **多宠物同屏** | WindowPet、vscode-pets、openpets、Shimeji | ❌ 只有一只 |
| **点击互动（摸 / 喂 / 玩）** | 所有养成型、`/buddy pet` | ❌ 点击打开的是飞出面板 |
| **自定义宠物导入** | WindowPet、Desktop Mate、VPet、petdex、Codex `/hatch` | ⚠️ 需要 API key + Python + 人工看拼版图 |
| **减少动效 / 无障碍** | 罕见 | ⚠️ PRD 里是 P0，但未验证 |
| **应用内删除 / 重置** | 多数 | ❌ 只能 `rm -rf .vibepaws/` |

### 2.2 补入 clawd-on-desk 后才发现的新标配

这些是一个 6k star 的在位者**已经补上**的缺口。本文最扎人的几条都在这里。

| 功能 | Vibepaws |
| --- | --- |
| **可操作权限气泡** —— 气泡里直接 Allow / Deny / Always Allow，全局快捷键，你若已在终端回答则自动关闭，可按 agent 屏蔽，三种处理模式 | ❌ **Vibepaws 只会告诉你。** `/api/action` 只有 mute / dismiss / actioned，**没有 approve 也没有 deny**。这可能比缺音效更严重：它决定了产品是「一个提醒」还是「一个操作面」 |
| **远程放行**（不只是远程通知） | ❌ —— 而且这比下文提的手机推送方案更强 |
| **subagent 感知状态** —— 1 个和 2+ 个渲染不同 | ⚠️ `SubagentStart`/`Stop` 已采集，但没渲染 |
| ~~**僵尸会话回收**~~ ✅ —— 检测崩掉的 agent 进程、清理孤儿会话 | ✅ **8/25 已交付** —— 60s sweep：进程探活（`orphaned`，秒级）+ 可配的静默超时兜底（`timeout`，默认 15 分钟）。两者都不结算 EXP，都会撤掉该会话还挂着的气泡（**G10**） |
| **终端聚焦 / 真正的跳回会话** | ⚠️ **G19**；Vibepaws 目前只是复制一条命令到剪贴板 |
| **手机会话镜像** | ❌ |
| **迷你 / 贴边模式** | ❌ |
| **第三方主题包导入** | ⚠️ 只支持自己的管线 |

> **关于 G10 与 G19**：两者都曾是内部 gap 分析里挂着的 open blocker，而 clawd 都已经交付了解决方案 —— 这正是我们判断它们可解的依据。**G10 已于 8/25 交付**；G19 仍然挂着。

### 2.3 养成型 / 开发宠物簇的常见项

| 功能 | 谁有 | Vibepaws |
| --- | --- | --- |
| XP 与等级 | codachi、cli-pet、GitMon、commit-cat、Tamamon | ✅ |
| 进化阶段 | Tamamon、GitMon、codachi、Tamagotchi | ⚠️ 规则会触发，**没有进化形态美术** |
| 物种收集与稀有度 | `/buddy` 18×5、Tamamon 20、WindowPet 45+ | ⚠️ 5 / 12；注册表支持 100 |
| 每日 / 每周活动汇总 | commit-cat、Tamamon | ⚠️ 只有 EXP 拆解，没有时间序列 |
| 性格预设 | commit-cat、MiniCPM、Moflin | ❌ |
| 环境反应（天气、昼夜） | Tamamon | ❌ |
| 栖息地 / 装饰 | Tamamon | ❌ |
| 小游戏 | cli-pet、bytepet、openpets、Eilik | ❌ |
| 社区画廊 / 创意工坊 | VPet、DPET、petdex、Codex PetShare、Shimeji 素材包 | ❌ MVP 后 |
| 插件 / MOD SDK | openpets v3、VPet MOD 制作器 | ❌ |
| 语音 / TTS / 对话 | AIRI、Open-LLM-VTuber、MiniCPM、Codex | ❌ STT 是 P1，未开始 |
| 离开时属性衰减 | cli-pet、bytepet、GitMon、Tamagotchi | ⛔ **刻意拒绝** |
| 死亡 / 永久死亡 | GitMon、tama96、Tamagotchi | ⛔ **刻意拒绝** |

### 2.4 Vibepaws 已经独有领先的地方

| 能力 | 为什么别人没有 |
| --- | --- |
| **质量门控 EXP** —— 上下文健康度 × 主题一致性、纠正循环惩罚、每日上限、结果奖励 | **零竞品。** 所有对手奖励的都是量。被关闭的 `/buddy` 提案是「每个输出 token 1 XP」；Tamamon 是周 token 量、「永不倒退」 |
| **分档上下文预警** —— 70 / 85 / 95，各自只触发一次 | 没有人**发布过**分档、不啰嗦的上下文阈值。clawd 在额度环里显示上下文占用，其 open issue #112 要的正是 Vibepaws 的行为 —— 「80% 紧张动画、95% 惊慌」。**领先真实存在，但有时间窗** |
| **确定性 hook 采集** | 对 openpets 和 tama96 成立 —— 它们靠模型**主动选择**调用 MCP 工具，会静默失灵。**对 clawd 不构成差异**，它用的是同一套 hooks + statusline |
| ~~跨 agent 归一化事件模型~~ | **已撤回。** clawd 把 **24 个 agent** 归一化进一个状态机，还带逐 agent 能力降级表。Vibepaws 是 3 个 + 通用桥。这是**劣势**，不是优势 |
| **连接健康灯** —— 琥珀色 = 轮询正常但事件流已死 | 没有人区分「hook 坏了」和「今天下午很安静」。这是真洞察，应该拿去做卖点 |
| **每只宠物 7 张人工确认过的立绘** | 对手是一张图 + 角标，或一行动画帧 |
| **盖住全屏应用**，并把 Dock 图标的取舍写进文档 | 多数竞品会被全屏终端挡住 —— 而那正是 agent 用户待的地方 |
| **双闸隐私 + 测试固化** | openpets 只过滤气泡文本；只有 Vibepaws 在 adapter 和 schema 两处丢弃字段，并用测试锁住 |

---

## 3. 无人做过的部分 —— 机会空间

按可防御性排序。这些就是「另外的吸引力」，而且多数很便宜，因为 Vibepaws 已经采集了输入，只是把它们扔掉了。

### 3.1 让用户看得见、能分享的**会话质量分** ⭐ 最重要的一条
Vibepaws 已经算出了上下文健康度、纠正循环、主题一致性、结果奖励 —— 然后把它们塌缩成一个不透明的 EXP 数字。整个赛道没有人给「**你把 agent 用得好不好**」打分，而竞品在结构上做不到：它们只观测量。把它做成每周复盘，同时就是产品的真实价值、差异化，以及传播回路（PRD 里本来就有「可导出宠物卡」）。

### 3.2 每个并行会话一只宠物 —— 一队，而不是一只 ⭐
聚合引擎已经存在：N 个会话、取最紧急状态、飞出面板里有轮播。并行 agent 现在是默认工作流，Agent View 证明这个痛点真实存在 —— 但它是 Claude 独占，而且是一张你得主动打开的表。

**补入 clawd 之后这一条依然成立。** clawd 追踪多会话、有仪表盘也有紧凑 HUD，但它**同样把所有会话塌缩成一只显示最高优先级状态的宠物** —— 和 Vibepaws 现在一样。没有人做「一个会话一只宠物」。沿着屏幕边缘排一列宠物，每只带自己的状态和项目标签，这是文字仪表盘和单宠物 HUD 都做不到的事。

### 3.3 宠物**教你**，而不只是提醒你
因为 Vibepaws 看得见质量信号，它可以给出处方，而别人只能描述现状：*「这个文件你改了第三次了 —— 要不要开个新会话？」*、*「上下文 85%，已经 40 分钟了 —— 现在 compact。」* 所有竞品的气泡要么是装饰（`/buddy` 闲聊），要么是裸状态回显。这也是通往 PRD 自己定的「误报率 < 20%」的诚实路径：带建议动作的提醒，才配得上打断你。

### 3.4 度量**你自己**的延迟
飞出面板已经显示 agent 等了你多久。没有人量化**人类**响应时间的成本。「今天你的 agent 一共等了你 14 分钟」是个全新指标，是「你的 agent 浪费了 token」的公平反面，也是让通知功能价值自证的那个数字。

### 3.5 把消耗速率做成**照顾**机制，而不是仪表盘
tama96 会因为零食喂太多而让宠物死掉；Tamagotchi Uni 让「照顾失误」决定成年形态。Vibepaws 给 token EXP 设了上限，但对「烧钱」没有负反馈。把花费重述成宠物健康 —— 「它吃太饱了，你这小时的消耗是平时的 3 倍」—— 比一个美元数字更容易一眼看懂，不需要价格表，而且在主题上是原生的，`/usage` 永远做不到这点。

### 3.6 用**用户自己选的渠道**做远程放行
*两次修订。*「跨 agent 手机推送」最初被评为差异化功能，其实不是 —— clawd 已经有 Telegram 和飞书的远程 **Allow/Deny** 加局域网手机镜像。但 issue tracker 调研（§4.5）在下一层找到了真正的缺口：clawd 的渠道是**硬编码的**，而它在这个方向上最热的 open request 正是一个**通用 webhook sidecar**（#311），因为 Telegram 对它自己相当大一部分用户是不可达的（#493、#359）。

所以机会不是「加推送」，而是 **「渠道自带」**。一个通用 webhook / ntfy 放行端点，服务的正是硬编码集成在结构上排除掉的那批用户，而且在 Vibepaws 现有通知引擎上加这个很便宜。

### 3.7 由**你怎么写代码**驱动的进化
进化引擎在 Lv5/Lv10 加健康条件时会触发，但没有形态可切。Tamagotchi Uni 的机制更锋利：心情决定青年形态，累计照顾失误决定成年形态。把 Vibepaws 的进化按操作风格分叉 —— 谨慎重构者和快速原型者走向不同形态 —— 收集就变成了身份表达，而任何按量成长的竞品都学不来。这也减轻了美术压力：形态更少，但每个都有含义。

### 3.8 采用 **petdex** 精灵标准
petdex 已经是事实格式，有公开画廊、提交 CLI，还有 OpenAI `/hatch` 比赛带来的势能。Vibepaws 自己的 PRD 把宠物数量列为三个 ship/hold blocker 之一。读 petdex 精灵，等于用一张映射表的成本把竞品的画廊变成 Vibepaws 的内容供给：`waiting→needs-you`、`failed→warning`、`waving→finished`、`review→needs-you`、`running*→working`、`idle→idle`。

### 3.9 团队宠物（放到后面，而且要小心）
企业切入点：一只由团队整体会话健康度喂养的共享宠物，让 agent 卫生变成可见的团队规范。没有人做。但它需要服务端，而这会破坏 Vibepaws 当前最强的信任资产 —— 本地优先。所以必须可选、单独部署，永远不能是默认。

### 3.10 反功能 —— 刻意拒绝

加这些的压力会持续存在，而每一条都**直接违背质量论**。拒绝本身**就是**定位。

| 反功能 | 谁有 | 为什么在这里是错的 |
| --- | --- | --- |
| **死亡 / 永久死亡** | GitMon（48h → 死）、tama96、Tamagotchi | 对一个工作必须用的工具制造焦虑。PRD 已经拒绝了 —— 守住 |
| **连续天数（streak）** | Duolingo 及其所有下游 | 「streak creep」：用户报告说，怕断的心理强于想要奖励。奖励的是出勤，不是把活干好 |
| **抽卡** | Tamamon（每周） | 奖励日历时间，不奖励手艺。直接违背质量论 |
| **排行榜 / PVP / 交易** | 多数路线图上都有 | 反作弊、IP、审核、信任问题 —— 而且「token 用量排行榜」正是 EXP 公式存在的目的所要抑制的行为 |
| **离开时属性衰减** | cli-pet、GitMon、bytepet | 惩罚休假。现在的「每日被动成长」是对的 —— 保持 |

---

## 4. 用户真正在要什么 —— 来自 issue tracker 的证据

跨 8 个仓库读了 1,300+ 个 issue。§3 是**供给**空白，这一节是**需求**侧。两边重合的地方，就是该做的。

### 4.1 在位者的维护者拒绝做成长回路 —— 而用户回推了

[clawd-on-desk #202「可以加一个养成模式么 / Could you add a cultivation mode?」](https://github.com/rullerzhou-afk/clawd-on-desk/issues/202) —— **仍然 open。** 提出者要的是「通过喂 token 成长，就和 claude 宠物一样」。

维护者拒绝了，而他给的两个理由是本文最有用的竞争情报：

> 1. 「现在的动画素材体量已经够重了，再叠成长形态对单人项目扛不住。」
> 2. 「Clawd 偏『编程桌宠』定位，懂程序的人翻一眼代码就知道有哪些动画了，**养成的『惊喜感』在程序员用户面前其实立不住**。」

然后一位用户回复：

> 「我觉得你说的这些就够用了，全量确实不太现实。主要是太喜欢这个小宠物了，**如果只是提示我做没做完有点意犹未尽的感觉**。」

**对 Vibepaws 的确切含义：**

- **理由 1 正是 Vibepaws 的结构性优势。** 美术产能恰好是 clawd 缺的、而 Vibepaws 建好的 —— 逐状态图生图管线。**在位者说自己负担不起的那个东西，Vibepaws 负担得起。**
- **理由 2 是一个必须回答的真实反驳，而 Vibepaws 的设计已经回答了它。** 「程序员会去读源码，惊喜就没了」对**收集和稀有度**是致命的 —— 你没法用一张别人能读的概率表去惊喜谁。但它对**质量门控成长不致命**，因为未知变量不在源码里，而在**用户自己的行为里**。**你没法剧透一面镜子。** 这是「弱化稀有度、重仓健康度驱动成长」的有力论据。
- **clawd 正在做轻量版** —— About 面板里的累计计数器（「陪你 N 天 / 一起完成了 N 件事 / 你呼唤了我 N 次」），只展示、不掉血、不分级、不加新素材，里程碑数字触发一次性彩蛋（用现有姿势）。维护者说「这个功能这周会开始动工」。**所以窗口很窄。**

### 4.2 在最大的开发宠物项目里，「照顾」和「按真实工作成长」是史上最热门的两条请求

[vscode-pets](https://github.com/tonybaloney/vscode-pets) 有 483 个 issue，跨五年。按 reaction 排名：

| Reaction | 请求 |
| --- | --- |
| **50 👍** | [#18「用 commit 喂猫」](https://github.com/tonybaloney/vscode-pets/issues/18) —— *「猫过一段时间会饿，你得用 git commit 喂它，基本上就是个编程电子宠物…… 这会给开发者一点『别让宠物饿死』的压力」* |
| **44 👍** · 28 评论 | [#4「不需要再开一个面板」](https://github.com/tonybaloney/vscode-pets/issues/4) —— 用户讨厌宠物要占一个独立界面 |
| **40 👍** | [#3「我想喂它零食！」](https://github.com/tonybaloney/vscode-pets/issues/3) |
| 24 👍 | #830 加个兽人 —— 之后是一长串物种请求（浣熊、兔子、宠物石头）各 13–20 👍 |
| 16 👍 | [#137「我们需要电子宠物式的活动」](https://github.com/tonybaloney/vscode-pets/issues/137) —— 投喂、抚摸、互动 |
| 15 👍 | #1「宠物大一点！」 |

前三名里有两条是**照顾互动**，第一名是**由真实工作驱动的成长** —— 而且在那边同样没做。

注意长尾的形状：物种请求集中在 13–24 reaction，照顾 / 成长类在 40–50。**内容请求数量多，成长请求强度高。宠物数量不是那个杠杆。**

### 4.3 唯一做了 XP 和进化的产品，正好演示了成长回路会怎么失败

[codachi](https://github.com/blairjordan/codachi) 有 XP、等级和进化。它的热门 issue 就是一份「要做对什么」的清单：

| Issue | 教训 |
| --- | --- |
| #10「XP Display」—— **参与度最高的单个 issue** | **看不见的进度等于不存在。** Vibepaws 的 EXP 拆解面板方向正确 —— 但要显眼，而不是藏在飞出面板里 |
| [#25「升到下一级要 10 万–55 万 XP，远超那 35 XP」](https://github.com/blairjordan/codachi/issues/25) | **不透明或荒谬的曲线摧毁信任。** Vibepaws 的 100 + 50(n−1) 是合理的 —— 把它印在 UI 上 |
| #26「Togetic 到了 2000 exp 也没进化」 | **静默的「没发生」会被读成 bug。** 如果进化条件没满足，要说清是**哪一条** |
| #20「宠物在 VS Code 里太快了」· #4「Buff 效果」 | 动效调优；用户希望宠物**做点什么** |

这是「把可读性当成成长回路的一等功能，而不是加分项」的最强论据。

### 4.4 一个 6k star 产品的用户，把抱怨花在哪里

343 个 clawd issue，按标题匹配分类 —— 所以这些数字是**低估**。

| 数量 | 主题 | 解读 |
| --- | --- | --- |
| **52** | 新 agent 支持请求 | 无穷无尽。证明广度是跑步机，不是护城河 |
| **33** | 安装 / 卸载 / 更新 | 含 [#360「怎么卸载？」](https://github.com/rullerzhou-afk/clawd-on-desk/issues/360)。和 Vibepaws 的 **G09** 同一个问题 |
| **33** | 自动放行与权限 UX | **功能类里的第一名**。见 §4.5 |
| **21** | 远程 / SSH agent 监控 | 基本无人服务。见 §4.6 |
| **21** | 窗口行为 / 置顶 | 拖拽边界、Dock 冲突、吞点击、贴边 |
| **21** | 通知行为 / 免打扰 | 气泡时长；`auto` 权限模式下气泡不触发；hook 超时后气泡残留 |
| **17** | 多显示器 | 高 DPI 下位置算错、副屏。全品类通病 |
| **16** | 主题 / 皮肤 / 自定义宠物 | 含指定角色的请求 |
| **14** | 终端聚焦 / 跳回会话 | 要逐个终端适配：Ghostty、cmux、Windows Terminal。**这很贵** —— 在承诺 G19 之前值得知道 |
| **13** | 额度 / token / 上下文展示 | 见 §4.7 |
| **13** | 多会话 / 仪表盘 | 项目路径显示错、并发会话数少算、空闲会话被误判为 thinking |
| **11** | 状态不准 / 卡住 | *「任务结束了三花还在敲键盘」*、*「状态不跟随 Claude Code」* |
| **10** | 宠物渲染异常 | **#408「每隔一段时间桌宠会自己变大」—— 22 条评论**，全仓库讨论最多的 bug |
| 8 | 展示 / 社交呈现 | 见 §4.8 |
| 8 | 性能 | 曾经在 macOS arm64 上空闲占用约 45% CPU。Electron 开销是真的 |
| 5 | 成长 / XP | 见 §4.1 |

### 4.5 权限 UX 是第一号功能需求，而它的核心是远程放行

33 个 issue。要的不是「告诉我 agent 需要授权」——**而是「让我在任何地方都能回答」**。

- [#493「希望新增一个国内远程审批的」](https://github.com/rullerzhou-afk/clawd-on-desk/issues/493) —— 13 条评论。一位国内用户请求**国内可用**的远程审批渠道，因为 Telegram 在那里不可达
- [#359「建议 TG 远程审批支持系统代理」](https://github.com/rullerzhou-afk/clawd-on-desk/issues/359) —— 10 条评论
- [#311「通用 HTTP Webhook 远程权限审批 Sidecar」](https://github.com/rullerzhou-afk/clawd-on-desk/issues/311) —— **仍然 open。** 要一个**通用 webhook** 审批 sidecar，让用户自己接渠道
- #437 自动批准工具 · #727 自动放行调优 · #482 希望能关掉放行快捷键后的终端自动聚焦

**对 Vibepaws 的解读**：一个**通用** webhook / ntfy 放行渠道，比任何特定集成都更有价值 —— 因为它服务的正是 clawd「只做 Telegram」在结构上排除掉的用户，而这个细分赛道里相当大一部分用户是中文用户，Telegram 和 Discord 都不是选项。这把「手机推送」从「补齐差距」升级为**一个可识别的、被忽视的真实受众**。

### 4.6 远程 / SSH agent 监控是一个真正未解的问题

21 个 issue，跨越数年，多数以「太难」关闭：

- [#9「支持感知远程 SSH 服务器上的 Claude Code 状态」](https://github.com/rullerzhou-afk/clawd-on-desk/issues/9)
- [#320](https://github.com/rullerzhou-afk/clawd-on-desk/issues/320) 对远程 SSH 会话做审批**和**监控 · #269 通过 SSH 安装 · #519 SSH 部署 hook 时报 `Node.js not found` · #546 Codespaces + `gh cs ssh` 破坏部署探测 · #304 WSL2 下 Codex 状态有响应但没声音

开发者越来越多地把 agent 跑在远端机器、devcontainer、WSL、Codespaces 上，而没有任何桌宠处理得好。**Vibepaws 的位置异常有利**：Core 本来就是一个带 token 鉴权的 localhost HTTP 守护进程，外加一个通用 JSONL 桥 —— 把远程 adapter 指向一个隧道过来的 Core，对 Vibepaws 是小改动，对一个建立在本地进程快照上的产品则不是。

### 4.7 上下文与额度展示有需求 —— 但 clawd 已经做完了

- [#357「宠物可以支持显示上下文用量吗，感觉很实用」](https://github.com/rullerzhou-afk/clawd-on-desk/issues/357) —— **已交付**：Claude 走 statusLine 的 `context_window.used_percentage`，Codex 走本地 rollout JSONL 的 `token_count` + `model_context_window`。**和 Vibepaws 用的是同一批通道。**
- [#112](https://github.com/rullerzhou-afk/clawd-on-desk/issues/112) 请求 5 小时 / 7 天额度仪表，并明确要**「80% 以上紧张动画、95% 以上惊慌」** —— 也就是 Vibepaws 的分档预警，在那边**被请求但还没做**。
- #631 Sonnet 5 会话的上下文上限被显示成 200K（应为 1M）· #797 自定义模型上报的上下文长度不对。

**两条教训。** Vibepaws 的**展示**领先没了；**「分档预警 + 建议动作」**的领先是真的，但有时间窗。另外，模型到上下文窗口的映射是一项人人都要交的维护税 —— **硬编码上限一定会带来 bug 报告。**

### 4.8 用户想把 agent 状态广播出去

[#215 Discord Rich Presence](https://github.com/rullerzhou-afk/clawd-on-desk/issues/215) —— 一份考虑周到、隐私优先的请求，**已在 v0.12.0 交付，可选、默认关闭**，只显示粗粒度状态（`Codex is thinking / working / waiting / idle`），不显示项目名和路径。提出者自己就明确反对默认暴露项目名。

「宠物作为**状态广播**」有真实需求，而且社区自己的直觉是偏保守隐私的 —— 这正好契合 Vibepaws 的定位。注意维护者把它排在「修好 subagent 完成误判」之后才做：**广播会放大你所有的状态 bug。**

### 4.9 一位付费用户已经把路线图写好了

[#41867](https://github.com/anthropics/claude-code/issues/41867) 是一份完整的社区规格书，作者是一位**每月付 200 美元的 Max 订阅者，而且不写代码** —— 一位经济学者，所有东西都通过 Claude Code 构建。这个人群画像很重要：**技术性最弱的用户，对宠物的情感投入最深。**

| 他们的提案 | 结论 |
| --- | --- |
| **成长来自个人里程碑** —— 「相对于**你自己**的历史，而不是别人。新手和资深都按自己的节奏推进。不要绝对的能力门槛。」 | **作为设计原则采纳。** 这同时也是目前见过的最锋利的「反排行榜」论据 |
| **行动多样性**作为成长维度 —— 写码 + 测试 + 部署 + 文档，而不是纯量 | **采纳。** 完美契合质量论，而且今天就能从工具调用事件里部分测得 |
| **分叉进化**：Lv5 → 从 2 个专精里选 1，Lv10 → 第二次分叉，每物种 4 个最终形态，**选择永久** | **采纳** —— 而且注意它落在 **Lv5/Lv10，正是 Vibepaws 进化引擎已经在用的阈值**。在分叉点加入**显式用户选择**，而不只是推断风格 |
| **Buddy 日志** —— 会话后自动生成 `.buddy/journal.md`：动过哪些文件、测试 🔴→🟢、连续天数。「几个月后，这会变成一份真正有用的个人开发日记」 | **采纳。** 这就是 Vibepaws 那张死掉的 `memories` 表（**G21**，「零设计」）应该成为的东西。纯文本对开发者是原生的 —— 可 grep、可 diff、可分享，比任何 UI 都好 |
| **上下文熟悉度** —— 对熟悉的代码显得从容，对新文件显得好奇。「让人觉得它住在你的项目里，而不只是你的终端里」 | 便宜地采纳，放进「按项目身份」里 |
| **属性只是风味** —— 「不管 buddy 怎么配置，核心工具必须始终 100% 正常工作」 | Vibepaws 本来就是这样。保持 |
| **商业化**：一切都能免费赚到，外观可选付费，**没有开箱、没有付费变强**，不做独立商店 | 来自最高价值人群的付费意愿验证，与 PRD 的 19 美元创始版许可一致 |
| 给宠物命名和改名 | **本文单位工程投入情感回报最高的一项。** 见 §4.10 —— **8/22 已交付** |

### 4.10 命名就是情感依附的机制，而且几乎免费

读 #45596 的评论，模式无法忽视：**每一条悼念帖都在用名字。** 仙人掌 Prickle。乌龟 Quibble。猫头鹰 Glint。Urchin。傲娇猫 Picksnark。一只水豚。

没有人写「我怀念我那只普通稀有度的乌龟」。他们写的是**「RIP Prickle」**。

Vibepaws 的宠物是设计师取的固定名字 —— Embercub、Lunafang、Sporewick。**让用户给自己的宠物命名**大约是一天的工作量，而它正是上面所有情感依附赖以形成的机制。上游反复被请求过（#45336 自定义、#41908 改名、#41921 一整个 buddy-customizer 插件）。

> **8/22 已在设置窗口里交付。** 一天的估算给宽了：`pets.name` 本来就在 schema 里且没人写，所以它实际上只是一个输入框加一条 `UPDATE`。

### 4.11 两个要绕开的信任陷阱

- [clawd #102「为什么我的 Claude 说这个插件消耗了我很多 token」](https://github.com/rullerzhou-afk/clawd-on-desk/issues/102) —— agent **幻觉**出「宠物在消耗 token」，用户信了。维护者不得不解释：hook 是纯本地的、不往 stdout 写任何东西、从不碰 API。**任何基于 hook 的宠物都会碰到这个。** Vibepaws 应该提前拦：README 一行、应用内一行 —— *「宠物从不向模型发送任何东西，它不可能消耗 token」* —— 再加一个可见的 hook 字节数 / 延迟计数器。 **已完成（0.12，8/25）** —— 而这个计数器还有第二个用处：它把每次 hook 调用约 78 ms 的 Node 启动摆到了界面上，那是这套设计唯一真实存在的开销。
- **杀软与 Gatekeeper。** 桌宠经常被误报；clawd [#872](https://github.com/rullerzhou-afk/clawd-on-desk/issues/872) 讲的是 macOS **每次更新**都要去「隐私与安全性」放行，openpets 则一路做到了 **SignPath 签名构建**。Vibepaws 的 README 已经记录了未签名构建的问题 —— 这证明只要发布范围超出朋友圈，签名就不是可选项。

### 4.12 每个竞品都踩过的 bug —— 送给 Vibepaws 的免费 QA

直接当测试清单用。每一条都是某个已发布竞品里的真实 bug：

| Bug | 出处 |
| --- | --- |
| 宠物会自己慢慢变大 | clawd #408（22 条评论）、#569 |
| 应用图标时不时在任务栏闪现 | clawd #596（14 条评论） |
| Windows 上透明失效 | clawd #699（11 条评论） |
| 高 DPI 显示器下点击命中判定错位 | clawd #44、WindowPet #19 |
| Dock 可见时无法把宠物拖到屏幕底部 | clawd #241 |
| 宠物遮住并**吞掉**文本输入气泡上的点击 | clawd #640 |
| 权限模式为 `auto` 时权限气泡不出现 | clawd #163 —— **Vibepaws 自己的 gap 分析把它标为 G13** |
| hook 超时后气泡残留不消失 | clawd #273 |
| 把 subagent 完成误判为主任务完成 | clawd #214；#862 里 1→2+ 分档未升级 |
| 只在主显示器渲染 | WindowPet #17 |
| `explorer.exe` 重启后隐藏窗口重新出现在任务栏 | clawd #184 |
| 页面 reload 后 `setIgnoreMouseEvents` 未复位导致宠物冻结 | openpets #20 —— **Vibepaws 用的是同一套点击穿透机制** |
| 启动时 renderer 崩溃，除非关掉沙箱 | clawd #530 |
| 本地模型下载与加载失败占满整个 tracker | MiniCPM #6（21 条评论）、#11（14 条）—— **不要内置本地 LLM** |

---

## 5. 功能清单

**5 个层级共 39 项。** 工作量按单人工程日计。**差异化** = 相对竞品集的差异化程度（★ = 大众功能，★★★★★ = 无人做过）。

| 层级 | 意图 | 工作量 | 何时做 |
| --- | --- | --- | --- |
| **0** | 补齐可信度缺口 | ~29d | 现在，按顺序 |
| **1** | 护城河 —— 让质量成为产品 | ~32d + 美术 | 紧接其后 |
| **2** | 多 agent 界面 | ~22d | 然后 |
| **3** | 魅力与留存 | ~15d | 机会性穿插 |
| **4** | 生态 | 45d+ | 只在留存被验证之后 |

### Tier 0 —— 补齐可信度缺口（无论如何先做）

用户在启动后 60 秒内就会据此评判产品，其中好几项还是 PRD 里未达成的发布标准。

| # | 功能 | 说明 | 天 | 差异化 |
| --- | --- | --- | --- | --- |
| 0.1 | ~~**设置窗口**~~ ✅ | **8/22 已交付**，做成一扇独立窗口 —— 宠物窗口只有 300px 宽还要放过点击，那里放不了表单。宠物名 · token 预算（全局 + 按 session）· 上下文阈值（可关）· 每日 EXP 上限 · 按 session 的目标 · 语言。两个依赖手改 SQLite 的 Activation 指标现在都能从界面走到，`topic` 倍率与漂移基准也终于有了录入口（**G17**）。缩放 / 音效 / 自启会在 0.2–0.4 交付时各占一行 —— 那些功能不存在之前，这里没有东西可配 | ~~3~~ **已完成** | ★ |
| 0.2 | **音效** | 3–4 个简短、安静、可区分的提示音 —— needs-you / warning / finished / level-up。分类开关、音量、遵守静音。**核心价值主张是「你在另一个窗口里」—— 一只静音的宠物无法交付它。** MiniCPM 就是为这个装了铃铛 | 2 | ★★ |
| 0.3 | **缩放 + 多显示器** | 3 档尺寸；按显示器记住位置；跟随活动显示器或固定在一个。全品类第一大抱怨，也是 Tamamon 用户点名要的 | 3 | ★ |
| 0.4 | **自启 + 单命令启动** | 一个托盘应用负责拉起 Core，加登录项。两条 `npm run` 是开发流程，不是产品 | 2 | ★ |
| 0.5 | ~~**应用内重置 / 删除**~~ ✅ | **8/22 已交付。** 设置 → 重置与卸载：换一只新宠物 · 删除全部本地数据（就地清表 + `VACUUM` —— 光 `DELETE` 会把原文留在文件里）· 移除 adapter hooks。每一项都是两段式确认。hook 移除按条进行，覆盖两个 scope 与三个 agent，并从我们的备份里还原被覆盖的 `statusLine`，同时报告刻意没动的东西（**G09**）。`npm run adapter:uninstall` 负责应用已经不在的情况 —— 而那才是卸载的常态 | ~~1~~ **已完成** | ★ |
| 0.6 | **减少动效 + 无障碍** | PRD 里是 P0 但未验证。遵守系统 reduce-motion；确保每个状态**不依赖动画或颜色**也能读懂 | 1 | ★★ |
| 0.7 | **petdex 精灵导入** | 读 8×9 / 192×208 图集，附状态映射表，加 `vibepaws install <slug>`。用现成画廊解掉「5 / 12 只宠物」这个 blocker | 3 | ★★★ |
| 0.8 | **一个进化家族的形态美术** | 规则引擎已经在触发，却没有形态可切 —— 第三个被点名的 ship/hold blocker | 2（美术） | ★★ |
| **0.9** | **可操作权限气泡** ⚠️ | 气泡内 Allow / Deny / Always Allow；全局快捷键；若已在终端回答则自动关闭；按 agent 屏蔽；破坏性工具走二次确认模式。**这可能是 Tier 0 里最重要的一项。** Vibepaws 的整个前提是「你在另一个窗口」—— 而它现在让你**回到**那个窗口，去做它把你叫醒要做的那件事 | 5 | ★ |
| 0.10 | ~~**僵尸会话回收**~~ ✅ | **8/25 已交付。** Core 每 60s 扫一轮，启动时先扫一次（上一次运行留下的 `is_active` 行，恰恰是最可能的僵尸）。两条路径：adapter 上报 agent 的 pid，`kill(pid,0)` 能在一个 sweep 周期内抓到崩溃（`outcome=orphaned`）；拿不到可用 pid 的通道退回可配的静默超时（`outcome=timeout`，默认 15 分钟，设置 → 闲置 session）。两者都不结算 EXP —— 崩溃不是胜利 —— 并且都会清掉该会话的 `needs-you` 标记、撤掉它还挂着的气泡。pid 只有在**同一个** pid 出现在两条事件上之后才被采信，这一条把真正的 agent 进程和一闪而过的包装 shell 分开；没有这道闸，这个功能会去杀正在干活的会话（**G10**） | ~~2~~ **已完成** | ★ |
| **0.11** | **subagent 感知状态** | `SubagentStart`/`Stop` 已经在采集 —— 把 1 个和 2+ 个渲染成不同状态。subagent 现在很常规，而扁平的「working」把它们藏起来了。留意 clawd #214 和 #862 | 2 | ★★ |
| **0.12** | ~~**「它不会吃你的 token」信任文案**~~ ✅ | **8/25 已交付。** README 里给的是一节而不是一行 —— 对一个被幻觉出来的指控，唯一有效的回答是机制：hook 通往模型的通道只有一条（stdout，Claude Code 会把 `UserPromptSubmit` 的那一份当上下文注入），而我们的 hook 一个字节都不写、永远以 0 退出，这两条现在由测试钉住 —— 一句调试完忘了删的 `console.log` 真的会开始花钱，而它在 review 里看起来完全无害。应用内：设置里一张 **Token 与开销** 卡，加上 EXP 明细下面的一行简版，数据来自 `GET /api/hookstats` —— 事件数、字节数、Core 的 p50/p95、hook 进程自报的墙上时间，JSON 里带着 `model_calls: 0` 与 `outbound_bytes: 0`，于是可以用 `curl` 去核对那扇窗口，而不是反过来。计数器暴露出来的东西本身就值这半天：每条事件约 310 字节、约 0.4 ms，但**每次 hook 调用有约 78 ms 的 Node 启动** —— 这是 hook 式设计真正的价码，现在它在界面上，而不是在脚注里 | ~~0.5~~ **已完成** | ★★ |
| **0.13** | **代码签名 + 公证** | README 里已经记录为已知问题。openpets 做到了 SignPath；clawd 用户每次更新都要点「隐私与安全性」。**发布范围超出朋友圈之前，不可选** | 2 | ★ |

### Tier 1 —— 护城河：让质量成为产品

路线图的重心。每一项对所有竞品都不可得，因为它们不采集这些输入 —— 而 1.7 到 1.10 全部是用户在公开场合免费写好的规格。

| # | 功能 | 说明 | 天 | 差异化 |
| --- | --- | --- | --- | --- |
| 1.1 | **会话健康分** | 把已经算出来的那些乘数塌缩成一个可见的 0–100 分，并列出贡献项。放在飞出面板里**实时**显示，而不是事后藏在 EXP 拆解里 | 4 | ★★★★★ |
| 1.2 | **每周复盘卡** | 可导出图片：健康趋势、上下文纪律、避免的纠正循环、交付的会话数、你的平均响应延迟、宠物的成长。PRD 本来就想做可导出卡 —— **把它做成关于手艺的**，它就成了获客渠道 | 5 | ★★★★★ |
| 1.3 | **教练气泡** | 每条预警都带一个建议动作 —— 现在 compact / 开新会话 / 这个文件你改了 N 次 —— 并带一个「没用」按钮来调阈值。那个按钮同时也是**测量**「误报率 < 20%」的方式，而不是空口断言 | 5 | ★★★★★ |
| 1.4 | **响应延迟追踪** | 从 `needs-you` 到解除的时间。飞出面板里按会话显示，按天汇总 | 2 | ★★★★★ |
| 1.5 | **消耗速率作为宠物状态** | 每小时 token 数对比你自己的滚动基线，表达为「吃饱 / 不舒服」。在 `working` 和 `tired` 之间加一个「过饱」状态 | 3 | ★★★★ |
| 1.6 | **带显式选择的分叉进化** | Lv5 → 从 2 个专精里选 1，Lv10 → 第二次分叉，永久。分叉按操作风格（上下文纪律 vs 吞吐 vs 交付节奏），但**由用户在分叉点选择** —— 社区规格书要的正是这个，而且落在 **Vibepaws 现有的 Lv5/Lv10 阈值上** | 4 + 美术 | ★★★★★ |
| **1.7** | ~~**给宠物命名**~~ ⭐ ✅ | **8/22 随设置窗口（0.1）一起交付。** 顺手发现的一件事值得记下来：`pets.name` 这一列早就在 schema 里，但**整个代码库没有任何地方写它** —— 它在结构上就是永久 NULL，所以这件事比估的一天更接近于零。命名与改名都通了，名牌实时跟着变，留空回落物种名。原来的论证一字不改仍然成立：那 266 条评论里每一条悼念帖都在用名字 —— Prickle、Quibble、Glint、Picksnark。没有人悼念「我那只普通稀有度的乌龟」 | ~~1~~ **已完成** | ★★★★ |
| **1.8** | **会话日志** —— `.vibepaws/journal.md` | 每个会话追加一条：动过哪些文件、测试 红→绿、健康分、哪里卡住了、EXP 从哪来。纯文本，可 grep、可 diff、可分享。**这就是那张死掉的 `memories` 表（G21）该成为的东西**，直接取自社区规格书的「buddy journal」 | 3 | ★★★★★ |
| **1.9** | **成长可读性专项** | codachi 的前三名 issue 是「看不见 XP」「曲线荒谬」「进化没触发也没人告诉我」。把曲线印在 UI 上；进化条件不满足时**说清是哪一条**；绝不让里程碑静默通过 | 2 | ★★★★ |
| **1.10** | **行动多样性 EXP 维度** | 奖励广度 —— 写码 + 测试 + 文档 + commit —— 而不只是量，今天就能从工具调用事件测得。并且把进度**相对用户自己的历史**来评分，**永不设绝对门槛**：「新手和资深都按自己的节奏推进」 | 3 | ★★★★★ |

### Tier 2 —— 多 agent 界面

| # | 功能 | 说明 | 天 | 差异化 |
| --- | --- | --- | --- | --- |
| 2.1 | **宠物小队** | 沿屏幕边缘最多 N 只宠物，一个会话一只，各带自己的状态和项目标签。点一只跳到它的会话；N 很大时折叠成一只聚合宠物。引擎已存在 —— 这是渲染和布局问题 | 6 | ★★★★★ |
| 2.2 | **按项目身份 + 上下文熟悉度** | 每个仓库一只固定宠物，好认出是哪个项目在叫。加上社区规格书的「熟悉度」细节 —— 老项目从容、新克隆好奇。*「让人觉得它住在你的项目里，而不只是你的终端里」* | 3 | ★★★★ |
| 2.3 | **通用 webhook 远程放行** ⬆️ | 不是「一个 Telegram bot」，而是**通用 webhook / ntfy 渠道**，让用户自己接。clawd 只做 Telegram 和飞书，把所有走代理的人排除在外，而它在这个方向最热的 open request 正是通用 sidecar（#311、#493、#359）。这个赛道相当大一部分用户是中文用户，Telegram 和 Discord 都不是选项。与 0.9 配套，让远程动作是**放行**，而不是「你去看一下」 | 4 | ★★★★ |
| 2.4 | **能用的跳回** | 复制命令已有；在终端允许的地方做成真正的聚焦（**G19**）。**已下调** —— clawd 有这个功能 | 3 | ★ |
| 2.5 | **会话时间线** | commit-cat 的「今日」视图，用于 agent 会话。**界面被占了**（clawd 有仪表盘 + HUD）**但内容没有** —— 没有别人能填出「你是瓶颈的时刻」这一列 | 4 | ★★★ |
| **2.6** | **远程 / SSH / devcontainer agent** | clawd tracker 里 21 个 issue、跨越数年、多数以「太难」关闭。**Vibepaws 位置异常有利**：Core 本来就是带 token 鉴权的 localhost HTTP 守护进程 + 通用 JSONL 桥，把远程 adapter 指向隧道过来的 Core，比一个建立在本地进程快照上的产品要小得多。远端机器、WSL、Codespaces 上跑 agent 越来越常规，而没人服务他们 | 6 | ★★★★★ |

### Tier 3 —— 魅力与留存（便宜的愉悦，机会性穿插）

| # | 功能 | 说明 | 天 | 差异化 |
| --- | --- | --- | --- | --- |
| 3.1 | **摸一摸宠物** | 点身体（而不是飞出面板）→ 爱心粒子 + 一个小小的好感计数。`/buddy` 有这个；一天成本，却是「小组件」和「伙伴」的分界 | 1 | ★★ |
| 3.2 | **环境反应** | 昼夜色调、待机小动作、偶尔伸个懒腰。Tamamon 那一招，但不依赖天气 API | 2 | ★★★ |
| 3.3 | **性格预设** | 气泡文案 3–4 种口吻（沉稳 / 冷淡 / 热情 / 直白）。commit-cat 证明这个的投入产出比高得离谱 | 2 | ★★★ |
| 3.4 | **窗口边缘栖息** | 宠物坐在你**终端窗口**的上边缘，而不只是屏幕边缘。Shimeji 最受喜爱的行为，而在这里它**有意义** —— 宠物栖息在它正在看的东西上。clawd 的屏幕贴边迷你模式是廉价版；真正跟随窗口仍无人做 | 5 | ★★★ |
| 3.5 | **里程碑庆祝 + 个人记录** | 当日首次交付、最长的干净上下文会话、个人最佳（「你连续多少个会话把上下文压在 70% 以下」）。绑定结果，绝不绑定量。**clawd 正在做它的轻量「陪你 N 天」计数器** —— 窗口在关闭 | 2 | ★★★ |
| **3.6** | **可选状态广播** | Discord Rich Presence，只显示粗粒度状态（`working / waiting / idle`），默认关闭，不显示项目名和路径。clawd 在一份隐私优先的社区请求后于 v0.12.0 交付 —— 需求已被证明，而社区自己的直觉就是保守的。**排在 0.11 之后**：广播会放大你所有的状态 bug | 3 | ★★ |

### Tier 4 —— 生态（只在留存被验证之后）

| # | 功能 | 说明 | 天 | 差异化 |
| --- | --- | --- | --- | --- |
| 4.1 | **应用内孵化** | 丢一张图 → 生成 7 个状态 → 应用内看拼版图 → 安装。手工 Python 管线是贡献者工具；Codex `/hatch` 已经设定了用户预期 | 6 | ★★★ |
| 4.2 | **社区画廊** | 带审核的提交，petdex 兼容格式 | 10+ | ★★ |
| 4.3 | **插件 SDK** | openpets v3 是标杆（沙箱、权限、有测试）。**只有在 Vibepaws 先赢下核心回路之后才值得做**：openpets 在这方面领先，而这里不是差异化所在 | 15+ | ★★ |
| 4.4 | **团队宠物** | 可选的共享实例，聚合团队会话健康度。付费切入点 —— 而且绝不能损害本地优先的默认行为 | 15+ | ★★★★★ |

---

## 6. 结论

**从「通知」转向「手艺」—— 并且去把那批被抛下的用户接过来。**

两个事实定义了这个机会，而且两个都来自 issue tracker 而不是产品页：

1. **在 Claude Code 上没有官方宠物，而有 1,170 个 👍 和 266 条评论的人想要一个回来。** 有人锁住旧版本保住自己那只，有人写了克隆版。这是一批温热的、可识别的、有真实情感投入却无处可去的受众 —— 而 Vibepaws 的主平台正是他们被抛下的地方。
2. **在位者已经公开拒绝做成长回路**，有明确记录，两个理由：美术成本（Vibepaws 的生成管线正好解决），以及「程序员会读源码、惊喜没了」（这对稀有度和抽卡成立，但对一个隐藏变量是**用户自身行为**的机制不成立 —— **你没法剧透一面镜子**）。

「宠物提醒你 agent 需要你」在 Codex 上是官方勾选项，在 Claude 上是 Remote Control 的一个设置。「唯一一只你**把 agent 用好**才会成长的宠物」是任何竞品不重建整条数据管线就说不出的话 —— 而这正是 Vibepaws 已经建好的东西。

**并且不要在广度上跟 clawd-on-desk 打。** 3 个 agent 对 24 个，背后还有两年执行和 6k star，这场比赛赢不了 —— 而且是错的比赛，因为在位者已经主动放弃了 Vibepaws 唯一擅长的那件事。有用户要就加 agent，省下的时间全投到深度上。

具体来说：

1. **先出 Tier 0（还剩约 26 天 —— 0.1 已于 8/22 交付）。** 不可选。一只静音、不能缩放、要敲两条终端命令、没有放行按钮的宠物，会在任何人评估成长回路之前就先在打磨度上输掉。**从 0.9（可操作权限气泡）开始** —— 一个你必须离开应用才能处理的通知是半成品，而这也是 clawd 有而 Vibepaws 没有的最明显的东西。
2. **然后 Tier 1，从 1.1 和 1.3 开始。** 会话健康分和教练气泡**就是**产品。其余一切都是它们的投递机制。
3. ~~**1.7（给宠物命名）这周就做。**~~ **8/22 已随设置窗口交付。** 它是那 266 条评论赖以运行的机制，而代价只是一个输入框 —— 本文确实没有比这更好的投入产出比。
4. **Tier 1 之后价值最高的是 2.1（宠物小队）和 2.6（远程 / SSH）。** 前者是文字仪表盘在结构上做不到的事；后者是一个多年未解的痛点，而 Vibepaws 的守护进程架构在这件事上是意外的运气。
5. **导入 petdex 精灵，而不是再画 7 只宠物。** 内容是一个已经有供应商的供给问题 —— 而 tracker 已经把优先级定死了：物种请求集中在 13–24 reaction，照顾 / 成长请求在 40–50。美术工时应该花在进化形态上，那才是成长回路的承重结构。
6. **继续拒绝死亡、连续天数、抽卡、衰减和排行榜 —— 并且公开这么说。** 拒绝**就是**定位，而社区自己最好的那份规格书论证的是同一件事：成长应当*「相对于你自己的历史，而不是别人…… 不要绝对的能力门槛」*。
7. **在 clawd 的轻量计数器上线之前动手。** 它的维护者关于「陪你 N 天 / 一起完成了 N 件事」说过「这个功能这周会开始动工」。一旦那个东西出现在一个 6k star 的应用里，情感依附这块界面就有一部分被占了，Vibepaws 只能靠深度取胜。

**唯一真正重要的指标**：不是 D7 留存，也不是宠物数量，而是用户在用了一周之后**上下文纪律是否真的改善了**。如果改善了，这就是一个带吉祥物的教练工具，有持久存在的理由。如果没有，它就只是一个吉祥物 —— 而 tracker 已经清楚展示了人们多么爱吉祥物，也清楚展示了厂商能多快把它拿走。

---

## 信源

### issue tracker（§4 的依据，1,300+ 个 issue）

| 仓库 | 已读 | open |
| --- | --- | --- |
| [rullerzhou-afk/clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk/issues) | 343 | 66 |
| [tonybaloney/vscode-pets](https://github.com/tonybaloney/vscode-pets/issues) | 483 | 34 |
| [crafter-station/petdex](https://github.com/crafter-station/petdex/issues) | 310 | 11 |
| [alvinunreal/openpets](https://github.com/alvinunreal/openpets/issues) | 65 | 12 |
| [OpenBMB/MiniCPM-Desk-Pet](https://github.com/OpenBMB/MiniCPM-Desk-Pet/issues) | 18 | 11 |
| [SeakMengs/WindowPet](https://github.com/SeakMengs/WindowPet/issues) | 18 | 16 |
| [blairjordan/codachi](https://github.com/blairjordan/codachi/issues) | 16 | 7 |
| [anthropics/claude-code](https://github.com/anthropics/claude-code/issues) | buddy / 通知类检索 | — |

被引用最多的单帖：[clawd #202 养成模式](https://github.com/rullerzhou-afk/clawd-on-desk/issues/202) · [#102 token 信任](https://github.com/rullerzhou-afk/clawd-on-desk/issues/102) · [#215 Discord RP](https://github.com/rullerzhou-afk/clawd-on-desk/issues/215) · [#311 webhook 审批](https://github.com/rullerzhou-afk/clawd-on-desk/issues/311) · [#357 上下文用量](https://github.com/rullerzhou-afk/clawd-on-desk/issues/357) · [#408 宠物自己变大](https://github.com/rullerzhou-afk/clawd-on-desk/issues/408) · [vscode-pets #18 用 commit 喂猫](https://github.com/tonybaloney/vscode-pets/issues/18) · [#3 零食](https://github.com/tonybaloney/vscode-pets/issues/3) · [#137 电子宠物式活动](https://github.com/tonybaloney/vscode-pets/issues/137) · [codachi #25 曲线崩坏](https://github.com/blairjordan/codachi/issues/25) · [claude-code #45596 请愿](https://github.com/anthropics/claude-code/issues/45596) · [#41867 成长与商业化规格书](https://github.com/anthropics/claude-code/issues/41867)

### 一手 —— 官方

- [Claude Code：2026 年第 16 周（4 月 13–17 日）](https://code.claude.com/docs/en/whats-new/2026-w16) —— 推送通知、`/usage`、Routines
- [anthropics/claude-code #41684 —— /buddy 的 RPG 进化](https://github.com/anthropics/claude-code/issues/41684)（已关闭）
- [openai/skills —— hatch-pet SKILL.md](https://github.com/openai/skills/blob/main/skills/.curated/hatch-pet/SKILL.md)

### 一手 —— 竞品仓库与商店

- [rullerzhou-afk/clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk) · [releases](https://github.com/rullerzhou-afk/clawd-on-desk/releases) · [setup guide](https://github.com/rullerzhou-afk/clawd-on-desk/blob/main/docs/guides/setup-guide.md)
- [alvinunreal/openpets](https://github.com/alvinunreal/openpets) · [docs.openpets.dev](https://docs.openpets.dev/)
- [crafter-station/petdex](https://github.com/crafter-station/petdex) · [OpenBMB/MiniCPM-Desk-Pet](https://github.com/OpenBMB/MiniCPM-Desk-Pet) · [SeakMengs/WindowPet](https://github.com/SeakMengs/WindowPet)
- [LorisYounger/VPet](https://github.com/LorisYounger/VPet) · [VPet Steam](https://store.steampowered.com/app/1920960/VPet/) · [VPet MOD 制作器](https://store.steampowered.com/app/2639250/VPet__MOD/)
- [tonybaloney/vscode-pets](https://github.com/tonybaloney/vscode-pets) · [blairjordan/codachi](https://github.com/blairjordan/codachi) · [eunseo9311/commit-cat](https://github.com/eunseo9311/commit-cat) · [muhtalhakhan/bytepet-cli](https://github.com/muhtalhakhan/bytepet-cli)
- [TeXmeijin/claude-code-mascot-statusline](https://github.com/TeXmeijin/claude-code-mascot-statusline) · [asimons81/hermes-pets](https://github.com/asimons81/hermes-pets)
- [Tamamon](https://www.tamamons.com/) · [Tamamon on Product Hunt](https://www.producthunt.com/products/tamamon-a-tiny-desktop-pet-that-grows) · [tama96 on Product Hunt](https://www.producthunt.com/products/tama96-desktop-terminal-ai-pet)
- [GitMon](https://gitmon.io/) · [cli-pet 介绍文](https://dev.to/depapp/i-built-a-tamagotchi-that-judges-your-github-activity-and-its-brutally-honest-oh1)
- [Desktop Mate Steam](https://steamcommunity.com/app/3301060/) · [MateEngine Steam](https://store.steampowered.com/app/3625270/MateEngine/) · [DPET 创意工坊](https://steamcommunity.com/workshop/about/?appid=1980920) · [Shimeji](https://shimejis.xyz/)
- [Project AIRI](https://github.com/moeru-ai/airi) · [Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber) · [awesome-ai-vtubers](https://github.com/proj-airi/awesome-ai-vtubers)

### 二手 —— 报道与分析

- [OpenAI Codex 加入显示 AI 状态的桌宠 —— BigGo](https://finance.biggo.com/news/202605040025_OpenAI_Codex_desktop_pets)
- [Claude Code Agent View —— 统一所有会话的 CLI 仪表盘](https://pasqualepillitteri.it/en/news/2384/claude-code-agent-view-cli-dashboard-sessions-2026) · [Agent View 指南](https://www.buildfastwithai.com/blogs/claude-code-agent-view-guide)
- [Claude Buddy 完全指南：18 个物种与 5 个稀有度](https://dev.to/damon_bb9e4bba1285afe2fcd/claude-buddy-the-complete-guide-to-your-ai-terminal-pet-all-18-species-rarities-hidden-22da)
- [Codex pets 完全指南](https://explainx.ai/blog/codex-pets-complete-guide-how-to-use-top-custom-pets-2026)
- [Tamagotchi Uni —— TamaVault](https://tamavault.com/devices/uni/) · [进化图鉴](https://tamavault.com/devices/uni/evolution-chart/)
- [Streak Creep：过度游戏化的危险 —— The Decision Lab](https://thedecisionlab.com/insights/consumer-insights/streak-creep-the-perils-of-too-much-gamification)
- [Calm Technology 原则](https://principles.design/examples/principles-of-calm-technology) · [Calm computing —— IxDF](https://ixdf.org/literature/topics/calm-computing)
- [2026 AI 编程 agent 采用情况 —— JetBrains Research](https://blog.jetbrains.com/research/2026/08/ai-coding-agent-adoption-2026/)

> **关于信源质量。** 搜索排名很高的那批「2026 最佳桌宠」清单文章是 SEO / 联盟营销内容农场，产品描述有编造成分，已全部排除。以上每一条产品功能都可追溯到仓库、商店页、官方文档或发布页。只有二手报道的部分（Codex Pet Mode、`/buddy` 机制、Agent View），要求两个独立信源互相印证。
