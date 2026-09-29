/**
 * Session Health 打分模块（U3）的单测 —— 先写的这一份：档位就是规格，
 * 一条边界写错会悄无声息地把每一个 session 都打错分。
 *
 * 全是纯函数：没有 db、没有时钟。读库的那一层在 health_query.test.ts。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FACTOR_NAMES,
  FACTOR_MAX,
  contextPoints,
  focusPoints,
  responsePoints,
  outcomePoints,
  responseSampleMs,
  median,
  scoreSegment,
  petScore,
  segmentDurationMs,
  dayMean,
  petHealthFromMean,
  DURATION_FLOOR_MS,
  SPOOL_REPLAY_GAP_MS,
  ARTEFACT_WAIT_MS,
  RESPONSE_SAMPLE_CAP_MS,
  HEALTH_FULL_AT,
  HEALTH_FLOOR_AT,
  HEALTH_FLOOR,
  segmentInputFromRows,
  type SegmentInput,
  type WaitSample,
} from "./health.ts";
import { TIRED_HEALTH_THRESHOLD } from "./exp.ts";

const T0 = Date.parse("2026-09-29T10:00:00.000Z");
const iso = (ms: number) => new Date(T0 + ms).toISOString();
const MIN = 60_000;

function wait(durationMs: number, over: Partial<WaitSample> = {}): WaitSample {
  return {
    startedAt: iso(0),
    receivedAt: iso(50),
    clearedAt: iso(durationMs),
    resolution: "inferred",
    mutedMs: 0,
    sleptMs: 0,
    ...over,
  };
}

function seg(over: Partial<SegmentInput> = {}): SegmentInput {
  return {
    contextPeak: 40,
    contextReported: true,
    repeatEdits: 0,
    waits: [],
    outcome: "success",
    errorCount: 0,
    settled: true,
    startedAt: iso(0),
    finishedAt: iso(60 * MIN),
    ...over,
  };
}

/* ================= 档位 ================= */

test("Context：<70 满分、70–85 含两端 19、>85–95 含 95 为 12、>95 为 6 —— 与 contextMultiplier 同一组比较", () => {
  assert.equal(contextPoints(0), 25);
  assert.equal(contextPoints(69.9), 25);
  assert.equal(contextPoints(70), 19, "恰好 70 属于第二档（exp.ts: pct < 70 才是第一档）");
  assert.equal(contextPoints(85), 19, "恰好 85 属于 19 分档（exp.ts:56 的 <= 85）");
  assert.equal(contextPoints(85.1), 12);
  assert.equal(contextPoints(95), 12, "恰好 95 仍是 12 分档");
  assert.equal(contextPoints(95.1), 6);
  assert.equal(contextPoints(100), 6);
});

test("Focus：0 → 25、1–2 → 20、3–4 → 14、5 及以上 → 8", () => {
  assert.equal(focusPoints(0), 25);
  assert.equal(focusPoints(1), 20);
  assert.equal(focusPoints(2), 20);
  assert.equal(focusPoints(3), 14);
  assert.equal(focusPoints(4), 14);
  assert.equal(focusPoints(5), 8, "五次 = correction loop 档");
  assert.equal(focusPoints(40), 8);
});

test("Response：<1m → 25、1–5m → 20、>5–15m → 13、>15m → 7", () => {
  assert.equal(responsePoints(0), 25);
  assert.equal(responsePoints(59_999), 25);
  assert.equal(responsePoints(MIN), 20, "恰好 1 分钟进 1–5m 档");
  assert.equal(responsePoints(5 * MIN), 20, "恰好 5 分钟仍在 1–5m 档");
  assert.equal(responsePoints(5 * MIN + 1), 13);
  assert.equal(responsePoints(15 * MIN), 13);
  assert.equal(responsePoints(15 * MIN + 1), 7);
});

test("Outcome：success 无报错 25、success 有报错 20、partial 12、abandoned 5、被回收的不打分", () => {
  assert.equal(outcomePoints("success", 0), 25);
  assert.equal(outcomePoints("success", 3), 20);
  assert.equal(outcomePoints("partial", 0), 12);
  assert.equal(outcomePoints("partial", 4), 12, "partial 不再因为报错额外扣分");
  assert.equal(outcomePoints("abandoned", 0), 5);
  assert.equal(outcomePoints("orphaned", 0), null);
  assert.equal(outcomePoints("timeout", 0), null);
  assert.equal(outcomePoints("something-new", 0), null, "认不出的 outcome 不猜");
});

test("四个因子各 25 分，名字固定", () => {
  assert.deepEqual([...FACTOR_NAMES], ["context", "focus", "response", "outcome"]);
  assert.equal(FACTOR_MAX, 25);
});

/* ================= Response 样本 ================= */

test("中位数：奇数取中间、偶数取中间两个的平均、空集 null", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([]), null);
});

test("一段 14 小时的等待被夹到 30 分钟上限，而不是按 14 小时打分", () => {
  assert.equal(RESPONSE_SAMPLE_CAP_MS, 30 * MIN);
  assert.equal(responseSampleMs(wait(14 * 60 * MIN)), 30 * MIN);
  const r = scoreSegment(seg({ waits: [wait(14 * 60 * MIN)] }))!;
  assert.equal(r.evidence.responseMedianMs, 30 * MIN);
  assert.equal(r.factors.response, 7);
});

test("被回收收掉的等待（timeout）照样算数，夹到上限 —— 丢掉它们等于把「走开了」报成「答得快」", () => {
  assert.equal(responseSampleMs(wait(3 * 60 * MIN, { resolution: "timeout" })), 30 * MIN);
});

test("跨过休眠的、整段被静音的等待不产生样本", () => {
  assert.equal(responseSampleMs(wait(10 * MIN, { sleptMs: 1 })), null);
  assert.equal(responseSampleMs(wait(10 * MIN, { mutedMs: 10 * MIN })), null, "整段静音");
  assert.equal(responseSampleMs(wait(10 * MIN, { mutedMs: 4 * MIN })), 10 * MIN, "只静音了一部分：照算");
});

test("离线缓冲回放（received_at 远晚于 started_at）不产生样本", () => {
  const replayed = wait(2 * MIN, { receivedAt: iso(SPOOL_REPLAY_GAP_MS + 1) });
  assert.equal(responseSampleMs(replayed), null);
  const onTime = wait(2 * MIN, { receivedAt: iso(SPOOL_REPLAY_GAP_MS) });
  assert.equal(responseSampleMs(onTime), 2 * MIN);
});

test("亚秒级的 turn_ended 是事件拼接的伪影（权限请求后紧跟一条 Notification），丢掉；别的收法照算", () => {
  assert.equal(ARTEFACT_WAIT_MS, 1000);
  assert.equal(responseSampleMs(wait(200, { resolution: "turn_ended" })), null);
  assert.equal(responseSampleMs(wait(1000, { resolution: "turn_ended" })), 1000, "满一秒的是真等待");
  assert.equal(responseSampleMs(wait(200, { resolution: "inferred" })), 200, "秒答不是伪影");
  // 一串伪影不该把一个真实的 20 分钟等待「稀释」成满分
  const r = scoreSegment(
    seg({ waits: [wait(20 * MIN), wait(100, { resolution: "turn_ended" }), wait(100, { resolution: "turn_ended" })] }),
  )!;
  assert.equal(r.evidence.responseSamples, 1);
  assert.equal(r.factors.response, 7);
});

test("还没关的等待不是样本", () => {
  assert.equal(responseSampleMs(wait(5 * MIN, { clearedAt: null, resolution: null })), null);
});

/* ================= 省略与重新归一 ================= */

test("没有样本的 Response 报成 omitted，分数在其余三个因子上归一到 100，而不是白送 25", () => {
  const r = scoreSegment(seg({ contextPeak: 80, repeatEdits: 1, outcome: "partial" }))!;
  assert.deepEqual(r.omitted, ["response"]);
  assert.equal(r.factors.response, null);
  // (19 + 20 + 12) / 75 × 100 = 68
  assert.equal(r.score, 68);
});

test("没报过 context 的一段省略 Context —— 是「不知道」，不是「峰值 0 = 很健康」", () => {
  const r = scoreSegment(seg({ contextPeak: 0, contextReported: false, waits: [wait(10_000)] }))!;
  assert.ok(r.omitted.includes("context"));
  assert.equal(r.factors.context, null);
  assert.equal(r.evidence.contextPeak, null);
});

test("R8：一段没有任何阻塞的 session 不可能比「阻塞了、又被秒答」的同一段 session 分高", () => {
  const ctx = [40, 80, 90, 99];
  const edits = [0, 2, 4, 9];
  const outcomes: Array<[string, number]> = [["success", 0], ["success", 2], ["partial", 0], ["abandoned", 0]];
  for (const c of ctx) {
    for (const e of edits) {
      for (const [o, errs] of outcomes) {
        for (const reported of [true, false]) {
          const base = { contextPeak: c, contextReported: reported, repeatEdits: e, outcome: o, errorCount: errs };
          const quiet = scoreSegment(seg({ ...base, waits: [] }))!;
          const prompt = scoreSegment(seg({ ...base, waits: [wait(20_000)] }))!;
          assert.ok(
            quiet.score! <= prompt.score!,
            `ctx=${c} edits=${e} outcome=${o} reported=${reported}: 没阻塞 ${quiet.score} > 秒答 ${prompt.score}`,
          );
          const quietPet = petScore(quiet)!;
          const promptPet = petScore(prompt)!;
          assert.equal(quietPet, promptPet, "宠物分本来就不看 Response");
        }
      }
    }
  }
});

test("bypassPermissions 下没有阻塞事件：Response 只是省略，没有别的说法", () => {
  const r = scoreSegment(seg({ waits: [] }))!;
  assert.deepEqual(r.omitted, ["response"]);
  assert.equal(r.score, 100);
});

/* ================= 结算 ================= */

test("还在跑的一段：unsettled，Outcome 为 null（不是 omitted —— 它会来的）", () => {
  const r = scoreSegment(seg({ settled: false, outcome: null, finishedAt: null }))!;
  assert.equal(r.unsettled, true);
  assert.equal(r.factors.outcome, null);
  assert.ok(!r.omitted.includes("outcome"));
  assert.equal(typeof r.score, "number", "live 分数是临时的，但照样给界面看");
});

test("被回收（orphaned / timeout）的一段没有分数 —— 是 null，不是 0", () => {
  assert.equal(scoreSegment(seg({ outcome: "orphaned" })), null);
  assert.equal(scoreSegment(seg({ outcome: "timeout" })), null);
});

test("手算的一段：峰值 88、重复编辑 3、等待中位 2 分钟、success 带报错 → (12+14+20+20)/100 = 66", () => {
  const r = scoreSegment(
    seg({ contextPeak: 88, repeatEdits: 3, errorCount: 1, waits: [wait(1 * MIN), wait(2 * MIN), wait(4 * MIN)] }),
  )!;
  assert.deepEqual(r.factors, { context: 12, focus: 14, response: 20, outcome: 20 });
  assert.deepEqual(r.omitted, []);
  assert.equal(r.score, 66);
  assert.equal(r.unsettled, false);
  // 宠物分只看 Context / Focus / Outcome：(12+14+20)/75 × 100 = 61.3
  assert.equal(petScore(r), 61.3);
});

/* ================= 一天的聚合 ================= */

test("时长：segment_started_at → finished_at；坏时间戳 / 没结算返回 null", () => {
  assert.equal(segmentDurationMs(seg({ startedAt: iso(0), finishedAt: iso(4 * 60 * MIN) })), 4 * 60 * MIN);
  assert.equal(segmentDurationMs(seg({ startedAt: null })), null);
  assert.equal(segmentDurationMs(seg({ finishedAt: null })), null);
  assert.equal(segmentDurationMs(seg({ startedAt: iso(10), finishedAt: iso(0) })), 0, "时钟倒退夹 0");
});

test("按时长加权：四小时的一段压过三十秒的一段；时长下限让一行 claude -p 也不至于是 0 权重", () => {
  const long = seg({ contextPeak: 40, finishedAt: iso(4 * 60 * MIN) }); // 宠物分 100
  const oneLiner = seg({ contextPeak: 99, repeatEdits: 9, outcome: "abandoned", finishedAt: iso(30_000) }); // (6+8+5)/75
  const mean = dayMean([long, oneLiner])!;
  const w1 = 4 * 60 * MIN;
  const w2 = DURATION_FLOOR_MS;
  const expected = (100 * w1 + (19 / 75) * 100 * w2) / (w1 + w2);
  assert.ok(Math.abs(mean - expected) < 0.05, `${mean} ≈ ${expected}`);
  assert.ok(mean > 95, "一天里那条一行命令拉不垮四小时的正事");
});

test("聚合只收已结算、没被回收的段；一段都没有 → null（不知道），不是 0", () => {
  assert.equal(dayMean([]), null);
  assert.equal(dayMean([seg({ settled: false, outcome: null, finishedAt: null })]), null);
  assert.equal(dayMean([seg({ outcome: "timeout" })]), null);
  assert.equal(dayMean([seg({ outcome: "timeout" }), seg()]), 100);
});

/* ================= 映射到 pets.health_score ================= */

test("映射：≥ HEALTH_FULL_AT 为 1.0，≤ HEALTH_FLOOR_AT 为下限 0.5，中间线性；null 保持 null（不知道）", () => {
  assert.equal(HEALTH_FLOOR, 0.5);
  assert.equal(petHealthFromMean(100), 1);
  assert.equal(petHealthFromMean(HEALTH_FULL_AT), 1);
  assert.equal(petHealthFromMean(HEALTH_FLOOR_AT), 0.5);
  assert.equal(petHealthFromMean(0), 0.5);
  const mid = petHealthFromMean((HEALTH_FULL_AT + HEALTH_FLOOR_AT) / 2)!;
  assert.ok(Math.abs(mid - 0.75) < 0.011);
  assert.equal(petHealthFromMean(null), null);
});

test("映射是单调的：分数高的一天，宠物永远不会更累", () => {
  let prev = -1;
  for (let m = 0; m <= 100; m += 0.5) {
    const h = petHealthFromMean(m)!;
    assert.ok(h >= prev, `${m} → ${h} < ${prev}`);
    prev = h;
  }
});

test("普通的一天（混着几段正常 session）宠物不 tired —— 与改之前「没报错的一天 = 1.0」同一个结论", () => {
  const day = [
    // 常规：context 走到 70–85、改错过一两次、顺利收工
    seg({ contextPeak: 78, repeatEdits: 1, finishedAt: iso(90 * MIN) }),
    // 长 session：撞到 88%、重复编辑 3 次、中间报过错但收工了
    seg({ contextPeak: 88, repeatEdits: 3, errorCount: 2, finishedAt: iso(3 * 60 * MIN) }),
    // 一段放弃掉的短尝试
    seg({ contextPeak: 30, repeatEdits: 0, outcome: "abandoned", finishedAt: iso(10 * MIN) }),
    // 一段 partial
    seg({ contextPeak: 65, repeatEdits: 2, outcome: "partial", finishedAt: iso(40 * MIN) }),
  ];
  const h = petHealthFromMean(dayMean(day))!;
  assert.ok(h >= TIRED_HEALTH_THRESHOLD, `普通的一天被判成 tired：health=${h}`);
});

test("一整天都在 correction loop + 撞满 context + 放弃：宠物会 tired —— 这条线还有意义", () => {
  const bad = [
    seg({ contextPeak: 97, repeatEdits: 8, outcome: "abandoned", finishedAt: iso(2 * 60 * MIN) }),
    seg({ contextPeak: 92, repeatEdits: 6, outcome: "partial", finishedAt: iso(60 * MIN) }),
  ];
  const h = petHealthFromMean(dayMean(bad))!;
  assert.ok(h < TIRED_HEALTH_THRESHOLD, `health=${h}`);
});

/* ================= 行 → 输入 ================= */

test("行适配器：本段的列 → SegmentInput；is_active=1 或 finished_at 为空都算没结算", () => {
  const row = {
    segment: 2,
    segment_started_at: iso(0),
    context_peak: 91,
    context_reported_at: iso(5),
    repeat_edit_count: 3,
    finished_at: iso(60 * MIN),
    outcome: "success",
    is_active: 0,
  };
  const waitRow = {
    started_at: iso(0),
    received_at: iso(10),
    cleared_at: iso(MIN),
    resolution: "inferred",
    muted_ms: 0,
    slept_ms: 0,
  };
  const input = segmentInputFromRows(row, [waitRow], 2);
  assert.equal(input.contextPeak, 91);
  assert.equal(input.contextReported, true);
  assert.equal(input.repeatEdits, 3);
  assert.equal(input.settled, true);
  assert.equal(input.errorCount, 2);
  assert.equal(input.waits.length, 1);
  assert.equal(input.waits[0]!.clearedAt, iso(MIN));

  assert.equal(segmentInputFromRows({ ...row, is_active: 1 }, [], 0).settled, false);
  assert.equal(segmentInputFromRows({ ...row, finished_at: null }, [], 0).settled, false);
  assert.equal(segmentInputFromRows({ ...row, context_reported_at: null }, [], 0).contextReported, false);
});
