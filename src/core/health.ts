/**
 * Session Health —— 一段（segment）session 的 0–100 分（R7–R11 / R31，计划 U3）。
 *
 * 四个因子各 25 分：Context、Focus、Response、Outcome。本文件只有纯函数和导出的常量：
 * 不碰 db、不读时钟 —— 读库的那一层在 health_query.ts，这里是规格本身，
 * EXP 引擎、状态推送、日志、周卡都从这一份判定取数，谁都不必自己再写一遍档位。
 *
 * ## 打分的单位是「一段」
 * clear / resume / 收工后再开都复用同一行 session，registry.startSegment 开新一段并把
 * 本段测量列（context_peak / context_reported_at / repeat_edit_count）清零。所以一行 session
 * 此刻的列描述的就是**当前这一段**；时长 = segment_started_at → finished_at。
 * 一段在 `is_active=1` 或 `finished_at IS NULL` 时还没结算（unsettled）。
 *
 * ## 档位（每个因子满分 25）
 * 已有的倍率只给了边界、没给分数，而且方向是反的（context 高是坏事，分数高是好事），
 * 所以分数是写出来的，不是继承来的：
 *   Context  按本段峰值，比较方式与 exp.ts contextMultiplier 逐字一致：
 *            <70 → 25 · 70–85（含两端）→ 19 · >85–95（含 95）→ 12 · >95 → 6
 *   Focus    按本段重复编辑次数（repeat_edit_count，所有编辑类工具）：
 *            0 → 25 · 1–2 → 20 · 3–4 → 14 · ≥5 → 8
 *            只看 correction（KTD11）；session goal 不计分 —— 给它计分等于给「用没用这个功能」打分。
 *            1–2 / 3–4 两档是新定的数：topicMultiplier 只有一条 ≥5 的线，没有东西可以对齐。
 *   Response 按本段已关闭等待的中位时长：<1m → 25 · 1–5m（含两端）→ 20 · >5–15m（含 15）→ 13 · >15m → 7
 *   Outcome  success 无报错 → 25 · success 有报错（恢复了）→ 20 · partial → 12 · abandoned → 5
 *            orphaned / timeout（被回收）→ 整段不打分（R10）
 *
 * ## 省略（R8 / KTD3）
 * 没有数据的因子报进 `omitted`，分数在剩下的因子上归一到 100 —— 绝不按满分算。
 *   Context  本段从没收到带百分比的 context_update（context_reported_at 为空）→ 省略。
 *            context_peak=0 说不清「很健康」还是「不知道」，所以不看它。
 *   Response 没有一条合格样本 → 省略。bypassPermissions / acceptEdits 模式下阻塞事件根本不会来，
 *            于是整周都是省略 —— 这里就是省略，不另外说模式（显示模式是计划里的开放问题）。
 *   Outcome  没结算时是 null，但**不**算 omitted：它会来的，界面画成虚线槽而不是缺席。
 *            认不出的 outcome 字符串算 omitted（今天不存在，registry 缺省写 success）。
 * 「省略绝不抬分」：归一后的分数 = 剩余因子的平均 × 4。一段根本没阻塞过的 session，
 * 和同一段「阻塞了、一分钟内答了」（Response = 25 = 单因子上限）相比，
 * 后者是在剩余平均（≤ 25）上再加一个 25 —— 只会相等或更高。health.test.ts 把这条枚举测了一遍。
 *
 * ## 宠物的健康（R11 / KTD4 / KTD5）
 * `pets.health_score` 只看 Context / Focus / Outcome 三个因子（petScore）。Response 衡量的是
 * 「人在不在桌前」，午饭、开会、跑一整夜都会拉低它 —— 让它喂进进化门槛，就是在惩罚用户
 * 挣到的进化。三因子分再按时长加权取当天平均（dayMean），然后**映射**到旧函数的取值范围
 * （petHealthFromMean）—— 映射的推导与目标 tired 率见那个函数的注释。
 */
import { isReclaimed } from "./events.ts";

/* ================= 因子 ================= */

export type FactorName = "context" | "focus" | "response" | "outcome";

/** 四个因子的固定顺序：每个界面都按这个顺序、用这四个名字 */
export const FACTOR_NAMES: readonly FactorName[] = ["context", "focus", "response", "outcome"];

/** 每个因子的满分 */
export const FACTOR_MAX = 25;

/** 喂宠物健康的三个因子（KTD4：Response 只展示，不喂宠物、不进进化门槛） */
export const PET_FACTORS: readonly FactorName[] = ["context", "focus", "outcome"];

/** Context：按本段峰值。比较方式照抄 exp.ts contextMultiplier（< 70 / <= 85 / <= 95） */
export function contextPoints(peak: number): number {
  if (peak < 70) return 25;
  if (peak <= 85) return 19;
  if (peak <= 95) return 12;
  return 6;
}

/** Focus：按本段重复编辑次数 */
export function focusPoints(repeatEdits: number): number {
  if (repeatEdits <= 0) return 25;
  if (repeatEdits <= 2) return 20;
  if (repeatEdits <= 4) return 14;
  return 8; // correction loop（与 topicMultiplier 的 >= 5 同一条线）
}

const MINUTE_MS = 60_000;

/** Response：按合格样本的中位等待时长（毫秒） */
export function responsePoints(medianMs: number): number {
  if (medianMs < MINUTE_MS) return 25;
  if (medianMs <= 5 * MINUTE_MS) return 20;
  if (medianMs <= 15 * MINUTE_MS) return 13;
  return 7;
}

/**
 * Outcome：镜像 exp.ts outcomeBonus 的三种收工方式（success +20 / partial +5 / abandoned 0），
 * success 再按本段有没有报过错（session_error）拆成两档。
 * 返回 null = 不打分：被回收（orphaned / timeout）或者认不出来的值。
 */
export function outcomePoints(outcome: string, errorCount: number): number | null {
  if (isReclaimed(outcome)) return null;
  switch (outcome) {
    case "success":
      return errorCount > 0 ? 20 : 25;
    case "partial":
      return 12;
    case "abandoned":
      return 5;
    default:
      return null;
  }
}

/* ================= Response 的样本 ================= */

/** 等待账本（needs_input_waits）的一行，已换成驼峰 */
export interface WaitSample {
  startedAt: string;
  receivedAt: string;
  /** null = 还在等 */
  clearedAt: string | null;
  /** WaitResolution；null = 还在等 */
  resolution: string | null;
  mutedMs: number;
  sleptMs: number;
}

/**
 * 单条样本的上限：沿用 registry 的 NEEDS_INPUT_MAX_MS（30 分钟）安全阀。
 * 超过的**夹到上限**而不是丢掉：一段 14 小时的等待说的是「没人答」，丢掉它 Response 就会
 * 把走开了报成答得快（reclaim 收掉的 timeout 行尤其如此）。
 */
export const RESPONSE_SAMPLE_CAP_MS = 30 * MINUTE_MS;

/**
 * 离线缓冲回放的判据：Core 收到那条 needs-you 事件的时刻（received_at）比事件自己的时间戳
 * （started_at）晚这么多，就是 adapter 在 Core 不在的时候先写进了 spool、之后补发的 ——
 * 那一段的时长不是用户的真实等待（用户根本没看到气泡）。
 * 正常投递是本机 HTTP，差值是毫秒级；hook 超时是 5s 级。取 60s 给时钟抖动留足余量。
 */
export const SPOOL_REPLAY_GAP_MS = 60_000;

/**
 * 亚秒级的 turn_ended 是伪影，不是等待：Claude Code 常在 PermissionRequest 之后几百毫秒内
 * 补一条 Notification hook，它映射成非阻塞 decision，把刚开的等待以 turn_ended 关掉。
 * 这些零长度的行要是算进去，一串伪影能把一个真实的 20 分钟等待「稀释」成中位 0 秒、满分。
 * 只丢 turn_ended：inferred（agent 又动了）在一秒内关掉，是用户真的秒答了。
 */
export const ARTEFACT_WAIT_MS = 1000;

/**
 * 一条等待行 → 样本时长（毫秒），或 null（这条不算数）。不算数的：
 *   · 还没关的（cleared_at 为空）—— 只有关掉的行 muted_ms 是准的
 *   · 跨过休眠的（slept_ms > 0）—— 机器睡着了，不是人没答
 *   · 整段被静音的（muted_ms ≥ 时长）—— 气泡从头到尾没出现过
 *   · 离线缓冲补发的（received_at − started_at > SPOOL_REPLAY_GAP_MS）
 *   · 亚秒级的 turn_ended 伪影（< ARTEFACT_WAIT_MS）
 * 其余的夹到 RESPONSE_SAMPLE_CAP_MS。
 */
export function responseSampleMs(w: WaitSample): number | null {
  if (w.clearedAt === null) return null;
  const started = Date.parse(w.startedAt);
  const cleared = Date.parse(w.clearedAt);
  if (!Number.isFinite(started) || !Number.isFinite(cleared)) return null;
  const duration = Math.max(0, cleared - started);
  if (w.sleptMs > 0) return null;
  if (w.mutedMs > 0 && w.mutedMs >= duration) return null;
  const received = Date.parse(w.receivedAt);
  if (Number.isFinite(received) && received - started > SPOOL_REPLAY_GAP_MS) return null;
  if (w.resolution === "turn_ended" && duration < ARTEFACT_WAIT_MS) return null;
  return Math.min(duration, RESPONSE_SAMPLE_CAP_MS);
}

/** 中位数；空集 null。偶数个取中间两个的平均 */
export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/* ================= 一段 ================= */

/** 打一段分需要的全部输入（纯数据；从库里取见 health_query.ts） */
export interface SegmentInput {
  /** 本段 context 峰值（0–100） */
  contextPeak: number;
  /** 本段收到过带百分比的 context_update 吗（否则 Context 省略） */
  contextReported: boolean;
  /** 本段重复编辑次数（repeat_edit_count） */
  repeatEdits: number;
  /** 本段的等待账本行（关没关都可以传，没关的自动不算） */
  waits: readonly WaitSample[];
  /** sessions.outcome；没结算时为 null */
  outcome: string | null;
  /** 本段里的 session_error 次数（拆 success 的两档） */
  errorCount: number;
  /** 结算了吗（is_active=0 且 finished_at 非空） */
  settled: boolean;
  /** segment_started_at */
  startedAt: string | null;
  /** finished_at（本段的） */
  finishedAt: string | null;
}

/** 分数背后的证据：展开一行时界面拿它说「为什么是这个分」 */
export interface HealthEvidence {
  /** null = 本段没报过 context */
  contextPeak: number | null;
  repeatEdits: number;
  /** null = 没有合格样本 */
  responseMedianMs: number | null;
  responseSamples: number;
  /** null = 还没结算 */
  outcome: string | null;
  errorCount: number;
}

export interface HealthResult {
  /**
   * 0–100（一位小数），在有数据的因子上归一。没结算的一段也有分：那是临时分，
   * Outcome 不在里面 —— 看 `unsettled`，临时分不许写进日志、当天聚合或周卡（R9）。
   * null = 一个因子都没有（实际上 Focus 总有数，留着防御）。
   */
  score: number | null;
  /** 每个因子的得分（满分 FACTOR_MAX）；null = 省略或没结算 */
  factors: Record<FactorName, number | null>;
  evidence: HealthEvidence;
  /** Outcome 还没来：这一段还在跑 */
  unsettled: boolean;
  /** 因为没数据而被省略的因子（FACTOR_NAMES 的顺序）。没结算的 Outcome 不在这里 */
  omitted: FactorName[];
}

/** 在给定因子里、有分的那些上归一到 0–100（一位小数）；一个都没有 → null */
function normalise(factors: Record<FactorName, number | null>, names: readonly FactorName[]): number | null {
  let sum = 0;
  let n = 0;
  for (const name of names) {
    const p = factors[name];
    if (p === null) continue;
    sum += p;
    n += 1;
  }
  if (n === 0) return null;
  return round1((sum / (n * FACTOR_MAX)) * 100);
}

/**
 * 给一段打分。被回收（orphaned / timeout）的一段返回 null —— 没有分数，不是 0 分（R10）。
 */
export function scoreSegment(input: SegmentInput): HealthResult | null {
  if (isReclaimed(input.outcome)) return null;

  const omitted: FactorName[] = [];

  const context = input.contextReported ? contextPoints(input.contextPeak) : null;
  if (context === null) omitted.push("context");

  const focus = focusPoints(input.repeatEdits);

  const samples: number[] = [];
  for (const w of input.waits) {
    const ms = responseSampleMs(w);
    if (ms !== null) samples.push(ms);
  }
  const responseMedianMs = median(samples);
  const response = responseMedianMs === null ? null : responsePoints(responseMedianMs);
  if (response === null) omitted.push("response");

  const unsettled = !input.settled;
  let outcome: number | null = null;
  if (!unsettled) {
    outcome = input.outcome === null ? null : outcomePoints(input.outcome, input.errorCount);
    if (outcome === null) omitted.push("outcome");
  }

  const factors: Record<FactorName, number | null> = { context, focus, response, outcome };
  return {
    score: normalise(factors, FACTOR_NAMES),
    factors,
    evidence: {
      contextPeak: input.contextReported ? input.contextPeak : null,
      repeatEdits: input.repeatEdits,
      responseMedianMs,
      responseSamples: samples.length,
      outcome: unsettled ? null : input.outcome,
      errorCount: input.errorCount,
    },
    unsettled,
    omitted,
  };
}

/** 宠物分：只在 Context / Focus / Outcome 上归一（KTD4）。Response 永远不进来 */
export function petScore(result: HealthResult): number | null {
  return normalise(result.factors, PET_FACTORS);
}

/* ================= 一天 ================= */

/**
 * 按时长加权的下限（KTD10）：一行 30 秒的 `claude -p` 按 5 分钟算权重。
 * 不加权的平均会让它和一段四小时的 session 一样重；完全按时长加权又会让它几乎等于 0，
 * 而一段秒退的 session 确实说明了点什么。
 */
export const DURATION_FLOOR_MS = 5 * MINUTE_MS;

/** 一段的时长（segment_started_at → finished_at）；没结算或时间戳坏了 → null。时钟倒退夹 0 */
export function segmentDurationMs(input: Pick<SegmentInput, "startedAt" | "finishedAt">): number | null {
  if (!input.startedAt || !input.finishedAt) return null;
  const a = Date.parse(input.startedAt);
  const b = Date.parse(input.finishedAt);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, b - a);
}

/**
 * 当天的宠物分：已结算、没被回收的段，按 max(时长, DURATION_FLOOR_MS) 加权取 petScore 的平均。
 * 没结算的段不进来（R9）。一段都没有 → null：不知道，不是 0（R31）。
 */
export function dayMean(segments: readonly SegmentInput[]): number | null {
  let weighted = 0;
  let total = 0;
  for (const s of segments) {
    if (!s.settled) continue;
    const r = scoreSegment(s);
    if (!r || r.unsettled) continue;
    const p = petScore(r);
    if (p === null) continue;
    const w = Math.max(segmentDurationMs(s) ?? 0, DURATION_FLOOR_MS);
    weighted += p * w;
    total += w;
  }
  if (total === 0) return null;
  return round1(weighted / total);
}

/**
 * 当天平均 ≥ 这个值 → 健康满格 1.0。
 * 旧函数（24 小时内 session_error + topic_drift_warning 每条 −0.1，下限 0.5）的意图是
 * 「普通的一天」返回 1.0。新档位下普通的一天大约落在 60–85（例：context 走到 70–85、改错一两次、
 * 顺利收工 = (19+20+25)/75 = 85；撞到 88%、改错 3 次、报过错 = 61），
 * 所以 60 以上一律满格 —— 与旧函数在普通日子上的读数一致。
 */
export const HEALTH_FULL_AT = 60;
/** 当天平均 ≤ 这个值 → 落到下限 */
export const HEALTH_FLOOR_AT = 30;
/** 下限：取代旧函数的 `Math.max(0.5, …)`，宠物不会因为一天打得差而「病死」（README 6.4） */
export const HEALTH_FLOOR = 0.5;

/**
 * 当天平均（0–100）→ pets.health_score（0.5–1.0）。null 进 null 出（不知道）。
 *
 *   mean ≥ HEALTH_FULL_AT(60)                    → 1.0
 *   HEALTH_FLOOR_AT(30) < mean < HEALTH_FULL_AT  → 0.5 + 0.5 × (mean − 30) / 30   （线性）
 *   mean ≤ HEALTH_FLOOR_AT(30)                   → 0.5（HEALTH_FLOOR）
 *
 * 为什么是映射而不是 mean ÷ 100（KTD5）：普通的一天落在 60 上下，直接除会让 tired（< 0.7）
 * 成为常态 —— 自成长暂停、进化被扣，干得越多宠物越停滞。
 * tired 线（TIRED_HEALTH_THRESHOLD = 0.7，不动）对应 mean < 42：要一整天都在
 * correction loop / 撞满 context / 放弃收场才碰得到，例如 (12+14+12)/75 = 50.7 还不累，
 * (6+8+12)/75 = 34.7 就累了。
 *
 * 目标 tired 率：普通的日子 0%，只有当天打分真的差才累；无论如何不高于旧函数。
 * 本机历史回放（scripts/backfill_health.ts，2026-08-19 → 09-21 两个库、149 段、153 个活跃小时）：
 * 旧函数实际上有 61–85% 的活跃小时是 tired —— 它的意图是「没报错的一天 = 1.0」，
 * 但 Claude Code 的 PostToolUseFailure 每次工具失败都记一条 session_error，24 小时 ≥ 4 条是常态。
 * 新映射在同一批数据上 tired 0%（每天的时长加权均值 89–100，全部满格）。
 * 所以「保持旧分布」保持的是旧函数的**意图**（普通的一天读作健康），不是它实测的读数。
 * 这批数据偏乐观：U2 之前的 adapter 不报编辑目标，老数据的 Focus 几乎全满 ——
 * 新数据只会更低，HEALTH_FULL_AT 为此留了 30 分的余量。
 */
export function petHealthFromMean(mean: number | null): number | null {
  if (mean === null) return null;
  if (mean >= HEALTH_FULL_AT) return 1;
  if (mean <= HEALTH_FLOOR_AT) return HEALTH_FLOOR;
  const t = (mean - HEALTH_FLOOR_AT) / (HEALTH_FULL_AT - HEALTH_FLOOR_AT);
  return round2(HEALTH_FLOOR + (1 - HEALTH_FLOOR) * t);
}

/* ================= 行 → 输入 ================= */

/** sessions 表里打分要用的列（本段的） */
export interface SessionHealthRow {
  segment: number;
  segment_started_at: string | null;
  context_peak: number;
  context_reported_at: string | null;
  repeat_edit_count: number;
  finished_at: string | null;
  outcome: string | null;
  is_active: number;
}

/** needs_input_waits 表里打分要用的列 */
export interface WaitRow {
  started_at: string;
  received_at: string;
  cleared_at: string | null;
  resolution: string | null;
  muted_ms: number;
  slept_ms: number;
}

/**
 * 库里的行 → SegmentInput。放在这里而不是 health_query.ts：列怎么解读（context_reported_at
 * 为空 = 不知道、is_active=1 或 finished_at 为空 = 没结算）是打分规格的一部分。
 * waits 只该是**本段**的行（agent, session_id, segment 三者一致），由调用方筛。
 */
export function segmentInputFromRows(row: SessionHealthRow, waits: readonly WaitRow[], errorCount: number): SegmentInput {
  const settled = !row.is_active && row.finished_at !== null;
  return {
    contextPeak: Number(row.context_peak) || 0,
    contextReported: row.context_reported_at !== null,
    repeatEdits: Number(row.repeat_edit_count) || 0,
    waits: waits.map((w) => ({
      startedAt: w.started_at,
      receivedAt: w.received_at,
      clearedAt: w.cleared_at,
      resolution: w.resolution,
      mutedMs: Number(w.muted_ms) || 0,
      sleptMs: Number(w.slept_ms) || 0,
    })),
    outcome: settled ? row.outcome : null,
    errorCount,
    settled,
    startedAt: row.segment_started_at,
    finishedAt: settled ? row.finished_at : null,
  };
}

function round1(v: number): number {
  return Math.round(v * 10) / 10;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
