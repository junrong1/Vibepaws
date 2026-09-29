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
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { applySchema } from "../db/schema.ts";
import { seedPetTypes } from "../db/seed.ts";
import {
  DESTRUCTIVE_COMMANDS,
  GRANTABLE_COMMANDS,
  READ_ONLY_TOOLS,
  addRuleToFile,
  createGrant,
  deriveGrant,
  destructiveMatch,
  grantFor,
  grantSecretMatches,
  isGranted,
  isUnsafeProjectRoot,
  listRules,
  pinGrantPreview,
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
  opts: { projectId: string; payload: Record<string, unknown>; agent?: string; type?: string; session?: string; pin?: boolean },
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
  const id = Number(info.lastInsertRowid);
  // 与 server.broadcastNotification 一致：气泡一出来就把预览钉住（推不出来的 = 没有预览，什么都不钉）
  if (opts.pin !== false) pinGrantPreview(db, id);
  return id;
}

function fileJson(p: string): Record<string, unknown> {
  return JSON.parse(readFileSync(ruleFilePath(p), "utf-8")) as Record<string, unknown>;
}

/* ---------------- 规则长什么样（纯函数） ---------------- */

test("不带参数的工具：规则就是工具名；Bash：按命令前缀收窄成 Bash(<前缀> *)", () => {
  assert.deepEqual(grantFor({ agent: "claude_code", tool: "Read" }), { ok: true, tool: "Read", pattern: null, rule: "Read" });
  assert.deepEqual(grantFor({ agent: "claude_code", tool: "Bash", commandPrefix: "npm test" }), {
    ok: true,
    tool: "Bash",
    pattern: "npm test",
    rule: "Bash(npm test *)",
  });
});

test("工具名本身只给只读的那几个：改文件的、替用户答题的、mcp__*、认不得的一律不给", () => {
  for (const tool of ["Read", "Glob", "Grep", "LS", "WebSearch"]) {
    assert.ok(READ_ONLY_TOOLS.has(tool), tool);
    assert.equal(grantFor({ agent: "claude_code", tool }).ok, true, tool);
  }
  for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit", "AskUserQuestion", "ExitPlanMode", "mcp__github__get_issue", "TodoWrite", "Task", "SomethingNew"]) {
    assert.deepEqual(grantFor({ agent: "claude_code", tool }), { ok: false, reason: "not_allowlisted" }, tool);
  }
  assert.deepEqual(grantFor({ agent: "claude_code", tool: "WebFetch" }), { ok: false, reason: "no_pattern" });
});

test("Bash 按允许表授予：表里的放行，表外的（包括认不得的程序）一律没有「永远允许」", () => {
  for (const p of ["npm test", "git status", "npm run build", "cargo test", "ls", "grep"]) {
    assert.equal(grantFor({ agent: "claude_code", tool: "Bash", commandPrefix: p }).ok, true, p);
  }
  for (const [p, reason] of [
    ["gh api", "destructive"],
    ["nice", "destructive"],
    ["git push", "destructive"],
    ["docker run", "destructive"],
    ["time", "destructive"],
    ["caffeinate", "destructive"],
    ["git", "destructive"],
    ["npm", "destructive"],
    ["npm run", "not_allowlisted"],
    ["mytool", "not_allowlisted"],
    ["echo", "not_allowlisted"],
    ["git branch", "destructive"],
  ] as const) {
    assert.deepEqual(grantFor({ agent: "claude_code", tool: "Bash", commandPrefix: p }), { ok: false, reason }, p);
  }
});

test("adapter 削出来的前缀喂给授予：gh api … -X DELETE / nice rm 拿不到任何规则", async () => {
  const { commandPrefix } = await import("./events.ts");
  for (const command of ["gh api repos/o/r -X DELETE", "nice rm -rf x", "nice -n 5 npm test", "time rm -rf build", "open -a Terminal"]) {
    const prefix = commandPrefix(command);
    assert.equal(grantFor({ agent: "claude_code", tool: "Bash", commandPrefix: prefix }).ok, false, `${command} → ${prefix}`);
  }
  assert.equal(grantFor({ agent: "claude_code", tool: "Bash", commandPrefix: commandPrefix("npm test -- --grep x") }).ok, true);
  assert.equal(grantFor({ agent: "claude_code", tool: "Bash", commandPrefix: commandPrefix("git status --short") }).ok, true);
});

test("允许表与危险类不相交：将来往允许表里加一项危险的，这条测试先红", () => {
  assert.ok(GRANTABLE_COMMANDS.length > 0);
  for (const c of GRANTABLE_COMMANDS) {
    assert.equal(destructiveMatch(c.prefix), null, `${c.prefix} 落进了危险类：${destructiveMatch(c.prefix)?.prefix}`);
    assert.ok(c.why.length > 0, `${c.prefix} 要写明为什么安全`);
    // 单个词只给程序本身只读的
    if (!c.prefix.includes(" ")) assert.match(c.why, /^read-only/, c.prefix);
  }
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

  const done = permissionRow(db, { projectId: p, payload: { tool_name: "Read" } });
  new NotificationEngine(db).dismiss(done);
  assert.deepEqual(deriveGrant(db, done), { ok: false, reason: "resolved" }, "已经结束的请求没有「这一次」可言");

  assert.deepEqual(deriveGrant(db, 99_999), { ok: false, reason: "not_found" });
  const codex = permissionRow(db, { projectId: p, agent: "codex", payload: { tool_name: "Read" } });
  assert.deepEqual(deriveGrant(db, codex), { ok: false, reason: "unsupported_agent" });
  const rm = permissionRow(db, { projectId: p, payload: { tool_name: "Bash", command_prefix: "rm" } });
  assert.deepEqual(deriveGrant(db, rm), { ok: false, reason: "destructive" });
  const gone = permissionRow(db, { projectId: join(p, "nope"), payload: { tool_name: "Read" } });
  assert.deepEqual(deriveGrant(db, gone), { ok: false, reason: "bad_project" });
  const relative = permissionRow(db, { projectId: "my-app", payload: { tool_name: "Read" } });
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
  const r = createGrant(db, permissionRow(db, { projectId: p, payload: { tool_name: "Read" } }));
  assert.deepEqual(r, { ok: false, reason: "malformed" });
  assert.equal((db.prepare("SELECT COUNT(*) AS c FROM rules").get() as { c: number }).c, 0);
  assert.equal(readFileSync(ruleFilePath(p), "utf-8"), "{ truncated");
});

test("撤销：文件里那一条与表里那一行一起去掉，别的条目不动", () => {
  const db = freshDb();
  const p = project();
  mkdirSync(join(p, ".claude"));
  writeFileSync(ruleFilePath(p), JSON.stringify({ permissions: { allow: ["Glob"] } }));
  const g = createGrant(db, permissionRow(db, { projectId: p, payload: { tool_name: "Read" } }));
  assert.ok(g.ok);
  assert.deepEqual(revokeGrant(db, g.id), { ok: true, rule: "Read" });
  assert.deepEqual(fileJson(p), { permissions: { allow: ["Glob"] } });
  assert.equal(isGranted(db, "claude_code", p, "Read"), false);
  assert.deepEqual(revokeGrant(db, g.id), { ok: false, reason: "not_found" });
});

test("文件里有、表里没有的规则：报成「不是经由 Vibepaws 授予的」，且不算授予", () => {
  const db = freshDb();
  const p = project();
  const g = createGrant(db, permissionRow(db, { projectId: p, payload: { tool_name: "Read" } }));
  assert.ok(g.ok);
  // agent 用它自己的 Write 工具往文件里加了一条 —— 这里拦不住，但不能把它洗成人批准过的
  const f = fileJson(p) as { permissions: { allow: string[] } };
  f.permissions.allow.push("Bash(curl *)");
  writeFileSync(ruleFilePath(p), JSON.stringify(f));

  const snap = listRules(db);
  assert.deepEqual(snap.rules.map((r) => [r.rule, r.project, r.in_file]), [["Read", "my-app", true]]);
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
  const g = createGrant(db, permissionRow(db, { projectId: p, payload: { tool_name: "Read" } }));
  assert.ok(g.ok);
  writeFileSync(ruleFilePath(p), JSON.stringify({ permissions: { allow: [] } }));
  assert.equal(listRules(db).rules[0]!.in_file, false);
  assert.deepEqual(revokeGrant(db, g.id), { ok: true, rule: "Read" });
});

test("同一条规则再按一次是幂等的：不新增行，文件里缺了就补回去", () => {
  const db = freshDb();
  const p = project();
  const first = createGrant(db, permissionRow(db, { projectId: p, session: "same", payload: { tool_name: "Read" } }));
  writeFileSync(ruleFilePath(p), "{}");
  const again = createGrant(db, permissionRow(db, { projectId: p, session: "same", payload: { tool_name: "Read" } }));
  assert.ok(first.ok && again.ok);
  assert.equal(again.id, first.id);
  assert.equal(again.created, false);
  assert.deepEqual(fileJson(p), { permissions: { allow: ["Read"] } });
});

/* ---------------- 复审：预览钉住、符号链接、项目本身像不像一个项目 ---------------- */

test("预览钉住：显示预览之后 session 的 project_id 被改了 → 按下去 changed，一个字节都不写", () => {
  const db = freshDb();
  const shown = project();
  const other = project();
  const id = permissionRow(db, { projectId: shown, session: "moved", payload: { tool_name: "Bash", command_prefix: "npm test" } });
  // 一条 resume 事件把同一个 session 的项目改到了别处
  db.prepare("UPDATE sessions SET project_id=? WHERE agent_session_id='moved'").run(other);
  assert.deepEqual(createGrant(db, id), { ok: false, reason: "changed" });
  assert.equal(pinGrantPreview(db, id), null, "钉住之后推出来的不一样：不再给预览，也不改钉");
  assert.ok(!existsSync(ruleFilePath(shown)) && !existsSync(ruleFilePath(other)));
  assert.equal((db.prepare("SELECT COUNT(*) AS c FROM rules").get() as { c: number }).c, 0);
});

test("预览钉住：从没显示过预览的通知（没钉）→ changed；钉住的规则与此刻推出来的不同 → changed", () => {
  const db = freshDb();
  const p = project();
  const unpinned = permissionRow(db, { projectId: p, pin: false, payload: { tool_name: "Read" } });
  assert.deepEqual(createGrant(db, unpinned), { ok: false, reason: "changed" });
  const id = permissionRow(db, { projectId: p, payload: { tool_name: "Read" } });
  db.prepare("UPDATE notifications SET grant_rule='Glob' WHERE id=?").run(id);
  assert.deepEqual(createGrant(db, id), { ok: false, reason: "changed" });
  assert.ok(!existsSync(ruleFilePath(p)));
});

test("符号链接：.claude 是链接 / 规则文件是链接 → 拒绝，链接指向的地方一个字节都不写", () => {
  // .claude → 项目外的一个目录
  const p1 = project();
  const outside = mkdtempSync(join(tmpdir(), "vibepaws-outside-"));
  symlinkSync(outside, join(p1, ".claude"));
  assert.deepEqual(addRuleToFile(ruleFilePath(p1), "Read"), { ok: false, reason: "unreadable" });
  assert.deepEqual(readdirSync(outside), []);

  // settings.local.json → 项目外的一个文件（比如 ~/.zshrc）
  const p2 = project();
  mkdirSync(join(p2, ".claude"));
  const victim = join(outside, "zshrc");
  writeFileSync(victim, "# rc\n");
  symlinkSync(victim, ruleFilePath(p2));
  assert.deepEqual(addRuleToFile(ruleFilePath(p2), "Read"), { ok: false, reason: "unreadable" });
  assert.deepEqual(removeRuleFromFile(ruleFilePath(p2), "Read"), { ok: false, reason: "unreadable" });
  assert.equal(readFileSync(victim, "utf-8"), "# rc\n");
});

test("符号链接：预先放好的 .vibepaws.bak / 老的固定 tmp 名链接不会被跟随", () => {
  const p = project();
  mkdirSync(join(p, ".claude"));
  writeFileSync(ruleFilePath(p), JSON.stringify({ permissions: { allow: [] } }));
  const outside = mkdtempSync(join(tmpdir(), "vibepaws-outside-"));
  const bakVictim = join(outside, "bak-target");
  const tmpVictim = join(outside, "tmp-target");
  // 悬空的链接：existsSync 说 false，老代码会顺着它把目标建出来
  symlinkSync(bakVictim, `${ruleFilePath(p)}.vibepaws.bak`);
  symlinkSync(tmpVictim, `${ruleFilePath(p)}.vibepaws.tmp`);
  assert.deepEqual(addRuleToFile(ruleFilePath(p), "Read"), { ok: true, changed: true });
  assert.ok(!existsSync(bakVictim), "备份不许写穿链接");
  assert.ok(!existsSync(tmpVictim), "临时文件不许写穿链接");
  assert.deepEqual(fileJson(p), { permissions: { allow: ["Read"] } });
  assert.equal(lstatSync(ruleFilePath(p)).isSymbolicLink(), false);
  assert.equal(lstatSync(ruleFilePath(p)).mode & 0o777, 0o600);
  // 没有留下随机名的临时文件
  assert.deepEqual(readdirSync(join(p, ".claude")).sort(), [
    "settings.local.json",
    "settings.local.json.vibepaws.bak",
    "settings.local.json.vibepaws.tmp",
  ]);
});

test("项目本身不像项目：/、home、home 的上级 → bad_project（不会写进 ~/.claude/）", () => {
  const home = homedir();
  for (const p of ["/", home, dirname(home)]) {
    assert.equal(isUnsafeProjectRoot(p), true, p);
  }
  assert.equal(isUnsafeProjectRoot(project()), false);
  // 用一个假 home 验「上级」与「经链接绕过来」
  const fakeHome = project();
  assert.equal(isUnsafeProjectRoot(dirname(fakeHome), fakeHome), true);
  assert.equal(isUnsafeProjectRoot(join(fakeHome), fakeHome), true);
  const link = join(mkdtempSync(join(tmpdir(), "vibepaws-link-")), "home-link");
  symlinkSync(fakeHome, link);
  assert.equal(isUnsafeProjectRoot(link, fakeHome), true, "链接到 home 的项目目录照样拒");
  const inside = join(fakeHome, "code");
  mkdirSync(inside);
  assert.equal(isUnsafeProjectRoot(inside, fakeHome), false, "home 底下的项目当然可以");

  const db = freshDb();
  for (const p of ["/", home]) {
    const id = permissionRow(db, { projectId: p, payload: { tool_name: "Read" } });
    assert.deepEqual(deriveGrant(db, id), { ok: false, reason: "bad_project" }, p);
  }
});
