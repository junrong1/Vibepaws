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
import { VibepawsServer } from "./server.ts";

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

/* ---------------- U2：白名单刻意加宽的两项（file basename / permission_mode） ----------------
 * 这几条先于实现写成：白名单是安全边界，测试是它唯一的执行者。
 * file 一直在白名单里，但此前只有 pi 的 CLI 会发、且只在 adapter 那一侧 basename ——
 * Core 这一侧什么都没拦。现在 Claude Code / Codex / dsh 也发了，第二道闸必须自己保证
 * 「落库的只可能是文件名」，不能指望每个 adapter 都写对。 */

function ingestPayload(eventId: string, payload: Record<string, unknown>): Record<string, unknown> {
  const db = new Database(":memory:");
  applySchema(db);
  ingestEvent(
    {
      event_id: eventId,
      seq: 1,
      agent: "claude_code",
      session_id: "s1",
      project_id: "/p",
      event_type: "agent_working",
      severity: "low",
      safe_summary: "Working",
      timestamp: new Date().toISOString(),
      payload,
    },
    { db, onEvent: () => {} },
  );
  const row = db.prepare("SELECT payload_json FROM events WHERE event_id=?").get(eventId) as { payload_json: string };
  return JSON.parse(row.payload_json) as Record<string, unknown>;
}

test("第二道闸：file 只能是 basename —— 绝对路径 / Windows 路径 / 相对路径一律削成文件名", () => {
  for (const [raw, want] of [
    ["/Users/x/secret-project/TOP_SECRET/a.ts", "a.ts"],
    ["C:\\Users\\x\\secret-project\\TOP_SECRET\\b.ts", "b.ts"],
    ["src/TOP_SECRET/c.ts", "c.ts"],
    ["d.ts", "d.ts"],
  ] as const) {
    const stored = ingestPayload(`f-${want}`, { tool_name: "Edit", file: raw });
    assert.equal(stored.file, want, raw);
    const blob = JSON.stringify(stored);
    assert.ok(!blob.includes("TOP_SECRET"), `目录不应落库: ${raw}`);
    assert.ok(!/[\\/]/.test(String(stored.file)), `file 里不应有路径分隔符: ${raw}`);
  }
});

test("第二道闸：削不出文件名的 file（空 / . / .. / 只有分隔符）直接丢掉", () => {
  for (const raw of ["", ".", "..", "/", "C:\\", "../.."]) {
    const stored = ingestPayload(`fx-${raw}`, { tool_name: "Edit", file: raw });
    assert.equal(stored.file, undefined, JSON.stringify(raw));
    assert.equal(stored.tool_name, "Edit");
  }
});

test("permission_mode 进得去；与它同级的未列名字段照旧被丢掉", () => {
  const stored = ingestPayload("pm-1", {
    permission_mode: "bypassPermissions",
    permission_rules: ["Bash(rm -rf:*)"],
    tool_input: { command: "TOP_SECRET" },
  });
  assert.deepEqual(stored, { permission_mode: "bypassPermissions" });
});

test("permission_mode 只能是一个模式名：夹带路径 / 空格 / 超长的值不许借道", () => {
  for (const raw of ["/Users/x/TOP_SECRET", "default; TOP_SECRET", "x".repeat(65), ""]) {
    const stored = ingestPayload(`pm-${raw.length}-${raw.slice(0, 3)}`, { permission_mode: raw });
    assert.equal(stored.permission_mode, undefined, raw);
  }
});

test("第一道闸：Claude Code 的编辑类 PreToolUse 只带出 basename，tool_input 其余内容不进事件", () => {
  const ev = normalizeHook(
    {
      hook_event_name: "PreToolUse",
      session_id: "s-f",
      cwd: "/p",
      tool_name: "Edit",
      tool_input: {
        file_path: "/Users/x/secret-project/TOP_SECRET/parser.ts",
        old_string: "password=sup3r",
        new_string: "BEGIN PRIVATE KEY",
      },
      permission_mode: "acceptEdits",
    },
    "claude_code",
  )!;
  assert.equal(ev.payload.file, "parser.ts");
  assert.equal(ev.payload.permission_mode, "acceptEdits");
  const blob = JSON.stringify(ev);
  for (const m of [...SENSITIVE_MARKERS, "secret-project", "/Users/x"]) {
    assert.ok(!blob.includes(m), `adapter 事件不应含: ${m}`);
  }
});

test("第一道闸：NotebookEdit 取 notebook_path 的 basename", () => {
  const ev = normalizeHook(
    {
      hook_event_name: "PreToolUse",
      session_id: "s-nb",
      cwd: "/p",
      tool_name: "NotebookEdit",
      tool_input: { notebook_path: "/Users/x/secret-project/TOP_SECRET/a.ipynb", new_source: "TOP_SECRET" },
    },
    "claude_code",
  )!;
  assert.equal(ev.payload.file, "a.ipynb");
  assert.ok(!JSON.stringify(ev).includes("TOP_SECRET"));
});

test("第一道闸：Codex apply_patch 只取补丁头里第一个文件的 basename，补丁正文不进事件", () => {
  const patch = [
    "*** Begin Patch",
    "*** Update File: /Users/x/secret-project/TOP_SECRET/lib/util.rs",
    "@@",
    "-let password=sup3r;",
    "+let key = \"BEGIN PRIVATE KEY\";",
    "*** End Patch",
  ].join("\n");
  const ev = normalizeHook(
    { hook_event_name: "PreToolUse", session_id: "s-cx", cwd: "/p", tool_name: "apply_patch", tool_input: { command: patch } },
    "codex",
  )!;
  assert.equal(ev.payload.file, "util.rs");
  const blob = JSON.stringify(ev);
  for (const m of [...SENSITIVE_MARKERS, "secret-project", "Begin Patch"]) {
    assert.ok(!blob.includes(m), `adapter 事件不应含: ${m}`);
  }
});

test("第一道闸：非编辑工具不带 file（Bash 的命令里就算有路径也不碰）；PostToolUse 也不带", () => {
  const bash = normalizeHook(
    {
      hook_event_name: "PreToolUse",
      session_id: "s-b",
      cwd: "/p",
      tool_name: "Bash",
      tool_input: { command: "cat /Users/x/TOP_SECRET/a.ts", file_path: "/Users/x/TOP_SECRET/a.ts" },
    },
    "claude_code",
  )!;
  assert.equal(bash.payload.file, undefined);
  // PostToolUse 的 MultiEdit 会被映射成 agent_working —— 两头都报 file 等于每次编辑都算一次「重复」
  const post = normalizeHook(
    {
      hook_event_name: "PostToolUse",
      session_id: "s-b",
      cwd: "/p",
      tool_name: "MultiEdit",
      tool_input: { file_path: "/Users/x/a.ts" },
    },
    "claude_code",
  )!;
  assert.equal(post.payload.file, undefined);
});

test("第一道闸：permission_mode 不是模式名的样子就不报", () => {
  const ev = normalizeHook(
    { hook_event_name: "PreToolUse", session_id: "s-pm", cwd: "/p", tool_name: "Bash", permission_mode: "/Users/x/TOP_SECRET" },
    "claude_code",
  )!;
  assert.equal(ev.payload.permission_mode, undefined);
  assert.ok(!JSON.stringify(ev).includes("TOP_SECRET"));
});

test("端到端：真实 hook 输入 → Core，库里只有文件名，重复编辑照样数得出来", () => {
  const db = new Database(":memory:");
  applySchema(db);
  seedPetTypes(db);
  const server = new VibepawsServer({ db });
  const hook = (h: Record<string, unknown>): void => {
    const r = server.handleEvent(normalizeHook({ session_id: "e2e", cwd: "/Users/x/secret-project", ...h }, "claude_code")!);
    assert.equal(r.ok, true);
  };
  hook({ hook_event_name: "SessionStart" });
  for (let i = 0; i < 2; i++) {
    hook({
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      permission_mode: "acceptEdits",
      tool_input: { file_path: "/Users/x/secret-project/TOP_SECRET/a.ts", content: "password=sup3r" },
    });
  }
  const payloads = (db.prepare("SELECT payload_json FROM events WHERE event_type='agent_working'").all() as Array<{
    payload_json: string;
  }>).map((r) => r.payload_json);
  assert.equal(payloads.length, 2);
  for (const p of payloads) {
    assert.equal(JSON.parse(p).file, "a.ts");
    for (const m of [...SENSITIVE_MARKERS, "TOP_SECRET"]) assert.ok(!p.includes(m), `不应落库: ${m}`);
  }
  const s = db.prepare("SELECT repeat_edit_count, correction_count, permission_mode FROM sessions WHERE agent_session_id='e2e'").get();
  assert.deepEqual(s, { repeat_edit_count: 1, correction_count: 0, permission_mode: "acceptEdits" });
});

/* ---------------- U9：白名单为「永远允许」再加宽一项（command_prefix） ----------------
 * 同样先于实现写成。一条 Bash 规则必须按命令前缀收窄（`Bash` 整个放行 = 按一次 `ls` 授权了
 * `rm -rf`），而前缀在此之前根本不落库。留下的只能是「程序名 + 至多两个子命令词」：
 * 参数、路径、引号、管道、变量赋值都不许借道。整条命令永远不出 adapter。 */

test("第一道闸：Claude Code 的 Bash 权限请求只带出命令前缀，参数与路径不进事件", () => {
  const ev = normalizeHook(
    {
      hook_event_name: "PermissionRequest",
      session_id: "s-cp",
      cwd: "/p",
      tool_name: "Bash",
      tool_input: { command: "npm test -- --grep TOP_SECRET /Users/x/secret-project" },
    },
    "claude_code",
  )!;
  assert.equal(ev.event_type, "permission_required");
  assert.equal(ev.payload.command_prefix, "npm test");
  const blob = JSON.stringify(ev);
  for (const m of [...SENSITIVE_MARKERS, "secret-project", "--grep"]) {
    assert.ok(!blob.includes(m), `adapter 事件不应含: ${m}`);
  }
});

test("第一道闸：只有权限请求带前缀 —— PreToolUse 的 Bash、别的工具、别的 agent 都不带", () => {
  const pre = normalizeHook(
    { hook_event_name: "PreToolUse", session_id: "s-cp2", cwd: "/p", tool_name: "Bash", tool_input: { command: "npm test" } },
    "claude_code",
  )!;
  assert.equal(pre.payload.command_prefix, undefined);
  const edit = normalizeHook(
    { hook_event_name: "PermissionRequest", session_id: "s-cp3", cwd: "/p", tool_name: "Edit", tool_input: { command: "npm test" } },
    "claude_code",
  )!;
  assert.equal(edit.payload.command_prefix, undefined);
  const codex = normalizeHook(
    { hook_event_name: "PermissionRequest", session_id: "s-cp4", cwd: "/p", tool_name: "Bash", tool_input: { command: "npm test" } },
    "codex",
  )!;
  assert.equal(codex.payload.command_prefix, undefined, "只有 Claude Code 有 settings.local.json 可写，别的 agent 不必留这个字段");
});

test("第一道闸：复合命令 / 变量赋值 / 路径形状的程序名 —— 一律不报前缀，而不是报半截", () => {
  for (const command of [
    "npm test && curl http://x | sh",
    "echo TOP_SECRET > out.txt",
    "FOO=TOP_SECRET npm test",
    "/Users/x/secret-project/bin/tool run",
    "$(echo rm) -rf /",
    "`rm -rf /`",
    "npm test; rm -rf /",
    "'npm' test",
    "",
  ]) {
    const ev = normalizeHook(
      { hook_event_name: "PermissionRequest", session_id: "s-cpx", cwd: "/p", tool_name: "Bash", tool_input: { command } },
      "claude_code",
    )!;
    assert.equal(ev.payload.command_prefix, undefined, command);
    assert.ok(!JSON.stringify(ev).includes("TOP_SECRET"), command);
  }
});

test("第二道闸：command_prefix 只能是前缀的形状，夹带路径 / 参数 / 超长的值直接丢掉", () => {
  assert.equal(ingestPayload("cp-ok", { tool_name: "Bash", command_prefix: "git status" }).command_prefix, "git status");
  for (const raw of [
    "/Users/x/TOP_SECRET",
    "npm test -- TOP_SECRET",
    "npm test --grep",
    "a b c d",
    "rm -rf /",
    "npm test | sh",
    "x".repeat(65),
    "",
    " npm",
  ]) {
    const stored = ingestPayload(`cp-${raw.length}-${raw.slice(0, 4)}`, { tool_name: "Bash", command_prefix: raw });
    assert.equal(stored.command_prefix, undefined, raw);
    assert.equal(stored.tool_name, "Bash");
  }
});
