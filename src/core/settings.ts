/**
 * Vibepaws settings 辅助：读写 settings 表（含 API token 生命周期）。
 *
 * 本文件同时是「设置窗口」的规格来源：可调项的默认值、取值范围与归一化规则全部
 * 集中在这里 —— HTTP 端点、设置界面、通知/EXP 引擎共用同一份判定，谁都不必自己
 * 再写一遍「预算是不是负数」。在这之前这些值只能手改 SQLite，于是没有任何一层
 * 校验过它们：`budget_tokens = -1` 或 `daily_exp_cap = 0` 都写得进去，
 * 而后果（里程碑永不触发 / token EXP 全被吃掉）在界面上完全看不出原因。
 */
import type Database from "better-sqlite3";
import { randomBytes } from "node:crypto";

export function getSetting(db: Database.Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(db: Database.Database, key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function deleteSetting(db: Database.Database, key: string): void {
  db.prepare("DELETE FROM settings WHERE key = ?").run(key);
}

/** 获取或生成 API token（安装时写入，防本机其他进程伪造事件） */
export function getApiToken(db: Database.Database): string {
  const existing = getSetting(db, "api_token");
  if (existing) return existing;
  const token = randomToken();
  setSetting(db, "api_token", token);
  return token;
}

export function randomToken(): string {
  return randomBytes(24).toString("hex");
}

/* ================= 用户可调项 ================= */

/** 键名沿用引擎早就在读的那几个（老库无需迁移） */
const KEY_BUDGET = "budget_tokens";
const KEY_DAILY_CAP = "daily_exp_cap";
const KEY_WARN_PCTS = "context_warn_pcts";

/** 默认 token 预算：0 = 关掉里程碑提醒（没有分母就没有百分比可报） */
export const DEFAULT_BUDGET_TOKENS = 0;
/** 每日 token EXP 上限（防 token farming，README 6.4） */
export const DEFAULT_DAILY_EXP_CAP = 200;
/** context 警告阈值（README 6.3）。空数组 = 关掉 context 警告。 */
export const DEFAULT_CONTEXT_WARN_PCTS: readonly number[] = [70, 85, 95];

/**
 * 上限存在的唯一理由：手滑输进去的 1e12 不该变成一个永久生效的荒谬值。
 * 界面把这些数字读回去当 input 的 max —— 前后端不各写一份，就不会各错一份。
 */
export const SETTINGS_LIMITS = {
  budget_tokens_max: 100_000_000,
  daily_exp_cap_max: 100_000,
  pet_name_max: 24,
  goal_max: 200,
  warn_pcts_max: 3,
} as const;

export interface VibepawsSettings {
  /** 默认 token 预算（0 = 关闭里程碑提醒）；session 自己的 budget_tokens 优先 */
  budget_tokens: number;
  daily_exp_cap: number;
  /** 升序，最多 3 档；空 = 关闭 context 警告 */
  context_warn_pcts: number[];
}

/**
 * 归一化结果。三种结局分得很清楚，因为它们对应三种完全不同的界面反馈：
 *   ok=false          → 这个值根本读不成数字/数组：整份 patch 一起拒（不留半套生效）
 *   ok, clamped=false → 原样收下
 *   ok, clamped=true  → 收进了合法区间，但**不是**用户填的那个数，必须说出来
 */
export type Normalized<T> = { ok: true; value: T; clamped: boolean } | { ok: false };

const INVALID = { ok: false } as const;

function normInt(raw: unknown, min: number, max: number): Normalized<number> {
  const n = typeof raw === "string" ? Number(raw.trim()) : raw;
  if (typeof n !== "number" || !Number.isFinite(n)) return INVALID;
  const rounded = Math.round(n);
  const value = Math.min(max, Math.max(min, rounded));
  return { ok: true, value, clamped: value !== rounded };
}

export function normalizeBudgetTokens(raw: unknown): Normalized<number> {
  return normInt(raw, 0, SETTINGS_LIMITS.budget_tokens_max);
}

/** 下限是 1 而不是 0：cap=0 会让 token EXP 全部落空，那不是「无上限」而是「全没了」 */
export function normalizeDailyExpCap(raw: unknown): Normalized<number> {
  return normInt(raw, 1, SETTINGS_LIMITS.daily_exp_cap_max);
}

/** session 级预算：0 / null = 跟随全局默认（列写 NULL，读取时自然回落） */
export function normalizeSessionBudget(raw: unknown): Normalized<number | null> {
  if (raw === null || raw === "") return { ok: true, value: null, clamped: false };
  const n = normalizeBudgetTokens(raw);
  if (!n.ok) return INVALID;
  return { ok: true, value: n.value > 0 ? n.value : null, clamped: n.clamped };
}

/** 阈值列表：升序去重、收进 1..99、最多 3 档。空数组 = 关闭。 */
export function normalizeContextWarnPcts(raw: unknown): Normalized<number[]> {
  const list = typeof raw === "string" ? (raw.trim() === "" ? [] : raw.split(",")) : raw;
  if (!Array.isArray(list)) return INVALID;
  const out: number[] = [];
  let clamped = false;
  for (const item of list) {
    const n = typeof item === "string" ? Number(item.trim()) : item;
    if (typeof n !== "number" || !Number.isFinite(n)) return INVALID;
    const rounded = Math.round(n);
    // ≤0 当成「这一档不要」，而不是判整份非法：界面清空一格就该是「少一档」
    if (rounded <= 0) {
      clamped = true;
      continue;
    }
    const value = Math.min(99, rounded);
    if (value !== rounded || out.includes(value)) clamped = true;
    if (!out.includes(value)) out.push(value);
  }
  out.sort((a, b) => a - b);
  if (out.length > SETTINGS_LIMITS.warn_pcts_max) {
    // 留最低的几档：多报一次不如漏报一次，早提醒总比晚提醒安全
    out.length = SETTINGS_LIMITS.warn_pcts_max;
    clamped = true;
  }
  return { ok: true, value: out, clamped };
}

/**
 * 文本归一化（宠物名 / session goal）。
 * 控制字符要清掉：这两个框的内容常常是从终端里粘过来的，会带上 \r 和折行。
 * 裁剪按**码点**走，不然一个 emoji 名字会被劈成半个代理对。
 * 空串 → null，语义是「清空」（宠物名回落物种名，goal 回落无目标）。
 */
export function normalizeText(raw: unknown, max: number): Normalized<string | null> {
  if (raw === null) return { ok: true, value: null, clamped: false };
  if (typeof raw !== "string") return INVALID;
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (cleaned === "") return { ok: true, value: null, clamped: false };
  const points = [...cleaned];
  const value = points.slice(0, max).join("");
  return { ok: true, value, clamped: points.length > max };
}

/* ---- 读取（引擎热路径：每项一次带索引的单行查询） ---- */

export function getDefaultBudgetTokens(db: Database.Database): number {
  const raw = getSetting(db, KEY_BUDGET);
  if (raw === null) return DEFAULT_BUDGET_TOKENS;
  const n = normalizeBudgetTokens(raw);
  return n.ok ? n.value : DEFAULT_BUDGET_TOKENS;
}

/**
 * 每日 EXP 上限。非正数与脏值一律按默认走 —— 保持老行为：
 * 手改成 0 的库过去等于「用默认 200」，改判成 1 会让那些用户的宠物突然不长了。
 */
export function getDailyExpCap(db: Database.Database): number {
  const n = Number(getSetting(db, KEY_DAILY_CAP) ?? "");
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DAILY_EXP_CAP;
  return Math.min(SETTINGS_LIMITS.daily_exp_cap_max, Math.round(n));
}

/**
 * context 警告阈值。缺 key = 用默认；存的是 `[]` = 用户明确关掉了警告 ——
 * 这两件事必须分开，否则「关闭」永远会被下一次读取还原成默认的三档。
 */
export function getContextWarnPcts(db: Database.Database): number[] {
  const raw = getSetting(db, KEY_WARN_PCTS);
  if (raw === null) return [...DEFAULT_CONTEXT_WARN_PCTS];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [...DEFAULT_CONTEXT_WARN_PCTS];
  }
  const n = normalizeContextWarnPcts(parsed);
  return n.ok ? n.value : [...DEFAULT_CONTEXT_WARN_PCTS];
}

export function readSettings(db: Database.Database): VibepawsSettings {
  return {
    budget_tokens: getDefaultBudgetTokens(db),
    daily_exp_cap: getDailyExpCap(db),
    context_warn_pcts: getContextWarnPcts(db),
  };
}

/* ---- 写入 ---- */

export interface ParsedSettingsPatch {
  /** 结构上读不成合法值的字段名（非空 → 整份 patch 拒掉，一个字段都不写） */
  invalid: string[];
  /** 被收进合法区间的字段名（界面据此提示「已改成 X」，而不是默默换个数） */
  clamped: string[];
  settings: Partial<VibepawsSettings>;
  /** 存在这个键才表示「要改名」；null = 清空（回落物种名） */
  pet_name?: string | null;
}

/**
 * 解析设置 patch。只认识的字段会被处理，未知字段直接忽略 ——
 * 校验与写入分成两步，是为了「要么全生效，要么全不生效」：
 * 一份 patch 里有个非法值时，不该有一半设置已经落库了。
 */
export function parseSettingsPatch(raw: unknown): ParsedSettingsPatch {
  const out: ParsedSettingsPatch = { invalid: [], clamped: [], settings: {} };
  if (!raw || typeof raw !== "object") {
    out.invalid.push("body");
    return out;
  }
  const body = raw as Record<string, unknown>;

  if ("budget_tokens" in body) {
    const n = normalizeBudgetTokens(body.budget_tokens);
    if (!n.ok) out.invalid.push("budget_tokens");
    else {
      out.settings.budget_tokens = n.value;
      if (n.clamped) out.clamped.push("budget_tokens");
    }
  }
  if ("daily_exp_cap" in body) {
    const n = normalizeDailyExpCap(body.daily_exp_cap);
    if (!n.ok) out.invalid.push("daily_exp_cap");
    else {
      out.settings.daily_exp_cap = n.value;
      if (n.clamped) out.clamped.push("daily_exp_cap");
    }
  }
  if ("context_warn_pcts" in body) {
    const n = normalizeContextWarnPcts(body.context_warn_pcts);
    if (!n.ok) out.invalid.push("context_warn_pcts");
    else {
      out.settings.context_warn_pcts = n.value;
      if (n.clamped) out.clamped.push("context_warn_pcts");
    }
  }
  if ("pet_name" in body) {
    const n = normalizeText(body.pet_name, SETTINGS_LIMITS.pet_name_max);
    if (!n.ok) out.invalid.push("pet_name");
    else {
      out.pet_name = n.value;
      if (n.clamped) out.clamped.push("pet_name");
    }
  }
  return out;
}

/** 落库；返回**真的变了**的键名（调用方据此决定要不要重置通知闩锁） */
export function applySettingsPatch(db: Database.Database, patch: Partial<VibepawsSettings>): string[] {
  const before = readSettings(db);
  const changed: string[] = [];
  if (patch.budget_tokens !== undefined && patch.budget_tokens !== before.budget_tokens) {
    setSetting(db, KEY_BUDGET, String(patch.budget_tokens));
    changed.push("budget_tokens");
  }
  if (patch.daily_exp_cap !== undefined && patch.daily_exp_cap !== before.daily_exp_cap) {
    setSetting(db, KEY_DAILY_CAP, String(patch.daily_exp_cap));
    changed.push("daily_exp_cap");
  }
  if (patch.context_warn_pcts !== undefined) {
    const next = patch.context_warn_pcts;
    const same = next.length === before.context_warn_pcts.length && next.every((v, i) => v === before.context_warn_pcts[i]);
    // 即使值没变也要写一次：默认值过去是「缺 key」，写进去才能把「我要这三档」
    // 和「我还没表态」区分开（否则改完默认档再改回来会被当成从未设置过）
    setSetting(db, KEY_WARN_PCTS, JSON.stringify(next));
    if (!same) changed.push("context_warn_pcts");
  }
  return changed;
}

export interface ParsedSessionPatch {
  invalid: string[];
  clamped: string[];
  patch: { goal?: string | null; budget_tokens?: number | null };
}

/** session 级 patch（goal / budget_tokens）—— G17 的录入口 */
export function parseSessionPatch(raw: unknown): ParsedSessionPatch {
  const out: ParsedSessionPatch = { invalid: [], clamped: [], patch: {} };
  if (!raw || typeof raw !== "object") {
    out.invalid.push("body");
    return out;
  }
  const body = raw as Record<string, unknown>;
  if ("goal" in body) {
    const n = normalizeText(body.goal, SETTINGS_LIMITS.goal_max);
    if (!n.ok) out.invalid.push("goal");
    else {
      out.patch.goal = n.value;
      if (n.clamped) out.clamped.push("goal");
    }
  }
  if ("budget_tokens" in body) {
    const n = normalizeSessionBudget(body.budget_tokens);
    if (!n.ok) out.invalid.push("budget_tokens");
    else {
      out.patch.budget_tokens = n.value;
      if (n.clamped) out.clamped.push("budget_tokens");
    }
  }
  return out;
}
