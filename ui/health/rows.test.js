/**
 * 浮层 Session Health 行的单测（R13）。
 *
 * 守三件事：排序说的是「先处理哪一个」，指纹不多不少地触发重画，
 * 以及「没测到 / 没结算 / 被回收」三种没有分数的情况永远不被画成 0、不被选成最弱。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FACTOR_NAMES,
  rowHealth,
  sortSessions,
  panelSignature,
  factorBreakdown,
  weakestFactor,
  rowKey,
} from "./rows.js";

const health = (score, factors, extra = {}) => ({
  score,
  factors: { context: null, focus: null, response: null, outcome: null, ...factors },
  evidence: { context_peak: 50, repeat_edits: 0, response_median_ms: null, response_samples: 0, outcome: null, error_count: 0 },
  unsettled: extra.unsettled ?? false,
  omitted: extra.omitted ?? [],
});
const session = (id, state, h, extra = {}) => ({
  agent: "claude_code", session_id: id, state, is_active: true, token_used: 0, title: id, health: h, ...extra,
});

const sig = (sessions, extra = {}) =>
  panelSignature({ reachable: true, adapters: 1, waitTick: 0, sessions, showHealth: true, expanded: [], ...extra });

test("排序：needs-you 永远最前（哪怕分数最高），其余按分数从差到好", () => {
  const list = [
    session("good", "working", health(90, { context: 25 })),
    session("waiting", "needs-you", health(95, { context: 25 })),
    session("bad", "idle", health(40, { context: 6 })),
    session("mid", "working", health(66, { context: 19 })),
  ];
  assert.deepEqual(sortSessions(list).map((s) => s.session_id), ["waiting", "bad", "mid", "good"]);
});

test("排序：没有分数的排在有分数的后面；可见性关掉时只按状态排", () => {
  const list = [
    session("nohealth", "warning", null),
    session("scored", "idle", health(80, { context: 25 })),
  ];
  assert.deepEqual(sortSessions(list).map((s) => s.session_id), ["scored", "nohealth"]);
  assert.deepEqual(sortSessions(list, { byScore: false }).map((s) => s.session_id), ["nohealth", "scored"]);
});

test("指纹：只有分数变了也要变 —— 列表才会真的刷新", () => {
  const a = [session("s1", "working", health(72.5, { context: 19 }))];
  const b = [session("s1", "working", health(68.1, { context: 12 }))];
  assert.notEqual(sig(a), sig(b));
  // 临时分结算了（unsettled 翻转）也算变
  const c = [session("s1", "working", health(72.5, { context: 19 }, { unsettled: true }))];
  assert.notEqual(sig(a), sig(c));
});

test("指纹：没有相关变化时一字不差（不然焦点会在操作中途被偷走）", () => {
  const mk = () => [session("s1", "working", health(72.5, { context: 19 }), { last_event_at: String(Math.random()) })];
  assert.equal(sig(mk()), sig(mk()), "last_event_at 这类不画出来的字段不进指纹");
  // 一个已经不在列表里的行的展开状态也不算
  assert.equal(sig(mk(), { expanded: ["codex:gone"] }), sig(mk()));
  assert.notEqual(sig(mk(), { expanded: [rowKey(mk()[0])] }), sig(mk()));
});

test("最弱因子：省略的因子没有数据，不会被选成最弱", () => {
  const h = health(70, { context: 19, focus: 20, response: null, outcome: 25 }, { omitted: ["response"] });
  assert.equal(weakestFactor(h), "context");
});

test("最弱因子：没结算的 Outcome 不参与（它还会变）", () => {
  // outcome 字段就算带着一个数也不信：unsettled 说了算
  const h = health(60, { context: 19, focus: 14, response: 20, outcome: 0 }, { unsettled: true });
  assert.equal(weakestFactor(h), "focus");
  assert.equal(weakestFactor(health(100, { context: 25, focus: 25, response: 25, outcome: 25 })), null, "全满分不点名");
});

test("被回收的 session 没有分数也没有 pip，不是 0", () => {
  const ghost = session("g", "finished", null, { is_active: false, outcome: "timeout" });
  assert.equal(rowHealth(ghost), null);
  // 就算带着 health（老数据）也不画：被回收的一段不打分（R10）
  const orphan = session("o", "finished", health(50, { context: 25 }), { is_active: false, outcome: "orphaned" });
  assert.equal(rowHealth(orphan), null);
});

test("每个因子都省略 → 说不知道，不是 0", () => {
  const h = health(null, {}, { omitted: [...FACTOR_NAMES] });
  assert.deepEqual(rowHealth(session("u", "working", h)), { kind: "unknown" });
  // 防御：分数给了数但四个都省略，照样是不知道
  assert.equal(rowHealth(session("u", "working", { ...h, score: 0 })).kind, "unknown");
  assert.ok(factorBreakdown(h).every((f) => f.status === "omitted"));
  assert.equal(weakestFactor(h), null);
});

test("有分的行：向下取整显示、带色带；没结算的是临时分", () => {
  const r = rowHealth(session("s", "working", health(79.9, { context: 19 }, { unsettled: true })));
  assert.equal(r.kind, "score");
  assert.equal(r.shown, 79);
  assert.equal(r.strip.lit, 7);
  assert.equal(r.band, "neutral");
  assert.equal(r.provisional, true);
  assert.equal(rowHealth(session("s", "working", health(45, { context: 6 }))).band, "red");
});

test("展开后的四行：省略写成 omitted、没结算的 Outcome 是 pending，都不是 0 分", () => {
  const h = health(72, { context: 12, focus: 20, response: null, outcome: null }, { unsettled: true, omitted: ["response"] });
  const rows = factorBreakdown(h);
  assert.deepEqual(rows.map((r) => r.name), FACTOR_NAMES);
  assert.deepEqual(rows.map((r) => r.status), ["scored", "scored", "omitted", "pending"]);
  assert.equal(rows[0].ratio, 12 / 25);
  assert.equal(rows[2].points, null);
  assert.equal(rows[3].points, null);
});
