/**
 * 模拟器习惯场景端到端验证（docs/handoff-habit-layer.md §9 DoD）：
 * 喂入 night_owl_burst 场景后，habit_profile 应非平凡且符合预期（burst + shipper + ready）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema.ts";
import { seedPetTypes } from "../db/seed.ts";
import { VibepawsServer } from "../core/server.ts";
import { generateScenario } from "./scenarios.ts";

test("night_owl_burst 场景驱动出非平凡的 habit 画像", () => {
  const db = new Database(":memory:");
  applySchema(db);
  seedPetTypes(db);
  const server = new VibepawsServer({ db });

  for (const e of generateScenario("night_owl_burst")) {
    const r = server.handleEvent(e);
    assert.equal(r.ok, true, `event ${e.event_id} 应被接受`);
  }

  const habit = server.stateSnapshot().habit!;
  assert.equal(habit.ready, true, "8 个 session / 2 个活跃日应越过冷启动门槛");
  assert.equal(habit.cadence, "burst");
  assert.equal(habit.outcome_bias, "shipper");
  assert.ok(Array.isArray(habit.tool_affinity) && habit.tool_affinity.length > 0, "工具亲和度非空");
});
