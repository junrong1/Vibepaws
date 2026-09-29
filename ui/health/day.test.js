/**
 * 本地日键的单测：Den、周卡与 Core 必须对「这一段属于哪一天」给出同一个回答。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { localDayKey } from "./day.js";
import { localDayKey as coreLocalDayKey } from "../../src/core/health_query.ts";

test("本地日键：按本地年月日取，23:50 收工落在当天；ISO 字符串与 Date 同一个回答", () => {
  const late = new Date(2026, 8, 28, 23, 50);
  assert.equal(localDayKey(late), "2026-09-28");
  assert.equal(localDayKey(late.toISOString()), "2026-09-28");
  assert.equal(localDayKey(late.getTime()), "2026-09-28");
  assert.equal(localDayKey(new Date(2026, 0, 5, 0, 0)), "2026-01-05", "月、日补零");
});

test("与 core/health_query.ts 的 localDayKey 逐点一致", () => {
  for (const d of [
    new Date(2026, 8, 28, 23, 59, 59),
    new Date(2026, 8, 29, 0, 0, 0),
    new Date(2026, 2, 8, 2, 30), // 夏令时切换附近
    new Date(2026, 10, 1, 1, 30),
    new Date(2026, 11, 31, 23, 30),
  ]) {
    assert.equal(localDayKey(d), coreLocalDayKey(d), d.toISOString());
  }
});
