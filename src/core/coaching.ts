/**
 * 辅导规则目录（U10 / R21 / R22）—— 每一条警告都带一个建议动作和一个可调阈值，
 * 「没用」是一条回路而不是一个垃圾桶：记下理由、把阈值往安静的方向挪一档、且不当场重报。
 *
 * 与 core/rules.ts（「永远允许」的授予）分开放：两者都叫规则，但那边是权限裁决、要壳的钥匙；
 * 这边只是提醒的灵敏度，普通 token 端点就能调。
 *
 * 目录是**数据**：条件、默认阈值、建议动作、能不能调、是不是影子模式。通知引擎按它判定，
 * 设置窗口按它列出来，文案目录测试按它检查每条都有两种语言的动作文案。
 *
 * 误报率是一条查询，不是一句断言（R22）：每条气泡落库时记下是哪条规则、跨的是哪一档
 * （notifications.rule_id / tier），被叉掉时记下理由（dismiss_reason，与 resolution 分开 ——
 * resolution 是「第一次结束」，理由是用户的评价，两件事不能互相覆盖）。
 * falsePositiveRates 按规则 × 周给出「没用」占「真的弹出来过」的比例。
 */
import type Database from "better-sqlite3";
import {
  DEFAULT_CONTEXT_WARN_PCTS,
  getContextWarnPcts,
  getSetting,
  normalizeContextWarnPcts,
  setSetting,
} from "./settings.ts";

export type CoachingRuleId = "context" | "repeat_edit" | "error" | "milestone" | "drift";

export interface CoachingRule {
  id: CoachingRuleId;
  /** 发出来的通知类型（notifications.type） */
  type: string;
  /** 什么时候响（给人读的一句话；判定本身在 notifications.ts 的 evaluate） */
  condition: string;
  /** 建议动作的文案 key —— 每条警告都要告诉用户「那我该做什么」 */
  actionKey: string;
  /** 阈值的形状：tiers = 一组升序档位（跨进更高一档才响）；count = 一个次数 */
  shape: "tiers" | "count";
  /** 默认阈值 */
  defaults: readonly number[];
  /** 「没用」能不能调它 */
  tunable: boolean;
  /** 影子模式：照常判定、照常落库，但不弹气泡、不带分（KTD11 / G18） */
  shadow: boolean;
  /** 往安静的方向挪一次挪多少（tiers：档位加多少；count：次数加多少） */
  step: number;
  /** 最安静能到哪 —— 连按「没用」停在这里，而不是悄悄把最后一档也删掉 */
  quietest: number;
}

/** 里程碑的默认档位（README 6.3 usage 提醒）。notifications.ts 的 TOKEN_MILESTONES 是它 */
export const DEFAULT_MILESTONE_TIERS: readonly number[] = [0.25, 0.5, 0.75, 0.9];

export const COACHING_RULES: readonly CoachingRule[] = Object.freeze([
  {
    id: "context",
    type: "context",
    condition: "a session's context window crosses a warning tier (context_warn_pcts)",
    actionKey: "coach.context.action",
    shape: "tiers",
    defaults: DEFAULT_CONTEXT_WARN_PCTS,
    tunable: true,
    shadow: false,
    step: 5,
    // 97 而不是 99：再往上的警告来的时候 agent 已经在自动压缩了，等于没有
    quietest: 97,
  },
  {
    id: "repeat_edit",
    type: "repeat_edit",
    condition: "the same file is edited again within 30s this many times in one segment (repeat_edit_count)",
    actionKey: "coach.repeat_edit.action",
    shape: "count",
    defaults: [3],
    tunable: true,
    shadow: false,
    step: 1,
    quietest: 8,
  },
  {
    id: "error",
    type: "error",
    condition: "a tool fails; with a threshold of N, every Nth failure in a session",
    actionKey: "coach.error.action",
    shape: "count",
    defaults: [1],
    tunable: true,
    shadow: false,
    step: 1,
    quietest: 5,
  },
  {
    id: "milestone",
    type: "milestone",
    condition: "token use crosses a share of the session budget",
    actionKey: "coach.milestone.action",
    shape: "tiers",
    defaults: DEFAULT_MILESTONE_TIERS,
    tunable: true,
    shadow: false,
    // 里程碑不挪档位，只从低往高摘掉一档；只剩一档时停下
    step: 0,
    quietest: 0.9,
  },
  {
    id: "drift",
    type: "drift",
    condition: "the adapter reports a topic-drift signal",
    actionKey: "coach.drift.action",
    shape: "count",
    defaults: [1],
    tunable: false,
    // 漂移的误报率还过不了 <20% 那条线（G18）：先只记录、不出声，攒够数据再说
    shadow: true,
    step: 0,
    quietest: 1,
  },
]);

export function coachingRule(id: string): CoachingRule | null {
  return COACHING_RULES.find((r) => r.id === id) ?? null;
}

/** 通知类型 → 哪条规则（decision / permission / ready 不是辅导，返回 null） */
export function ruleForType(type: string): CoachingRule | null {
  return COACHING_RULES.find((r) => r.type === type) ?? null;
}

/* ---------------- 阈值的存取 ----------------
 * context 就用设置窗口那一份（context_warn_pcts）：同一个阈值不该有两处可改、各说各的。
 * 其余三条各一个 settings 键；缺 key / 脏值一律回默认。 */

const KEY_PREFIX = "coach.";
const keyFor = (id: CoachingRuleId): string => `${KEY_PREFIX}${id}.threshold`;

function readNumbers(raw: string | null): number[] | null {
  if (raw === null) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    const list = Array.isArray(v) ? v : [v];
    if (list.length === 0 || !list.every((x) => typeof x === "number" && Number.isFinite(x))) return null;
    return (list as number[]).slice().sort((a, b) => a - b);
  } catch {
    return null;
  }
}

/** 这条规则此刻生效的阈值（tiers = 升序档位；count = 一个数的数组） */
export function ruleThreshold(db: Database.Database, id: CoachingRuleId): number[] {
  const rule = coachingRule(id)!;
  if (id === "context") return getContextWarnPcts(db);
  const stored = readNumbers(getSetting(db, keyFor(id)));
  if (!stored) return [...rule.defaults];
  if (rule.shape === "count") {
    const n = Math.round(stored[0]!);
    return [Math.min(rule.quietest, Math.max(rule.defaults[0]!, n))];
  }
  // 里程碑档位只能是默认档位的子集：手改进去的 0.01 不该变成每条事件都响
  const tiers = stored.filter((x) => rule.defaults.includes(x));
  return tiers.length ? tiers : [...rule.defaults];
}

function writeThreshold(db: Database.Database, id: CoachingRuleId, value: number[]): void {
  if (id === "context") setSetting(db, "context_warn_pcts", JSON.stringify(value));
  else setSetting(db, keyFor(id), JSON.stringify(value));
}

/** 回到默认阈值（设置窗口里的「恢复默认」—— 「没用」只会越调越安静，得有一条回来的路） */
export function resetThreshold(db: Database.Database, id: CoachingRuleId): number[] {
  const rule = coachingRule(id)!;
  writeThreshold(db, id, [...rule.defaults]);
  return ruleThreshold(db, id);
}

export interface TuneResult {
  rule: CoachingRuleId;
  changed: boolean;
  /** 已经是最安静的了：这一次只记了理由，阈值没动 */
  atQuietest: boolean;
  before: number[];
  after: number[];
  /**
   * 被按「没用」的那一档，调完之后落在哪一档上（context / milestone：新的那一档；count：新的次数）。
   * 调用方拿它给**这个** session 上闩锁：88% 上按了「没用」、85 挪到 90，
   * 这个 session 不该在 91% 时又因为「新的 90」响一次。null = 那一档整个没了，没有可闩的。
   */
  silencedAt: number | null;
}

/**
 * 「没用」→ 往安静的方向挪一档（纯阈值变换，见 tuneThreshold）并落库。
 * 不可调的规则（drift）原样返回 changed=false。
 */
export function tuneRule(db: Database.Database, id: CoachingRuleId, firedTier: number | null): TuneResult {
  const rule = coachingRule(id)!;
  const before = ruleThreshold(db, id);
  if (!rule.tunable) return { rule: id, changed: false, atQuietest: true, before, after: before, silencedAt: null };
  const r = tuneThreshold(rule, before, firedTier);
  if (r.changed) writeThreshold(db, id, r.after);
  return { rule: id, before, ...r };
}

/**
 * 纯函数：给定当前阈值和被嫌弃的那一档，算出更安静的阈值。
 *   context   那一档 +step；撞上（或越过）上一档 → 这一档并进上一档（删掉它）；
 *             只剩一档时不删，只往上挪，挪到 quietest（97）为止
 *   milestone 摘掉最低的一档；只剩一档（90%）时停下
 *   count     次数 +step，到 quietest 为止
 */
export function tuneThreshold(
  rule: CoachingRule,
  current: readonly number[],
  firedTier: number | null,
): { changed: boolean; atQuietest: boolean; after: number[]; silencedAt: number | null } {
  const same = { changed: false, atQuietest: true, after: [...current], silencedAt: firedTier };
  if (rule.shape === "count") {
    const n = current[0] ?? rule.defaults[0]!;
    if (n >= rule.quietest) return { ...same, silencedAt: n };
    const next = Math.min(rule.quietest, n + rule.step);
    return { changed: true, atQuietest: next >= rule.quietest, after: [next], silencedAt: next };
  }
  if (current.length === 0) return { ...same, silencedAt: null };
  if (rule.id === "milestone") {
    if (current.length <= 1) return same;
    const after = current.slice(1);
    return { changed: true, atQuietest: after.length <= 1, after, silencedAt: after[0] ?? null };
  }
  // context：被嫌弃的那一档。设置在气泡弹出之后又被改过的话，取「不高于它的最高一档」
  const tiers = [...current];
  let i = firedTier === null ? -1 : tiers.indexOf(firedTier);
  if (i < 0 && firedTier !== null) {
    for (let k = tiers.length - 1; k >= 0; k--) {
      if (tiers[k]! <= firedTier) {
        i = k;
        break;
      }
    }
  }
  if (i < 0) i = 0;
  const raised = tiers[i]! + rule.step;
  const upper = tiers[i + 1];
  if (upper !== undefined && raised >= upper) {
    // 并进上一档：这一档不再单独响，这个 session 闩在上一档上
    tiers.splice(i, 1);
    return { changed: true, atQuietest: false, after: tiers, silencedAt: upper };
  }
  if (tiers.length === 1 && tiers[0]! >= rule.quietest) return { ...same, silencedAt: tiers[0]! };
  const value = Math.min(rule.quietest, raised);
  if (value === tiers[i]) return { ...same, silencedAt: value };
  tiers[i] = value;
  // 走一遍设置窗口同一套归一化（升序去重、1..99、最多 3 档），两处永远是同一种形状
  const norm = normalizeContextWarnPcts(tiers);
  const after = norm.ok ? norm.value : tiers;
  const atQuietest = after.length === 1 && after[0]! >= rule.quietest;
  return { changed: true, atQuietest, after, silencedAt: value };
}

/* ---------------- 误报率（R22） ---------------- */

export interface FalsePositiveRow {
  rule: string;
  /** 这一周的周一（UTC，YYYY-MM-DD） */
  week: string;
  /** 真的弹出来过的气泡（不算被静音吞掉的、不算影子模式的） */
  shown: number;
  /** 其中被按了「没用」的 */
  not_useful: number;
  /** 其中被普通地叉掉的 */
  dismissed: number;
  /** 影子模式下判定命中、但没有弹出来的次数（drift 靠它攒数据） */
  shadow: number;
  /** not_useful / shown；这一周一条都没弹出来过 → null（不是 0） */
  ratio: number | null;
}

/**
 * 每条规则每周的误报率：「没用」占「真的弹出来过」的比例。周按 UTC 的周一切 ——
 * shown_at 是 ISO UTC 字符串，按本地周切要把时区带进 SQL，而这个数字是拿来看趋势的，不是记账。
 */
export function falsePositiveRates(db: Database.Database, opts: { weeks?: number; now?: Date } = {}): FalsePositiveRow[] {
  const weeks = Math.min(52, Math.max(1, Math.round(opts.weeks ?? 4)));
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - weeks * 7 * 86_400_000).toISOString();
  const rows = db
    .prepare(
      `SELECT rule_id AS rule,
              date(shown_at, 'weekday 0', '-6 days') AS week,
              SUM(CASE WHEN shadow = 0 AND status != 'muted' THEN 1 ELSE 0 END) AS shown,
              SUM(CASE WHEN shadow = 0 AND status != 'muted' AND dismiss_reason = 'not_useful' THEN 1 ELSE 0 END) AS not_useful,
              SUM(CASE WHEN shadow = 0 AND status != 'muted' AND dismiss_reason = 'dismissed' THEN 1 ELSE 0 END) AS dismissed,
              SUM(CASE WHEN shadow = 1 THEN 1 ELSE 0 END) AS shadow
         FROM notifications
        WHERE rule_id IS NOT NULL AND shown_at >= ?
        GROUP BY rule_id, week
        ORDER BY week, rule_id`,
    )
    .all(since) as Array<Omit<FalsePositiveRow, "ratio">>;
  return rows.map((r) => ({ ...r, ratio: r.shown > 0 ? r.not_useful / r.shown : null }));
}

/** GET /api/coaching：目录 + 现在的阈值 + 误报率 */
export function coachingSnapshot(db: Database.Database, now = new Date()): {
  rules: Array<{
    id: CoachingRuleId;
    type: string;
    condition: string;
    action_key: string;
    shape: "tiers" | "count";
    threshold: number[];
    defaults: number[];
    tunable: boolean;
    shadow: boolean;
    at_quietest: boolean;
  }>;
  false_positive: FalsePositiveRow[];
} {
  return {
    rules: COACHING_RULES.map((r) => {
      const threshold = ruleThreshold(db, r.id);
      return {
        id: r.id,
        type: r.type,
        condition: r.condition,
        action_key: r.actionKey,
        shape: r.shape,
        threshold,
        defaults: [...r.defaults],
        tunable: r.tunable,
        shadow: r.shadow,
        at_quietest: r.tunable ? !tuneThreshold(r, threshold, threshold[0] ?? null).changed : true,
      };
    }),
    false_positive: falsePositiveRates(db, { now }),
  };
}
