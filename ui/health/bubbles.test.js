/**
 * 气泡纯判定的单测：常驻气泡的撤除（U1），以及 U7 的键、淘汰、排版、动作表与停留护栏。
 *
 * U1 守两个方向：一个不存在的会话不该继续在屏幕上求人回答（R17），
 * 一个还在等你的会话，气泡一条都不能丢。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  stickyBubbleStale,
  STALE_PUSH_GRACE_MS,
  bubbleKey,
  isActionable,
  collapseTarget,
  sortBubbles,
  layoutBubbles,
  pickEvictions,
  bubbleFactor,
  bubbleActions,
  actionsLabel,
  DWELL_MS,
  MAX_ACTIONS,
  guardFocus,
  guardTop,
  guardContent,
  guardResnap,
  decideKey,
} from "./bubbles.js";

const NOW = 1_800_000_000_000;
const old = { agent: "claude_code", session: "s1", createdAt: NOW - STALE_PUSH_GRACE_MS - 1 };
const session = (state, extra = {}) => ({ agent: "claude_code", session_id: "s1", state, ...extra });

test("session 已经不在推送列表里（掉出 LIMIT 50 / 被回收）→ 撤掉", () => {
  assert.equal(stickyBubbleStale(old, [], NOW), true);
  assert.equal(stickyBubbleStale(old, [session("working", { session_id: "other" })], NOW), true);
});

test("session 还在、仍然在等你 → 留着", () => {
  assert.equal(stickyBubbleStale(old, [session("needs-you")], NOW), false);
});

test("session 还在、但不再等你 → 撤掉（老行为不变）", () => {
  assert.equal(stickyBubbleStale(old, [session("working")], NOW), true);
  assert.equal(stickyBubbleStale(old, [session("idle")], NOW), true);
});

test("同 session_id 不同 agent 不算同一个会话", () => {
  const codex = session("needs-you", { agent: "codex" });
  assert.equal(stickyBubbleStale(old, [codex], NOW), true);
});

test("刚出生的气泡不被一份过期的轮询快照撤掉（session 还没进列表 / 还是 working）", () => {
  const fresh = { ...old, createdAt: NOW - 1000 };
  assert.equal(stickyBubbleStale(fresh, [], NOW), false);
  assert.equal(stickyBubbleStale(fresh, [session("working")], NOW), false);
  // 过了宽限期，同一份列表就该生效
  assert.equal(stickyBubbleStale(fresh, [], NOW + STALE_PUSH_GRACE_MS), true);
});

/* ================= U7：气泡组件（R14 / R15 / R16） =================
 * 键与淘汰先写：两条都是安全性质 —— 两个权限请求绝不合并成一条，
 * 一条「等你」绝不被悄悄挤掉 —— 而且两条都是对今天已有行为的回归。 */

const notif = (type, extra = {}) => ({ agent: "claude_code", session_id: "s1", type, ...extra });
/** 屏幕上的一条气泡（app.js 里的记录只多了 DOM 那一截） */
const rec = (uid, type, seq, extra = {}) => ({
  uid, type, seq, key: `k${uid}`, actionable: isActionable(type), sticky: isActionable(type), ...extra,
});

test("同一 session 的两个权限请求 → 两个不同的键（R15：绝不合并）", () => {
  const a = bubbleKey(notif("permission", { id: 11, event_id: "e1" }));
  const b = bubbleKey(notif("permission", { id: 12, event_id: "e2" }));
  assert.notEqual(a, b);
  // 决策问题同理
  assert.notEqual(bubbleKey(notif("decision", { id: 1 })), bubbleKey(notif("decision", { id: 2 })));
});

test("老 Core 不发 id 时退到 event_id；两样都没有 → 没有键（永不合并）", () => {
  assert.notEqual(bubbleKey(notif("permission", { event_id: "e1" })), bubbleKey(notif("permission", { event_id: "e2" })));
  assert.equal(bubbleKey(notif("permission")), null);
});

test("同一 session 的两条 context 警告 → 同一个键（辅导类照旧原地合并）", () => {
  assert.equal(bubbleKey(notif("context", { id: 1 })), bubbleKey(notif("context", { id: 2 })));
  // 不同 session / 不同类型不合并
  assert.notEqual(bubbleKey(notif("context")), bubbleKey(notif("context", { session_id: "s2" })));
  assert.notEqual(bubbleKey(notif("context")), bubbleKey(notif("error")));
});

test("可操作的气泡永远不被选来原地更新，哪怕键撞上了", () => {
  const n = notif("permission", { id: 12 });
  const onScreen = [{ uid: 1, key: bubbleKey(n), actionable: true }];
  assert.equal(collapseTarget(onScreen, n), null);
  // 键为 null 时也不匹配一条键为 null 的旧气泡
  assert.equal(collapseTarget([{ uid: 2, key: null, actionable: true }], notif("permission")), null);
  // 辅导类照常命中
  const c = notif("context", { id: 3 });
  const coach = { uid: 3, key: bubbleKey(c), actionable: false };
  assert.equal(collapseTarget([coach], notif("context", { id: 4 })), coach);
});

test("淘汰永远不选常驻气泡 —— 屏幕上全是常驻时一条都不淘汰", () => {
  const all = [1, 2, 3, 4, 5].map((i) => rec(i, "permission", i));
  assert.deepEqual(pickEvictions(all, 4), []);
  // 混着的时候先淘汰最老的会自己走的那条，常驻的一条不碰
  const mixed = [rec(1, "permission", 1), rec(2, "context", 2), rec(3, "permission", 3), rec(4, "error", 4), rec(5, "ready", 5)];
  const victims = pickEvictions(mixed, 4).map((b) => b.uid);
  assert.deepEqual(victims, [2]);
  assert.deepEqual(pickEvictions(mixed, 2).map((b) => b.uid), [2, 4, 5]);
});

test("四条常驻 → 一条展开 + 三条单行，计数为三", () => {
  const four = [1, 2, 3, 4].map((i) => rec(i, "permission", i));
  const l = layoutBubbles(four);
  assert.equal(l.top.uid, 1);
  assert.deepEqual(l.stubs.map((b) => b.uid), [2, 3, 4]);
  assert.equal(l.behind, 3);
  assert.equal(l.hidden, 0);
  // 再多也不丢：多出来的折进计数
  const six = [1, 2, 3, 4, 5, 6].map((i) => rec(i, "permission", i));
  const l6 = layoutBubbles(six);
  assert.equal(l6.stubs.length, 3);
  assert.equal(l6.behind, 5);
  assert.equal(l6.hidden, 2);
  assert.deepEqual(layoutBubbles([]), { top: null, stubs: [], behind: 0, hidden: 0 });
});

test("可操作的排在辅导类前面；同一档按到达顺序，同一刻到的两条顺序稳定", () => {
  const list = [rec(1, "context", 1), rec(2, "permission", 2), rec(3, "permission", 3)];
  assert.deepEqual(sortBubbles(list).map((b) => b.uid), [2, 3, 1]);
  // 同一 tick：createdAt 一样，靠 seq 定序；输入顺序打乱结果也一样 —— 顶上那条不会在按键时换人
  const tick = 1000;
  const a = rec(10, "permission", 7, { createdAt: tick });
  const b = rec(11, "decision", 8, { createdAt: tick });
  assert.deepEqual(sortBubbles([a, b]).map((x) => x.uid), [10, 11]);
  assert.deepEqual(sortBubbles([b, a]).map((x) => x.uid), [10, 11]);
  // 后来的同档气泡排在后面，不抢顶
  const later = rec(12, "permission", 9);
  assert.equal(layoutBubbles([a, b, later]).top.uid, 10);
});

test("移除判定：session 不在了 → 撤；还在且还在等你 → 留（R17）", () => {
  const b = { agent: "claude_code", session: "s1", createdAt: NOW - STALE_PUSH_GRACE_MS - 1 };
  assert.equal(stickyBubbleStale(b, [session("working", { session_id: "gone" })], NOW), true);
  assert.equal(stickyBubbleStale(b, [session("needs-you")], NOW), false);
});

test("因子点名（R14）：context → Context，报错 → Outcome，重复编辑 → Focus；其余不点名", () => {
  assert.equal(bubbleFactor("context"), "context");
  assert.equal(bubbleFactor("error"), "outcome");
  assert.equal(bubbleFactor("repeat_edit"), "focus");
  assert.equal(bubbleFactor("permission"), null);
  assert.equal(bubbleFactor("drift"), null, "drift 是影子模式，不带分，也就不点名（KTD11）");
  assert.equal(bubbleFactor("milestone"), null);
});

test("动作表是数据：每条带数字键、文案 key，恰好一条安全动作；不超过三条", () => {
  for (const type of ["permission", "decision", "context", "error", "ready", "milestone", "drift"]) {
    const acts = bubbleActions(notif(type, { id: 1 }));
    assert.ok(acts.length >= 1 && acts.length <= MAX_ACTIONS, type);
    assert.deepEqual(acts.map((a) => a.key), acts.map((_, i) => String(i + 1)), `${type} 的数字键从 1 连续编号`);
    assert.equal(acts.filter((a) => a.safe).length, 1, `${type} 恰好一条安全动作`);
    for (const a of acts) assert.ok(a.id && a.labelKey, `${type} / ${a.id}`);
  }
  // 现在还没有回传通道：权限气泡上绝没有「允许」这一类动作
  assert.ok(!bubbleActions(notif("permission", { id: 1 })).some((a) => /allow/i.test(a.id) && !/always/i.test(a.id)));
});

test("无障碍名写明每个数字键做什么（R28）", () => {
  const acts = [
    { id: "dismiss", key: "1", labelKey: "d", safe: true },
    { id: "always", key: "2", labelKey: "a", params: { tool: "Bash" } },
  ];
  const tr = (k, p) => (k === "d" ? "Dismiss" : `Always allow ${p.tool}`);
  assert.equal(actionsLabel(acts, tr), "1: Dismiss, 2: Always allow Bash");
});

/* ---------------- 停留护栏与快照 ---------------- */
const ACTS = [
  { id: "dismiss", key: "1", labelKey: "d", safe: true },
  { id: "extra", key: "2", labelKey: "x", safe: false },
];
const press = (g, key, now, topId, extra = {}) => decideKey(g, { key, repeat: false, now, topId, actions: ACTS, ...extra });

test("停留窗口内的按键被拦下，过了窗口才生效", () => {
  const g = guardFocus(1000, 7);
  assert.equal(press(g, "1", 1000 + DWELL_MS - 1, 7).kind, "dwell");
  const ok = press(g, "1", 1000 + DWELL_MS, 7);
  assert.equal(ok.kind, "act");
  assert.equal(ok.action.id, "dismiss");
  assert.equal(press(g, "2", 1000 + DWELL_MS, 7).action.id, "extra");
});

test("停留时长在 500–750ms 之间", () => {
  assert.ok(DWELL_MS >= 500 && DWELL_MS <= 750);
});

test("自动连发的 keydown 被吞掉", () => {
  const g = guardFocus(0, 7);
  assert.equal(press(g, "1", 10_000, 7, { repeat: true }).kind, "swallow");
  assert.equal(press(g, "Enter", 10_000, 7, { repeat: true }).kind, "swallow");
});

test("Enter 绑安全动作，永远不绑别的", () => {
  const g = guardFocus(0, 7);
  const r = press(g, "Enter", 10_000, 7);
  assert.equal(r.kind, "act");
  assert.equal(r.action.safe, true);
  // 没有安全动作的表：Enter 什么也不做
  assert.equal(decideKey(g, { key: "Enter", repeat: false, now: 10_000, topId: 7, actions: [ACTS[1]] }).kind, "pass");
});

test("不是我们的键 / 没有顶上的气泡 / 窗口没焦点 → 放行，不吞", () => {
  const g = guardFocus(0, 7);
  assert.equal(press(g, "3", 10_000, 7).kind, "pass");
  assert.equal(press(g, "a", 10_000, 7).kind, "pass");
  assert.equal(press(g, "1", 10_000, null).kind, "pass");
  assert.equal(press(null, "1", 10_000, 7).kind, "unfocused");
});

test("快照：拿到焦点后顶上换了人 → 拒绝按键，不落到新气泡上", () => {
  const g = guardTop(guardFocus(0, 7), 8, 5000);
  assert.equal(g.snapshotId, 7, "已经有快照时，换顶不改快照");
  assert.equal(press(g, "1", 10_000, 8).kind, "changed");
});

test("快照那条还在顶上 → 按键照常生效", () => {
  const g = guardTop(guardFocus(0, 7), 7, 5000);
  assert.equal(press(g, "1", 10_000, 7).kind, "act");
});

test("拿焦点时还没有气泡：第一条成为顶的那一刻拍快照、从那一刻起算停留（取较晚者）", () => {
  const g0 = guardFocus(1000, null);
  const g = guardTop(g0, 9, 4000);
  assert.equal(g.snapshotId, 9);
  assert.equal(press(g, "1", 4000 + DWELL_MS - 1, 9).kind, "dwell");
  assert.equal(press(g, "1", 4000 + DWELL_MS, 9).kind, "act");
});

test("被拒之后重拍快照，并重新计停留", () => {
  const g = guardResnap(guardFocus(0, 7), 8, 10_000);
  assert.equal(g.snapshotId, 8);
  assert.equal(press(g, "1", 10_000 + DWELL_MS - 1, 8).kind, "dwell");
  assert.equal(press(g, "1", 10_000 + DWELL_MS, 8).kind, "act");
});

test("辅导气泡原地改了正文 → 停留护栏重新上膛，不只是新建时", () => {
  const g0 = guardFocus(0, 7);
  assert.equal(press(g0, "1", 5000, 7).kind, "act");
  const g = guardContent(g0, 7, 5000); // 72% → 95%
  assert.equal(press(g, "1", 5000 + DWELL_MS - 1, 7).kind, "dwell");
  assert.equal(press(g, "1", 5000 + DWELL_MS, 7).kind, "act");
  // 别的气泡改了正文不影响快照那条
  assert.equal(guardContent(g0, 99, 5000), g0);
});
