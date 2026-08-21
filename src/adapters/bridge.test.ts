/**
 * generic bridge 归一化单测：任意 JSONL 行 → 标准事件。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeLine } from "./bridge.ts";

test("标准事件直通", () => {
  const ev = {
    event_id: "b1", seq: 1, agent: "generic", session_id: "s1",
    project_id: "/p", event_type: "session_started", severity: "low",
    safe_summary: "x", timestamp: "2026-08-19T00:00:00Z", payload: {},
  };
  const out = normalizeLine(ev);
  assert.equal(out?.event_type, "session_started");
  assert.equal(out?.agent, "generic");
});

test("pi 发射器标准事件直通（agent=pi，不经 hook 归一化）", () => {
  const ev = {
    event_id: "pi-e1", seq: 1, agent: "pi", session_id: "pi-live-1",
    project_id: "/p", event_type: "session_finished", severity: "low",
    safe_summary: "Session finished", timestamp: "2026-08-19T00:00:00Z",
    payload: { reason: "completion", outcome: "success" },
  };
  const out = normalizeLine(ev);
  assert.equal(out?.agent, "pi");
  assert.equal(out?.event_type, "session_finished");
  assert.deepEqual(out?.payload, { reason: "completion", outcome: "success" });
});

test("raw hook 输入归一化：PermissionRequest → permission_required", () => {
  const out = normalizeLine({
    hook_event_name: "PermissionRequest",
    session_id: "raw-1",
    cwd: "/p/proj",
    tool_name: "Bash",
    tool_input: { secret: "TOP" }, // 应被丢弃
  });
  assert.equal(out?.event_type, "permission_required");
  assert.equal(out?.project_id, "/p/proj");
  assert.equal(out?.safe_summary, "Tool permission needed: Bash");
  assert.equal((out?.payload as Record<string, unknown>).tool_input, undefined);
});

test("raw hook 归一化：Stop → decision_required（带 turn_id）", () => {
  const out = normalizeLine({
    hook_event_name: "Stop",
    session_id: "raw-2",
    cwd: "/p",
    turn_id: "t-1",
  });
  assert.equal(out?.event_type, "decision_required");
  assert.equal(out?.payload.turn_id, "t-1");
});

test("垃圾行 → null", () => {
  assert.equal(normalizeLine(null), null);
  assert.equal(normalizeLine("not json"), null);
  assert.equal(normalizeLine({ foo: 1 }), null);
});
