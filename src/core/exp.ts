/**
 * EXP / 健康 / 进化引擎 — README 6.4/6.5。
 *
 * session_exp = capped_token_exp × context_multiplier × topic_multiplier
 *             + outcome_bonus + daily_care_bonus
 * capped_token_exp: 每 1000 tokens = 1 EXP，每日 cap（防 token farming）
 * context_multiplier: <70%→1.10 · 70–85%→1.00 · 85–95%→0.75 · >95%→0.50
 * topic_multiplier:   goal 一致→1.10 · correction loop→0.80
 * outcome_bonus:      success→+20 · partial→+5 · abandoned→0
 * daily_care_bonus:   休息后恢复新 session → +5
 * self_growth:        每小时 +0.1 EXP（tired 暂停）
 * 进化: 纯配置 {from_level, conditions, to_stage}；发生时经 onEvolve 交给 server（气泡 + 日志，R29）
 * health:             今天已结算段的 Session Health（Context / Focus / Outcome，时长加权）
 *                     映射到 0.5–1.0（core/health.ts petHealthFromMean）；今天还没有 → 按 1.0
 */
import type Database from "better-sqlite3";
import type { CoreEvent, EvolutionStatus, ExpSource, GrowthView, PetState } from "./events.ts";
import type { HabitProfile } from "./habit.ts";
import { getDailyExpCap } from "./settings.ts";
import { localDayKey, localDayStart, todayHealth, type DayHealth } from "./health_query.ts";
import { EVOLUTION_HEALTH_GATE, type EvolutionRecord } from "./journal.ts";

export interface PetSnapshot {
  id: number;
  pet_type_id: number;
  /** 显示名：用户起的名字优先，没起过就是物种名 */
  name: string | null;
  /** 用户起的名字本身（null = 没起过）。设置窗口要靠它区分「输入框的值」和「占位提示」 */
  custom_name: string | null;
  /** 物种名（设置窗口把它当占位符：清空名字就会回落到这个） */
  species: string | null;
  level: number;
  exp: number;
  state: PetState;
  health_score: number;
  daily_exp: number;
  next_level_exp: number;
}
/** 每 1000 tokens = 1 EXP */
const TOKEN_EXP_RATE = 1 / 1000;
/** 每小时自成长 */
const SELF_GROWTH_PER_HOUR = 0.1;
/** 健康分低于这个值算「累了」：自成长暂停，宠物在闲下来时显示 tired（README 6.4） */
export const TIRED_HEALTH_THRESHOLD = 0.7;

/** starter 抽取权重：越稀有越难滚到 */
export const RARITY_WEIGHT: Record<string, number> = {
  common: 6,
  uncommon: 3,
  rare: 1,
  legendary: 1,
};

export function rarityWeight(rarity: string): number {
  return RARITY_WEIGHT[rarity] ?? 1;
}

export function contextMultiplier(pct: number): number {
  if (pct <= 0) return 1.0; // 未知 context（尚无事件）视为中性
  if (pct < 70) return 1.1;
  if (pct <= 85) return 1.0;
  if (pct <= 95) return 0.75;
  return 0.5;
}

export function topicMultiplier(correctionCount: number, hasGoal: boolean): number {
  if (correctionCount >= 5) return 0.8; // correction loop
  if (hasGoal) return 1.1; // goal 一致
  return 1.0;
}

export function outcomeBonus(outcome: string): number {
  switch (outcome) {
    case "success":
      return 20;
    case "partial":
      return 5;
    default:
      return 0;
  }
}

export class ExpEngine {
  private db: Database.Database;
  /** 进化的那一刻（R29）。server 注入：发 evolution 气泡 + 写日志。这里只负责说「发生了」 */
  onEvolve?: (e: EvolutionRecord) => void;
  /** 由 server 注入的习惯画像提供者 —— 进化条件里的 habit 键用它求值 */
  habitProvider?: () => HabitProfile;

  constructor(db: Database.Database) {
    this.db = db;
    this.ensurePet();
  }

  /**
   * 方案 A：单宠物。首次启动按稀有度加权分配一只 starter。
   * 公开的原因：重置（src/core/reset.ts）删掉 pets 行之后，得有人把新宠物滚出来 ——
   * 靠 getPetSnapshot 的兜底也能滚，但那让「重置发了一只新宠物」变成一个副作用。
   */
  ensurePet(): void {
    const has = this.db.prepare("SELECT COUNT(*) as c FROM pets").get() as { c: number };
    if ((has.c ?? 0) > 0) return;
    const typeId = this.rollStarter();
    this.db
      .prepare("INSERT INTO pets(pet_type_id, name, state) VALUES(?, NULL, 'idle')")
      .run(typeId);
    console.log(`[vibepaws] ✨ starter pet assigned (pet_type=${typeId})`);
  }

  /**
   * 加权抽一只 starter。
   *
   * 原来是 `ORDER BY RANDOM() LIMIT 1` —— 那让 legendary 和 common 一样容易滚出来，
   * 稀有度这一列等于没有意义。
   */
  private rollStarter(): number {
    const rows = this.db
      .prepare("SELECT id, rarity FROM pet_types WHERE starter=1 ORDER BY id")
      .all() as Array<{ id: number; rarity: string }>;
    if (rows.length === 0) return 1; // starter 池为空（素材没构建）：退到 1 号
    const total = rows.reduce((sum, r) => sum + rarityWeight(r.rarity), 0);
    let roll = Math.random() * total;
    for (const r of rows) {
      roll -= rarityWeight(r.rarity);
      if (roll < 0) return r.id;
    }
    return rows[rows.length - 1]!.id; // 浮点兜底
  }

  handle(ev: CoreEvent): void {
    switch (ev.event_type) {
      case "token_update": {
        const tokens = ev.payload.tokens ?? 0;
        this.grantTokenExp(ev, tokens);
        break;
      }
      case "session_finished": {
        const outcome = ev.payload.outcome ?? "success";
        const sessionId = this.sessionRowId(ev);
        if (sessionId) this.grantOutcomeExp(sessionId, outcome);
        break;
      }
      case "session_started": {
        // 休息后恢复新 session → daily care bonus（非 fork/clear）
        const source = ev.payload.source ?? "startup";
        if (source === "startup" || source === "resume" || source === "continue") {
          const sessionId = this.sessionRowId(ev);
          if (sessionId) this.grantCareBonus(sessionId);
        }
        break;
      }
    }
    this.tickSelfGrowth();
  }

  // ---- token EXP ----
  /**
   * token_update 的 `tokens` 是**累计值**（adapter 报的是 session 至今用量）。
   * 按累计值发 EXP 会重复计数：30k → +30，紧接着 60k → +60，一共 90 EXP 却只烧了
   * 60k tokens。所以只结算增量，并把「已结算到哪」持久化在 session 上
   * （token_exp_granted）—— 存内存的话 Core 一重启就又从 0 开始重发一遍。
   */
  private grantTokenExp(ev: CoreEvent, tokens: number): void {
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    const row = this.db
      .prepare(
        `SELECT id, context_pct, correction_count, goal, token_exp_granted
         FROM sessions WHERE agent=? AND agent_session_id=?`,
      )
      .get(ev.agent, ev.session_id) as
      | { id: number; context_pct: number; correction_count: number; goal: string | null; token_exp_granted: number }
      | undefined;
    if (!row) return;
    const granted = row.token_exp_granted ?? 0;
    // 计数器倒退（clear/compact 重置用量）→ 把新值整个当成新增用量重新累计
    const delta = tokens >= granted ? tokens - granted : tokens;
    // 无论 daily cap 是否截断，都要记下已结算的累计值：否则第二天会补发今天烧掉的量，
    // cap 就形同虚设。
    this.db.prepare("UPDATE sessions SET token_exp_granted=? WHERE id=?").run(Math.round(tokens), row.id);
    const raw = delta * TOKEN_EXP_RATE;
    if (raw <= 0) return;
    const ctxM = contextMultiplier(row.context_pct ?? 0);
    const topicM = topicMultiplier(row.correction_count ?? 0, Boolean(row.goal));
    const amount = raw * ctxM * topicM;
    this.addExp(row.id, amount, "token", `tokens=${Math.round(delta)} ×ctx=${ctxM} ×topic=${topicM}`);
  }

  // ---- outcome bonus ----
  private grantOutcomeExp(sessionId: number, outcome: string): void {
    const bonus = outcomeBonus(outcome);
    if (bonus > 0) this.addExp(sessionId, bonus, "outcome", `outcome=${outcome}`);
  }

  // ---- daily care bonus ----
  private grantCareBonus(sessionId: number): void {
    this.addExp(sessionId, 5, "care", "new session after rest");
  }

  // ---- 自成长（每小时 +0.1；tired 暂停） ----
  private lastGrowthAt = Date.now();
  private tickSelfGrowth(): void {
    const now = Date.now();
    const elapsed = now - this.lastGrowthAt;
    this.lastGrowthAt = now;
    const pet = this.petRow();
    if (!pet) return;
    // tired 暂停自成长。tired 不落库（它是派生态），所以这里直接看健康分 ——
    // 原来比对 pet.state === "tired" 永远为假，这条规则等于没实现。
    if (this.healthScore() < TIRED_HEALTH_THRESHOLD) return;
    const hours = elapsed / 3_600_000;
    if (hours > 0.0005) {
      this.addExp(null, hours * SELF_GROWTH_PER_HOUR, "self", "self growth");
    }
  }

  // ---- 落库 + daily cap ----
  private addExp(sessionId: number | null, amount: number, category: string, note: string): void {
    if (!Number.isFinite(amount) || amount <= 0) return;
    this.resetDailyIfNeeded();
    const pet = this.petRow();
    if (!pet) return;
    // daily cap 检查（token 类计入 cap；care/self 不计）
    let capped = amount;
    if (category === "token") {
      const cap = this.dailyCap();
      const remaining = cap - pet.daily_exp;
      if (remaining <= 0) return;
      capped = Math.min(amount, remaining);
    }
    this.db
      .prepare("INSERT INTO exp_logs(session_id, amount, category, note) VALUES(?, ?, ?, ?)")
      .run(sessionId, round2(capped), category, note);
    const newExp = round2(pet.exp + capped);
    const newDaily = round2(pet.daily_exp + (category === "token" ? capped : 0));
    this.db.prepare("UPDATE pets SET exp=?, daily_exp=? WHERE id=?").run(newExp, newDaily, pet.id);
    this.checkLevelUp(pet.id, newExp);
  }

  private dailyCap(): number {
    return getDailyExpCap(this.db);
  }

  private resetDailyIfNeeded(): void {
    const pet = this.petRow();
    if (!pet) return;
    const today = new Date().toISOString().slice(0, 10);
    const resetDay = (pet.daily_reset_at ?? "").slice(0, 10);
    if (today !== resetDay) {
      this.db.prepare("UPDATE pets SET daily_exp=0, daily_reset_at=? WHERE id=?").run(new Date().toISOString(), pet.id);
    }
  }

  // ---- 等级 + 进化 ----
  private lastLevelUpAt = 0;
  /** 一次大额 EXP 可能跨多级：循环结算，别把余量留在原地（levelExpRequired ≥ 100，必然收敛） */
  private checkLevelUp(petId: number, exp: number): void {
    const pet = this.petRow();
    if (!pet) return;
    let level = pet.level;
    let remaining = exp;
    while (remaining >= levelExpRequired(level)) {
      remaining = round2(remaining - levelExpRequired(level));
      level += 1;
      this.db
        .prepare("INSERT INTO exp_logs(session_id, amount, category, note) VALUES(NULL, 0, 'level', ?)")
        .run(`level up to ${level}`);
      console.log(`[vibepaws] 🎉 pet level up → Lv.${level}`);
    }
    if (level === pet.level) return;
    this.lastLevelUpAt = Date.now(); // 用于 level-up 状态 5s 回落
    this.db.prepare("UPDATE pets SET level=?, exp=?, state='level-up' WHERE id=?").run(level, remaining, petId);
    this.checkEvolution(petId, level, this.habitProvider?.());
  }

  private checkEvolution(petId: number, level: number, habit?: HabitProfile): void {
    const visited = new Set<number>();
    while (true) {
      const pet = this.petRow();
      if (!pet || visited.has(pet.pet_type_id)) return;
      visited.add(pet.pet_type_id);

      const type = this.db.prepare("SELECT evolution_meta FROM pet_types WHERE id=?").get(pet.pet_type_id) as
        | { evolution_meta: string }
        | undefined;
      if (!type) return;
      let meta: Array<{ from_level: number; conditions?: string[]; to_stage: string }> = [];
      try {
        meta = JSON.parse(type.evolution_meta);
      } catch {
        return;
      }

      const health = this.healthScore();
      const rule = meta.find((candidate) => {
        if (level < candidate.from_level) return false;
        const conditions = candidate.conditions ?? [];
        // 向后兼容：空 conditions 不触发（starter 宠物的 evolution_meta 为空数组）。
        if (conditions.length === 0) return false;
        return conditions.every((c) => evaluateEvolutionCondition(c, health, habit));
      });
      if (!rule) return;
      const targetId = Number(rule.to_stage);
      if (!Number.isInteger(targetId) || visited.has(targetId)) return;

      // 记下满足门槛的那个健康分（原来写死 1.0）—— 进化日志（R29）要说出「凭什么进化的」
      this.db
        .prepare("UPDATE pets SET pet_type_id=?, health_score=? WHERE id=?")
        .run(targetId, health, petId);
      // 原来只有一行 console.log：用户从来不知道自己的宠物进化过（landscape：codachi 的「无声进化」）。
      // 现在交给 server —— 它发一条 evolution 气泡、写一行日志。连跳两级就说两次，每一步各是一件事
      this.announceEvolution({
        petId,
        fromTypeId: pet.pet_type_id,
        toTypeId: targetId,
        fromForm: this.typeName(pet.pet_type_id),
        toForm: this.typeName(targetId),
        level,
        health: round2(health),
        at: new Date().toISOString(),
      });
    }
  }

  private typeName(id: number): string | null {
    const row = this.db.prepare("SELECT name FROM pet_types WHERE id=?").get(id) as { name: string } | undefined;
    return row?.name ?? null;
  }

  /** 进化已经落库了：通知与日志失败不该回滚它，也不该从 EXP 结算里抛出去 */
  private announceEvolution(e: EvolutionRecord): void {
    console.log(`[vibepaws] 🐣 evolution ${e.fromTypeId} → ${e.toTypeId}`);
    try {
      this.onEvolve?.(e);
    } catch (err) {
      console.error("[vibepaws] evolution announce failed:", err);
    }
  }

  /**
   * 宠物的健康分（0.5–1.0）。tired、自成长暂停、进化门槛都拿它和 0.7 比 —— 那条线不动。
   *
   * 原来的实现：最近 24 小时里每条 session_error / topic_drift_warning −0.1，下限 0.5。
   * 它说不出为什么（一次 lint 报错和一次崩溃同价），也和 Session Health 是两套互不相干的数 ——
   * 宠物可能在 pip 条读 82 的时候显示 tired。现在是同一个概念（R11 / KTD5）：
   *
   *   1. 取今天（本地午夜起）已结算、没被回收的段，只看 Context / Focus / Outcome
   *      三个因子（Response 不喂宠物，KTD4），在有数据的因子上归一到 0–100；
   *   2. 按 max(时长, 5 分钟) 加权取平均（KTD10：一行 claude -p 拉不垮四小时的正事）；
   *   3. 映射到旧函数的取值范围，而不是直接 ÷100：
   *        mean ≥ 60 → 1.0 · 30 < mean < 60 → 0.5 + 0.5×(mean−30)/30 · mean ≤ 30 → 0.5
   *      0.5 的下限取代原来的 `Math.max(0.5, …)`；tired（< 0.7）对应 mean < 42。
   *      目标 tired 率：普通的一天（60–85）一律满格，与旧函数「没报错的一天 = 1.0」同读数；
   *      只有一整天都打得差才会累。推导与本机历史回放见 core/health.ts 与 scripts/backfill_health.ts。
   *
   * 今天还没有一段结算过（包括升级后的第一个早上）= 不知道（R31）。不知道**当作健康**：
   * 不渲染 tired、不暂停自成长、不扣进化 —— 所以这里返回 1.0。要区分「不知道」和「满格」的
   * 界面去读 health_query.todayHealth()（health 为 null）。
   */
  private healthScore(today: DayHealth = todayHealth(this.db)): number {
    return today.health ?? 1.0;
  }

  // ---- 读取 ----
  /** `today`：调用方这一刻已经算好的当天聚合（stateSnapshot 一帧只算一次）；不给就自己算 */
  getPetSnapshot(today?: DayHealth): PetSnapshot {
    const pet = this.petRow();
    if (!pet) {
      // 兜底：确保存在
      this.ensurePet();
    }
    const p = this.petRow()!;
    const type = this.db.prepare("SELECT name FROM pet_types WHERE id=?").get(p.pet_type_id) as
      | { name: string }
      | undefined;
    // level-up 状态 5 秒后回落为 idle（避免永远庆祝）
    let state = (p.state as PetState) ?? "idle";
    if (state === "level-up" && Date.now() - this.lastLevelUpAt > 5000) {
      state = "idle";
      this.db.prepare("UPDATE pets SET state='idle' WHERE id=?").run(p.id);
    }
    return {
      id: p.id,
      pet_type_id: p.pet_type_id,
      // 用户给宠物起的名字优先；没起过才显示物种名
      name: p.name ?? type?.name ?? "vibepaws",
      custom_name: p.name,
      species: type?.name ?? null,
      level: p.level,
      exp: round2(p.exp),
      state,
      health_score: this.persistHealth(p.id, p.health_score, today),
      daily_exp: round2(p.daily_exp),
      next_level_exp: levelExpRequired(p.level),
    };
  }

  /** 算出当前健康分，和库里的不一样就写回 pets.health_score（这一列要跟得上，不只是进化那一刻） */
  private persistHealth(petId: number, stored: number, today?: DayHealth): number {
    const health = round2(this.healthScore(today));
    if (health !== stored) this.db.prepare("UPDATE pets SET health_score=? WHERE id=?").run(health, petId);
    return health;
  }

  /**
   * 给宠物改名（设置窗口）。null = 清空，显示名回落到物种名 ——
   * 在这之前 `pets.name` 这一列从来没有写入方，只能手改 SQLite。
   */
  renamePet(name: string | null): void {
    const pet = this.petRow();
    if (!pet) return;
    this.db.prepare("UPDATE pets SET name=? WHERE id=?").run(name, pet.id);
  }

  expLogs(limit = 100): Array<Record<string, unknown>> {
    return this.db
      .prepare("SELECT * FROM exp_logs ORDER BY created_at DESC LIMIT ?")
      .all(limit) as Array<Record<string, unknown>>;
  }

  private petRow(): {
    id: number;
    pet_type_id: number;
    name: string | null;
    level: number;
    exp: number;
    state: string;
    health_score: number;
    daily_exp: number;
    daily_reset_at: string;
  } | null {
    return (this.db.prepare("SELECT * FROM pets LIMIT 1").get() as
      | {
          id: number;
          pet_type_id: number;
          name: string | null;
          level: number;
          exp: number;
          state: string;
          health_score: number;
          daily_exp: number;
          daily_reset_at: string;
        }
      | undefined) ?? null;
  }

  private sessionRowId(ev: CoreEvent): number | null {
    const row = this.db
      .prepare("SELECT id FROM sessions WHERE agent=? AND agent_session_id=?")
      .get(ev.agent, ev.session_id) as { id: number } | undefined;
    return row?.id ?? null;
  }
}

export function levelExpRequired(level: number): number {
  return 100 + (level - 1) * 50; // Lv1→100, Lv2→150, ...
}

/* ================= Growth（Den 的 Growth 标签页，U13）=================
 * 下面全是纯函数：输入是库里的行，输出是 GET /api/growth 的一段。
 * landscape 里 codachi 的头号抱怨是「看不见的进度、不透明的曲线、无声的进化」——
 * 曲线就是 levelExpRequired，来源就是 exp_logs.category，门槛就是 checkEvolution 那一行；
 * 这里不发明任何新的数，只是把已经在算的数说出来。 */

/** 会加到宠物身上的 EXP 类别（顺序即界面顺序）。level 是 0 EXP 的升级标记，不在其中 */
export const EXP_SOURCES: ExpSource[] = ["token", "outcome", "care", "self"];
/** 曲线至少画到这一级：新宠物（Lv1）也看得出「后面每一级都更长」 */
const CURVE_MIN_LEVELS = 10;
/** 曲线画到当前等级之后几级 */
const CURVE_AHEAD = 5;
const LEVEL_UPS_MAX = 20;

/**
 * 等级曲线：Lv1 起到 max(当前 + 5, 10) 级。total = 从 Lv1 的 0 EXP 起、升过这一级累计要多少 ——
 * 「Lv.7 一共要攒多少」是曲线上用户最想问、却要自己加的那个数。
 */
export function levelCurve(level: number): Array<{ level: number; required: number; total: number }> {
  const current = Number.isInteger(level) && level >= 1 ? level : 1;
  const last = Math.max(current + CURVE_AHEAD, CURVE_MIN_LEVELS);
  const out: Array<{ level: number; required: number; total: number }> = [];
  let total = 0;
  for (let l = 1; l <= last; l++) {
    const required = levelExpRequired(l);
    total += required;
    out.push({ level: l, required, total });
  }
  return out;
}

/** exp_logs.created_at 是 SQLite 的 datetime('now')：UTC、空格分隔、没有 Z */
export function sqliteUtc(at: string): Date {
  return new Date(/(?:[zZ]|[+-]\d\d:?\d\d)$/.test(at) ? at : `${at.replace(" ", "T")}Z`);
}

/** ISO → SQLite datetime 的写法（比较 created_at 用） */
function toSqliteUtc(iso: string): string {
  return new Date(iso).toISOString().slice(0, 19).replace("T", " ");
}

function emptySources(): Record<ExpSource, number> {
  return { token: 0, outcome: 0, care: 0, self: 0 };
}

/**
 * 最近 `days` 个本地日的 EXP 来源。按**本地**日分桶（23:50 的一笔是用户过的那一天）；
 * 每一天都列出来（没有 EXP 的日子是 0），范围外的行、level 标记、认不出的类别一律不算。
 */
export function expSourceBreakdown(
  rows: ReadonlyArray<{ amount: number; category: string; created_at: string }>,
  opts: { now?: Date; days?: number } = {},
): GrowthView["week"] {
  const now = opts.now ?? new Date();
  const days = Math.max(1, Math.floor(opts.days ?? 7));
  const since = localDayStart(now, days - 1);
  const daily = new Map<string, Record<ExpSource, number>>();
  for (let back = days - 1; back >= 0; back--) {
    daily.set(localDayKey(new Date(localDayStart(now, back))), emptySources());
  }
  const sources = emptySources();
  const sinceMs = new Date(since).getTime();
  for (const r of rows) {
    if (!(EXP_SOURCES as string[]).includes(r.category)) continue;
    const amount = Number(r.amount);
    if (!Number.isFinite(amount) || amount <= 0) continue;
    const at = sqliteUtc(r.created_at);
    if (!Number.isFinite(at.getTime()) || at.getTime() < sinceMs || at.getTime() > now.getTime()) continue;
    const bucket = daily.get(localDayKey(at));
    if (!bucket) continue;
    const cat = r.category as ExpSource;
    bucket[cat] += amount;
    sources[cat] += amount;
  }
  const roundAll = (rec: Record<ExpSource, number>): Record<ExpSource, number> => {
    const out = emptySources();
    for (const k of EXP_SOURCES) out[k] = round2(rec[k]);
    return out;
  };
  const sum = (rec: Record<ExpSource, number>): number => round2(EXP_SOURCES.reduce((a, k) => a + rec[k], 0));
  return {
    days,
    since,
    until: now.toISOString(),
    total: sum(sources),
    sources: roundAll(sources),
    daily: [...daily.entries()].map(([day, rec]) => ({ day, total: sum(rec), sources: roundAll(rec) })),
  };
}

type EvolutionRule = { from_level: number; conditions?: string[]; to_stage: string };

/**
 * 下一次进化还差什么。判定与 checkEvolution 逐字一致：只认带 `health>=0.7` 的规则、
 * 等级够了才轮到它、健康要过门槛、而且**只在升级那一刻**判定 ——
 * 所以两样都满足时说的是「下一次升级时」，而不是假装它此刻就该发生。
 * health = null（今天还不知道）按 R31 读作健康：不挡进化，和引擎一样。
 */
export function evolutionStatus(
  meta: readonly EvolutionRule[],
  level: number,
  health: number | null,
  formName: (typeId: number) => string | null = () => null,
): EvolutionStatus {
  const candidates = meta.filter(
    (m) =>
      Number.isFinite(m.from_level) &&
      m.conditions?.includes("health>=0.7") &&
      Number.isInteger(Number(m.to_stage)),
  );
  if (candidates.length === 0) return { state: "final" };
  // 引擎会挑的那一条（等级已到的第一条）；都没到就是门槛最低的那一条
  const rule =
    candidates.find((m) => level >= m.from_level) ??
    [...candidates].sort((a, b) => a.from_level - b.from_level)[0]!;
  const toTypeId = Number(rule.to_stage);
  const state = level < rule.from_level ? "level" : health !== null && health < EVOLUTION_HEALTH_GATE ? "health" : "ready";
  return {
    state,
    to_type_id: toTypeId,
    to_form: formName(toTypeId),
    from_level: rule.from_level,
    level,
    health_gate: EVOLUTION_HEALTH_GATE,
    health,
  };
}

/** 升级标记（exp_logs category=level，note = "level up to N"）→ { level, at }，从新到旧 */
export function levelUps(rows: ReadonlyArray<{ note: string | null; created_at: string }>): Array<{ level: number; at: string }> {
  const out: Array<{ level: number; at: string }> = [];
  for (const r of rows) {
    const m = /level up to (\d+)/.exec(r.note ?? "");
    const at = sqliteUtc(r.created_at);
    if (!m || !Number.isFinite(at.getTime())) continue;
    out.push({ level: Number(m[1]), at: at.toISOString() });
  }
  return out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.level - a.level)).slice(0, LEVEL_UPS_MAX);
}

/**
 * GET /api/growth。`pet` 由调用方传进来（ExpEngine.getPetSnapshot）：这里只读库，不碰宠物行。
 */
export function growthView(
  db: Database.Database,
  pet: PetSnapshot,
  opts: { now?: Date; days?: number } = {},
): GrowthView {
  const now = opts.now ?? new Date();
  const days = Math.max(1, Math.floor(opts.days ?? 7));
  const since = toSqliteUtc(localDayStart(now, days - 1));
  const expRows = db
    .prepare(
      `SELECT amount, category, created_at FROM exp_logs
       WHERE created_at >= ? AND category IN ('token','outcome','care','self')`,
    )
    .all(since) as Array<{ amount: number; category: string; created_at: string }>;
  const levelRows = db
    .prepare(`SELECT note, created_at FROM exp_logs WHERE category='level' ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(LEVEL_UPS_MAX) as Array<{ note: string | null; created_at: string }>;
  const type = db.prepare("SELECT evolution_meta FROM pet_types WHERE id=?").get(pet.pet_type_id) as
    | { evolution_meta: string }
    | undefined;
  let meta: EvolutionRule[] = [];
  try {
    const parsed = JSON.parse(type?.evolution_meta ?? "[]");
    if (Array.isArray(parsed)) meta = parsed as EvolutionRule[];
  } catch {
    meta = [];
  }
  const health = todayHealth(db, now).health;
  const formName = (id: number): string | null =>
    (db.prepare("SELECT name FROM pet_types WHERE id=?").get(id) as { name: string } | undefined)?.name ?? null;
  return {
    pet: {
      name: pet.name ?? pet.species ?? "vibepaws",
      species: pet.species,
      pet_type_id: pet.pet_type_id,
      level: pet.level,
      exp: pet.exp,
      next_level_exp: pet.next_level_exp,
      health,
    },
    curve: levelCurve(pet.level),
    week: expSourceBreakdown(expRows, { now, days }),
    level_ups: levelUps(levelRows),
    evolution: evolutionStatus(meta, pet.level, health, formName),
  };
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * 进化条件里的 habit 数值键（depth>=0.6 / precision>=0.6 / context_hygiene>=0.6）。
 * 返回 null 表示「不是这个键」，让调用方继续试下一个键。
 */
function evalHabitGe(
  cond: string,
  key: "depth" | "precision" | "context_hygiene",
  habit?: HabitProfile,
): boolean | null {
  const prefix = `${key}>=`;
  if (!cond.startsWith(prefix)) return null;
  const n = Number(cond.slice(prefix.length));
  if (!Number.isFinite(n)) return false;
  return (habit?.[key] ?? 0) >= n;
}

/**
 * 进化条件判定。支持的键（docs/handoff-habit-layer.md §6.2）：
 *   health>=0.7 · chronotype=night_owl|early_bird · cadence=burst|steady ·
 *   depth>=0.6 · precision>=0.6 · context_hygiene>=0.6
 * 未知条件一律 false（保守不触发）；habit 缺省时 habit 键不通过。
 */
export function evaluateEvolutionCondition(cond: string, health: number, habit?: HabitProfile): boolean {
  if (cond === "health>=0.7") return health >= 0.7;
  if (cond.startsWith("chronotype=")) return habit?.chronotype === cond.slice("chronotype=".length);
  if (cond.startsWith("cadence=")) return habit?.cadence === cond.slice("cadence=".length);
  for (const key of ["depth", "precision", "context_hygiene"] as const) {
    const r = evalHabitGe(cond, key, habit);
    if (r !== null) return r;
  }
  return false;
}
