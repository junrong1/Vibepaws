/**
 * 隐私双闸验收（AC7）：敏感字段（tool_input/prompt/secret/transcript_path）不落库。
 * 第一道闸：adapter 白名单提取（hook_agent.ts）；第二道闸：ingress sanitizePayload。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema.ts";
import { seedPetTypes } from "../db/seed.ts";
import { ingestEvent } from "./ingress.ts";
import { normalizeHook } from "../adapters/hook_agent.ts";

const SENSITIVE_MARKERS = ["TOP_SECRET", "password=sup3r", "hidden prompt", "BEGIN PRIVATE KEY"];

test("第二道闸：ingress 丢弃未知/敏感字段，payload 仅白名单", () => {
  const db = new Database(":memory:");
  applySchema(db);
  seedPetTypes(db);
  const raw = {
    event_id: "p-1",
    seq: 1,
    agent: "claude_code",
    session_id: "s1",
    project_id: "/p",
    event_type: "agent_working",
    severity: "low",
    safe_summary: "Working",
    timestamp: new Date().toISOString(),
    payload: {
      tool_name: "Edit",
      tool_input: { file_path: "/etc/passwd", content: "TOP_SECRET", password: "sup3r" },
      prompt: "hidden prompt",
      api_key: "BEGIN PRIVATE KEY",
      tokens: 100, // 白名单字段保留
    },
  };
  const r = ingestEvent(raw, { db, onEvent: () => {} });
  assert.equal(r.ok, true);
  const row = db.prepare("SELECT payload_json, safe_summary FROM events WHERE event_id='p-1'").get() as {
    payload_json: string;
    safe_summary: string;
  };
  const stored = JSON.stringify(row);
  for (const m of SENSITIVE_MARKERS) {
    assert.ok(!stored.includes(m), `敏感内容不应落库: ${m}`);
  }
  assert.ok(stored.includes("tool_name"));
  assert.ok(stored.includes("tokens"));
  assert.equal(row.safe_summary, "Working"); // safe_summary 是固定措辞
});

test("第一道闸：hook_agent 白名单提取（tool_input/prompt/transcript_path 不进事件）", () => {
  const ev = normalizeHook(
    {
      hook_event_name: "PreToolUse",
      matcher: "Bash",
      session_id: "s-2",
      cwd: "/p",
      tool_name: "Bash",
      tool_input: { command: "rm -rf / && echo TOP_SECRET" },
      prompt: "do something hidden",
      transcript_path: "/Users/x/.claude/projects/p/s-2.jsonl",
      api_key: "BEGIN PRIVATE KEY",
    },
    "claude_code",
  )!;
  const blob = JSON.stringify(ev);
  for (const m of SENSITIVE_MARKERS) {
    assert.ok(!blob.includes(m), `adapter 事件不应含敏感内容: ${m}`);
  }
  assert.ok(!JSON.stringify(ev).includes("transcript_path"));
  assert.ok(!JSON.stringify(ev).includes("tool_input"));
  assert.equal(ev.payload.tool_name, "Bash");
});

test("safe_summary 永远是固定措辞，不含事件动态内容", () => {
  const ev = normalizeHook(
    {
      hook_event_name: "PermissionRequest",
      session_id: "s-3",
      cwd: "/p",
      tool_name: "Bash",
      tool_input: { command: "TOP_SECRET_COMMAND" },
    },
    "claude_code",
  )!;
  assert.ok(!ev.safe_summary.includes("TOP_SECRET"));
  assert.equal(ev.safe_summary, "Tool permission needed: Bash");
});

test("pid 是白名单里刻意加宽的一项：进得去，但只能是数字（G10）", () => {
  const db = new Database(":memory:");
  applySchema(db);
  seedPetTypes(db);
  ingestEvent(
    {
      event_id: "p-pid",
      seq: 1,
      agent: "claude_code",
      session_id: "s1",
      project_id: "/p",
      event_type: "agent_working",
      severity: "low",
      safe_summary: "Working",
      timestamp: new Date().toISOString(),
      // 探活只需要一个整数。任何试图借这个字段捎带内容的东西都过不去 ——
      // sanitizePayload 只放行 string/number/boolean，且键必须在白名单里。
      payload: { pid: 4242, pid_cmdline: "node /Users/x/secret-project/TOP_SECRET.ts" },
    },
    { db, onEvent: () => {} },
  );
  const row = db.prepare("SELECT payload_json FROM events WHERE event_id='p-pid'").get() as {
    payload_json: string;
  };
  assert.deepEqual(JSON.parse(row.payload_json), { pid: 4242 });
  assert.ok(!row.payload_json.includes("TOP_SECRET"));
});

test("adapter 只在真的跑在 agent 子进程里时才报 pid（bridge 补发不许自作主张）", () => {
  const hook = {
    hook_event_name: "PreToolUse" as const,
    matcher: "Bash",
    session_id: "s-pid",
    cwd: "/p",
    tool_name: "Bash",
  };
  // bridge 走的是这条路：它的 ppid 与该 session 的 agent 毫无关系
  assert.equal(normalizeHook(hook, "claude_code")!.payload.pid, undefined);
  assert.equal(normalizeHook(hook, "claude_code", { pid: 4242 })!.payload.pid, 4242);
});
