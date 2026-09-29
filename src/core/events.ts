/**
 * Vibepaws 标准化事件 schema — 对应 docs/mvp_architecture.md §3
 * 隐私：payload 仅允许白名单字段（第一道闸在 adapter，第二道闸在 ingress）。
 */

export type AgentId = "claude_code" | "codex" | "generic" | "pi" | "dsh";
export type Severity = "low" | "medium" | "high";

export const AGENTS: AgentId[] = ["claude_code", "codex", "generic", "pi", "dsh"];

export type EventType =
  | "session_started"
  | "agent_working"
  | "decision_required"
  | "permission_required"
  | "token_update"
  | "context_update"
  | "topic_drift_warning"
  | "session_finished"
  | "session_error"
  | "subagent_started"
  | "subagent_stopped"
  | "adapter_status";

export const EVENT_TYPES: EventType[] = [
  "session_started",
  "agent_working",
  "decision_required",
  "permission_required",
  "token_update",
  "context_update",
  "topic_drift_warning",
  "session_finished",
  "session_error",
  "subagent_started",
  "subagent_stopped",
  "adapter_status",
];

/** session_started 的 source：用于推断 session 生命周期（不解析 transcript 文件） */
export type SessionSource = "startup" | "resume" | "fork" | "clear" | "compact" | "continue";

/** 白名单 payload。任何不在这些字段里的内容都会被 ingress 丢弃。 */
export interface EventPayload {
  title?: string;              // session_started: 显示名提示（adapter 尽量不给，Core 用 cwd 目录名）
  cwd?: string;                // session_started
  source?: SessionSource;      // session_started
  tool_name?: string;          // agent_working / permission_required / session_error
  kind?: string;               // decision_required: "question"(AskUserQuestion) | Notification matcher | Stop 等
  turn_id?: string;            // decision_required
  tokens?: number;             // token_update
  cost?: number;               // token_update
  context_pct?: number;        // context_update
  signal_kind?: string;        // topic_drift_warning
  reason?: string;             // session_finished: completion | stopped | error | timeout
  outcome?: string;            // session_finished: success | partial | abandoned
  error_kind?: string;         // session_error
  parent_session_id?: string;  // subagent_started / fork
  subagent_kind?: string;      // subagent_started
  capabilities?: string[];     // adapter_status
  adapter_version?: string;    // adapter_status
  file?: string;               // agent_working: 目标文件（仅文件名 basename，防路径泄漏；ingress 再削一遍，见 fileBasename）
  /**
   * agent 当前的权限模式（Claude Code 的 hook 输入自带：default / acceptEdits / plan /
   * bypassPermissions …）。`bypassPermissions` / `acceptEdits` 下权限事件根本不会触发，
   * 界面要能说出「这个模式下等你的气泡不会出现」，而不是让用户以为宠物坏了（G13）。
   * 隐私上只允许一个模式名（isPermissionMode），不许借道捎带任何别的东西。
   */
  permission_mode?: string;
  /**
   * Bash 权限请求的命令前缀（U9 / R20）：程序名 + 至多两个子命令词，例如 `npm test`、`git status`。
   * 「永远允许」要按它收窄 —— 整个 `Bash` 放行意味着按一次 `ls` 就永久授权了 `rm -rf`。
   * 只在 Claude Code 的 permission_required 上出现（只有它有 settings.local.json 可写），
   * 形状由 isCommandPrefix 把关：参数、路径、引号、管道、变量赋值一概进不来，整条命令永远不出 adapter。
   */
  command_prefix?: string;
  /**
   * agent 进程的 pid（僵尸回收 G10）。Core 用它探活：进程没了 = session 死了，
   * 不必干等 15 分钟静默超时。隐私上这是一个本机整数，不携带任何用户内容 ——
   * 它唯一能回答的问题是「这个 session 背后的进程还在不在」。
   */
  pid?: number;
  /**
   * hook 进程自报的耗时（进程启动 → 发出这一条），毫秒。
   *
   * 存在的理由是信任而不是功能（landscape 0.12 / clawd #102）：用户需要一个能核对的
   * 数字来对抗 agent 幻觉出来的「这个插件在烧你的 token」。测量点只能在 hook 里 ——
   * 采集开销的大头是 Node 自己的启动，那段时间 Core 根本还不知道有这次调用。
   * 隐私上与 `pid` 同级：一个本机数字，不携带任何用户内容。
   */
  hook_ms?: number;
}

/**
 * 路径 → 只剩文件名（隐私：目录绝不出 adapter，也绝不进库）。
 * POSIX 与 Windows 分隔符都认；削不出一个像样的文件名（空、`.`、`..`、只有分隔符、
 * 超长）返回 undefined —— 调用方把它当「没有 file」，而不是报一个半截路径上去。
 * adapter（第一道闸）与 ingress（第二道闸）用的是同一份实现；dsh_plugin 必须零依赖，
 * 自带一份等价实现，两处改动必须一起走。
 */
export function fileBasename(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const parts = raw.split(/[\\/]+/).filter((p) => p.length > 0);
  const last = parts[parts.length - 1]?.trim();
  if (!last || last === "." || last === ".." || last.length > 255) return undefined;
  // Windows 盘符（`C:`）不是文件名
  if (parts.length === 1 && /^[A-Za-z]:$/.test(last)) return undefined;
  return last;
}

/**
 * 「改文件」形状的工具（重复编辑检测 R5 的输入）。只看名字，大小写与 `_`/`-` 不敏感：
 * Claude Code 的 Edit / Write / MultiEdit / NotebookEdit，Codex 的 apply_patch，
 * pi / dsh 的小写变体。此前 registry 只认 `Edit`，于是 Write、MultiEdit 和 Codex 的
 * 每一个补丁都不算数。
 */
const EDIT_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit", "applypatch", "editfile", "writefile", "createfile"]);
export function isEditTool(name: unknown): boolean {
  return typeof name === "string" && EDIT_TOOLS.has(name.toLowerCase().replace(/[_-]/g, ""));
}

/* ---------------- Bash 命令前缀（U9） ----------------
 * adapter（第一道闸）从整条命令里削出前缀，ingress（第二道闸）再按形状验一遍，两处共用这里。 */

/** 程序名：不许有 `/`（路径会把目录带进库）、不许有 `=`（变量赋值）、不许有引号 */
const PROGRAM_WORD = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
/** 子命令词：字母开头，不以 `-` 开头（那是参数），不带 `.` 与 `/`（那多半是文件） */
const SUBCOMMAND_WORD = /^[A-Za-z][A-Za-z0-9:_-]{0,31}$/;
/** 一出现就说明这是复合命令 / 重定向 / 替换：前缀不再能说明「会跑什么」，干脆不报 */
const SHELL_OPERATORS = /[;&|<>`$\\\n\r(){}'"*?!#~]/;
export const COMMAND_PREFIX_MAX = 64;

/**
 * 整条 Bash 命令 → 前缀（程序名 + 至多两个子命令词）；说不清楚就返回 undefined。
 * `npm test -- --grep x` → `npm test`；`git log --oneline` → `git log`；`ls -la` → `ls`。
 * 复合命令（`a && b`、管道、`;`）、替换、重定向、变量赋值前缀、路径形状的程序名一律 undefined ——
 * 宁可不给「永远允许」这个选项，也不给一条用户读不懂它会放行什么的规则。
 */
export function commandPrefix(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const command = raw.trim();
  if (!command || SHELL_OPERATORS.test(command)) return undefined;
  const words = command.split(/\s+/);
  const program = words[0]!;
  if (!PROGRAM_WORD.test(program)) return undefined;
  const out = [program];
  for (const w of words.slice(1, 3)) {
    if (!SUBCOMMAND_WORD.test(w)) break;
    out.push(w);
  }
  const prefix = out.join(" ");
  return prefix.length <= COMMAND_PREFIX_MAX ? prefix : undefined;
}

/** 第二道闸：一个值是不是 commandPrefix 能产出的形状（单空格分隔、1–3 个词、每个词合规） */
export function isCommandPrefix(raw: unknown): raw is string {
  if (typeof raw !== "string" || !raw || raw.length > COMMAND_PREFIX_MAX) return false;
  const words = raw.split(" ");
  if (words.length > 3 || !PROGRAM_WORD.test(words[0]!)) return false;
  return words.slice(1).every((w) => SUBCOMMAND_WORD.test(w));
}

/** 权限模式名的形状：一个 ASCII 单词。不在这个形状里的值一律不报 / 不收 */
export function isPermissionMode(raw: unknown): raw is string {
  return typeof raw === "string" && /^[A-Za-z]{1,64}$/.test(raw);
}

/** 标准化事件信封（§3.1） */
export interface CoreEvent {
  event_id: string;
  seq: number;
  agent: AgentId;
  session_id: string;
  project_id: string;
  event_type: EventType;
  severity: Severity;
  safe_summary: string;
  timestamp: string;           // ISO 8601
  payload: EventPayload;
}

/**
 * session 的结束归因。前三个来自 `session_finished` 事件（agent 自己说的），
 * 后两个由僵尸回收写入（G10，见 core/reclaim.ts）：
 *   orphaned —— agent 进程没了（崩溃 / kill -9），`SessionEnd` 永远不会来
 *   timeout  —— 进程在不在不知道，但已经静默超过阈值（休眠、拔网线、adapter 掉了）
 * 这两种都**不是**收工：不结算 EXP，宠物也不播庆祝动画。
 */
export type SessionOutcome = "success" | "partial" | "abandoned" | "orphaned" | "timeout";

/**
 * 这个 session 是被回收的（而不是正常收工的）吗。
 * 渲染层有一份等价实现（`ui/app.js` 的 `reclaimedSession`）—— 浏览器里的 app.js
 * 没法 import 这个模块，两处改动必须一起走。
 */
export function isReclaimed(outcome: string | null | undefined): boolean {
  return outcome === "orphaned" || outcome === "timeout";
}

/**
 * 宠物聚合状态（10 态，README 6.1 / 架构 §2.3）。
 *
 * ## ready 状态设计契约（单一事实来源）
 *
 * `decision_required` 事件被 5 个 adapter 复用来表达两种不同语义，registry 必须按
 * `payload.kind` 分流，不能再一律置 needs-you：
 *
 *   kind = "question"                      → needs-you（阻塞：agent 停下等回答）
 *   kind = "Stop" | "idle" | "blocked" | "Notification"（及其余非 question 值）
 *                                           → ready（非阻塞：一轮结束，待命）
 *   permission_required（任何来源）          → needs-you（阻塞：停下等批准）
 *
 * 聚合优先级（高 → 低）：needs-you > warning > juggling > delegating > working > ready > idle
 * （finished / tired / level-up 由宠物引擎叠加，不在这个排序里）
 *
 * ready 保鲜期：READY_MAX_MS = 15 min（与 idle 阈值一致，见 registry.ts）；
 * 进入 = 收到非 question 的 decision_required；退出 = agent_working 或 session 生命周期。
 * 超过保鲜期后由 last_event_at 判定自然回落（见 registry.ts 的 sessionState）。
 *
 * 视觉：ready 目前复用 idle 外观 —— 素材清单（ui/pets/index.json）的 frames 没有
 * ready 帧（渲染兜底到 base），程序生成宠物（ui/pets/procedural.js）的 stateExpr
 * 显式映射到 normal。加独立素材前，宠物本体在 ready 时与 idle 一致，只有 session
 * 圆点（.s-state.ready）是绿色的。
 *
 * ## subagent 态设计契约（delegating / juggling，landscape 20c / 0.11）
 *
 * `subagent_started` / `subagent_stopped` 维护 `sessions.subagent_count`，它把
 * `working` 细分成三档：
 *
 *   count = 0  → working      自己干
 *   count = 1  → delegating   派出去 1 个，自己在等
 *   count ≥ 2  → juggling     同时盯着好几个
 *
 * 三条约束，每条对应一个在别家产品上真实发生过的 bug：
 *
 *   ① **subagent 收工不是任务收工**（clawd #214）。`subagent_stopped` 只做减法，
 *      绝不写 `ready_since` / `finished_at`，也不清 `needs_input_since` ——
 *      「一个分身回来了」和「这一轮结束了」是两件事，混起来就是告诉用户可以走了。
 *   ② **1 → 2+ 必须升档**（clawd #862）。宠物聚合看的是全部活跃 session 的 subagent
 *      **总数**，不是「有没有 session 在 delegating」—— 两个 session 各派 1 个，
 *      桌面上同时跑着的就是 2 个，宠物该 juggling。
 *   ③ **subagent 态排在 ready 前面**。主 agent 不可能在自己的分身还在跑的时候「待命」，
 *      所以计数 > 0 时的 ready 标记是可疑的（漏收的 stop，或 ① 那种误判），
 *      按 subagent 态渲染。反过来把「还有 3 个在跑」显示成「待命」正是 #214 的症状。
 *
 * 视觉：与 ready 一样没有独立立绘 —— 渲染层回落到 working 帧（ui/pets/registry.js
 * 的 FRAME_FALLBACK），差异由动作（delegating 沉稳、juggling 急促）和绕着宠物转的
 * 小方块（ui/pets/fx.js 的 `helpers`，个数 = subagent 数）表达。
 */
export type PetState =
  | "idle" | "working" | "delegating" | "juggling" | "needs-you" | "warning"
  | "ready" | "finished" | "tired" | "level-up";

export const PET_STATES: PetState[] = [
  "idle", "working", "delegating", "juggling", "needs-you", "warning",
  "ready", "finished", "tired", "level-up",
];

/** Session 状态（Registry 内部） */
export type SessionState =
  | "idle" | "working" | "delegating" | "juggling" | "needs-you" | "warning" | "ready" | "finished";

/** 聚合后的 session 视图（SSE /api/state 输出） */
export interface SessionView {
  agent: AgentId;
  session_id: string;
  project_id: string;
  title: string;
  state: SessionState;
  token_used: number;
  context_pct: number;
  correction_count: number;
  last_event_at: string;
  finished_at: string | null;
  /** agent 卡在「等你」的起始时刻（ISO），null = 不在等 */
  needs_input_since: string | null;
  /** agent 一轮结束待命的起始时刻（ISO），null = 不待命 */
  ready_since: string | null;
  /** 当前在跑的 subagent 个数（0 = 没有）。1 vs 2+ 渲染成不同状态 */
  subagent_count: number;
  /** 计数从 0 变成 1 的那一刻（ISO），null = 当前没有 subagent */
  subagent_since: string | null;
  /** 本段（segment）见过的最高 context 百分比。compaction 不会把它拉低，新一段从 0 开始 */
  context_peak: number;
  /** 本段里「同一个文件 30s 内又改了一次」的次数（所有编辑类工具）。不喂 EXP，见 registry */
  repeat_edit_count: number;
  /** 第几段：同一行 session 被 clear / resume / 收工后再开，都是新的一段（从 1 数） */
  segment: number;
  /** agent 最近一次报上来的权限模式；null = 没报过（非 Claude Code，或老 hook） */
  permission_mode: string | null;
  /** 这次要做什么（设置窗口录入）。有 goal → topic_multiplier 1.1，也是漂移判定的基准 */
  goal: string | null;
  /** 本 session 的 token 预算；null = 跟随设置里的全局默认 */
  budget_tokens: number | null;
  is_active: boolean;
  parent_id: number | null;
  outcome?: string;
  /**
   * 当前这一段的 Session Health（core/health.ts）。null = 这一段被回收了（orphaned / timeout）：
   * 没有分数，不是 0 分（R10）。还在跑的一段也有分 —— 那是临时分，看 `unsettled`。
   */
  health: SessionHealthView | null;
}

/**
 * 分数显示在哪（R30）：off = 哪都不显示；flyout = 只在浮层里；everywhere = 浮层 + 宠物名牌上的 pip 条。
 * 默认 flyout（见 core/settings.ts 的 DEFAULT_HEALTH_VISIBILITY）。
 */
export type HealthVisibility = "off" | "flyout" | "everywhere";

/** Session Health 的四个因子（顺序即界面顺序，见 core/health.ts 的 FACTOR_NAMES） */
export type HealthFactorName = "context" | "focus" | "response" | "outcome";

/** 一段的 Session Health 上线后的样子（SessionView.health；字段即 health.ts HealthResult 的 snake_case 版） */
export interface SessionHealthView {
  /** 0–100，一位小数，在有数据的因子上归一；null = 一个因子都没有（防御，实际上 Focus 总有数） */
  score: number | null;
  /** 每个因子的得分（满分 25）；null = 省略（见 omitted）或没结算（Outcome，见 unsettled） */
  factors: Record<HealthFactorName, number | null>;
  /** 展开一行时说「为什么是这个分」 */
  evidence: {
    /** null = 本段没报过 context */
    context_peak: number | null;
    repeat_edits: number;
    /** null = 没有合格样本 */
    response_median_ms: number | null;
    response_samples: number;
    /** null = 还没结算 */
    outcome: string | null;
    error_count: number;
  };
  /** Outcome 还没来：这一段还在跑。临时分不进日志、当天聚合、周卡（R9） */
  unsettled: boolean;
  /** 因为没数据被省略的因子 —— 界面要说出缺的是哪一个，而不是按满分画。没结算的 Outcome 不在这里 */
  omitted: HealthFactorName[];
}

/**
 * 一天（或任意一组段）的聚合。`mean` 与宠物的 health_score 是同一个数的两种读法：
 * 三因子（不含 Response，KTD4）时长加权平均，health = 它映射到 0.5–1.0 之后。
 */
export interface DayHealthView {
  /** 0–100；null = 不知道（这一天没有结算过的段）—— 不是 0，也不渲染 tired（R31） */
  mean: number | null;
  /** 映射后的宠物健康（0.5–1.0）；null = 不知道 */
  health: number | null;
  /** mean === null 的直白说法：界面画「不知道」而不是一条空的 pip 条 */
  unknown: boolean;
  /** 参与聚合的段数（已结算、没被回收） */
  segments: number;
}

/** GET /api/session_health 的一段（只有已结算、没被回收的） */
export interface SessionHealthHistoryItem {
  agent: string;
  session_id: string;
  segment: number;
  /** 项目短名（projectShortName）。原始 project_id 是绝对路径，永远不出 Core */
  project: string;
  /** 收工那一刻的本地日历日（YYYY-MM-DD） */
  day: string;
  started_at: string | null;
  finished_at: string;
  /** null = 起点缺失（U2 之前的老行没有 segment_started_at） */
  duration_ms: number | null;
  score: number | null;
  /** 三因子分（喂宠物的那个，不含 Response）；daily.mean 是它的时长加权平均 */
  pet_score: number | null;
  factors: Record<HealthFactorName, number | null>;
  omitted: HealthFactorName[];
}

/** GET /api/session_health 的一天 */
export interface SessionHealthDay extends DayHealthView {
  /** 本地日历日（YYYY-MM-DD） */
  day: string;
  /** 四个因子各自的时长加权平均（满分 25）；Response 在这里展示，但不进 mean */
  factors: Record<HealthFactorName, number | null>;
  /** 这一天各段真实时长之和（毫秒） */
  duration_ms: number;
}

/** GET /api/session_health 的响应 */
export interface SessionHealthHistory {
  /** 历史取自哪里：今天是 sessions 表（每行只有最近一段）；U12 之后是 journal */
  source: "sessions" | "journal";
  days: number;
  /** 范围起点：最早那一天的本地午夜（ISO） */
  since: string;
  /** 范围终点：算这份响应的时刻（ISO） */
  until: string;
  /** 按 finished_at 从早到晚 */
  segments: SessionHealthHistoryItem[];
  /** 范围里的**每一个**本地日，从早到晚；没有段的日子 unknown=true、segments=0 */
  daily: SessionHealthDay[];
}

export interface AgentCapabilities {
  agent: AgentId;
  adapter_version?: string;
  events: EventType[];
  resume_command?: string;   // jump-to 模板，如 "claude --resume <id>"
}

/** 已接入的 adapter（SSE 推给界面：空数组 = 没装 hooks，不是「还没干活」） */
export interface AdapterView {
  agent: AgentId;
  adapter_version: string | null;
  capabilities: string[];
  connected_at: string | null;
  last_event_at: string | null;
}

/**
 * 一条通知是怎么结束的（notifications.resolution）。
 *   user_actioned —— 用户在宠物里点了这条气泡（Response 因子要的就是这个时间戳）
 *   inferred      —— 用户没碰气泡，但 agent 自己往下走了（needs-you 被进展事件清掉）：
 *                    多半是在终端里答的，时间里混着 agent 自己的重启
 *   timeout       —— session 被僵尸回收（orphaned / timeout 都算这一种，见 core/reclaim.ts）
 *   dismissed     —— 用户在宠物里叉掉了
 *   muted         —— 被静音吞掉，从来没出现在屏幕上
 * 只记**第一次**结束：被回收之后用户再叉一次，它依然是 timeout。
 */
export type NotificationResolution = "user_actioned" | "inferred" | "timeout" | "dismissed" | "muted";

export const NOTIFICATION_RESOLUTIONS: NotificationResolution[] = [
  "user_actioned",
  "inferred",
  "timeout",
  "dismissed",
  "muted",
];

/**
 * 一段「等你」是怎么结束的（needs_input_waits.resolution）—— 每个清掉
 * `sessions.needs_input_since` 的地方各记一种，Response 因子据此决定一条样本算不算数：
 *   inferred   —— agent 又动了（agent_working）：多半是用户在终端里答了
 *   turn_ended —— agent 说「这一轮结束了」（非阻塞 decision）：权限被拒 / 问题被跳过之后常见
 *   finished   —— session 收工（session_finished）
 *   restarted  —— session 重新开始（session_started：resume / clear / compact / 再次 startup）
 *   timeout    —— 被僵尸回收收掉（core/reclaim.ts）：人走开了的那一种，最长的等待。
 *                 静默丢掉它们会让 Response 把「没人答」报成「答得很快」
 */
export type WaitResolution = "inferred" | "turn_ended" | "finished" | "restarted" | "timeout";

export const WAIT_RESOLUTIONS: WaitResolution[] = ["inferred", "turn_ended", "finished", "restarted", "timeout"];

/**
 * SSE `notification_resolved` 帧：一条气泡已经结束了，界面按 id 撤掉它。
 * 没有这一帧的时候，Core 在库里把气泡标成 dismissed，屏幕上的那一条却要等重启才走。
 */
export interface NotificationResolvedPush {
  id: number;
  agent: string;
  session_id: string;
  type: string;
  resolution: NotificationResolution;
  resolved_at: string;
}

/** 聚合宠物状态推送（SSE） */
export interface PetStatePush {
  type: "pet_state";
  pet: {
    pet_type_id: number;
    name: string;
    level: number;
    exp: number;
    state: PetState;
    health_score: number;
    /** 升级所需 EXP —— 渲染层的 EXP 条分母，漏发会显示成 "37/undefined" */
    next_level_exp: number;
  };
  sessions: SessionView[];
  /** 已接入的 adapter。空数组 = 一个 hook 都没装 —— 界面要说的是「去装 adapter」，
   * 而不是「还没有 session」。这两句话指向完全不同的操作。 */
  adapters: AdapterView[];
  /**
   * 今天（本地午夜起）的 Session Health 聚合 —— 宠物 health_score 的来源，pip 条读的就是它。
   * unknown = 今天还没有一段结算过（包括升级后的第一个早上），不是 0 分（R31）
   */
  health_today: DayHealthView;
  /**
   * 分数显示在哪（R30）。跟着状态推送走而不是让宠物窗口去读 /api/settings：
   * 设置窗口里一改，宠物名牌与浮层下一帧就照做，不必再开一条轮询。
   */
  health_visibility: HealthVisibility;
  /** 当前静音状态：界面要能显示「还剩多久」、点亮对应按钮并原地取消（issue #7） */
  mute: { global_until: number | null; global_minutes: number | null };
  needs_you: SessionView[];
  warning: SessionView[];
  /** 自己干活的 session。**不含** delegating / juggling —— 那两档单独成组，
   * 否则「有没有 subagent 在跑」这件事在 API 层面又被压回一个扁平的 working。 */
  working: SessionView[];
  delegating: SessionView[];
  juggling: SessionView[];
  ready: SessionView[];
  idle: SessionView[];
}
