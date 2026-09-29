#!/usr/bin/env node
/**
 * 把本机已有的 events 重放一遍，看 Session Health 的分数长什么样（计划 U3 的 Verification）。
 *
 * 存在的理由：70 这条线是从旧 healthScore()（一天的报错数、下限 0.5）继承来的，
 * 它和新的四因子分数没有任何理由共用一个阈值。在任何界面把档位写死之前，先看分布 ——
 * 如果普通的 session 都挤在 70 以下，宠物就会永远是琥珀色，分数读起来像一张不及格的成绩单。
 *
 * 做法：源库**只读**打开，一条都不写。按 received_at 顺序把 events 喂给一个内存库里的
 * SessionRegistry（与 Core 同一份状态机：分段、峰值、等待账本、重复编辑都由它产生），
 * 每条 session_finished 当场取走那一段（就像日志 U12 会做的那样）交给 core/health.ts 打分。
 * 然后在每个有活动的整点上，用新旧两个公式各算一次宠物健康，比较 tired 率。
 *
 * 重放的失真（打印在输出里）：
 *   · events 只有 Core 的 received_at（秒级），没有 adapter 的原始时间戳 —— 等待时长按秒取整，
 *     离线缓冲的回放在这里分辨不出来（一律当作准时送达）
 *   · U2 之前的 adapter 不报编辑目标的 file，老数据的 Focus 几乎一定是满分（偏乐观）
 *   · 被僵尸回收的 session 没有 session_finished：在重放里它们停在「没结算」，不进分数 —— 与 R10 同向
 *
 * ## 用法
 *   node --experimental-strip-types scripts/backfill_health.ts                 # cwd/.vibepaws/vibepaws.db
 *   node --experimental-strip-types scripts/backfill_health.ts --db <path>     # 比如打包版的 userData 目录
 *
 * 源库正被 Core 用着（WAL）时建议先把 vibepaws.db* 复制出来再指过去。
 */
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { applySchema } from "../src/db/schema.ts";
import { SessionRegistry } from "../src/core/registry.ts";
import { loadSegmentInput } from "../src/core/health_query.ts";
import {
  scoreSegment,
  petScore,
  dayMean,
  petHealthFromMean,
  segmentDurationMs,
  median,
  FACTOR_NAMES,
  type FactorName,
  type HealthResult,
  type SegmentInput,
} from "../src/core/health.ts";
import { TIRED_HEALTH_THRESHOLD } from "../src/core/exp.ts";
import type { CoreEvent } from "../src/core/events.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const DB = arg("db") ?? join(process.cwd(), ".vibepaws", "vibepaws.db");
if (!existsSync(DB)) {
  console.error(`no database at ${DB}`);
  process.exit(1);
}

/** SQLite 的 'YYYY-MM-DD HH:MM:SS'（UTC）→ ISO */
function sqliteToIso(s: string): string {
  return s.includes("T") ? s : `${s.replace(" ", "T")}Z`;
}

const HOUR = 3_600_000;

interface Scored {
  finishedAt: string;
  durationMs: number | null;
  input: SegmentInput;
  result: HealthResult;
}

function main(): void {
  const src = new Database(DB, { readonly: true, fileMustExist: true });
  const projects = new Map<string, string>();
  for (const r of src.prepare("SELECT agent, agent_session_id, project_id FROM sessions").all() as Array<{
    agent: string;
    agent_session_id: string;
    project_id: string;
  }>) {
    projects.set(`${r.agent}:${r.agent_session_id}`, r.project_id);
  }

  const replay = new Database(":memory:");
  applySchema(replay);
  const reg = new SessionRegistry({ db: replay });
  const insertEvent = replay.prepare(
    "INSERT INTO events(event_id, agent, session_id, event_type, safe_summary, received_at) VALUES(?,?,?,?,?,?)",
  );

  const fixReceivedAt = replay.prepare("UPDATE needs_input_waits SET received_at = started_at WHERE received_at > started_at");
  const scored: Scored[] = [];
  let reclaimedOrUnscored = 0;
  const errorTimes: number[] = []; // 旧公式要数的 session_error / topic_drift_warning
  const activeHours = new Set<number>();
  let n = 0;

  const rows = src
    .prepare(
      `SELECT id, event_id, seq, agent, session_id, event_type, severity, safe_summary, payload_json, received_at
       FROM events ORDER BY received_at, id`,
    )
    .iterate() as IterableIterator<{
    id: number;
    event_id: string | null;
    seq: number;
    agent: string;
    session_id: string;
    event_type: string;
    severity: string;
    safe_summary: string;
    payload_json: string;
    received_at: string;
  }>;

  for (const r of rows) {
    n += 1;
    const timestamp = sqliteToIso(r.received_at);
    const ms = Date.parse(timestamp);
    activeHours.add(Math.floor(ms / HOUR));
    let payload: Record<string, unknown> = {};
    try {
      payload = JSON.parse(r.payload_json) as Record<string, unknown>;
    } catch {
      /* 坏行当空 payload */
    }
    const ev = {
      event_id: r.event_id ?? `replay-${r.id}`,
      seq: r.seq,
      agent: r.agent,
      session_id: r.session_id,
      project_id: projects.get(`${r.agent}:${r.session_id}`) ?? "/unknown",
      event_type: r.event_type,
      severity: r.severity,
      safe_summary: r.safe_summary,
      timestamp,
      payload,
    } as unknown as CoreEvent;

    if (r.event_type === "session_error" || r.event_type === "topic_drift_warning") {
      errorTimes.push(ms);
      insertEvent.run(`replay-${r.id}`, r.agent, r.session_id, r.event_type, "x", r.received_at);
    }
    reg.handle(ev);
    // openWait 把 received_at 记成「现在」（重放的这一刻）：改回事件时间，否则每一条都像离线回放
    fixReceivedAt.run();

    if (r.event_type === "session_finished") {
      const input = loadSegmentInput(replay, r.agent, r.session_id);
      const result = input ? scoreSegment(input) : null;
      if (!input || !result || result.unsettled) {
        reclaimedOrUnscored += 1;
        continue;
      }
      scored.push({ finishedAt: input.finishedAt!, durationMs: segmentDurationMs(input), input, result });
    }
  }
  src.close();

  /* ---------- 每段的分布 ---------- */
  const scores = scored.map((s) => s.result.score).filter((x): x is number => x !== null);
  const pets = scored.map((s) => petScore(s.result)).filter((x): x is number => x !== null);

  console.log(`source: ${DB}`);
  console.log(`events replayed: ${n}; settled segments scored: ${scored.length}; finish events without a score: ${reclaimedOrUnscored}`);
  if (scored.length === 0) {
    console.log("nothing to score");
    return;
  }
  printDistribution("Session Health (4 factors, renormalised)", scores);
  printDistribution("Pet score (Context / Focus / Outcome)", pets);

  const omittedCount: Record<FactorName, number> = { context: 0, focus: 0, response: 0, outcome: 0 };
  const factorSum: Record<FactorName, { sum: number; n: number }> = {
    context: { sum: 0, n: 0 },
    focus: { sum: 0, n: 0 },
    response: { sum: 0, n: 0 },
    outcome: { sum: 0, n: 0 },
  };
  for (const s of scored) {
    for (const f of s.result.omitted) omittedCount[f] += 1;
    for (const f of FACTOR_NAMES) {
      const p = s.result.factors[f];
      if (p !== null) {
        factorSum[f].sum += p;
        factorSum[f].n += 1;
      }
    }
  }
  console.log("\nper factor (mean points of 25 where present · omitted share):");
  for (const f of FACTOR_NAMES) {
    const { sum, n: c } = factorSum[f];
    console.log(
      `  ${f.padEnd(9)} ${c ? (sum / c).toFixed(1).padStart(5) : "   — "}   omitted ${pct(omittedCount[f], scored.length)}`,
    );
  }

  /* ---------- 按天：宠物健康 ---------- */
  const byDay = new Map<string, SegmentInput[]>();
  for (const s of scored) {
    const key = localDayKey(Date.parse(s.finishedAt));
    const list = byDay.get(key) ?? [];
    list.push(s.input);
    byDay.set(key, list);
  }
  console.log("\nper day (end of day): segments · duration-weighted pet mean → mapped health");
  for (const [day, segs] of [...byDay.entries()].sort()) {
    const mean = dayMean(segs);
    const h = petHealthFromMean(mean);
    console.log(
      `  ${day}  ${String(segs.length).padStart(3)}  mean ${mean === null ? "  —  " : mean.toFixed(1).padStart(5)}  → ${h === null ? "unknown" : h.toFixed(2)}${h !== null && h < TIRED_HEALTH_THRESHOLD ? "  tired" : ""}`,
    );
  }

  /* ---------- 按小时采样：新旧 tired 率 ---------- */
  errorTimes.sort((a, b) => a - b);
  const finishedSorted = [...scored].sort((a, b) => Date.parse(a.finishedAt) - Date.parse(b.finishedAt));
  let oldTired = 0;
  let newTired = 0;
  let newUnknown = 0;
  const oldHealths: number[] = [];
  const newHealths: number[] = [];
  const hours = [...activeHours].sort((a, b) => a - b);
  for (const h of hours) {
    const t = (h + 1) * HOUR; // 这一小时结束的时刻
    // 旧：最近 24 小时每条报错 −0.1，下限 0.5
    const errs = countInRange(errorTimes, t - 24 * HOUR, t);
    const oldH = Math.min(1, Math.max(0.5, 1 - errs * 0.1));
    oldHealths.push(oldH);
    if (oldH < TIRED_HEALTH_THRESHOLD) oldTired += 1;
    // 新：本地午夜以来结算过的段
    const dayStart = new Date(new Date(t - 1).setHours(0, 0, 0, 0)).getTime();
    const today = finishedSorted
      .filter((s) => {
        const f = Date.parse(s.finishedAt);
        return f >= dayStart && f <= t;
      })
      .map((s) => s.input);
    const mapped = petHealthFromMean(dayMean(today));
    if (mapped === null) newUnknown += 1;
    const newH = mapped ?? 1.0; // 不知道当作健康（R31）
    newHealths.push(newH);
    if (newH < TIRED_HEALTH_THRESHOLD) newTired += 1;
  }
  console.log(`\nactive hours sampled: ${hours.length}`);
  console.log(`  old healthScore(): mean ${avg(oldHealths).toFixed(2)} · tired ${pct(oldTired, hours.length)}`);
  console.log(
    `  new healthScore(): mean ${avg(newHealths).toFixed(2)} · tired ${pct(newTired, hours.length)} · unknown (reads 1.0) ${pct(newUnknown, hours.length)}`,
  );
  console.log(
    "\ncaveats: waits rounded to whole seconds (received_at only); spool replays indistinguishable;\n" +
      "         pre-U2 adapters sent no edit file, so Focus is near-full on old data; reclaimed sessions never finish in replay.",
  );
}

function printDistribution(title: string, xs: number[]): void {
  console.log(`\n${title}: n=${xs.length} mean ${avg(xs).toFixed(1)} median ${(median(xs) ?? 0).toFixed(1)} · below 70: ${pct(xs.filter((x) => x < 70).length, xs.length)}`);
  const bands: Array<[string, (x: number) => boolean]> = [
    ["≥70 (neutral)", (x) => x >= 70],
    ["50–69 (amber)", (x) => x >= 50 && x < 70],
    ["<50 (red)", (x) => x < 50],
  ];
  for (const [label, f] of bands) console.log(`  ${label.padEnd(14)} ${pct(xs.filter(f).length, xs.length)}`);
  const buckets = new Array<number>(10).fill(0);
  for (const x of xs) buckets[Math.min(9, Math.floor(x / 10))]! += 1;
  const max = Math.max(...buckets);
  for (let i = 9; i >= 0; i--) {
    const c = buckets[i]!;
    const bar = "#".repeat(max ? Math.round((c / max) * 40) : 0);
    console.log(`  ${String(i * 10).padStart(3)}–${String(i * 10 + 9).padEnd(3)} ${String(c).padStart(4)} ${bar}`);
  }
}

function countInRange(sorted: number[], from: number, to: number): number {
  let c = 0;
  for (const x of sorted) {
    if (x > to) break;
    if (x > from) c += 1;
  }
  return c;
}

function localDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function pct(a: number, b: number): string {
  return b ? `${((a / b) * 100).toFixed(1)}%` : "—";
}

main();
