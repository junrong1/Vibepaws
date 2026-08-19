/**
 * 文案目录单测（issue #3 多语言 / #6 语言一致性）。
 * 重点不是「翻得好不好」，而是三条会直接漏到界面上的机器可查约束：
 *   1. 两种语言的 key 完全一致 —— 少一条就会在界面上混出另一种语言；
 *   2. 通知引擎发出的每个 key 都在目录里 —— 否则气泡会显示 "notif.xxx.title" 这种原始 key；
 *   3. 渲染后不残留 {placeholder} —— 参数名写错时立刻失败。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema.ts";
import { NotificationEngine } from "../core/notifications.ts";
import type { CoreEvent } from "../core/events.ts";
import { MESSAGES, SUPPORTED_LOCALES, DEFAULT_LOCALE, normalizeLocale, detectNodeLocale, t } from "./messages.js";

test("normalizeLocale：中文一律简体，其余一律英文", () => {
  for (const zh of ["zh", "zh-CN", "zh_CN.UTF-8", "zh-Hans-CN", "zh-TW", "ZH-hk"]) {
    assert.equal(normalizeLocale(zh), "zh-CN", `${zh} 应归一化为 zh-CN`);
  }
  for (const other of ["en", "en-US", "ja-JP", "de", "", null, undefined]) {
    assert.equal(normalizeLocale(other), "en", `${other} 应回落英文`);
  }
});

test("detectNodeLocale：显式覆盖 > POSIX 环境变量，C/POSIX 不当作语言信号", () => {
  assert.equal(detectNodeLocale({ VIBEPAWS_LOCALE: "zh", LANG: "en_US.UTF-8" }), "zh-CN");
  assert.equal(detectNodeLocale({ VIBEPAWS_LOCALE: "en", LANG: "zh_CN.UTF-8" }), "en");
  assert.equal(detectNodeLocale({ LANG: "zh_CN.UTF-8" }), "zh-CN");
  assert.equal(detectNodeLocale({ LC_ALL: "zh_CN.UTF-8", LANG: "en_US.UTF-8" }), "zh-CN");
  // LANG=C 无区域信息 → 走 ICU 兜底，只要求落在支持集合内
  assert.ok(SUPPORTED_LOCALES.includes(detectNodeLocale({ LANG: "C" })));
});

test("两种语言的 key 完全一致（缺一条就会在界面上混语言）", () => {
  const keys = Object.fromEntries(SUPPORTED_LOCALES.map((l) => [l, Object.keys(MESSAGES[l]).sort()]));
  for (const locale of SUPPORTED_LOCALES) {
    if (locale === DEFAULT_LOCALE) continue;
    const missing = keys[DEFAULT_LOCALE]!.filter((k) => !keys[locale]!.includes(k));
    const extra = keys[locale]!.filter((k) => !keys[DEFAULT_LOCALE]!.includes(k));
    assert.deepEqual(missing, [], `${locale} 缺少文案: ${missing.join(", ")}`);
    assert.deepEqual(extra, [], `${locale} 多出文案（英文缺失）: ${extra.join(", ")}`);
  }
});

test("t()：插值、缺 key 回落英文、彻底缺失时原样返回 key", () => {
  assert.equal(t("en", "notif.decision.title", { agent: "Claude" }), "Claude needs you");
  assert.equal(t("zh-CN", "notif.decision.title", { agent: "Claude" }), "Claude 需要你");
  assert.equal(t("ja-JP", "notif.drift.title"), MESSAGES.en["notif.drift.title"], "不支持的 locale 回落英文");
  assert.equal(t("en", "no.such.key"), "no.such.key");
});

test("没有文案残留未替换的 {placeholder}（参数名写错会在这里失败）", () => {
  for (const locale of SUPPORTED_LOCALES) {
    for (const [key, value] of Object.entries(MESSAGES[locale])) {
      const enPlaceholders = [...(MESSAGES[DEFAULT_LOCALE][key] ?? "").matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      const localePlaceholders = [...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      assert.deepEqual(localePlaceholders, enPlaceholders, `${locale} / ${key} 的参数与英文不一致`);
    }
  }
});

/* ---------------- 通知引擎 → 文案目录的连通性 ---------------- */

function ev(partial: Partial<CoreEvent>): CoreEvent {
  return {
    event_id: `e-${Math.random().toString(36).slice(2)}`,
    seq: 0,
    agent: "claude_code",
    session_id: `s-${Math.random().toString(36).slice(2)}`,
    project_id: "/Users/x/my-app",
    event_type: "decision_required",
    severity: "high",
    safe_summary: "Needs decision (Stop)",
    timestamp: new Date().toISOString(),
    payload: {},
    ...partial,
  };
}

test("每种通知的 key 都在目录里，且两种语言都渲染得出完整句子", () => {
  const db = new Database(":memory:");
  applySchema(db);
  db.prepare(
    "INSERT INTO sessions(agent, agent_session_id, project_id, budget_tokens) VALUES('claude_code','s-budget','/Users/x/my-app', 100000)",
  ).run();
  const engine = new NotificationEngine(db);

  const cases: CoreEvent[] = [
    ev({ event_type: "decision_required", payload: { kind: "agent_needs_input" } }),
    ev({ event_type: "decision_required", payload: {} }), // 无 kind 分支
    ev({ event_type: "permission_required", payload: { tool_name: "Bash" } }),
    ev({ event_type: "permission_required", payload: {} }), // 无 tool 分支
    ev({ event_type: "context_update", payload: { context_pct: 72 } }),
    ev({ event_type: "context_update", payload: { context_pct: 88 } }),
    ev({ event_type: "context_update", payload: { context_pct: 97 } }),
    ev({ event_type: "session_error", payload: { error_kind: "tool_failed" } }),
    ev({ event_type: "session_error", payload: {} }),
    ev({ event_type: "topic_drift_warning", payload: {} }),
    ev({ event_type: "token_update", session_id: "s-budget", payload: { tokens: 26000 } }),
  ];

  for (const e of cases) {
    const n = engine.getForEvent(e);
    assert.ok(n, `${e.event_type} 应产出通知`);
    assert.ok(n.i18n, `${e.event_type} 的通知必须带 i18n（渲染层靠它出字）`);
    for (const slot of ["title", "body"] as const) {
      const spec = n.i18n[slot];
      assert.ok(MESSAGES[DEFAULT_LOCALE][spec.key], `${e.event_type}.${slot} 的 key 不在目录里: ${spec.key}`);
      for (const locale of SUPPORTED_LOCALES) {
        const rendered = t(locale, spec.key, spec.params);
        assert.ok(rendered.length > 0, `${locale} / ${spec.key} 渲染为空`);
        assert.ok(!/\{\w+\}/.test(rendered), `${locale} / ${spec.key} 有未替换的占位符: ${rendered}`);
      }
    }
  }
});

test("落库的 title/body 固定英文（DB 内容与界面语言解耦）", () => {
  const db = new Database(":memory:");
  applySchema(db);
  const engine = new NotificationEngine(db);
  engine.getForEvent(ev({ event_type: "topic_drift_warning", payload: {} }));
  const row = db.prepare("SELECT title, body FROM notifications ORDER BY id DESC LIMIT 1").get() as {
    title: string;
    body: string;
  };
  assert.equal(row.title, MESSAGES.en["notif.drift.title"]);
  assert.equal(row.body, MESSAGES.en["notif.drift.body"]);
});

test("safe_summary 不再进入气泡文案（它是英文固定措辞，会造成中英混排）", () => {
  const db = new Database(":memory:");
  applySchema(db);
  const engine = new NotificationEngine(db);
  const n = engine.getForEvent(
    ev({ event_type: "decision_required", safe_summary: "Needs decision (Stop)", payload: { kind: "Stop" } }),
  );
  const zhBody = t("zh-CN", n!.i18n!.body.key, n!.i18n!.body.params);
  assert.ok(!zhBody.includes("Needs decision"), "中文气泡不应带上英文 safe_summary");
});
