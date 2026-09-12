# Vibepaws MVP 架构 v1 —— Gap Analysis

> **审查对象**：`mvp_architecture.html`（定稿草案 v1）
> **对照基准**：`README.md`（MVP 发布 PRD，P0 范围与发布标准）
> **审查日期**：2026-08-19
> **方法**：逐条把架构文档中的事实性断言与上游官方文档核对（Claude Code hooks / statusline、Codex hooks）。核对结果见 [附录 A–D](#附录-a上游事实核查表)。
> **结论**：整体分层（adapter 只报事件 / Core 做全部判定 / UI 无业务逻辑 / 隐私双闸）成立，**不建议改动**。问题集中在两处：**(1) 数据可得性假设**——EXP 与 context 警告依赖的 token/context 数据在 hooks 里根本不存在；**(2) 状态机缺少退出边**——`needs-you` 没有解除事件，`SessionEnd` 没有区分 `/clear`。这两类问题会让 README 的多条 P0 发布标准在真实环境里静默失效（不报错，只是永远不触发或永远不复位）。

---

## 0. 摘要

| ID | 严重度 | 问题 | 影响章节 | 阻塞 P0 发布标准 |
| --- | --- | --- | --- | --- |
| [G01](#g01-hooks-不提供-tokencostcontext必须新增-statusline-计量通道) | **Blocker** | hooks 不提供 token / cost / context，EXP 与 context 警告无数据源 | §2.3 §2.5 §3.2 | ✅ Usage notification、Context warning、EXP bar |
| [G02](#g02-needs-you-没有解除事件宠物会永久卡住) | **Blocker** | `needs-you` 无解除事件，宠物永久卡住 | §2.3 §2.4 | ✅ Decision bubble |
| [G03](#g03-decision_required--stop-会在每一轮对话后误报) | **Blocker** | `decision_required ← Stop` 每轮误报 | §3.2 | ✅ false positive < 20% |
| [G04](#g04-sessionendclearresume-会导致误结算与误庆祝) | **Blocker** | `SessionEnd(clear/resume)` 误结算 EXP + 误播庆祝动画 | §2.3 §3.2 | ✅ EXP bar |
| [G05](#g05-全文没有等级曲线进化在两周-alpha-里可能完全不可见) | **Blocker** | 全文无等级曲线、daily cap 数值未定 | §2.5 §2.7 | ✅ 升级循环 / 进化 |
| [G06](#g06-codex-hooks-是实验特性默认关闭windows-不支持) | High | Codex hooks 实验性、默认关闭、Windows 不支持 | D3 §6 §7 | ⚠️ 双 adapter 路径 |
| [G07](#g07-滚动-exp-与乘法公式自相矛盾) | High | 滚动 EXP 与「结算时乘倍率」自相矛盾 | §2.5 §3.2 | ⚠️ EXP explanation |
| [G08](#g08-ingress-的四个安全与生命周期漏洞) | High | token 写进 argv / 项目级 settings.json 会进 git / PORT 未定义 / generic bridge 无鉴权 | §2.1 §2.2 D7 | ⚠️ 隐私信任 |
| [G09](#g09-没有卸载路径) | High → **已闭** | 没有卸载路径，残留 hooks 会永久拖慢用户 agent —— **8/22 交付 `uninstall.ts` + 设置窗口危险区** | §2.1 §4 | ✅ 删除本地数据 |
| [G10](#g10-没有僵尸-session-回收) | High → **已闭** | 无僵尸 session 回收，`is_active` 永不复位 —— **8/25 交付 `reclaim.ts`：进程探活 + 静默超时 sweep** | §2.3 | ⚠️ 与 G02 叠加 |
| [G11](#g11-tauri-窗口会在点击宠物时抢焦点) | High | Tauri 窗口点击会抢焦点，破坏核心交互 | §2.6 §7 | ⚠️ 点击宠物打开 session |
| [G12](#g12-两套运行时的打包与签名成本未进排期) | High | Node sidecar + Tauri 两套运行时，打包/签名成本未进排期 | D6 §6 | — |
| [G13](#g13-permission_mode-会静默关掉整个决策信号) | High | `bypassPermissions` / `acceptEdits` 模式下决策事件根本不触发 | §3.2 | ✅ Decision bubble |
| [G14](#g14-seq-在多进程模型下不可实现) | Medium | `seq` 在多进程 hook 模型下不可实现 | §3.1 | — |
| [G15](#g15-fswatch-兜底方案不可靠且会重放陈旧事件) | Medium | `fs.watch` 兜底不可靠 + 陈旧事件重放 | §2.1 §5 | — |
| [G16](#g16-隐私规则自相矛盾cwd-与文件路径) | Medium | 隐私规则自相矛盾（cwd / 文件路径） | §2.1 §2.3 §3.2 §3.3 | ✅ 不存储原始代码/路径 |
| [G17](#g17-session-goal--budget-没有录入时机质量循环会静默空转) | Medium → **半闭** | `goal` / `budget_tokens` 无录入时机，质量循环空转 —— **8/22 已有录入口（设置窗口），但仍然没有任何时刻主动来问** | §2.5 §3.3 §4 | ⚠️ 隐藏质量 EXP |
| [G18](#g18-topic-drift-的误报率无法满足-20-建议影子模式上线) | Medium | topic drift 误报率无法满足 <20% | §3.3 | ✅ false positive < 20% |
| [G19](#g19-jump-to-两处描述互相矛盾且聚焦终端窗口不可实现) | Medium | jump-to 两处描述矛盾，「聚焦终端窗口」不可实现 | §2.3 §2.6 | — |
| [G20](#g20-美术产能完全没有排期) | Medium | 12 宠物 × 7 状态 + 进化家族的美术产能未排期 | §6 §7 | ✅ 12 starter pets |
| [G21](#g21-memories-是留存卖点但零设计) | Medium | `memories` 零设计 | §4 §6 | — |
| [G22](#g22-引用的两份-reference-文件不存在) | Doc | 引用的两份 reference 文件不存在 | 页头 §2.1 | — |
| [G23](#g23-附录-a-表格被未转义的--破坏) | Doc | 附录 A 表格被未转义的 `\|` 破坏 | 附录 A | — |
| [G24](#g24-sessionstart-source-取值有误路线图已偏移) | Doc | `SessionStart.source` 取值有误；路线图已偏移一天 | §2.3 §6 | — |

**核对后被证伪的担忧**（架构文档在这几点上是对的，无需改）：

- §3.2 里的 `PermissionRequest`、`PostCompact`、`SubagentStart`、`PostToolUseFailure` **都是真实存在的 Claude Code 事件**，不是杜撰。
- D3 关于「Claude Code 与 Codex 共用同一 stdin JSON 协议与 `hookSpecificOutput` 结构」的判断，与 Codex 官方文档一致。共享模板的思路成立。
- 「不解析 Claude Code transcript」是正确决定，而且理由比文档写的更强：官方明确说明 transcript **异步写入、可能落后于内存中的对话**，即使格式不变也不能用于实时判定。

---

## 1. Blocker —— 会让 P0 功能静默失效

### G01｜hooks 不提供 token/cost/context，必须新增 statusLine 计量通道

**现状**：`mvp_architecture.html:211` 断言「主数据源 = hooks 事件流（session_id / cwd / 时间 / **token / context** 全部来自事件）」。§3.2 据此写了两行映射：

- `:382` `token_update ← Notification(usage)`
- `:389` `context_update ← PreCompact/PostCompact`

**事实**：Claude Code hooks 的 common input fields 只有 `session_id` / `prompt_id` / `transcript_path` / `cwd` / `permission_mode` / `effort` / `hook_event_name`，**没有任何事件携带 token 数、成本或 context 占比**。具体到上面两行：

- `Notification` 的 matcher 取值是 `permission_prompt`、`idle_prompt`、`auth_success`、`elicitation_*`、`agent_needs_input`、`agent_completed` —— **不存在 usage 类通知**。这一行是杜撰的。
- `Pre/PostCompact` 只能告诉你「压缩发生了」，即 context 已经接近 100%。**永远无法产出 70% / 85% / 95% 三档警告**，而这三档是 README 6.3 的验收内容与发布标准。

**影响**：§2.5 公式里的 `capped_token_exp` 和 `context_multiplier` 目前是在对空气做运算。§5 降级表里「`token_update` 缺失 → EXP 只算 outcome + daily care」不是兜底路径，**而是默认路径**。README 发布标准中的「Usage notification 可用」「Context warning 可用」「EXP bar 和 level-up 可用」三条都无法达成。

**建议（低成本，数据现成）**：新增**第三条采集通道 —— statusLine 作为计量面，hooks 作为事件面**。Claude Code 的 `statusLine` 命令从 stdin 收到的 JSON 恰好包含全部缺失字段，且用同一个 `session_id`，与 hook 事件天然可 join：

```json
{
  "session_id": "abc123...",
  "session_name": "my-session",
  "context_window": {
    "total_input_tokens": 15500, "total_output_tokens": 1200,
    "context_window_size": 200000,
    "used_percentage": 8, "remaining_percentage": 92
  },
  "cost": {
    "total_cost_usd": 0.01234, "total_duration_ms": 45000,
    "total_lines_added": 156, "total_lines_removed": 23
  },
  "rate_limits": { "five_hour": { "used_percentage": 23.5, "resets_at": 1738425600 } },
  "workspace": { "repo": { "host": "github.com", "owner": "...", "name": "..." } },
  "pr": { "number": 123, "review_state": "approved" }
}
```

需要设计进去的约束：

1. **必须包裹用户已有的 statusLine**，不能覆盖写。安装时读取现有 `statusLine.command`，把 stdin 同时喂给它并原样透传它的 stdout，否则会静默毁掉用户的状态栏。
2. **必须 fire-and-forget 且 < 100ms**。Claude Code 对 statusLine 做 300ms 去抖，且新一次更新触发时会**取消正在运行的脚本**，所以不能在里面做同步 HTTP。
3. **只在 TUI 渲染时运行**，headless / `-p` 模式不产出计量数据 —— 这是可接受的降级面，但要写进 §5。
4. 设 `refreshInterval`（最小 1 秒），保证 session 空闲时计量仍在滚动。

**顺带修正 §2.3 的一条结论**：文档称「hooks 输入不含 session 名；AI title / 用户命名只对 pi（P1）可用」。statusLine 的 `session_name` 字段直接给出用户 `/rename` 的名字或 AI 生成的 title。显示名策略应改为：**用户手动命名 > `session_name` > `workspace.repo.name` > cwd 目录名 > agent 短 id**。`workspace.repo` 也比「cwd 归一化」更适合做 `project_id`（能天然合并 worktree 与 monorepo 子目录）。

---

### G02｜`needs-you` 没有解除事件，宠物会永久卡住

**现状**：§2.3 `:208` 的聚合规则是优先级取最大值：`needs-you > warning > working > idle`，没有任何衰减或解除条件。§2.4 只定义了 dismiss（用户手动关气泡）和 mute，**没有定义「事件本身已被解决」**。

**事实**：`PermissionRequest` 在需要决策时触发，但**用户批准时不会触发任何事件**。只有自动模式下的拒绝会触发 `PermissionDenied`。也就是说，「用户在终端里按了 y」这个动作对 Vibepaws 完全不可见。

**影响**：用户在终端批准权限后，Core 侧该 session 永远停留在 `needs-you`，宠物被钉死在抖动状态；由于是全局聚合取最大值，**一个卡住的 session 会让整只宠物永久处于 needs-you**，其他 session 的状态全部被掩盖。这是会在 alpha 第一天就被用户发现的问题。

**建议**：在 §2.3 状态机里补上解除边，三条并存：

| 解除条件 | 说明 |
| --- | --- |
| 同 session 后续出现 `PreToolUse` / `PostToolUse` | 隐含「决策已被处理，agent 继续跑了」→ 回 `working` |
| 同 session 出现 `PermissionDenied` | 用户/策略拒绝 → 回 `working` 或 `idle` |
| TTL 超时（建议 90s，可配） | 兜底，防止 agent 在等待中被 kill |

对应地，`notifications` 表需要补一个 `resolved_at` 与 `resolution`（`user_actioned` / `inferred` / `timeout` / `dismissed`），否则「70% decision notifications 从宠物处被处理」这条 README 指标无法归因——你分不清用户是从宠物处理的，还是回终端自己处理的。

---

### G03｜`decision_required ← Stop` 会在每一轮对话后误报

**现状**：§3.2 `:368` 把 `decision_required` 映射到 Claude Code 的 `Notification / Stop`，触发「宠物→needs-you + 气泡」。

**事实**：`Stop` 的语义是「Claude 结束了本轮回复」，即正常的「轮到你说话了」，**不是被阻塞**。按此映射，用户每收到一次回复就会弹一个「需要你」气泡。

**影响**：直接击穿 README 的「false positive warning rate 低于 20%」指标，并且是最招人烦的那种误报（高频、无信息量）。通知焦虑是 README 列出的最大产品风险之一。

**建议**：改用语义精确的 matcher，Claude Code 已经提供了：

| 标准化事件 | Claude Code 来源（修订后） |
| --- | --- |
| `decision_required` | `Notification` matcher = `agent_needs_input` |
| `permission_required` | `PermissionRequest`；`Notification` matcher = `permission_prompt` 作为冗余确认 |
| `session_idle`（新增，不弹气泡） | `Stop`、`Notification` matcher = `idle_prompt` |
| `session_finished` | `Notification` matcher = `agent_completed` + `SessionEnd`（见 G04） |

Codex 侧没有 `Notification` 事件，只能用 `PermissionRequest`；Codex 的 `Stop` 同样不应映射到 `needs-you`。这个差异应写进 `adapter_status` 的能力声明。

---

### G04｜`SessionEnd(clear/resume)` 会导致误结算与误庆祝

**现状**：§2.3 `:218–247` 的生命周期表把 `clear` 和 `resume` 只当作 `SessionStart` 的 **source** 处理（「同一 session 内 context 重置」「复用并标记活跃」），完全没有考虑与之配对的 `SessionEnd`。§3.2 `:404` 则规定 `SessionEnd → EXP 结算 + finished`。

**事实**：`SessionEnd` 的 matcher 取值是 `clear`、`resume`、`logout`、`prompt_input_exit`、`other`。也就是说用户每输入一次 `/clear`，都会先收到 `SessionEnd(clear)` 再收到 `SessionStart(clear)`。

**影响**：用户按 `/clear` → 宠物立刻播放庆祝动画 + 结算一次 EXP。`/clear` 是长会话用户的高频操作，因此这会造成**反复的 EXP 重复计算**（同一批 token 被结算多次）和莫名其妙的庆祝。这既是 EXP 经济漏洞，也是明显的观感 bug。

**建议**：`SessionEnd` 必须按 reason 分流：

| reason | Registry 动作 |
| --- | --- |
| `prompt_input_exit` / `logout` / `other` | 真结束：结算 EXP、置 `finished`、生成 memory |
| `clear` | 不结算、不庆祝；记 context 重置里程碑，状态回 `working` |
| `resume` | 不结算、不庆祝；等待配对的 `SessionStart(resume)` |

同时给 `sessions` 表加 `settled_at`，让结算成为幂等操作 —— 这是防止任何路径重复计 EXP 的最后一道闸。

---

### G05｜全文没有等级曲线，进化在两周 alpha 里可能完全不可见

**现状**：§2.7 与 README 6.5 都规定「Level 10+ 触发进化」，§6 的 W2 D3 排了一整天做进化家族。但**全文没有任何地方定义每级所需 EXP**，§2.5 的 `daily cap` 也只写了「每宠物每日 cap」，没有数值。

**影响**：这是全文最关键的未定义数字。若两周 alpha 期内用户到不了 Level 10，那么进化家族（一整天工时 + 3 套美术）在 alpha 中**完全不可见**，README 四个 MVP 验证目标里的「升级循环是否有趣」也就无法被验证。反过来若曲线太平，宠物两天满级，留存循环同样失效。目前没有任何人算过这笔账。

**建议**：在写代码前定下三个数并反推：

1. **等级曲线**（建议先用 `exp_to_next(L) = round(80 * L^1.35)` 之类的显式公式，写进 `pet_types` 或 settings，可热调）。
2. **daily token EXP cap**（建议按「重度用户一天 1–2M tokens ≈ 1000–2000 EXP 未封顶」这个量级校准）。
3. **目标节奏**：典型 alpha 用户应在**第 4–5 天**触发进化。

把这三个数固化成一张「Day 1 / 3 / 5 / 7 / 14 预期等级」的表，作为 D4（EXP 引擎）的验收标准，比事后调参便宜得多。另外 §2.5 的 `self_growth: 每小时 +0.1 EXP` 意味着一整天挂机只有 2.4 EXP —— 这个数需要和曲线一起校准，否则「自我成长」的存在感为零，起不到 README 说的「避免不用 agent 就被惩罚」的作用。

---

## 2. High —— 会造成返工或严重体验缺陷

### G06｜Codex hooks 是实验特性，默认关闭，Windows 不支持

**现状**：D3 `:77` 把 Codex 列为「第一梯队」，与 Claude Code 并列。§7 的风险表只写了「Codex 信任评审流程（/hooks）增加 setup 摩擦」。

**事实**：Codex hooks 目前是**实验特性**，需要用户在 `~/.codex/config.toml` 手动写入 `[features] codex_hooks = true` 才启用；并且 **Windows 上被禁用**；此外每个非托管 command hook 都需要用户逐条 review + 信任（hash 绑定，hook 内容一改就重新失信）。另有一个未决分歧：官方文档称 `PreToolUse` 覆盖 Bash / `apply_patch` / MCP 工具调用，第三方参考资料称仅覆盖 `shell`。

**影响**：Codex 路径的 setup 漏斗比文档预期长得多（改 toml → 写 hooks.json → 逐条信任），直接压低 README 的「60% alpha 用户至少连接一个 agent」这条 activation 指标。Windows 用户完全没有 Codex 路径。

**建议**：

1. §7 风险表补上「实验 flag + Windows 不支持」两条，别只写信任流程。
2. **W2 D1 之前先花 30 分钟 spike**，确认 `PreToolUse` 的真实覆盖范围 —— 如果真的只有 `shell`，那么 Codex 侧的 `agent_working` 信号会漏掉全部文件编辑，宠物在 Codex 写代码时是「idle」的，这会显著改变 Codex adapter 的价值判断。
3. README 的验收允许「一个真实 adapter + 一个 generic bridge」。鉴于以上摩擦，**把 Claude Code 定为唯一必达路径，Codex 降为 stretch**，是更安全的排期。

---

### G07｜滚动 EXP 与乘法公式自相矛盾

**现状**：§3.2 `:386` 规定 `token_update → EXP 滚动 + 里程碑气泡`，即边跑边发 EXP；但 §2.5 `:290` 的公式是 `capped_token_exp × context_multiplier × topic_multiplier + ...`，而这两个倍率**只有在 session 结束时才知道**。

**影响**：无法把已经发出去的 EXP 追溯乘以倍率。若强行实现，要么写负数 `exp_logs` 并可能触发**掉级**（极差体验，且与「无永久死亡、低焦虑」的产品定调冲突），要么倍率形同虚设 —— 也就丢掉了 README 6.4 的核心机制「隐藏质量 EXP」。

**建议**：改为**预结算 + 终结算**两段式：

- 运行中只显示 `pending_exp`（灰色/半透明），并实时应用**当前**倍率作为预览，明确标注「结束时结算」。
- `session_finished` 时按最终倍率一次性写入 `exp_logs` 并升级。
- `exp_logs` 加 `phase` 字段（`pending` / `settled`），既支撑「EXP 为什么变了」面板，也让预览值不污染真实等级。

副作用要一并处理：daily cap 按「每宠物每日」计，但 session 会跨午夜。需要明确 **cap 按事件时间戳所属自然日归属，时区取本机时区**，并在 `pets.daily_reset_at` 上做惰性重置。

---

### G08｜Ingress 的四个安全与生命周期漏洞

1. **API token 写进 hook 命令参数**（§2.2 `:198`）。进程参数对本机任意进程可见（`ps`），恰好击穿它自己声明的威胁模型「防本机其他进程伪造」。→ 改为放在数据目录下 `0600` 权限的文件里，adapter 启动时读取。
2. **§2.1 `:158` 把项目级 `.claude/settings.json` 列为安装目标**。官方文档明确标注该文件「**Yes, can be committed to the repo**」，token 会随 git 泄露到远端。→ 默认只写 `~/.claude/settings.json`；确需项目级时只能写 `.claude/settings.local.json`（该文件被 gitignore）。
3. **`localhost:PORT` 在全文出现 4 次，PORT 从未定义**。固定端口会撞车，动态端口则 hook 找不到。→ Core 启动时写 `~/.vibepaws/runtime.json`（`{port, token, pid, started_at}`，`0600`），adapter 每次读它。这同时给了 adapter 一个廉价的「Core 是否在跑」探测。
4. **generic bridge 声明接受「任意 JSONL/JSON 事件」（§2.1 `:194`），未提鉴权**。这是一个开放的 EXP farming 与噪声注入入口。→ 复用同一 token；对 HTTP 入口校验 `Origin`（防浏览器页面经 DNS rebinding 投递事件）；加基础速率限制。

另有一条隐私细节：`Stop` 与 `SubagentStop` 事件的 stdin 里含有 **`last_assistant_message`（模型回复原文）**。模板的白名单必须显式把它排除，否则「原始文本不进 Core」这条承诺在 `Stop` 这条最高频路径上就破了。建议在 §2.1 步骤 3 里点名这个字段。

---

### G09｜没有卸载路径

**现状**：§2.1 `:183` 的 `install.ts` 负责「写配置（先备份原文件）」，全文没有 uninstall。§4 `:454` 把「删除本地数据」定义为「清空 vibepaws 数据目录」。

**影响**：用户删掉数据目录甚至卸载 App 之后，`~/.claude/settings.json` 里的 hooks 仍然存在，**在此后每一次工具调用上都去 POST 一个已经没人监听的端口**。虽然超时的 command hook 不会阻塞工具调用（官方已确认），但每个事件仍要付出一次进程启动的代价，用户的 agent 会永久性地变慢，而且他不会知道为什么。这是最容易招致差评的一类问题。

**建议**：`uninstall.ts` 与 `install.ts` 同一个 PR 交付，覆盖：移除自己写入的 hooks 条目（按标记识别，不要整段覆盖）、还原被包裹的 `statusLine.command`、删除 runtime.json 与数据目录。README 的「用户可以删除本地 pet data」这条发布标准应扩写为「可完全卸载并还原 agent 配置」。

**已交付（8/22）**：`src/adapters/uninstall.ts`（引擎 + CLI `npm run adapter:uninstall`）与设置窗口的「重置与卸载」分区（Core 的 `GET/POST /api/reset`、`GET/POST /api/uninstall`）。落地时与上面的建议有三处偏差，都是刻意的：

- **数据目录不由卸载器删**，删除走 Core 的就地清表 + `VACUUM`（`src/core/reset.ts`）。Core 开着库的时候删目录，只会让它继续往一个已经不在目录树里的 inode 写；而且光 `DELETE` 会把 session 标题的原文留在空闲页里。CLI 的 `--purge-data` 仍然存在，用于「App 已经不在了」，并且探测到 Core 还活着就拒绝执行。
- **`~/.codex/config.toml` 的项目信任条目不动**，只在报告里提示用户手动清理 —— 没有 TOML 解析器就去改写用户的 TOML，是把「清理残留」变成「吃掉配置」。
- **`api_token` 在「删除全部数据」里活下来**：它一起没了的话，正在跑的 hook 会在下一次请求上 401，而用户刚才点的是「删除数据」，不是「把采集通道弄坏」。

一条实践教训值得记下来：卸载器的每个入口都同时覆盖项目级与用户级，所以 `home` 必须是**参数**。这条不是假想 —— 本功能的测试第一版只沙箱化了 repoRoot，跑一次就删掉了开发机上真实的 `~/.vibepaws` 并把全局 hooks 一起卸了。

---

### G10｜没有僵尸 session 回收

`SessionEnd` 在 `kill -9`、崩溃、笔记本休眠等情况下不会触发。§2.3 的 `sessions.is_active` 因此永不复位，`last_event_at` 字段存在却没有被任何逻辑消费。叠加 G02 之后，一个僵尸 session 会永久钉住整只宠物的聚合状态。

**建议**：Core 侧加周期性 sweep（建议 60s 一轮）：`last_event_at` 超过 N 分钟（建议 15 分钟，可配）→ 置 `is_active = 0`，状态转 `idle`，且**不结算 EXP**（避免把崩溃当成功）。同时 §5 降级表补一行「session 静默超时」。

**已交付（8/25）**：`src/core/reclaim.ts`（sweep 引擎 + 进程探活）、`sessions` 加 `agent_pid` / `agent_pid_confirmed`（schema v3，老库自动补列）、adapter 上报 `payload.pid`、设置窗口的「闲置 session」分区（`zombie_timeout_min`，1–1440 分钟，默认 15）。Core 在启动时扫一遍、之后 60s 一轮。落地时比建议多做/改做了四处：

- **进程探活是主路径，静默超时降级为兜底**。只有超时的话，一个 `kill -9` 掉的 session 要占着宠物 15 分钟；有 pid 之后同样的场景是**一个 sweep 周期**。反过来，没有 pid 的通道（generic bridge、手动发射器、老库）行为与建议完全一致。
- **pid 必须被「确认」过才敢用来判死**。hook 是 agent 的子进程，`ppid` 通常就是 agent —— 但只要中间那层 `sh -c` 没有 exec 掉自己，`ppid` 就是一个**转瞬即逝**的 shell，60 秒后必然「已死」，于是我们会去回收一个正在干活的 session。判别很便宜：包装 shell 每次都是新 pid，agent 进程整个会话不变，所以只有同一个 pid 被两条事件报到过才置 `agent_pid_confirmed=1`。拿不到确认就退回静默超时 —— 慢一点，但不会错杀。这条不是假想，它决定了这个功能是「有用」还是「有害」。
- **outcome 分成 `orphaned` 与 `timeout` 两种**，而不是共用一个「非成功」。用户看到「进程没了」和「没声了」时的下一步动作完全不同（去看崩在哪 / 直接 resume）。两者都落在 `outcomeBonus()` 给 0 分的那一边。
- **回收要顺手把还挂着的气泡标成 dismissed**，并清掉 `needs_input_since`。只写 `is_active=0` 的话，一个已经不存在的会话会继续在屏幕上求人回答，而它 `--resume` 回来时还会带着三小时前的「等你」复活。

另外，`sessionState()` 对被回收的 session 返回 `idle` 而不是 `finished`，`aggregatePetState()` 也把它从「刚收工」的庆祝里排除掉 —— `finished` 在这个产品里是有奖励含义的状态（打勾 + 庆祝动画 + outcome bonus），拿它表示「崩了」等于告诉用户这次干得不错。

---

### G11｜Tauri 窗口会在点击宠物时抢焦点

**现状**：§2.6 `:308` 把「点击宠物弹出浮层」定义为唯一的 session 管理入口，§7 只把 always-on-top 列为跨平台风险。

**问题**：Tauri v2 的窗口在 macOS 上是 `NSWindow` 而非 non-activating 的 `NSPanel`。点击它会**激活 Vibepaws 这个 App**，把焦点从用户正在盯着的终端/编辑器上抢走。对一个「always-on-top 陪伴型」产品来说这是致命的：用户点一下宠物想看看情况，结果丢了终端焦点。要修必须写 Rust/objc 插件把窗口降级成非激活面板，同时还要处理 `canJoinAllSpaces` / `fullScreenAuxiliary` 才能浮在全屏应用之上。

**建议**：**这是 Day 1 就要做的 spike，不是 D2 的实现细节**。它可能推翻 D6 的技术选型，越晚发现越贵。另外建议把「气泡层用独立透明子窗口」（§2.6 `:307`）合并进主窗口 —— 两个 always-on-top 窗口会有 z-order 互相抢占的问题，一个足够大的透明窗口 + 内部布局更省事。

---

### G12｜两套运行时的打包与签名成本未进排期

D6 `:92` 选择 Core = Node ≥20 + better-sqlite3，UI = Tauri v2（Rust）。这意味着要分发：一个 Node 运行时 + 一个需要按平台/ABI 预编译的原生模块（`.node` 在 macOS 上要单独参与公证）+ 一个 Rust 应用，用 Tauri sidecar 串起来，并且自动更新时两者必须同版本。§6 的 14 天排期里**没有任何一天分配给打包、签名、公证或更新器**。

**建议**：alpha 阶段把 Core 用 Rust 实现并放进 Tauri 进程内（`rusqlite`），单二进制，保留 `--headless` 参数。D5 提出的「Core 独立守护进程」理由是「桌面壳 / pi-gui / 未来 pi extension 都只是消费者」—— 那是 P1 的关注点，而进程边界随时可以在 P1 拆出来（HTTP + SSE 接口不变）。若坚持 Node sidecar，则必须在 §6 里补一个完整的打包日，并把它算进 D6–7 的缓冲之外。

---

### G13｜`permission_mode` 会静默关掉整个决策信号

**事实**：hooks 的 common input 里有 `permission_mode`，取值为 `default` / `plan` / `acceptEdits` / `auto` / `dontAsk` / `bypassPermissions`。

**影响**：Vibepaws 的目标用户是「vibe coder」，而这类用户大量使用 `acceptEdits`、`dontAsk` 或 `bypassPermissions` 跑长会话 —— 在这些模式下，权限根本不会向用户征询，**`PermissionRequest` / `permission_prompt` 不会触发**。也就是说产品最核心的价值（决策气泡）对最核心的用户群静默失效，而且失效得毫无提示。

**建议**：

1. adapter 把 `permission_mode` 加入白名单并上报，Core 存到 `sessions` 表。
2. onboarding 与浮层里显式提示：当检测到 session 处于 `bypassPermissions` / `dontAsk` 时，告诉用户「这个模式下我帮不上忙」，并说明改用哪个模式能获得提醒。诚实说明比默默无声好得多。
3. 这也应作为一条降级路径写进 §5。

---

## 3. Medium

### G14｜`seq` 在多进程模型下不可实现
§3.1 `:330` 的事件信封里有 `"seq": 128`。每个 hook 都是独立的短命进程，没有共享状态，无法产生单调递增序号（除非引入带锁的计数文件，为此付出的代价不值）。并发进程经 HTTP 投递本身也会乱序。→ 删除 `seq`，改为按 `timestamp` 排序并让状态机容忍乱序（关键是幂等 + 「后到的旧事件不覆盖新状态」）。

### G15｜`fs.watch` 兜底方案不可靠且会重放陈旧事件
§2.1 `:191` 的兜底是「append 到 `events/*.jsonl`，Core 用 `fs.watch` 收」。`fs.watch` 不提供字节偏移、在高频写入下会丢事件；多个 hook 进程并发 append 同一文件还会交错。更重要的是：Core 启动时读到三天前积压的 JSONL，会把陈旧的 `needs-you` 当成实时状态，宠物一启动就开始惊慌。→ 改为按进程分文件（或持久化读取偏移量），并设置**陈旧阈值**（建议 5 分钟）：超过阈值的事件只入库用于 EXP 补算，不参与实时状态机。

### G16｜隐私规则自相矛盾（cwd 与文件路径）
§2.1 步骤 3（`:189`）要求丢弃「`cwd` 中的敏感路径值」，但 §3.2 的 `session_started` payload 里就有 `cwd`，§2.3 又用 cwd 目录名做显示名。同时 §3.3 的漂移启发式依赖「PostToolUse 文件路径前缀变化」，意味着**文件路径确实越过了 adapter 边界**，与白名单声明冲突。→ 定一条明确规则：完整路径只用于本地 hash 得到 `project_id`（或直接用 statusLine 的 `workspace.repo`），对外只传 basename 与深度受限的相对前缀（如前两级），绝不传绝对路径。README 发布标准里的「默认不存储原始代码或 prompt text」应扩展到路径。

### G17｜session goal / budget 没有录入时机，质量循环会静默空转
`sessions.goal` 是 `topic_multiplier`（§2.5）和整个 §3.3 漂移判定的基准，`budget_tokens` 是 25/50/75/90% 里程碑的分母。但两者都在 UI 里设置，而 session 是在终端里诞生的 —— 文档没有定义任何录入时机。现实结果：绝大多数用户永远不填，于是 `topic_multiplier` 恒为 1.00，漂移检测没有基准，usage 里程碑没有分母，README 6.4 的「隐藏质量 EXP」这个核心差异点整体空转。→ 需要定一个录入时刻。成本最低的方案：`session_started` 后由宠物弹一次轻量气泡「这次要做什么？」，允许一键跳过并落一个默认 budget（取用户全局默认值）。

> **8/22 进展：半闭，不是关闭。**
> 设置窗口（landscape 0.1）补上了这一条通路里缺的那一半：`POST /api/settings` 存全局默认 budget、`POST /api/session` 给每个在跑的 session 写 `goal` / `budget_tokens`，两者都当场生效 —— 改完预算会重新武装里程碑闩锁，所以不必等下一个 session。已用测试钉住两件事：填了 goal 之后 `exp_logs.note` 变成 `×topic=1.1`，填了 budget 之后里程碑气泡真的会来（`src/core/settings.test.ts`）。
> **但本条 gap 的要害不是「没有地方填」，而是「没有人会想到去填」** —— 那部分完全没动：仍然没有任何时刻主动来问。默认 budget 依然是 0（= 里程碑默认关闭），`goal` 依然默认 NULL（= `topic_multiplier` 恒为 1.00、漂移判定没有基准）。上面那个「`session_started` 后弹一次轻量气泡」的方案依旧是这条 gap 真正的解法，只是现在它的落点已经建好了：气泡只需要把用户送到这两个已经存在、已经带校验的端点。

### G18｜topic drift 的误报率无法满足 <20%，建议影子模式上线
§3.3 的信号里「文件区域突变幅度（PostToolUse 文件路径前缀变化）」在正常的多文件重构中会持续触发。README 要求 false positive rate < 20%，目前没有任何测量手段。→ alpha 期先**影子模式**上线：规则照跑、只写 `events` 不弹气泡，配合「not useful」反馈按钮收集数据；第二周确认误报率达标后再放开。同时注意 `FileChanged` 事件帮不上忙——它的 matcher 只支持字面文件名的精确匹配（仅允许字母、数字、`_`、`|`），无法监听任意路径或 glob。

### G19｜jump-to 两处描述互相矛盾，且「聚焦终端窗口」不可实现
§2.3 `:261` 写「复制命令到剪贴板 + 唤起终端（P1）」，§2.6 `:310` 写「点击行 = jump-to（对 Codex/Claude：聚焦其终端窗口 / 打开 session 目录）」。后者不可实现：没有任何 hook payload 携带 PID 或窗口句柄，Core 无从知道某个 session activo 在哪个终端窗口的哪个 tab 里。→ 统一为「复制 `claude --resume <id>` 到剪贴板 + toast 提示」，这是 MVP 能诚实兑现的行为；把「唤起终端」明确标为 P1 并写清依赖（需要在 `SessionStart` 时采集 ppid 链并做平台相关的窗口映射）。

### G20｜美术产能完全没有排期
README 要求至少 12 个高质量 starter pets，§2.7 还要一个完整进化家族（基础/进化/rare alternate 三形态），§2.6 要求 7 种状态各有动画。粗算是 15 套精灵 × 7 状态 ≈ 100+ 组动画。这些内容目前躺在 §6 的 **D6–7「缓冲」**里，且 §7 风险表完全没有提到美术产能。仓库里 `output/imagegen/` 已经有 batch-02/03 的静态 PNG，但从静态图到 7 状态像素动画之间还有完整的 pipeline 缺口。→ 这是最可能滑期的一项，应单列风险并明确取舍顺序（例如：先保 6 只 × 7 状态完整，再补到 12 只，进化家族优先于宠物数量，因为它服务于 G05 的验证目标）。

### G21｜`memories` 是留存卖点但零设计
`memories` 表出现在 §4 `:450`，W2 D3 排了工时，全文没有任何设计。在「不读 prompt」的约束下，仅凭 `safe_summary` 能生成的只有「在项目 X 工作了 2 小时，跑了 30 次工具调用」这类记录。→ 要么明确它就是这种「工作日志式」记忆并接受其价值有限，要么直接砍出 alpha。目前这种「有表、有工时、无定义」的状态最危险。

---

## 4. 文档硬伤

### G22｜引用的两份 reference 文件不存在
页头引用了 `references/event_collection.md` 与 `references/cc-session.md`，`references/` 目录在本次审查前并不存在。§2.1 关于 Codex 的全部论证都以前者为依据，导致**审查者无法独立验证**。本文档的[附录 A–D](#附录-a上游事实核查表)可作为 `event_collection.md` 的替代事实基础。

### G23｜附录 A 表格被未转义的 `|` 破坏
`mvp_architecture.html:626–630`，「恢复方式」一行的 Claude Code 单元格里 `` `--resume <id|name>` `` 的 `|` 未转义，把单元格劈成两半，`name>` 泄漏到了 Codex 列。该行当前渲染是错位的。→ 转义为 `\|` 或改写为 `--resume <id>`。

### G24｜`SessionStart.source` 取值有误；路线图已偏移一天
- §2.3 生命周期表列出 `resume / continue` 与 `fork / branch`。真实取值是 `startup`、`resume`、`clear`、`compact`、`fork` —— **没有 `continue`，也没有 `branch`**。`--continue` 上报为 `resume`。
- §6 的路线图整体比 README 偏移一天（架构文档的 D1 = README 的 8/18）。截至 2026-08-19 代码尚未开始，即已带着 D1 的欠账进入 D2。另外 §6 完全删掉了 README 8/28 的 STT，虽然它是 P1 可以砍，但**应显式记为「已从两周排期中移除」**，而不是无声消失。

---

## 5. 建议的架构修订清单

按改动成本从低到高排列，前四项建议在写第一行代码之前完成：

| # | 修订 | 涉及位置 | 对应 gap |
| --- | --- | --- | --- |
| 1 | 新增 statusLine 计量通道；重写 §3.2 中 `token_update` / `context_update` 两行；修订显示名策略与 `project_id` 定义 | §2.1 §2.3 §3.2 §5 | G01 |
| 2 | 确定等级曲线、daily cap、目标进化节奏三个数，写成 Day 1/3/5/7/14 预期等级表作为 D4 验收标准 | §2.5 §2.7 | G05 |
| 3 | 状态机补解除边（推断/拒绝/TTL）与 `SessionEnd` 按 reason 分流；`sessions` 加 `settled_at`，`notifications` 加 `resolved_at` / `resolution` | §2.3 §2.4 §4 | G02 G04 G10 |
| 4 | 事件映射改用精确 matcher（`agent_needs_input` / `permission_prompt` / `agent_completed`）；新增不弹气泡的 `session_idle` | §3.2 | G03 |
| 5 | Day 1 spike：Tauri 非激活窗口（NSPanel）+ Codex hooks 真实覆盖范围。两者都可能推翻既有选型 | D3 D6 §7 | G06 G11 |
| 6 | Ingress 安全四项修订 + `runtime.json` 端口发现 + `last_assistant_message` 列入排除名单 | §2.1 §2.2 | G08 |
| 7 | ~~`uninstall.ts` 与 `install.ts` 同 PR 交付~~ **8/22 已交付**（`uninstall.ts` + 设置窗口危险区；数据删除走 Core 清表而不是删目录，见 G09） | §2.1 | G09 |
| 8 | EXP 改两段式（pending / settled），`exp_logs` 加 `phase` | §2.5 §4 | G07 |
| 9 | 采集 `permission_mode` 并在 onboarding/浮层做能力提示 | §3.2 §5 | G13 |
| 10 | topic drift 改影子模式上线；~~session goal 定录入时机~~ → 录入**口**已于 8/22 交付（设置窗口），仍需定一个主动**询问**的时刻 | §3.3 | G17 G18 |
| 11 | 若保留 Node sidecar，§6 补打包/签名日；否则 Core 改 Rust 内嵌 | D6 §6 | G12 |
| 12 | 删除 `seq`；JSONL 兜底改偏移量 + 陈旧阈值；统一隐私路径规则 | §2.1 §3.1 §5 | G14 G15 G16 |
| 13 | 文档修订：修复附录 A 表格、修正 source 取值、补齐 references、显式记录 STT 已移除、§7 风险表补 4 条（Codex 实验 flag、美术产能、焦点抢占、打包成本） | 全文 | G20 G22 G23 G24 |

---

## 附录 A：上游事实核查表

| # | 架构文档的断言 | 核查结果 | 依据 |
| --- | --- | --- | --- |
| 1 | Claude Code 有 `PermissionRequest` / `PostCompact` / `SubagentStart` / `PostToolUseFailure` 事件 | ✅ 成立 | CC hooks 文档事件表 |
| 2 | Claude Code 与 Codex 共用 stdin JSON + `hookSpecificOutput` 输出结构 | ✅ 成立 | Codex hooks 官方文档 |
| 3 | Codex 事件清单与 Claude Code 高度重合 | ⚠️ 基本成立，但 **Codex 无 `Notification` 事件**，这正好是 G03 修复方案所依赖的事件 | Codex hooks 官方文档 |
| 4 | 「token / context 全部来自事件」 | ❌ **不成立**，任何 hook 事件都不含 token / cost / context | CC hooks「Common input fields」 |
| 5 | `token_update ← Notification(usage)` | ❌ **不存在 usage 类通知**，matcher 取值见附录 B | CC hooks Notification matcher |
| 6 | `context_update ← Pre/PostCompact` 可产出 70/85/95% 警告 | ❌ 压缩事件只在 ~100% 时触发，无法产出分档警告 | CC hooks 事件语义 |
| 7 | `SessionStart.source` 含 `continue` / `branch` | ❌ 实际取值为 `startup`/`resume`/`clear`/`compact`/`fork` | CC hooks SessionStart matcher |
| 8 | 「不解析 Claude Code transcript」 | ✅ 成立，且理由更强：transcript **异步写入、可能落后于内存对话** | CC hooks `transcript_path` 字段说明 |
| 9 | 「hooks 输入不含 session 名，AI title 只对 pi 可用」 | ❌ statusLine 提供 `session_name`（用户命名或 AI title） | CC statusline 数据表 |
| 10 | 项目级 `.claude/settings.json` 可作为安装目标 | ⚠️ 可以，但该文件官方标注为「可提交到仓库」，写 token 会泄露 | CC hooks 配置位置表 |
| 11 | 「adapter <100ms」且慢 hook 会拖慢 agent | ⚠️ 部分成立：command hook 默认超时 **600 秒**，但**超时的 command hook 不会阻塞工具调用** | CC hooks Timeouts 一节 |
| 12 | Codex 是可与 Claude Code 并列的「第一梯队」 | ❌ Codex hooks 为实验特性、需 `[features] codex_hooks = true`、**Windows 禁用**、需逐条信任 | Codex 配置文档 + 社区资料 |

---

## 附录 B：Claude Code hooks 可用信息（供 adapter 白名单参考）

**common input fields**（几乎所有事件都有）：
`session_id` · `prompt_id` · `transcript_path` · `cwd` · `permission_mode` · `effort` · `hook_event_name`
子 agent 场景额外提供：`agent_id` · `agent_type`

**关键 matcher 取值**：

| 事件 | matcher 取值 |
| --- | --- |
| `SessionStart` | `startup` · `resume` · `clear` · `compact` · `fork` |
| `SessionEnd` | `clear` · `resume` · `logout` · `prompt_input_exit` · `other` |
| `Notification` | `permission_prompt` · `idle_prompt` · `auth_success` · `elicitation_dialog` · `elicitation_url_dialog` · `elicitation_complete` · `elicitation_response` · `agent_needs_input` · `agent_completed` |
| `SubagentStart` | `agent_type`（`general-purpose` / `Explore` / 自定义名 / 插件作用域名） |
| `PreToolUse` / `PostToolUse` | 工具名 |

**超时**：`command` / `http` / `mcp_tool` 默认 600s，`prompt` 30s，`agent` 60s；`UserPromptSubmit` 降为 30s，`MessageDisplay` 降为 10s。超时的 command hook **不阻塞**工具调用。

**配置位置与可提交性**：

| 位置 | 作用域 | 可提交到仓库 |
| --- | --- | --- |
| `~/.claude/settings.json` | 全部项目 | 否（本机） |
| `.claude/settings.json` | 单项目 | **是** ← 不要写 token |
| `.claude/settings.local.json` | 单项目 | 否（gitignore） |

**尚未被架构文档利用、但可能有价值的事件**：`CwdChanged`（工作目录变化，可用于 project 归属修正）· `TeammateIdle`（agent team 成员将转 idle）· `TaskCreated` / `TaskCompleted`（可作为 outcome_bonus 的更强信号）· `PermissionDenied`（G02 的解除信号之一）。

**隐私注意**：`Stop` / `SubagentStop` 的 stdin 含 `last_assistant_message`（模型回复原文），必须显式排除。

---

## 附录 C：statusLine 数据契约（G01 的数据来源）

完整 stdin 结构见上游文档，与本项目相关的字段：

| 字段 | 用途 |
| --- | --- |
| `session_id` | 与 hook 事件 join 的主键 |
| `session_name` | 显示名（用户 `/rename` 或 AI title），无则字段缺失 |
| `context_window.used_percentage` / `remaining_percentage` | **70/85/95% context 警告的唯一来源** |
| `context_window.total_input_tokens` / `total_output_tokens` / `context_window_size` | `capped_token_exp` 的来源 |
| `cost.total_cost_usd` / `total_duration_ms` | usage 里程碑气泡、session 时长 |
| `cost.total_lines_added` / `total_lines_removed` | outcome 信号的候选 |
| `rate_limits.five_hour` / `seven_day` | 「今天还能跑多久」类提示（P1 机会） |
| `workspace.repo` / `workspace.git_worktree` | 比 cwd 归一化更稳的 `project_id` |
| `pr.number` / `pr.review_state` | `outcome_bonus` 的强信号 |
| `effort.level` | 与 hook 的 `effort` 字段同源，可交叉校验 |

**运行时约束**：300ms 去抖；新更新触发时**取消**正在运行的脚本（所以必须 fire-and-forget）；仅在 TUI 渲染时运行；`refreshInterval` 最小 1 秒；必须包裹而非覆盖用户已有的 statusLine 命令。

---

## 附录 D：Codex hooks 现状

**事件**：`SessionStart` / `SessionEnd` · `PreToolUse` / `PostToolUse` · `PermissionRequest` · `PreCompact` / `PostCompact` · `UserPromptSubmit` · `SubagentStart` / `SubagentStop` · `Stop`。**无 `Notification`**，也**无 token/context 数据**。

**stdin 常见字段**：`session_id` · `cwd` · `hook_event_name` · `model` · `transcript_path`（可空） · `permission_mode` · 事件相关的 `tool_name` / `tool_input` / `tool_response`。

**stdout**：`hookSpecificOutput { hookEventName, additionalContext }`，另有 `continue` / `stopReason` / `systemMessage` / `suppressOutput`。与 Claude Code 同构 —— **D3 的共享模板结论在协议层面成立**。

**启用条件**：`~/.codex/config.toml` 写入 `[features] codex_hooks = true`；实验特性；**Windows 禁用**；`.codex/hooks.json`（项目）与 `~/.codex/hooks.json`（全局）同时加载；非托管 command hook 需逐条 review 并按内容 hash 信任，hook 内容变更即失信（可用 `--dangerously-bypass-hook-trust` 绕过，但不应引导用户这样做）。

---

## 附录 E：待验证清单（写代码前的 spike）

| # | 待验证问题 | 影响 | 建议时机 |
| --- | --- | --- | --- |
| 1 | Codex `PreToolUse` 究竟覆盖哪些工具（仅 `shell`？还是含 `apply_patch` / MCP？上游资料矛盾） | 决定 Codex 侧 `agent_working` 是否有效 | W2 D1 之前，30 分钟 |
| 2 | Tauri v2 能否做出非激活（NSPanel 式）always-on-top 窗口 | 可能推翻 D6 技术选型 | **Day 1** |
| 3 | Claude Code `--resume` 后 `session_id` 是否保持不变 | 决定 §2.3「resume 复用同一 session」是否成立，影响 token 累计与最后活跃记忆 | Day 1，simulator 之前 |
| 4 | hook 进程冷启动实测耗时（Node vs 编译产物 vs 静态二进制） | 决定 `hook_agent.ts` 的分发形态；PreToolUse 是同步路径，每次工具调用都要付这个代价 | Day 1 |
| 5 | statusLine 包裹用户已有命令的兼容性（多行 statusLine、ANSI 转义） | 决定 G01 方案的安装安全性 | 实现 statusLine 通道时 |
| 6 | Codex hooks 是否已脱离实验状态 / Windows 是否恢复支持 | 决定 Codex 是必达还是 stretch | W2 D1 之前 |

---

**上游文档来源**

- Claude Code hooks — https://code.claude.com/docs/en/hooks
- Claude Code statusline — https://code.claude.com/docs/en/statusline
- Codex hooks — https://learn.chatgpt.com/docs/hooks
- Codex hooks 参考（第三方，与官方存在分歧，见附录 E #1）— https://agenticcontrolplane.com/blog/codex-cli-hooks-reference
- Codex CLI feature flags（第三方）— https://codex.danielvaughan.com/2026/03/28/codex-cli-feature-flags-tui-tuning/
