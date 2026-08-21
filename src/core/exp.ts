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
 * 进化: 纯配置 {from_level, conditions, to_stage}
 */
import type Database from "better-sqlite3";
import type { CoreEvent, PetState } from "./events.ts";
import { getDailyExpCap } from "./settings.ts";

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

  constructor(db: Database.Database) {
    this.db = db;
    this.ensurePet();
  }

  /** 方案 A：单宠物。首次启动按稀有度加权分配一只 starter。 */
  private ensurePet(): void {
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
    if (this.healthScore(pet.id) < TIRED_HEALTH_THRESHOLD) return;
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
    this.checkEvolution(petId, level);
  }

  private checkEvolution(petId: number, level: number): void {
    const pet = this.petRow();
    if (!pet) return;
    const type = this.db.prepare("SELECT evolution_meta FROM pet_types WHERE id=?").get(pet.pet_type_id) as
      | { evolution_meta: string }
      | undefined;
    if (!type) return;
    let meta: Array<{ from_level: number; conditions?: string[]; to_stage: string }> = [];
    try {
      meta = JSON.parse(type.evolution_meta);
    } catch {
      meta = [];
    }
    for (const rule of meta) {
      if (level >= rule.from_level && rule.conditions?.includes("health>=0.7")) {
        const health = this.healthScore(petId);
        if (health >= 0.7) {
          this.db
            .prepare("UPDATE pets SET pet_type_id=?, health_score=? WHERE id=?")
            .run(rule.to_stage, 1.0, petId);
          console.log(`[vibepaws] 🐣 evolution → ${rule.to_stage}`);
        }
      }
    }
  }

  private healthScore(petId: number): number {
    // 简单健康分：基于近期 context/error 记录（MVP 保守：0.5~1.0）
    const recent = this.db
      .prepare(
        `SELECT COUNT(*) as c FROM events WHERE event_type IN ('session_error','topic_drift_warning')
         AND received_at > datetime('now','-1 day')`,
      )
      .get() as { c: number };
    const score = Math.max(0.5, 1 - (recent.c ?? 0) * 0.1);
    return round2(Math.min(1, score));
  }

  // ---- 读取 ----
  getPetSnapshot(): PetSnapshot {
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
      health_score: round2(this.healthScore(p.id)),
      daily_exp: round2(p.daily_exp),
      next_level_exp: levelExpRequired(p.level),
    };
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

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
