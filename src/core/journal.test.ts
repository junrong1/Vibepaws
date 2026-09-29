/**
 * 日志（journal.ts，U12 / R23 / R24 / R29）的单测。
 *
 * 要守住的是四件事：
 *   1. 一段收工一行，而且只有一行 —— 重放、同一段来第二条收工都写不出第二行；
 *      clear / resume 之后的第二段是第二行，历史与当天聚合两段都看得见；
 *   2. 被回收的、没结算的段不写（R9 / R10）；
 *   3. 文件是导出：只追加、不在就重建、手改过的原样留着、写失败不抛；reset 两个 scope 都把它删掉；
 *   4. 文件与 /api/journal 里都没有原始 project_id（绝对路径）。
 *
 * 所有文件都写在临时目录：Core 绝不对着开发机真实的数据目录跑。
 */
import { test as nodeTest, type TestContext } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySchema } from "../db/schema.ts";
import { seedPetTypes } from "../db/seed.ts";
import { VibepawsServer } from "./server.ts";
import {
  JOURNAL_MAX_FILES,
  adoptSettledSessions,
  flushJournal,
  parseJournalMonth,
  recordFinish,
  renderEntry,
} from "./journal.ts";
import { loadHistorySegments, localDayKey, localDayStart, todayHealth } from "./health_query.ts";
import { sessionHealthHistory } from "./health_history.ts";
import type { CoreEvent, JournalEntryView } from "./events.ts";

const MIN = 60_000;

/**
 * 这里的段都贴着「现在」造（Date.now() − 几分钟），断言的是「今天」「这个月的文件」。
 * 午夜刚过、月初第一分钟跑，段的开始会落到前一天 / 前一个月，于是 segments==2、days:1 之类的断言
 * 随时间偶发失败。每条测试都把时钟钉在今天的本地正午（只 mock Date：没有测试靠 setTimeout 等时间流逝）。
 */
function freezeAtNoon(t: TestContext): void {
  const noon = new Date();
  noon.setHours(12, 0, 0, 0);
  t.mock.timers.enable({ apis: ["Date"], now: noon.getTime() });
}

const test = (name: string, fn: (t: TestContext) => void | Promise<void>): void => {
  nodeTest(name, (t) => {
    freezeAtNoon(t);
    return fn(t);
  });
};

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `vibepaws-journal-${prefix}-`));
}

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  seedPetTypes(db);
  return db;
}

/** repoRoot / home 也换成临时目录（server.test.ts 的 sandbox 同理：/api/uninstall 会去动它们） */
function makeServer(opts: { db?: Database.Database; journalDir?: string | null } = {}): VibepawsServer {
  const base = tempDir("srv");
  const repoRoot = join(base, "repo");
  const home = join(base, "home");
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(home, { recursive: true });
  const journalDir = opts.journalDir === undefined ? join(base, "journal") : opts.journalDir;
  return new VibepawsServer({ db: opts.db ?? makeDb(), repoRoot, home, journalDir });
}

let seq = 0;
function ev(partial: Partial<CoreEvent>): CoreEvent {
  seq += 1;
  return {
    event_id: `jr-${seq}`,
    seq,
    agent: "claude_code",
    session_id: "s1",
    project_id: "/Users/alice/secret-corp/my-app",
    event_type: "session_started",
    severity: "low",
    safe_summary: "x",
    timestamp: new Date().toISOString(),
    payload: {},
    ...partial,
  };
}

function rows(server: VibepawsServer, kind = "session"): Array<{ segment: number; idem_key: string; rendered_at: string | null }> {
  return server.db
    .prepare("SELECT segment, idem_key, rendered_at FROM memories WHERE kind=? ORDER BY id")
    .all(kind) as Array<{ segment: number; idem_key: string; rendered_at: string | null }>;
}

function monthFile(server: VibepawsServer, at = new Date()): string {
  return join(server.journal.dir!, `${localDayKey(at).slice(0, 7)}.md`);
}

/** 一段：开始 → 改两个文件（其中一个改两次）→ 收工。时间戳贴着「现在」，都落在今天 */
function runSegment(server: VibepawsServer, sessionId = "s1", source: "startup" | "clear" | "resume" = "startup"): void {
  const base = { session_id: sessionId };
  server.handleEvent(ev({ ...base, payload: { source, cwd: "/Users/alice/secret-corp/my-app" } }));
  server.handleEvent(ev({ ...base, event_type: "context_update", payload: { context_pct: 40 } }));
  for (const file of ["/Users/alice/secret-corp/my-app/src/app.ts", "/Users/alice/secret-corp/my-app/README.md", "src/app.ts"]) {
    server.handleEvent(ev({ ...base, event_type: "agent_working", payload: { tool_name: "Edit", file } }));
  }
  // 读过的文件不是「这一段做了什么」
  server.handleEvent(ev({ ...base, event_type: "agent_working", payload: { tool_name: "Read", file: "secrets.env" } }));
  server.handleEvent(ev({ ...base, event_type: "session_finished", payload: { outcome: "success" } }));
}

/* ---------------- 一段一行 ---------------- */

test("一段收工写一行；重放同一条收工、同一段再来一条收工，都写不出第二行", () => {
  const server = makeServer();
  runSegment(server);
  assert.equal(rows(server).length, 1);

  // 同一条事件原样重放（spool 补发）：ingress 按 event_id 去重
  const finish = ev({ event_type: "session_finished", payload: { outcome: "success" } });
  server.handleEvent(finish);
  server.handleEvent(finish);
  // 换了 event_id 的第二条收工（hook 重复触发）：靠 memories.idem_key 的唯一索引
  server.handleEvent(ev({ event_type: "session_finished", payload: { outcome: "partial" } }));
  assert.equal(rows(server).length, 1, "同一段只有一行");
  assert.equal(recordFinish(server.db, "claude_code", "s1"), null, "再直接调一次也是 null");
  assert.equal(rows(server)[0]!.idem_key, "session:claude_code:s1:1");
});

test("收工、clear、再收工：两行、两个段号；历史与当天聚合两段都在（sessions 只剩最后一段）", () => {
  const server = makeServer();
  runSegment(server);
  runSegment(server, "s1", "clear");
  assert.deepEqual(rows(server).map((r) => r.segment), [1, 2]);

  const history = loadHistorySegments(server.db, localDayStart(new Date()));
  assert.deepEqual(history.map((h) => h.segment), [1, 2], "第一段没有随着 clear 从历史里消失");
  assert.equal(todayHealth(server.db).segments, 2, "当天聚合也两段都算（U3 留下的缺口）");
  const api = sessionHealthHistory(server.db, { days: 1 });
  assert.equal(api.source, "journal");
  assert.deepEqual(api.segments.map((s) => s.segment), [1, 2]);

  const text = readFileSync(monthFile(server), "utf8");
  assert.match(text, /segment 1 /);
  assert.match(text, /segment 2 /);
});

test("resume 回来的段也是新的一行（SessionEnd 之后的 startup 同理）", () => {
  const server = makeServer();
  runSegment(server);
  runSegment(server, "s1", "resume");
  runSegment(server, "s1", "startup");
  assert.deepEqual(rows(server).map((r) => r.segment), [1, 2, 3]);
});

test("被回收的 session 不写日志（R10）", () => {
  const server = makeServer();
  server.handleEvent(ev({ session_id: "zombie", payload: { source: "startup" } }));
  const at = new Date(Date.now() - 20 * MIN).toISOString();
  server.db.prepare("UPDATE sessions SET last_event_at=?").run(at);
  assert.equal(server.sweepZombies().length, 1);
  assert.equal(recordFinish(server.db, "claude_code", "zombie"), null);
  // adapter 自己报了一个回收形状的 outcome 也一样
  server.handleEvent(ev({ session_id: "t", payload: { source: "startup" } }));
  server.handleEvent(ev({ session_id: "t", event_type: "session_finished", payload: { outcome: "timeout" } }));
  assert.equal(rows(server).length, 0);
  assert.equal(existsSync(monthFile(server)), false, "一个字都没写，连文件都没建");
});

test("没结算的一段不写日志（R9）", () => {
  const server = makeServer();
  server.handleEvent(ev({ payload: { source: "startup" } }));
  server.handleEvent(ev({ event_type: "agent_working", payload: { tool_name: "Edit", file: "a.ts" } }));
  assert.equal(recordFinish(server.db, "claude_code", "s1"), null);
  assert.equal(recordFinish(server.db, "claude_code", "nobody"), null);
  assert.equal(rows(server).length, 0);
});

/* ---------------- 文件 ---------------- */

test("渲染出来的条目：有文件名（basename）、有短名，没有项目路径里的任何一段目录", () => {
  const server = makeServer();
  runSegment(server);
  const text = readFileSync(monthFile(server), "utf8");
  assert.match(text, /^# Vibepaws journal · \d{4}-\d{2}/, "新文件带表头");
  assert.match(text, /· my-app · score \d+/, "标题行带短名与分数：grep 得到");
  assert.match(text, /- files: app\.ts, README\.md\n/, "改过的文件去重、按顺序；读过的不算");
  assert.ok(!text.includes("secrets.env"));
  for (const leak of ["/Users", "alice", "secret-corp", "src/"]) {
    assert.ok(!text.includes(leak), `文件里不该出现 ${leak}`);
  }
  // 库里也没有原始 project_id
  const stored = JSON.stringify(server.db.prepare("SELECT * FROM memories").all());
  assert.ok(!stored.includes("/Users/alice"), "日志行里只有短名");
});

test("文件名最多列 JOURNAL_MAX_FILES 个，其余说「还有几个」；换行洗掉，伪造不出一条条目", () => {
  const server = makeServer();
  server.handleEvent(ev({ payload: { source: "startup" } }));
  for (let i = 0; i < JOURNAL_MAX_FILES + 3; i++) {
    server.handleEvent(ev({ event_type: "agent_working", payload: { tool_name: "Write", file: `f${i}.ts` } }));
  }
  server.handleEvent(ev({ event_type: "agent_working", payload: { tool_name: "Edit", file: "evil\n### fake entry" } }));
  server.handleEvent(ev({ event_type: "session_finished", payload: { outcome: "success" } }));
  const text = readFileSync(monthFile(server), "utf8");
  assert.match(text, /\(\+4 more\)/);
  assert.equal(text.match(/^### /gm)!.length, 1, "只有一条条目");
});

test("文件被删了就在下一次写的时候重建；手改过的文件原样留着，新条目接在后面", () => {
  const dir = tempDir("edit");
  const server = makeServer({ journalDir: dir });
  runSegment(server, "a");
  const path = monthFile(server);
  // 用户在文件里写了自己的笔记（末尾不带换行）
  appendFileSync(path, "\nMy own note: the refactor went well.");
  const edited = readFileSync(path, "utf8");
  runSegment(server, "b");
  const after = readFileSync(path, "utf8");
  assert.ok(after.startsWith(edited), "前面的内容一个字节都没动");
  assert.match(after.slice(edited.length), /^\n\n### /, "新条目另起一段，不粘在用户那一行后面");

  // 文件整个没了（用户删的）：下一次写的时候连表头一起重建
  rmSync(path);
  runSegment(server, "c");
  const rebuilt = readFileSync(path, "utf8");
  assert.match(rebuilt, /^# Vibepaws journal/);
  assert.equal(rebuilt.match(/^### /gm)!.length, 1, "重建的文件只有新的那一条（旧的在库里，文件只是导出）");
});

test("写文件失败不抛出事件链：行照样写进去，目录好了之后下一次写把欠的一起补上", () => {
  const base = tempDir("fail");
  const blocker = join(base, "not-a-dir");
  writeFileSync(blocker, "I am a file"); // 目录的位置上是一个文件：mkdir 必然失败
  const server = makeServer({ journalDir: join(blocker, "journal") });
  const errors: unknown[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  try {
    runSegment(server, "a");
  } finally {
    console.error = real;
  }
  assert.equal(rows(server).length, 1, "行在：库才是真相");
  assert.equal(rows(server)[0]!.rendered_at, null, "没写出去就不标");
  assert.ok(errors.length > 0, "失败要记一笔");
  assert.ok(server.stateSnapshot().pet.exp > 0, "事件链后半段（EXP）照常跑完了");

  // 换一个写得进去的目录：下一次写的时候把欠的那一条一起补上
  const good = join(base, "journal");
  const healed = makeServer({ db: server.db, journalDir: good });
  runSegment(healed, "b");
  const text = readFileSync(join(good, `${localDayKey(new Date()).slice(0, 7)}.md`), "utf8");
  assert.equal(text.match(/^### /gm)!.length, 2);
  assert.ok(rows(healed).every((r) => r.rendered_at !== null));
});

test("一个月份文件写不进去只挡住那个月：别的月份照写；失败那一条的 rendered_at 跟着事务撤掉", () => {
  // 先只写行（没配目录），再把其中两段挪到上个月，模拟升级时收养进来的老行
  const server = makeServer({ journalDir: null });
  for (const id of ["old-1", "old-2", "new-1"]) runSegment(server, id);
  const prev = new Date();
  prev.setDate(1);
  prev.setMonth(prev.getMonth() - 1);
  const prevDay = localDayKey(prev);
  server.db
    .prepare("UPDATE memories SET day=?, occurred_at=? WHERE agent_session_id IN ('old-1','old-2')")
    .run(prevDay, prev.toISOString());

  const dir = tempDir("iso");
  // 上个月的文件名被一个目录占了：appendFileSync 必然 EISDIR
  mkdirSync(join(dir, `${prevDay.slice(0, 7)}.md`));
  const errors: unknown[] = [];
  const real = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  let written: number;
  try {
    written = flushJournal(server.db, dir);
  } finally {
    console.error = real;
  }
  assert.equal(written, 1, "这个月那一条照写");
  assert.equal(errors.length, 1, "坏掉的月份一轮只记一次，不是每行一次");
  const thisMonth = readFileSync(join(dir, `${localDayKey(new Date()).slice(0, 7)}.md`), "utf8");
  assert.equal(thisMonth.match(/^### /gm)!.length, 1);
  const state = server.db
    .prepare("SELECT agent_session_id AS id, rendered_at FROM memories WHERE kind='session' ORDER BY agent_session_id")
    .all() as Array<{ id: string; rendered_at: string | null }>;
  assert.deepEqual(
    state.map((r) => [r.id, r.rendered_at !== null]),
    [["new-1", true], ["old-1", false], ["old-2", false]],
    "追加抛了 → 先标上的 rendered_at 随事务回滚，下一次还会补",
  );

  // 修好之后再跑一次：欠的两条补上，已经写过的那一条不会再写一遍
  rmSync(join(dir, `${prevDay.slice(0, 7)}.md`), { recursive: true });
  assert.equal(flushJournal(server.db, dir), 2);
  assert.equal(readFileSync(join(dir, `${prevDay.slice(0, 7)}.md`), "utf8").match(/^### /gm)!.length, 2);
  assert.equal(flushJournal(server.db, dir), 0);
  assert.equal(readFileSync(join(dir, `${localDayKey(new Date()).slice(0, 7)}.md`), "utf8"), thisMonth, "没有重复的收据");
});

test("没配目录（注入 db 的缺省）：只写行，不碰任何文件", () => {
  const server = makeServer({ journalDir: null });
  runSegment(server);
  assert.equal(server.journal.dir, null);
  assert.equal(rows(server).length, 1);
});

/* ---------------- reset ---------------- */

test("reset(scope=data)：行与文件一起清空；目录里不是我们起名的文件不碰", () => {
  const server = makeServer();
  runSegment(server);
  const notes = join(server.journal.dir!, "notes.md");
  writeFileSync(notes, "mine");
  const lookalike = join(server.journal.dir!, "2026-13.md"); // 不是一个月份
  writeFileSync(lookalike, "mine too");
  assert.ok(existsSync(monthFile(server)));

  const result = server.resetLocalData("data");
  assert.equal(result.journal_files, 1);
  assert.equal(rows(server).length, 0);
  assert.equal(existsSync(monthFile(server)), false);
  assert.ok(existsSync(notes) && existsSync(lookalike), "只删 YYYY-MM.md");
});

test("reset(scope=pet) 也清掉文件：换一只新宠物，不给它留一整本旧的散文历史", () => {
  const server = makeServer();
  runSegment(server);
  const result = server.resetLocalData("pet");
  assert.equal(result.journal_files, 1);
  assert.equal(rows(server).length, 0);
  assert.equal(existsSync(monthFile(server)), false);
  assert.equal(server.stateSnapshot().sessions.length, 1, "session 列表留着");

  // 重启 Core：还留着的 sessions 不会被重新收养成日志（收养只跑一次）
  const restarted = makeServer({ db: server.db, journalDir: server.journal.dir });
  assert.equal(rows(restarted).length, 0);
  assert.equal(existsSync(monthFile(restarted)), false);
});

/* ---------------- 收养（升级） ---------------- */

test("升级：sessions 里已经结算的段收养成日志行（只一次）；被回收的、还在跑的不收", () => {
  const db = makeDb();
  const put = db.prepare(
    `INSERT INTO sessions(agent, agent_session_id, project_id, is_active, segment_started_at, finished_at, outcome,
       context_peak, context_reported_at)
     VALUES('claude_code', ?, '/Users/x/old-app', ?, ?, ?, ?, 40, ?)`,
  );
  const end = new Date(Date.now() - MIN).toISOString();
  const start = new Date(Date.now() - 30 * MIN).toISOString();
  put.run("done", 0, start, end, "success", start);
  put.run("gone", 0, start, end, "orphaned", start);
  put.run("live", 1, start, null, null, start);

  const server = makeServer({ db });
  assert.equal(rows(server).length, 1);
  assert.equal(todayHealth(db).segments, 1, "升级当天的健康不会突然变成「不知道」");
  assert.match(readFileSync(monthFile(server), "utf8"), /· old-app · score 100/);
  assert.equal(adoptSettledSessions(db), 0, "第二次不跑");
});

/* ---------------- 进化（R29） ---------------- */

test("进化：发一条 evolution 气泡，写一行日志 —— 说出从哪个形态、到哪个形态、凭的是多少健康", () => {
  const server = makeServer();
  // 今天一段中等偏下的：(12 + 14 + 12) / 75 = 50.7 → 映射后 0.85（exp.test 的同一组数）
  const end = new Date(Date.now() - MIN).toISOString();
  const start = new Date(Date.now() - 2 * MIN).toISOString();
  server.db
    .prepare(
      `INSERT INTO sessions(agent, agent_session_id, project_id, is_active, segment_started_at, finished_at, outcome,
         context_peak, context_reported_at, repeat_edit_count)
       VALUES('claude_code', 'meh', '/p/app', 0, ?, ?, 'partial', 90, ?, 3)`,
    )
    .run(start, end, start);
  assert.ok(server.journal.onFinish("claude_code", "meh"));
  server.db.prepare("UPDATE pets SET pet_type_id=20, level=4, exp=249").run();
  const names = server.db.prepare("SELECT id, name FROM pet_types WHERE id IN (20, 30)").all() as Array<{ id: number; name: string }>;
  const nameOf = (id: number): string => names.find((n) => n.id === id)!.name;

  server.handleEvent(ev({ session_id: "meh", event_type: "token_update", payload: { tokens: 1000 } }));

  const pet = server.db.prepare("SELECT pet_type_id FROM pets").get() as { pet_type_id: number };
  assert.equal(pet.pet_type_id, 30);
  const evo = server.db
    .prepare("SELECT from_type_id, to_type_id, from_form, to_form, level, health FROM memories WHERE kind='evolution'")
    .all();
  assert.deepEqual(evo, [{ from_type_id: 20, to_type_id: 30, from_form: nameOf(20), to_form: nameOf(30), level: 5, health: 0.85 }]);
  const notif = server.db.prepare("SELECT agent, session_id, title, body FROM notifications WHERE type='evolution'").all() as Array<{
    agent: string;
    session_id: string;
    title: string;
    body: string;
  }>;
  assert.equal(notif.length, 1);
  assert.equal(notif[0]!.title, `${nameOf(20)} evolved into ${nameOf(30)}!`);
  assert.match(notif[0]!.body, /Lv\.5 · health 85%/);
  const text = readFileSync(monthFile(server), "utf8");
  assert.ok(text.includes(`· evolution · ${nameOf(20)} → ${nameOf(30)}`));
  assert.match(text, /health 0\.85 \(gate ≥ 0\.70\)/);
});

test("按项目 / session 静音不吞进化气泡；全局静音才吞", () => {
  const server = makeServer();
  const e = { fromForm: "A", toForm: "B", fromTypeId: 1, toTypeId: 2, level: 5, health: 0.9 };
  server.notifications.muteProject("/p", 30);
  assert.ok(server.notifications.forEvolution(e), "项目静音与宠物无关");
  assert.ok(server.notifications.forEvolution(e), "连跳两级是两件事：不走 60s 去重");
  server.notifications.muteGlobal(30);
  assert.equal(server.notifications.forEvolution(e), null, "全局静音 = 什么都别说");
});

/* ---------------- /api/journal ---------------- */

test("HTTP：/api/journal 要 token；返回行（不是文件），按月、按项目短名筛；没有绝对路径", async () => {
  const server = makeServer();
  runSegment(server, "a");
  server.handleEvent(ev({ session_id: "b", project_id: "/Users/bob/other", payload: { source: "startup" } }));
  server.handleEvent(ev({ session_id: "b", project_id: "/Users/bob/other", event_type: "session_finished", payload: {} }));
  server.port = 0;
  await server.start();
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const auth = { headers: { "x-vibepaws-token": server.token } };
    assert.equal((await fetch(`${base}/api/journal`)).status, 401);

    const month = localDayKey(new Date()).slice(0, 7);
    const res = await fetch(`${base}/api/journal`, auth);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { month: string; months: string[]; projects: string[]; entries: JournalEntryView[]; file: string | null };
    assert.equal(body.month, month, "缺省是本地的这个月");
    assert.deepEqual(body.months, [month]);
    assert.deepEqual(body.projects, ["my-app", "other"]);
    assert.equal(body.entries.length, 2);
    assert.equal(body.file, `journal/${month}.md`, "只给相对路径");
    const a = body.entries.find((e) => e.session_id === "a")!;
    assert.equal(a.kind, "session");
    assert.equal(a.segment, 1);
    assert.deepEqual(a.files, ["app.ts", "README.md"]);
    assert.equal(typeof a.score, "number");
    assert.deepEqual(Object.keys(a.factors!), ["context", "focus", "response", "outcome"]);
    const wire = JSON.stringify(body);
    assert.ok(!wire.includes("/Users/") && !wire.includes("alice") && !wire.includes("bob"), "路径与用户名都不出 Core");
    assert.ok(!wire.includes(tmpdir()), "数据目录的绝对路径也不出去");

    const filtered = (await (await fetch(`${base}/api/journal?project=other`, auth)).json()) as { entries: JournalEntryView[] };
    assert.deepEqual(filtered.entries.map((e) => e.project), ["other"]);
    const empty = (await (await fetch(`${base}/api/journal?month=2001-01`, auth)).json()) as { entries: unknown[]; file: null };
    assert.deepEqual([empty.entries.length, empty.file], [0, null]);
    assert.equal((await fetch(`${base}/api/journal?month=2026-9`, auth)).status, 400);
  } finally {
    await server.close();
  }
});

test("parseJournalMonth：缺省本地这个月；形状不对是 null", () => {
  assert.equal(parseJournalMonth(null, new Date(2026, 8, 30, 23, 59)), "2026-09");
  assert.equal(parseJournalMonth("", new Date(2026, 0, 1, 0, 1)), "2026-01");
  assert.equal(parseJournalMonth("2026-12"), "2026-12");
  for (const bad of ["2026-13", "2026-00", "26-09", "2026-9", "../etc", "2026-09.md"]) assert.equal(parseJournalMonth(bad), null, bad);
});

test("renderEntry：一段收工的固定写法（样例，grep 得到分数）", () => {
  const at = new Date(2026, 8, 29, 14, 32).toISOString();
  const text = renderEntry({
    id: 1,
    kind: "session",
    at,
    day: "2026-09-29",
    project: "my-app",
    agent: "claude_code",
    session_id: "s1",
    segment: 2,
    started_at: new Date(2026, 8, 29, 14, 29).toISOString(),
    finished_at: at,
    duration_ms: 3 * MIN,
    outcome: "success",
    score: 82,
    pet_score: 82.7,
    factors: { context: 12, focus: 25, response: 20, outcome: 25 },
    omitted: [],
    evidence: { context_peak: 88, repeat_edits: 0, response_median_ms: 2 * MIN, response_samples: 1, outcome: "success", error_count: 0 },
    files: ["app.ts", "README.md"],
    files_total: 2,
    evolution: null,
  });
  assert.equal(
    text,
    [
      "### 2026-09-29 14:32 · my-app · score 82",
      "",
      "- claude_code · segment 2 · 14:29 → 14:32 (3m)",
      "- context 12 · focus 25 · response 20 · outcome 25",
      "- outcome success · peak context 88% · repeat edits 0 · response median 2m (1 wait) · errors 0",
      "- files: app.ts, README.md",
      "",
    ].join("\n"),
  );
});

test("老库升级：memories 补上日志的列与幂等索引", () => {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE memories (
    id INTEGER PRIMARY KEY, session_id INTEGER, kind TEXT NOT NULL, safe_summary TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  db.prepare("INSERT INTO memories(kind, safe_summary) VALUES('achievement', 'old')").run();
  applySchema(db);
  const cols = (db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>).map((c) => c.name);
  for (const c of ["idem_key", "input_json", "files_json", "rendered_at", "from_form", "health"]) assert.ok(cols.includes(c), c);
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_memories_idem'").get();
  assert.ok(idx, "唯一索引建在补完列之后");
  applySchema(db); // 幂等
  assert.equal((db.prepare("SELECT COUNT(*) c FROM memories").get() as { c: number }).c, 1, "老行还在");
});
