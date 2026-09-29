/**
 * Session Health 历史（health_history.ts，GET /api/session_health 的那一层）的单测：
 * 本地日分桶、只收已结算没回收的段、项目名只出短名、范围里每一天都在。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema.ts";
import { seedPetTypes } from "../db/seed.ts";
import {
  HISTORY_DEFAULT_DAYS,
  HISTORY_MAX_DAYS,
  dayHealthView,
  parseHistoryDays,
  sessionHealthHistory,
} from "./health_history.ts";
import { localDayKey } from "./health_query.ts";
import { recordFinish } from "./journal.ts";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  seedPetTypes(db);
  return db;
}

const MIN = 60_000;

/** 直接写一行 session：本段从 start 到 end，peak / 重复编辑 / outcome 可调 */
function put(
  db: Database.Database,
  id: string,
  o: { start: Date; end: Date | null; outcome?: string | null; peak?: number; edits?: number; project?: string },
): void {
  db.prepare(
    `INSERT INTO sessions(agent, agent_session_id, project_id, is_active, segment_started_at, finished_at, outcome,
       context_peak, context_reported_at, repeat_edit_count)
     VALUES('claude_code', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    o.project ?? "/Users/x/my-app",
    o.end ? 0 : 1,
    o.start.toISOString(),
    o.end?.toISOString() ?? null,
    o.end ? (o.outcome ?? "success") : null,
    o.peak ?? 40,
    o.start.toISOString(),
    o.edits ?? 0,
  );
  // 历史读的是日志行（U12）：像 server 的事件链那样在收工那一刻记一笔（没结算 / 被回收的它不写）
  recordFinish(db, "claude_code", id);
}

// 固定的「现在」：本地时间 2026-09-29 15:00
const NOW = new Date(2026, 8, 29, 15, 0);

test("本地日分桶：昨晚 23:50 收工的一段落在昨天，不是 UTC 的那一天", () => {
  const db = makeDb();
  const late = new Date(2026, 8, 28, 23, 50);
  put(db, "late", { start: new Date(late.getTime() - 30 * MIN), end: late });
  const h = sessionHealthHistory(db, { days: 2, now: NOW });
  assert.equal(h.segments.length, 1);
  assert.equal(h.segments[0]!.day, "2026-09-28");
  assert.deepEqual(
    h.daily.map((d) => [d.day, d.segments]),
    [
      ["2026-09-28", 1],
      ["2026-09-29", 0],
    ],
  );
});

test("范围之外、还在跑的、被回收的都不进历史；没有段的日子 unknown 而不是 0", () => {
  const db = makeDb();
  const old = new Date(2026, 8, 20, 12, 0);
  put(db, "old", { start: new Date(old.getTime() - 10 * MIN), end: old });
  put(db, "live", { start: new Date(NOW.getTime() - 10 * MIN), end: null });
  const t = new Date(2026, 8, 29, 10, 0);
  put(db, "gone", { start: new Date(t.getTime() - 10 * MIN), end: t, outcome: "orphaned" });
  put(db, "tout", { start: new Date(t.getTime() - 10 * MIN), end: t, outcome: "timeout" });

  const h = sessionHealthHistory(db, { now: NOW });
  assert.equal(h.days, HISTORY_DEFAULT_DAYS);
  assert.equal(h.daily.length, HISTORY_DEFAULT_DAYS);
  assert.equal(h.segments.length, 0);
  for (const d of h.daily) {
    assert.equal(d.unknown, true);
    assert.equal(d.mean, null, "不知道不是 0 分（R31）");
    assert.equal(d.health, null);
    assert.equal(d.segments, 0);
  }
  assert.equal(h.daily.at(-1)!.day, localDayKey(NOW), "最后一格是今天");
});

test("项目名只出短名：POSIX 与 Windows 路径都不带分隔符出去", () => {
  const db = makeDb();
  const t = new Date(2026, 8, 29, 10, 0);
  put(db, "posix", { start: new Date(t.getTime() - 10 * MIN), end: t, project: "/Users/alice/corp/app-one/" });
  put(db, "win", { start: new Date(t.getTime() - 10 * MIN), end: t, project: "C:\\Users\\bob\\corp\\app-two" });
  const h = sessionHealthHistory(db, { days: 1, now: NOW });
  assert.deepEqual(h.segments.map((s) => s.project).sort(), ["app-one", "app-two"]);
  const wire = JSON.stringify(h);
  assert.ok(!wire.includes("alice") && !wire.includes("bob"), "路径里的用户名不该跟着出去");
});

test("一天的聚合：时长加权，四个因子都有；mean 与宠物同口径（不含 Response）", () => {
  const db = makeDb();
  const t = new Date(2026, 8, 29, 14, 0);
  // 四小时的好段：40% / 0 次重复 / success → 25 + 25 + 25
  put(db, "long", { start: new Date(t.getTime() - 240 * MIN), end: t });
  // 三十秒的烂段：98% / 7 次重复 / abandoned → 6 + 8 + 5；按 5 分钟的下限加权
  put(db, "short", {
    start: new Date(t.getTime() - 30_000),
    end: t,
    peak: 98,
    edits: 7,
    outcome: "abandoned",
  });
  const h = sessionHealthHistory(db, { days: 1, now: NOW });
  const day = h.daily[0]!;
  assert.equal(day.segments, 2);
  assert.equal(day.unknown, false);
  // (100 × 240 + 25.3 × 5) / 245
  assert.equal(day.mean, 98.5);
  assert.equal(day.health, 1);
  assert.equal(day.factors.response, null, "两段都没阻塞过：Response 省略，不是满分");
  assert.equal(day.factors.context, Math.round(((25 * 240 + 6 * 5) / 245) * 10) / 10);
  assert.equal(day.duration_ms, 240 * MIN + 30_000, "时长是真实时长，不含下限补足");
  const short = h.segments.find((s) => s.session_id === "short")!;
  assert.equal(short.duration_ms, 30_000);
  assert.deepEqual(short.omitted, ["response"]);
  assert.equal(short.pet_score, 25.3);
});

test("?days= 的解析：缺省 7、夹到上限、垃圾值是 null（回 400）", () => {
  assert.equal(parseHistoryDays(null), HISTORY_DEFAULT_DAYS);
  assert.equal(parseHistoryDays(""), HISTORY_DEFAULT_DAYS);
  assert.equal(parseHistoryDays("14"), 14);
  assert.equal(parseHistoryDays("100000"), HISTORY_MAX_DAYS);
  for (const bad of ["0", "-3", "1.5", "abc", "7d"]) assert.equal(parseHistoryDays(bad), null, bad);
});

test("dayHealthView：unknown 就是 mean === null", () => {
  assert.deepEqual(dayHealthView({ mean: null, health: null, segments: 0 }), {
    mean: null,
    health: null,
    unknown: true,
    segments: 0,
  });
  assert.equal(dayHealthView({ mean: 70, health: 1, segments: 2 }).unknown, false);
});
