/**
 * 周卡的单测（U14 / R26）。
 *
 * 周卡是唯一会离开这台机器的东西，所以守的第一件事是：绘制清单里没有一个路径分隔符 ——
 * 不管项目名从哪来、长什么样（POSIX / Windows）。其余是这张图不许画错的几种一周：
 * 两段（不除以零）、零段（空状态，不是白卡）、23:50 收工（落在用户过的那一天）、没结算的段（不算）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { t as translate } from "../../src/i18n/messages.js";
import {
  weekBuckets,
  weekSummary,
  layoutCard,
  redactProject,
  fitText,
  countable,
  cardFileName,
  CARD_W,
} from "./card.js";

const NOW = new Date(2026, 8, 29, 15, 0, 0); // 本地 9/29 下午
const at = (d, h, m = 0) => new Date(2026, 8, d, h, m).toISOString();
const seg = (extra = {}) => ({
  agent: "claude_code",
  session_id: "s1",
  segment: 1,
  project: "my-app",
  started_at: at(29, 9),
  finished_at: at(29, 10),
  duration_ms: 3_600_000,
  score: 80,
  pet_score: 78,
  factors: { context: 12, focus: 25, response: 20, outcome: 25 },
  omitted: [],
  ...extra,
});

/** 假的量字：每个码点 10px（汉字 20px）。够用来验证截断，不假装是真字体 */
const measure = (s) => [...String(s)].reduce((w, ch) => w + (ch.charCodeAt(0) > 0x2e80 ? 20 : 10), 0);
const env = (locale = "en") => ({
  t: (k, p) => translate(locale, k, p),
  measure,
  dayLabel: (d) => d.slice(5),
  weekday: (d) => d.slice(8),
  duration: (ms) => `${Math.round(ms / 60000)}m`,
  pet: { name: "Mochi", level: 3 },
});
const texts = (card) => card.ops.filter((o) => o.type === "text").map((o) => o.text);
const numbers = (card) =>
  card.ops.flatMap((o) => (o.type === "rect" ? [o.x, o.y, o.w, o.h] : [o.x, o.y]));

test("原始绝对路径在进清单之前就削成了最后一段", () => {
  assert.equal(redactProject("/Users/alice/secret-corp/my-app"), "my-app");
  assert.equal(redactProject("C:\\Users\\alice\\Client Co\\site"), "site");
  assert.equal(redactProject("/"), "?");
  const model = weekSummary(
    { segments: [seg({ project: "/Users/alice/secret-corp/my-app" })] },
    { now: NOW, includeProjects: true },
  );
  assert.deepEqual(model.projects, ["my-app"]);
});

test("清单里没有一个路径分隔符 —— POSIX 与 Windows 写法、宠物名、所有文案都算", () => {
  const segments = [
    seg({ project: "/Users/alice/secret-corp/my-app" }),
    seg({ session_id: "s2", project: "C:\\Users\\bob\\client\\portal", finished_at: at(28, 12) }),
    seg({ session_id: "s3", project: "weird/name\\mix", finished_at: at(27, 12) }),
  ];
  for (const locale of ["en", "zh-CN"]) {
    for (const includeProjects of [true, false]) {
      const model = weekSummary({ segments }, { now: NOW, includeProjects });
      const card = layoutCard(model, { ...env(locale), pet: { name: "a/b\\c", level: 2 } });
      for (const s of texts(card)) assert.ok(!/[\\/]/.test(s), `清单里有分隔符：${JSON.stringify(s)}（${locale}）`);
      assert.ok(!texts(card).some((s) => /alice|bob|secret-corp|client/.test(s)), "路径里的目录名一个都不许上卡");
    }
  }
});

test("默认不写项目名，只写有几个；勾上才写至多三个短名", () => {
  const segments = ["a", "b", "c", "d"].map((p, i) => seg({ session_id: p, project: `/x/${p}`, duration_ms: (i + 1) * 600_000 }));
  const off = weekSummary({ segments }, { now: NOW });
  assert.deepEqual(off.projects, []);
  assert.equal(off.projectCount, 4);
  const on = weekSummary({ segments }, { now: NOW, includeProjects: true });
  assert.deepEqual(on.projects, ["d", "c", "b"], "按这周花的时间排");
});

test("两段的一周画得出图，而且清单里没有 NaN / Infinity", () => {
  const model = weekSummary(
    { segments: [seg({ duration_ms: 0 }), seg({ session_id: "s2", duration_ms: null, pet_score: 60 })] },
    { now: NOW },
  );
  assert.equal(model.empty, false);
  assert.equal(model.sessions, 2);
  assert.equal(model.mean, 69, "时长都是 0 / 缺失 → 按 5 分钟下限等权，不除以零");
  const card = layoutCard(model, env());
  for (const n of numbers(card)) assert.ok(Number.isFinite(n), "清单里有非有限数");
  assert.ok(texts(card).includes("69"));
});

test("零段的一周是空状态，不是一张白卡", () => {
  const model = weekSummary({ segments: [] }, { now: NOW });
  assert.equal(model.empty, true);
  assert.equal(model.mean, null);
  const card = layoutCard(model, env());
  assert.ok(texts(card).includes(translate("en", "card.empty")));
  for (const n of numbers(card)) assert.ok(Number.isFinite(n));
  assert.equal(weekSummary(null, { now: NOW }).empty, true, "history 都没有也不抛");
});

test("按本地日分桶：23:50 收工的一段落在用户过的那一天", () => {
  const days = weekBuckets([seg({ finished_at: at(28, 23, 50) })], { now: NOW });
  assert.equal(days.length, 7);
  assert.equal(days.at(-1).day, "2026-09-29");
  assert.equal(days.find((d) => d.day === "2026-09-28").segments, 1);
  assert.equal(days.at(-1).segments, 0);
  assert.equal(days.at(-1).mean, null, "没有段的日子是「不知道」，不是 0");
});

test("没结算的段不进这周的任何数字", () => {
  assert.equal(countable(seg({ unsettled: true })), false);
  assert.equal(countable(seg({ outcome: "orphaned" })), false);
  assert.equal(countable(seg({ finished_at: null })), false);
  const model = weekSummary({ segments: [seg(), seg({ session_id: "live", unsettled: true, pet_score: 10 })] }, { now: NOW });
  assert.equal(model.sessions, 1);
  assert.equal(model.mean, 78);
  assert.equal(weekSummary({ segments: [seg({ unsettled: true })] }, { now: NOW }).empty, true);
});

test("文字放不下就按量出来的宽度截断加省略号，不劈开汉字", () => {
  assert.equal(fitText("hello", 100, measure), "hello");
  const cut = fitText("abcdefghij", 60, measure);
  assert.ok(measure(cut) <= 60 && cut.endsWith("…"));
  const zh = fitText("数据平台项目名很长", 70, measure);
  assert.ok(measure(zh) <= 70 && zh.endsWith("…"));
  assert.equal(fitText("abc", 5, measure), "", "连省略号都放不下就不画");
  const card = layoutCard(weekSummary({ segments: [seg()] }, { now: NOW }), { ...env("zh-CN"), pet: { name: "名".repeat(80), level: 9 } });
  for (const o of card.ops) if (o.type === "text" && o.align === "left") assert.ok(o.x + measure(o.text) <= CARD_W, "没有文字溢出卡片");
});

test("文件名只有日期：vibepaws-week-YYYY-MM-DD.png", () => {
  assert.equal(cardFileName(weekSummary({ segments: [] }, { now: NOW })), "vibepaws-week-2026-09-29.png");
  assert.equal(cardFileName({ to: "../../etc" }), "vibepaws-week-week.png");
});
