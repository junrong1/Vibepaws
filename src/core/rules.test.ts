/**
 * 「永远允许」单测（U9 / R20）。
 *
 * 一律在临时目录里：规则文件是**别的工具**的配置（Claude Code 的 settings.local.json），
 * 这里任何一个用例写到了仓库自己的 .claude/ 或者用户 home，都是在开发机上真的放行了一个权限。
 * 所以每个用例自己建一个项目目录，project_id 就是它，别的路径一个都不碰。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../db/schema.ts";
import { seedPetTypes } from "../db/seed.ts";
import {
  DESTRUCTIVE_COMMANDS,
  addRuleToFile,
  createGrant,
  deriveGrant,
  destructiveMatch,
  grantFor,
  grantSecretMatches,
  isGranted,
  listRules,
  readRuleFile,
  removeRuleFromFile,
  revokeGrant,
  ruleFilePath,
} from "./rules.ts";
import { NotificationEngine } from "./notifications.ts";

function project(): string {
  const dir = mkdtempSync(join(tmpdir(), "vibepaws-rules-"));
  const p = join(dir, "my-app");
  mkdirSync(p);
  return p;
}

function freshDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  seedPetTypes(db);
  return db;
}

let seq = 0;
/**
 * 造一条还挂着的通知 + 它背后那条事件与 session —— 与 ingress / 通知引擎落库的形状一致：
 * notifications.event_id → events.payload_json（白名单 payload），session 行带 project_id。
 */
function permissionRow(
  db: Database.Database,
  opts: { projectId: string; payload: Record<string, unknown>; agent?: string; type?: string; session?: string },
): number {
  seq += 1;
  const agent = opts.agent ?? "claude_code";
  const session = opts.session ?? `s-${seq}`;
  const eventId = `evt-${seq}`;
  db.prepare(
    "INSERT OR IGNORE INTO sessions(agent, agent_session_id, project_id) VALUES(?, ?, ?)",
  ).run(agent, session, opts.projectId);
  db.prepare(
    `INSERT INTO events(event_id, agent, session_id, event_type, severity, safe_summary, payload_json)
     VALUES(?, ?, ?, 'permission_required', 'high', 'x', ?)`,
  ).run(eventId, agent, session, JSON.stringify(opts.payload));
  const info = db
    .prepare(
      `INSERT INTO notifications(event_id, agent, session_id, type, title, body, status, shown_at)
       VALUES(?, ?, ?, ?, 't', 'b', 'shown', ?)`,
    )
    .run(eventId, agent, session, opts.type ?? "permission", new Date().toISOString());
  return Number(info.lastInsertRowid);
}

function fileJson(p: string): Record<string, unknown> {
  return JSON.parse(readFileSync(ruleFilePath(p), "utf-8")) as Record<string, unknown>;
}

/* ---------------- 规则长什么样（纯函数） ---------------- */

test("不带参数的工具：规则就是工具名；Bash：按命令前缀收窄成 Bash(<前缀> *)", () => {
  assert.deepEqual(grantFor({ agent: "claude_code", tool: "Edit" }), { ok: true, tool: "Edit", pattern: null, rule: "Edit" });
  assert.deepEqual(grantFor({ agent: "claude_code", tool: "Bash", commandPrefix: "npm test" }), {
    ok: true,
    tool: "Bash",
    pattern: "npm test",
    rule: "Bash(npm test *)",
  });
  assert.equal(grantFor({ agent: "claude_code", tool: "mcp__github__get_issue" }).ok, true);
});

test("推不出参数模式的带参工具一律不给：Bash 没有前缀 ≠ 整个 Bash 放行", () => {
  assert.deepEqual(grantFor({ agent: "claude_code", tool: "Bash" }), { ok: false, reason: "no_pattern" });
  assert.deepEqual(grantFor({ agent: "claude_code", tool: "Bash", commandPrefix: "npm test --grep x" }), {
    ok: false,
    reason: "no_pattern",
  });
  assert.deepEqual(grantFor({ agent: "claude_code", tool: "WebFetch" }), { ok: false, reason: "no_pattern" });
});

test("只有 Claude Code 有「永远允许」；工具名长得不像工具名（通配、括号、空）也不给", () => {
  assert.deepEqual(grantFor({ agent: "codex", tool: "Edit" }), { ok: false, reason: "unsupported_agent" });
  for (const tool of ["*", "Bash(*)", "", "Edit Write", undefined, 42]) {
    assert.deepEqual(grantFor({ agent: "claude_code", tool }), { ok: false, reason: "bad_tool" }, String(tool));
  }
});

test("危险类按枚举表拒绝，而不是临场判断：表里的每一项都拿不到授予", () => {
  assert.ok(DESTRUCTIVE_COMMANDS.length >= 20, "危险类是一张显式的表");
  for (const d of DESTRUCTIVE_COMMANDS) {
    assert.deepEqual(
      grantFor({ agent: "claude_code", tool: "Bash", commandPrefix: d.prefix }),
      { ok: false, reason: "destructive" },
      d.prefix,
    );
    assert.ok(d.why.length > 0, `${d.prefix} 要写明为什么危险`);
  }
});

test("危险类按词对齐比前缀：`git` 覆盖 `git push` 所以拒；`git push origin` 落在里面也拒；`git status` 放行", () => {
  for (const p of ["git", "npm", "gh", "docker", "rm", "git push origin", "git reset", "sudo npm"]) {
    assert.ok(destructiveMatch(p), `${p} 应该落进危险类`);
  }
  for (const p of ["git status", "git log", "git diff", "npm test", "npm run build", "ls", "cat", "gitk", "rmate"]) {
    assert.equal(destructiveMatch(p), null, `${p} 不该被当成危险类`);
  }
});

test("grant secret：常数时间比较；Core 手里没有 secret 时什么都对不上", () => {
  const secret = "a".repeat(64);
  assert.equal(grantSecretMatches(secret, secret), true);
  assert.equal(grantSecretMatches(secret, "b".repeat(64)), false);
  assert.equal(grantSecretMatches(secret, undefined), false);
  assert.equal(grantSecretMatches(secret, "a"), false);
  assert.equal(grantSecretMatches(null, ""), false);
  assert.equal(grantSecretMatches(null, secret), false);
});

/* ---------------- 规则文件（镜像） ---------------- */

test("文件不存在就建出来，只写 permissions.allow 里的那一条", () => {
  const p = project();
  assert.deepEqual(addRuleToFile(ruleFilePath(p), "Edit"), { ok: true, changed: true });
  assert.deepEqual(fileJson(p), { permissions: { allow: ["Edit"] } });
  assert.ok(!existsSync(join(p, ".claude", "settings.json")), "绝不写 git 跟踪的 settings.json");
});

test("手改过的文件：别的键、别的条目、非字符串条目原样保留；同一条再写一次不重复；第一次改之前留备份", () => {
  const p = project();
  mkdirSync(join(p, ".claude"));
  const original = {
    model: "opus",
    permissions: { allow: ["Bash(npm run *)", 7], deny: ["Read(.env)"], defaultMode: "default" },
    hooks: { Stop: [] },
  };
  writeFileSync(ruleFilePath(p), JSON.stringify(original, null, 2));
  addRuleToFile(ruleFilePath(p), "Bash(npm test *)");
  assert.deepEqual(addRuleToFile(ruleFilePath(p), "Bash(npm test *)"), { ok: true, changed: false });
  assert.deepEqual(fileJson(p), {
    model: "opus",
    permissions: { allow: ["Bash(npm run *)", 7, "Bash(npm test *)"], deny: ["Read(.env)"], defaultMode: "default" },
    hooks: { Stop: [] },
  });
  assert.deepEqual(JSON.parse(readFileSync(`${ruleFilePath(p)}.vibepaws.bak`, "utf-8")), original);
});

test("读不成的文件（截断 / 不是对象 / allow 不是数组）只报告、一个字节都不改", () => {
  for (const broken of ['{"permissions": {"allow": ["Edit"', "[1,2,3]", '{"permissions": {"allow": "Edit"}}', '{"permissions": 3}']) {
    const p = project();
    mkdirSync(join(p, ".claude"));
    writeFileSync(ruleFilePath(p), broken);
    assert.deepEqual(addRuleToFile(ruleFilePath(p), "Edit"), { ok: false, reason: "malformed" }, broken);
    assert.deepEqual(removeRuleFromFile(ruleFilePath(p), "Edit"), { ok: false, reason: "malformed" }, broken);
    assert.equal(readFileSync(ruleFilePath(p), "utf-8"), broken, "坏文件不许被「修好」—— 那等于抹掉用户的条目");
    assert.equal(readRuleFile(ruleFilePath(p)).ok, false);
  }
});

/* ---------------- 授予：从库里那一行推出来 ---------------- */

test("一次授予：写进那个项目的 settings.local.json，行里记着规则、模式与按出它的那条气泡", () => {
  const db = freshDb();
  const p = project();
  const id = permissionRow(db, { projectId: p, payload: { tool_name: "Bash", command_prefix: "npm test" } });
  const r = createGrant(db, id);
  assert.ok(r.ok);
  assert.equal(r.rule, "Bash(npm test *)");
  assert.equal(r.project, "my-app", "回给界面的是短名，不是绝对路径");
  assert.deepEqual(fileJson(p), { permissions: { allow: ["Bash(npm test *)"] } });
  const row = db.prepare("SELECT * FROM rules").get() as Record<string, unknown>;
  assert.equal(row.tool, "Bash");
  assert.equal(row.pattern, "npm test");
  assert.equal(row.origin, "bubble");
  assert.equal(row.notification_id, id, "要能说出是哪条气泡授予的");
  assert.equal(row.use_count, 0);
  assert.equal(isGranted(db, "claude_code", p, "Bash(npm test *)"), true);
});

test("Bash 授予只管那一个前缀：同一项目里换一条命令照样要问", () => {
  const db = freshDb();
  const p = project();
  createGrant(db, permissionRow(db, { projectId: p, payload: { tool_name: "Bash", command_prefix: "npm test" } }));
  const other = grantFor({ agent: "claude_code", tool: "Bash", commandPrefix: "npm run build" });
  assert.ok(other.ok);
  assert.notEqual(other.rule, "Bash(npm test *)");
  assert.equal(isGranted(db, "claude_code", p, other.rule), false);
  assert.ok(!(fileJson(p).permissions as { allow: string[] }).allow.includes(other.rule));
});

test("拒绝授予：不是 permission / 已经结束 / 不存在 / 别的 agent / 危险类 / 项目目录不在", () => {
  const db = freshDb();
  const p = project();
  const context = permissionRow(db, { projectId: p, type: "context", payload: {} });
  assert.deepEqual(deriveGrant(db, context), { ok: false, reason: "not_permission" });

  const done = permissionRow(db, { projectId: p, payload: { tool_name: "Edit" } });
  new NotificationEngine(db).dismiss(done);
  assert.deepEqual(deriveGrant(db, done), { ok: false, reason: "resolved" }, "已经结束的请求没有「这一次」可言");

  assert.deepEqual(deriveGrant(db, 99_999), { ok: false, reason: "not_found" });
  const codex = permissionRow(db, { projectId: p, agent: "codex", payload: { tool_name: "Edit" } });
  assert.deepEqual(deriveGrant(db, codex), { ok: false, reason: "unsupported_agent" });
  const rm = permissionRow(db, { projectId: p, payload: { tool_name: "Bash", command_prefix: "rm" } });
  assert.deepEqual(deriveGrant(db, rm), { ok: false, reason: "destructive" });
  const gone = permissionRow(db, { projectId: join(p, "nope"), payload: { tool_name: "Edit" } });
  assert.deepEqual(deriveGrant(db, gone), { ok: false, reason: "bad_project" });
  const relative = permissionRow(db, { projectId: "my-app", payload: { tool_name: "Edit" } });
  assert.deepEqual(deriveGrant(db, relative), { ok: false, reason: "bad_project" });

  for (const id of [context, done, rm, codex]) assert.equal(createGrant(db, id).ok, false);
  assert.ok(!existsSync(ruleFilePath(p)), "被拒的授予一个字节都不写");
  assert.equal((db.prepare("SELECT COUNT(*) AS c FROM rules").get() as { c: number }).c, 0);
});

test("文件读不成时不落行：表里不许多出一条 agent 并不认的「授予」", () => {
  const db = freshDb();
  const p = project();
  mkdirSync(join(p, ".claude"));
  writeFileSync(ruleFilePath(p), "{ truncated");
  const r = createGrant(db, permissionRow(db, { projectId: p, payload: { tool_name: "Edit" } }));
  assert.deepEqual(r, { ok: false, reason: "malformed" });
  assert.equal((db.prepare("SELECT COUNT(*) AS c FROM rules").get() as { c: number }).c, 0);
  assert.equal(readFileSync(ruleFilePath(p), "utf-8"), "{ truncated");
});

test("撤销：文件里那一条与表里那一行一起去掉，别的条目不动", () => {
  const db = freshDb();
  const p = project();
  mkdirSync(join(p, ".claude"));
  writeFileSync(ruleFilePath(p), JSON.stringify({ permissions: { allow: ["Read"] } }));
  const g = createGrant(db, permissionRow(db, { projectId: p, payload: { tool_name: "Edit" } }));
  assert.ok(g.ok);
  assert.deepEqual(revokeGrant(db, g.id), { ok: true, rule: "Edit" });
  assert.deepEqual(fileJson(p), { permissions: { allow: ["Read"] } });
  assert.equal(isGranted(db, "claude_code", p, "Edit"), false);
  assert.deepEqual(revokeGrant(db, g.id), { ok: false, reason: "not_found" });
});

test("文件里有、表里没有的规则：报成「不是经由 Vibepaws 授予的」，且不算授予", () => {
  const db = freshDb();
  const p = project();
  const g = createGrant(db, permissionRow(db, { projectId: p, payload: { tool_name: "Edit" } }));
  assert.ok(g.ok);
  // agent 用它自己的 Write 工具往文件里加了一条 —— 这里拦不住，但不能把它洗成人批准过的
  const f = fileJson(p) as { permissions: { allow: string[] } };
  f.permissions.allow.push("Bash(curl *)");
  writeFileSync(ruleFilePath(p), JSON.stringify(f));

  const snap = listRules(db);
  assert.deepEqual(snap.rules.map((r) => [r.rule, r.project, r.in_file]), [["Edit", "my-app", true]]);
  assert.deepEqual(snap.external, [{ rule: "Bash(curl *)", project: "my-app" }]);
  assert.equal(isGranted(db, "claude_code", p, "Bash(curl *)"), false, "来历不明的规则不被当作授予");
  assert.ok(!JSON.stringify(snap).includes(p), "列表里只有短名，绝对路径不出 Core");
});

test("列表也扫最近的 Claude Code 项目：一条从没授予过的项目里冒出来的规则同样报出来；坏文件单独报", () => {
  const db = freshDb();
  const clean = project();
  const broken = project();
  db.prepare("INSERT INTO sessions(agent, agent_session_id, project_id) VALUES('claude_code','a', ?)").run(clean);
  db.prepare("INSERT INTO sessions(agent, agent_session_id, project_id) VALUES('claude_code','b', ?)").run(broken);
  addRuleToFile(ruleFilePath(clean), "Write");
  mkdirSync(join(broken, ".claude"));
  writeFileSync(ruleFilePath(broken), "not json");
  const snap = listRules(db);
  assert.deepEqual(snap.rules, []);
  assert.deepEqual(snap.external, [{ rule: "Write", project: "my-app" }]);
  assert.deepEqual(snap.problems, [{ project: "my-app", reason: "malformed" }]);
});

test("规则被手动从文件里删掉：行还在（表是权威），标成 in_file=false，撤销照样清得掉", () => {
  const db = freshDb();
  const p = project();
  const g = createGrant(db, permissionRow(db, { projectId: p, payload: { tool_name: "Edit" } }));
  assert.ok(g.ok);
  writeFileSync(ruleFilePath(p), JSON.stringify({ permissions: { allow: [] } }));
  assert.equal(listRules(db).rules[0]!.in_file, false);
  assert.deepEqual(revokeGrant(db, g.id), { ok: true, rule: "Edit" });
});

test("同一条规则再按一次是幂等的：不新增行，文件里缺了就补回去", () => {
  const db = freshDb();
  const p = project();
  const first = createGrant(db, permissionRow(db, { projectId: p, session: "same", payload: { tool_name: "Edit" } }));
  writeFileSync(ruleFilePath(p), "{}");
  const again = createGrant(db, permissionRow(db, { projectId: p, session: "same", payload: { tool_name: "Edit" } }));
  assert.ok(first.ok && again.ok);
  assert.equal(again.id, first.id);
  assert.equal(again.created, false);
  assert.deepEqual(fileJson(p), { permissions: { allow: ["Edit"] } });
});
