/**
 * Den 三个标签页的单测（U13）。
 *
 * 守三件事：每一页没有行的时候画的是它自己的 first-run（不是一片空白，也不是「连不上」），
 * 连不上与「真的没有」分得开，以及分数设成「哪都不显示」时 Den 里一个分数都不剩。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { todayModel, journalModel, growthModel, safeName, dayFactors, settledSegment, localDay } from "./den.js";

const NOW = new Date(2026, 8, 29, 15, 0, 0); // 本地 9/29 下午
const at = (d, h, m = 0) => new Date(2026, 8, d, h, m).toISOString();

const state = (extra = {}) => ({
  health_visibility: "flyout",
  health_today: { mean: 74, health: 1, unknown: false, segments: 1 },
  ...extra,
});
const seg = (extra = {}) => ({
  agent: "claude_code",
  session_id: "s1",
  segment: 1,
  project: "my-app",
  day: "2026-09-29",
  started_at: at(29, 13),
  finished_at: at(29, 14),
  duration_ms: 3_600_000,
  score: 82,
  pet_score: 80,
  factors: { context: 12, focus: 25, response: 20, outcome: 25 },
  omitted: [],
  ...extra,
});
const history = (segments, daily = []) => ({ source: "journal", days: 7, segments, daily });

test("Today：从来没连上 = offline，不是「今天还没有 session」", () => {
  assert.equal(todayModel({ state: null, history: null, now: NOW }).kind, "offline");
  assert.equal(todayModel({ state: state(), history: null, now: NOW }).kind, "offline");
});

test("Today：没有今天收工的段 = first-run（昨天的段不算今天）", () => {
  const m = todayModel({ state: state(), history: history([seg({ finished_at: at(28, 23, 50) })]), now: NOW });
  assert.equal(m.kind, "first-run");
  assert.equal(todayModel({ state: state(), history: history([]), now: NOW }).kind, "first-run");
});

test("Today：有段 → 分数取 health_today、四个因子、段从新到旧；没数据的因子是 omitted 不是 0", () => {
  const m = todayModel({
    state: state(),
    history: history(
      [seg(), seg({ session_id: "s2", finished_at: at(29, 14, 30), score: 60 })],
      [{ day: "2026-09-29", mean: 70, factors: { context: 12.34, focus: 25, response: null, outcome: 25 } }],
    ),
    now: NOW,
  });
  assert.equal(m.kind, "day");
  assert.equal(m.mean, 74);
  assert.equal(m.segments, 2);
  assert.deepEqual(m.sessions.map((s) => s.score), [60, 82]);
  assert.deepEqual(m.factors.map((f) => f.status), ["scored", "scored", "omitted", "scored"]);
  assert.equal(m.factors[0].points, 12.3);
});

test("Today：可见性 off → 段照样列，但一个分数、一个因子都不剩", () => {
  const m = todayModel({ state: state({ health_visibility: "off" }), history: history([seg()]), now: NOW });
  assert.equal(m.kind, "day");
  assert.equal(m.showScores, false);
  assert.equal(m.mean, null);
  assert.equal(m.strip, null);
  assert.deepEqual(m.factors, []);
  assert.equal(m.sessions[0].score, null);
  assert.ok(!JSON.stringify(m).includes("82"));
});

test("Today：没结算 / 被回收 / 没有收工时刻的段一律不进（防御：history 本来就不给）", () => {
  assert.equal(settledSegment(seg({ unsettled: true })), false);
  assert.equal(settledSegment(seg({ outcome: "timeout" })), false);
  assert.equal(settledSegment(seg({ finished_at: null })), false);
  assert.equal(settledSegment(seg()), true);
  const m = todayModel({ state: state(), history: history([seg({ unsettled: true })]), now: NOW });
  assert.equal(m.kind, "first-run");
});

test("Journal：从来没写过 = first-run；这个月没东西 = empty；连不上 = offline", () => {
  assert.equal(journalModel(null).kind, "offline");
  assert.equal(journalModel({ month: "2026-09", months: [], projects: [], entries: [], file: null }).kind, "first-run");
  const empty = journalModel({ month: "2026-08", months: ["2026-09"], projects: [], entries: [], file: null }, { project: "my-app" });
  assert.equal(empty.kind, "empty");
  assert.equal(empty.project, "my-app");
});

test("Journal：条目从新到旧；进化条目带形态与健康；off 时分数与因子收起", () => {
  const view = {
    month: "2026-09",
    months: ["2026-09"],
    projects: ["my-app"],
    file: "journal/2026-09.md",
    entries: [
      { id: 1, kind: "session", at: at(28, 10), project: "my-app", score: 82, factors: seg().factors, omitted: ["response"], files: ["a.ts"], files_total: 3 },
      { id: 2, kind: "evolution", at: at(29, 10), evolution: { from: "Embercub", to: "Cinderclaw", level: 5, health: 0.93 } },
    ],
  };
  const m = journalModel(view);
  assert.equal(m.kind, "entries");
  assert.deepEqual(m.entries.map((e) => e.id), [2, 1]);
  assert.equal(m.entries[0].health, 93);
  assert.equal(m.entries[1].files_more, 2);
  assert.deepEqual(m.entries[1].omitted, ["response"]);
  const hidden = journalModel(view, { showScores: false });
  assert.equal(hidden.entries[1].score, null);
  assert.deepEqual(hidden.entries[1].factors, []);
});

test("Growth：连不上 = offline；新宠物 = 曲线照画，这周与升级记录各自是 first-run", () => {
  assert.equal(growthModel(null).kind, "offline");
  const m = growthModel({
    pet: { name: "Mochi", species: "Embercub", level: 1, exp: 40, next_level_exp: 100, health: null },
    curve: [
      { level: 1, required: 100, total: 100 },
      { level: 2, required: 150, total: 250 },
    ],
    week: { total: 0, sources: { token: 0, outcome: 0, care: 0, self: 0 }, daily: [{ day: "2026-09-29", total: 0 }] },
    level_ups: [],
    evolution: { state: "level", to_form: "Cinderclaw", from_level: 5, level: 1, health_gate: 0.7, health: null },
  });
  assert.equal(m.kind, "growth");
  assert.equal(m.curve.length, 2);
  assert.deepEqual(m.curve.map((p) => p.status), ["current", "ahead"]);
  assert.equal(m.curve[0].fill, 0.4);
  assert.equal(m.week.empty, true);
  assert.equal(m.week.daily[0].height, 0, "一周都是 0 时不除以零");
  assert.deepEqual(m.levelUps, []);
  assert.equal(m.pet.toNext, 60);
});

test("项目短名：路径分隔符一个都不进（POSIX 与 Windows）", () => {
  assert.equal(safeName("/Users/alice/secret-corp/my-app"), "my-app");
  assert.equal(safeName("C:\\Users\\alice\\client\\site"), "site");
  assert.equal(safeName("my-app/"), "my-app");
  assert.equal(safeName(""), "?");
  assert.equal(safeName(null), "?");
});

test("dayFactors：四个因子固定顺序；本地日键跟着本地时间走", () => {
  assert.deepEqual(dayFactors(null).map((f) => f.name), ["context", "focus", "response", "outcome"]);
  assert.equal(localDay(new Date(2026, 8, 28, 23, 50)), "2026-09-28");
});
