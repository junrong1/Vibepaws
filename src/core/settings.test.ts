/**
 * 设置窗口的后端单测（landscape 表格第 13 项）。
 *
 * 这组测试的重点不是「能不能存」，而是三件在没有设置界面时不可能被覆盖的事：
 *   1. 归一化：手滑输入的 1e12 / 负数 / 乱序阈值不能变成永久生效的库内容；
 *   2. 原子性：一份 patch 里有个读不成的值时，不许有一半设置已经落库；
 *   3. 连通性：在设置里填的预算/阈值/目标，**真的**改变了通知与 EXP 的行为 ——
 *      在这之前这两条通路只能靠手改 SQLite 才能验证，于是从没被验证过。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema.ts";
import { seedPetTypes } from "../db/seed.ts";
import { VibepawsServer } from "./server.ts";
import {
  normalizeBudgetTokens,
  normalizeDailyExpCap,
  normalizeContextWarnPcts,
  normalizeSessionBudget,
  normalizeText,
  parseSettingsPatch,
  readSettings,
  getContextWarnPcts,
  SETTINGS_LIMITS,
  DEFAULT_CONTEXT_WARN_PCTS,
} from "./settings.ts";
import type { CoreEvent } from "./events.ts";

/* ---------------- 归一化 ---------------- */

test("预算：负数收到 0，超上限收到上限，都要报 clamped", () => {
  assert.deepEqual(normalizeBudgetTokens(200_000), { ok: true, value: 200_000, clamped: false });
  assert.deepEqual(normalizeBudgetTokens(-5), { ok: true, value: 0, clamped: true });
  const huge = normalizeBudgetTokens(1e12);
  assert.deepEqual(huge, { ok: true, value: SETTINGS_LIMITS.budget_tokens_max, clamped: true });
  // 表单送来的永远是字符串
  assert.deepEqual(normalizeBudgetTokens("150000"), { ok: true, value: 150_000, clamped: false });
  // 读不成数字 = 整份 patch 拒掉，而不是悄悄当 0（那会把里程碑关掉且没人知道）
  assert.deepEqual(normalizeBudgetTokens("abc"), { ok: false });
  assert.deepEqual(normalizeBudgetTokens({}), { ok: false });
});

test("每日 EXP 上限下限是 1：0 不是「无上限」而是「token EXP 全没了」", () => {
  assert.deepEqual(normalizeDailyExpCap(0), { ok: true, value: 1, clamped: true });
  assert.deepEqual(normalizeDailyExpCap(500), { ok: true, value: 500, clamped: false });
});

test("session 预算：空 / 0 都是「跟随全局默认」（列写 NULL）", () => {
  assert.deepEqual(normalizeSessionBudget(""), { ok: true, value: null, clamped: false });
  assert.deepEqual(normalizeSessionBudget(0), { ok: true, value: null, clamped: false });
  assert.deepEqual(normalizeSessionBudget(null), { ok: true, value: null, clamped: false });
  assert.deepEqual(normalizeSessionBudget(80_000), { ok: true, value: 80_000, clamped: false });
});

test("context 阈值：升序去重、收进 1..99、最多 3 档；空数组 = 关闭", () => {
  assert.deepEqual(normalizeContextWarnPcts([95, 70, 85]), { ok: true, value: [70, 85, 95], clamped: false });
  assert.deepEqual(normalizeContextWarnPcts([]), { ok: true, value: [], clamped: false }, "空数组是合法的「关闭」");
  const dirty = normalizeContextWarnPcts([70, 70, 300, 60, 80]);
  assert.equal(dirty.ok, true);
  if (dirty.ok) {
    assert.deepEqual(dirty.value, [60, 70, 80], "去重 + 排序 + 只留最低三档");
    assert.equal(dirty.clamped, true, "被动过手就必须说出来");
  }
  assert.deepEqual(normalizeContextWarnPcts("not-a-list-or-number"), { ok: false });
});

test("文本：控制字符清掉、按码点裁剪（emoji 名字不能被劈成半个代理对）", () => {
  const pasted = normalizeText("  fix\r\n the parser  ", 200);
  assert.deepEqual(pasted, { ok: true, value: "fix the parser", clamped: false });
  assert.deepEqual(normalizeText("   ", 24), { ok: true, value: null, clamped: false }, "空白 = 清空");
  const emoji = normalizeText("🐾🐾🐾", 2);
  assert.equal(emoji.ok, true);
  if (emoji.ok) {
    assert.equal(emoji.value, "🐾🐾");
    assert.equal([...(emoji.value ?? "")].length, 2, "不能出现半个字符");
  }
});

test("patch 校验是先做完再落库：一个非法字段会拒掉整份", () => {
  const parsed = parseSettingsPatch({ budget_tokens: 100_000, daily_exp_cap: "nope" });
  assert.deepEqual(parsed.invalid, ["daily_exp_cap"]);
  const db = new Database(":memory:");
  applySchema(db);
  assert.equal(readSettings(db).budget_tokens, 0, "被拒的 patch 里那个合法字段也不该生效");
});

/* ---------------- HTTP ---------------- */

async function withServer(fn: (ctx: { server: VibepawsServer; base: string }) => Promise<void>): Promise<void> {
  const db = new Database(":memory:");
  applySchema(db);
  seedPetTypes(db);
  // persistToken 默认关闭（注入 db）：绝不能覆盖用户真实的 ~/.vibepaws/api_token
  const server = new VibepawsServer({ db, port: 0 });
  await server.start();
  try {
    await fn({ server, base: `http://127.0.0.1:${server.port}` });
  } finally {
    await server.close();
  }
}

function authed(server: VibepawsServer, body?: unknown): RequestInit {
  return {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", "x-vibepaws-token": server.token },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
}

let seq = 0;
function ev(partial: Partial<CoreEvent>): CoreEvent {
  seq += 1;
  return {
    event_id: `set-${seq}`,
    seq,
    agent: "claude_code",
    session_id: "s1",
    project_id: "/Users/x/my-app",
    event_type: "session_started",
    severity: "low",
    safe_summary: "x",
    timestamp: new Date().toISOString(),
    payload: {},
    ...partial,
  };
}

test("GET /api/settings 带上取值范围与默认值（界面不必再抄一份常量）", async () => {
  await withServer(async ({ server, base }) => {
    const r = await fetch(`${base}/api/settings`, authed(server));
    assert.equal(r.status, 200);
    const view = (await r.json()) as Record<string, any>;
    assert.deepEqual(view.settings.context_warn_pcts, [...DEFAULT_CONTEXT_WARN_PCTS]);
    assert.equal(view.settings.budget_tokens, 0, "默认没有预算 —— 里程碑默认是关的");
    assert.equal(view.limits.budget_tokens_max, SETTINGS_LIMITS.budget_tokens_max);
    assert.equal(view.defaults.daily_exp_cap, 200);
    assert.ok(view.pet.species, "改名框要用物种名当占位符");
    assert.equal(view.pet.custom_name, null, "还没起过名字");
  });
});

test("设置端点没 token 一律 401（本机任何网页都不该能改预算或改名）", async () => {
  await withServer(async ({ server, base }) => {
    assert.equal((await fetch(`${base}/api/settings`)).status, 401);
    const forged = await fetch(`${base}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ budget_tokens: 1 }),
    });
    assert.equal(forged.status, 401);
    assert.equal(readSettings(server.db).budget_tokens, 0, "未授权的写入不该生效");
  });
});

test("改名走通了 pets.name：这一列在有设置窗口之前从来没有写入方", async () => {
  await withServer(async ({ server, base }) => {
    const r = await fetch(`${base}/api/settings`, authed(server, { pet_name: "  Mochi  " }));
    assert.equal(r.status, 200);
    const view = (await r.json()) as Record<string, any>;
    assert.equal(view.pet.custom_name, "Mochi", "首尾空格要去掉");
    assert.equal(server.stateSnapshot().pet.name, "Mochi", "名牌立刻跟着变");
    // 清空 → 回落物种名
    const cleared = (await (await fetch(`${base}/api/settings`, authed(server, { pet_name: "" }))).json()) as Record<
      string,
      any
    >;
    assert.equal(cleared.pet.custom_name, null);
    assert.equal(server.stateSnapshot().pet.name, cleared.pet.species);
  });
});

test("非法值 → 400，而且一个字段都没写进去（不留半套生效）", async () => {
  await withServer(async ({ server, base }) => {
    const r = await fetch(`${base}/api/settings`, authed(server, { budget_tokens: 250_000, daily_exp_cap: "abc" }));
    assert.equal(r.status, 400);
    assert.deepEqual(((await r.json()) as { fields: string[] }).fields, ["daily_exp_cap"]);
    assert.equal(readSettings(server.db).budget_tokens, 0);
  });
});

test("超范围的值被收敛，并在响应里显式报 clamped（界面据此回填真实值）", async () => {
  await withServer(async ({ server, base }) => {
    const r = await fetch(`${base}/api/settings`, authed(server, { budget_tokens: 1e12 }));
    const body = (await r.json()) as { clamped: string[]; settings: { budget_tokens: number } };
    assert.deepEqual(body.clamped, ["budget_tokens"]);
    assert.equal(body.settings.budget_tokens, SETTINGS_LIMITS.budget_tokens_max);
  });
});

test("在设置里填预算 → 里程碑气泡真的会来（这条通路以前只能手改 SQLite 验证）", async () => {
  await withServer(async ({ server, base }) => {
    server.handleEvent(ev({ payload: { source: "startup" } }));
    // 没有预算时 26k tokens 不该有任何里程碑（没有分母）
    server.handleEvent(ev({ event_type: "token_update", payload: { tokens: 26_000 } }));
    assert.equal(countNotifications(server, "milestone"), 0);

    await fetch(`${base}/api/settings`, authed(server, { budget_tokens: 100_000 }));
    server.handleEvent(ev({ event_type: "token_update", payload: { tokens: 30_000 } }));
    assert.equal(countNotifications(server, "milestone"), 1, "25% 那一档该出声了");
  });
});

test("context 警告可以关掉：阈值设成空数组后 99% 也不再出声", async () => {
  await withServer(async ({ server, base }) => {
    server.handleEvent(ev({ payload: { source: "startup" } }));
    await fetch(`${base}/api/settings`, authed(server, { context_warn_pcts: [] }));
    assert.deepEqual(getContextWarnPcts(server.db), [], "「关闭」不能被下一次读取还原成默认三档");
    server.handleEvent(ev({ event_type: "context_update", payload: { context_pct: 99 } }));
    assert.equal(countNotifications(server, "context"), 0);
  });
});

test("自定义阈值立刻生效：改完不必等下一个 session（闩锁被重新武装）", async () => {
  await withServer(async ({ server, base }) => {
    server.handleEvent(ev({ payload: { source: "startup" } }));
    // 默认三档下 65% 不该出声
    server.handleEvent(ev({ event_type: "context_update", payload: { context_pct: 65 } }));
    assert.equal(countNotifications(server, "context"), 0);

    await fetch(`${base}/api/settings`, authed(server, { context_warn_pcts: [60, 75, 90] }));
    server.handleEvent(ev({ event_type: "context_update", payload: { context_pct: 66 } }));
    assert.equal(countNotifications(server, "context"), 1, "新阈值该在同一个 session 里就生效");
  });
});

test("POST /api/session 写 goal → EXP 真的按 1.1× 算（G17 的录入口）", async () => {
  await withServer(async ({ server, base }) => {
    server.handleEvent(ev({ payload: { source: "startup" } }));
    const r = await fetch(
      `${base}/api/session`,
      authed(server, { agent: "claude_code", session_id: "s1", goal: "  ship the settings window\n" }),
    );
    assert.equal(r.status, 200);
    const { session } = (await r.json()) as { session: { goal: string } };
    assert.equal(session.goal, "ship the settings window", "换行/空格要清掉");

    server.handleEvent(ev({ event_type: "token_update", payload: { tokens: 10_000 } }));
    const note = (
      server.db.prepare("SELECT note FROM exp_logs WHERE category='token' ORDER BY id DESC LIMIT 1").get() as
        | { note: string }
        | undefined
    )?.note;
    assert.match(note ?? "", /topic=1\.1/, "有 goal 才有 1.1× —— 没有录入口时这条规则永远空转");
  });
});

test("session 级预算覆盖全局默认；清空则回到跟随默认", async () => {
  await withServer(async ({ server, base }) => {
    server.handleEvent(ev({ payload: { source: "startup" } }));
    await fetch(`${base}/api/settings`, authed(server, { budget_tokens: 1_000_000 }));
    const set = await fetch(
      `${base}/api/session`,
      authed(server, { agent: "claude_code", session_id: "s1", budget_tokens: 40_000 }),
    );
    assert.equal(((await set.json()) as { session: { budget_tokens: number } }).session.budget_tokens, 40_000);
    // 全局 1M 下 12k 什么都不是；按 session 的 40k 算已经过了 25%
    server.handleEvent(ev({ event_type: "token_update", payload: { tokens: 12_000 } }));
    assert.equal(countNotifications(server, "milestone"), 1);

    const cleared = await fetch(
      `${base}/api/session`,
      authed(server, { agent: "claude_code", session_id: "s1", budget_tokens: null }),
    );
    assert.equal(((await cleared.json()) as { session: { budget_tokens: number | null } }).session.budget_tokens, null);
  });
});

test("过长的 goal 被裁到上限并报 clamped", async () => {
  await withServer(async ({ server, base }) => {
    server.handleEvent(ev({ payload: { source: "startup" } }));
    const r = await fetch(
      `${base}/api/session`,
      authed(server, { agent: "claude_code", session_id: "s1", goal: "x".repeat(500) }),
    );
    const body = (await r.json()) as { clamped: string[]; session: { goal: string } };
    assert.deepEqual(body.clamped, ["goal"]);
    assert.equal(body.session.goal.length, SETTINGS_LIMITS.goal_max);
  });
});

test("不存在的 session → 404（界面据此说「它已经不在跑了」，而不是假装保存成功）", async () => {
  await withServer(async ({ server, base }) => {
    const r = await fetch(`${base}/api/session`, authed(server, { agent: "claude_code", session_id: "ghost", goal: "x" }));
    assert.equal(r.status, 404);
    const missing = await fetch(`${base}/api/session`, authed(server, { goal: "x" }));
    assert.equal(missing.status, 400, "缺 agent/session_id 是请求错误，不是 404");
  });
});

test("处理器抛异常时回 500 且 Core 还活着（这个回调跑在 req 的 end 事件里，漏出去就是进程崩）", async () => {
  await withServer(async ({ server, base }) => {
    const boom = new Error("boom");
    const original = server.exp.renamePet.bind(server.exp);
    server.exp.renamePet = () => {
      throw boom;
    };
    try {
      const r = await fetch(`${base}/api/settings`, authed(server, { pet_name: "Mochi" }));
      assert.equal(r.status, 500);
    } finally {
      server.exp.renamePet = original;
    }
    // 进程还在、端点还能用
    assert.equal((await fetch(`${base}/api/settings`, authed(server))).status, 200);
  });
});

test("请求体有上限：谁都不该让 Core 为一个本地页面缓冲兆级数据", async () => {
  await withServer(async ({ server, base }) => {
    const r = await fetch(`${base}/api/settings`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-vibepaws-token": server.token },
      body: JSON.stringify({ pet_name: "a".repeat(200_000) }),
    });
    assert.equal(r.status, 413);
  });
});

function countNotifications(server: VibepawsServer, type: string): number {
  const row = server.db
    .prepare("SELECT COUNT(*) as c FROM notifications WHERE type=? AND status='shown'")
    .get(type) as { c: number };
  return row.c ?? 0;
}
