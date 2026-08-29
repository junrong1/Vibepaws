/**
 * 僵尸 session 回收单测（G10）。
 *
 * 这套用例里最重要的不是「僵尸会被收掉」，而是**活着的 session 不会被错杀** ——
 * 一个把正在干活的会话判死的回收器，比没有回收器糟得多。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema.ts";
import {
  isProcessAlive,
  notePid,
  reclaimZombies,
  LIVENESS_GRACE_MS,
  DEFAULT_ZOMBIE_TIMEOUT_MIN,
} from "./reclaim.ts";

const NOW = Date.parse("2026-08-25T12:00:00.000Z");
const TIMEOUT_MS = DEFAULT_ZOMBIE_TIMEOUT_MIN * 60_000;

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

interface SeedSession {
  sessionId?: string;
  /** 静默了多久（毫秒） */
  idleMs?: number;
  pid?: number | null;
  confirmed?: boolean;
  active?: boolean;
  needsInputSince?: string | null;
  lastEventAt?: string;
}

function seedSession(db: Database.Database, s: SeedSession = {}): string {
  const sessionId = s.sessionId ?? "s1";
  const lastEventAt = s.lastEventAt ?? new Date(NOW - (s.idleMs ?? 0)).toISOString();
  db.prepare(
    `INSERT INTO sessions(agent, agent_session_id, project_id, title, is_active,
                          last_event_at, started_at, needs_input_since, agent_pid, agent_pid_confirmed)
     VALUES('claude_code', ?, '/p/app', 'app', ?, ?, ?, ?, ?, ?)`,
  ).run(
    sessionId,
    s.active === false ? 0 : 1,
    lastEventAt,
    lastEventAt,
    s.needsInputSince ?? null,
    s.pid ?? null,
    s.confirmed ? 1 : 0,
  );
  return sessionId;
}

function row(db: Database.Database, sessionId = "s1"): Record<string, unknown> {
  return db.prepare("SELECT * FROM sessions WHERE agent_session_id=?").get(sessionId) as Record<string, unknown>;
}

const dead = (): number => {
  // 已经退出并被 spawnSync 收尸的进程：它的 pid 一定不存在了。
  // 写死一个「大概没人用」的 pid 才是不可靠的 —— 那个 pid 可能真的属于某个进程。
  const r = spawnSync(process.execPath, ["-e", ""]);
  return r.pid as number;
};

/* ---------------- 探活本身 ---------------- */

test("isProcessAlive：自己活着，已退出的子进程是死的", () => {
  assert.equal(isProcessAlive(process.pid), true);
  assert.equal(isProcessAlive(dead()), false);
});

test("isProcessAlive：不可判定的 pid 一律当活着（未知 ≠ 可以回收）", () => {
  assert.equal(isProcessAlive(0), true);
  assert.equal(isProcessAlive(-1), true);
  assert.equal(isProcessAlive(1.5), true);
  assert.equal(isProcessAlive(1), true); // init/launchd：没意义的 pid，不当依据
});

/* ---------------- pid 的记录与确认 ---------------- */

test("notePid：第一次只记不信，同一个 pid 再来一次才算确认", () => {
  const db = makeDb();
  seedSession(db);
  notePid(db, "claude_code", "s1", 4242);
  assert.equal(row(db).agent_pid, 4242);
  assert.equal(row(db).agent_pid_confirmed, 0, "第一次见到的 pid 可能是一闪而过的包装 shell");

  notePid(db, "claude_code", "s1", 4242);
  assert.equal(row(db).agent_pid_confirmed, 1, "同一个 pid 出现两次 = 它是常驻的 agent 进程");
});

test("notePid：pid 每次都变（包装 shell 的特征）→ 永远确认不了", () => {
  const db = makeDb();
  seedSession(db);
  for (const pid of [100, 101, 102, 103]) notePid(db, "claude_code", "s1", pid);
  assert.equal(row(db).agent_pid, 103);
  assert.equal(row(db).agent_pid_confirmed, 0);
});

test("notePid：没带 pid 的事件不能擦掉已确认的结论", () => {
  const db = makeDb();
  seedSession(db);
  notePid(db, "claude_code", "s1", 555);
  notePid(db, "claude_code", "s1", 555);
  for (const junk of [undefined, null, "555", 0, -3, 1, 2.5]) {
    notePid(db, "claude_code", "s1", junk);
  }
  assert.equal(row(db).agent_pid, 555);
  assert.equal(row(db).agent_pid_confirmed, 1);
});

/* ---------------- 静默超时 ---------------- */

test("刚活动过的 session 不动它", () => {
  const db = makeDb();
  seedSession(db, { idleMs: 30_000 });
  assert.deepEqual(reclaimZombies(db, { now: NOW, timeoutMs: TIMEOUT_MS }), []);
  assert.equal(row(db).is_active, 1);
});

test("静默超过阈值 → 收成 timeout", () => {
  const db = makeDb();
  seedSession(db, { idleMs: TIMEOUT_MS + 1000 });
  const reclaimed = reclaimZombies(db, { now: NOW, timeoutMs: TIMEOUT_MS });
  assert.equal(reclaimed.length, 1);
  assert.equal(reclaimed[0]!.outcome, "timeout");
  assert.equal(reclaimed[0]!.session_id, "s1");
  const r = row(db);
  assert.equal(r.is_active, 0);
  assert.equal(r.outcome, "timeout");
  assert.equal(r.finished_at, new Date(NOW).toISOString());
});

test("阈值可配：调短之后同一个 session 就该被收掉", () => {
  const db = makeDb();
  seedSession(db, { idleMs: 3 * 60_000 });
  assert.deepEqual(reclaimZombies(db, { now: NOW, timeoutMs: TIMEOUT_MS }), []);
  const reclaimed = reclaimZombies(db, { now: NOW, timeoutMs: 2 * 60_000 });
  assert.equal(reclaimed.length, 1);
});

test("回收时清掉「等你」标记：resume 回来不该带着三小时前的告警复活", () => {
  const db = makeDb();
  const since = new Date(NOW - TIMEOUT_MS - 5000).toISOString();
  seedSession(db, { idleMs: TIMEOUT_MS + 1000, needsInputSince: since });
  reclaimZombies(db, { now: NOW, timeoutMs: TIMEOUT_MS });
  assert.equal(row(db).needs_input_since, null);
  assert.equal(row(db).needs_input_kind, null);
});

test("回收时清掉 ready 标记：resume 回来不该带着旧一轮的待命复活", () => {
  const db = makeDb();
  seedSession(db, { idleMs: TIMEOUT_MS + 1000 });
  db.prepare("UPDATE sessions SET ready_since = ?").run(new Date(NOW - 1000).toISOString());
  reclaimZombies(db, { now: NOW, timeoutMs: TIMEOUT_MS });
  assert.equal(row(db).ready_since, null);
});

test("回收顺带撤掉还挂着的气泡（orphan cleanup）", () => {
  const db = makeDb();
  seedSession(db, { idleMs: TIMEOUT_MS + 1000 });
  const insert = db.prepare(
    `INSERT INTO notifications(agent, session_id, type, title, body, status)
     VALUES('claude_code', 's1', ?, 't', 'b', ?)`,
  );
  insert.run("decision", "shown");
  insert.run("context", "shown");
  insert.run("error", "dismissed");
  // 别的 session 的气泡不该被连坐
  db.prepare(
    `INSERT INTO notifications(agent, session_id, type, title, body, status)
     VALUES('claude_code', 'other', 'decision', 't', 'b', 'shown')`,
  ).run();

  reclaimZombies(db, { now: NOW, timeoutMs: TIMEOUT_MS });
  const shown = db
    .prepare("SELECT session_id FROM notifications WHERE status='shown'")
    .all() as Array<{ session_id: string }>;
  assert.deepEqual(shown.map((n) => n.session_id), ["other"]);
});

test("已经结束的 session 不再被碰（outcome 不会被覆写成 timeout）", () => {
  const db = makeDb();
  seedSession(db, { idleMs: 10 * TIMEOUT_MS, active: false });
  db.prepare("UPDATE sessions SET outcome='success' WHERE agent_session_id='s1'").run();
  assert.deepEqual(reclaimZombies(db, { now: NOW, timeoutMs: TIMEOUT_MS }), []);
  assert.equal(row(db).outcome, "success");
});

test("坏时间戳与未来时间戳都不构成回收理由", () => {
  const db = makeDb();
  seedSession(db, { sessionId: "bad", lastEventAt: "not-a-date" });
  seedSession(db, { sessionId: "future", lastEventAt: new Date(NOW + 3_600_000).toISOString() });
  assert.deepEqual(reclaimZombies(db, { now: NOW, timeoutMs: TIMEOUT_MS }), []);
  assert.equal(row(db, "bad").is_active, 1);
  assert.equal(row(db, "future").is_active, 1);
});

/* ---------------- 进程探活 ---------------- */

test("确认过的 pid 死了 → 不等静默超时，直接收成 orphaned", () => {
  const db = makeDb();
  seedSession(db, { idleMs: LIVENESS_GRACE_MS + 1000, pid: 777, confirmed: true });
  const reclaimed = reclaimZombies(db, { now: NOW, timeoutMs: TIMEOUT_MS, isAlive: () => false });
  assert.equal(reclaimed.length, 1);
  assert.equal(reclaimed[0]!.outcome, "orphaned");
  assert.equal(row(db).is_active, 0);
});

test("**没确认过**的 pid 死了也不许动它 —— 那可能是包装 shell，session 还在干活", () => {
  const db = makeDb();
  seedSession(db, { idleMs: LIVENESS_GRACE_MS + 1000, pid: 777, confirmed: false });
  assert.deepEqual(reclaimZombies(db, { now: NOW, timeoutMs: TIMEOUT_MS, isAlive: () => false }), []);
  assert.equal(row(db).is_active, 1);
});

test("确认过的 pid 死了，但还在探活宽限期内 → 再等一轮", () => {
  const db = makeDb();
  seedSession(db, { idleMs: LIVENESS_GRACE_MS - 1000, pid: 777, confirmed: true });
  assert.deepEqual(reclaimZombies(db, { now: NOW, timeoutMs: TIMEOUT_MS, isAlive: () => false }), []);
  assert.equal(row(db).is_active, 1);
});

test("pid 还活着 → 只走静默超时那条路（pid 复用只会让回收变慢，不会错杀）", () => {
  const db = makeDb();
  seedSession(db, { sessionId: "quiet", idleMs: TIMEOUT_MS + 1000, pid: 777, confirmed: true });
  seedSession(db, { sessionId: "busy", idleMs: 60_000, pid: 778, confirmed: true });
  const reclaimed = reclaimZombies(db, { now: NOW, timeoutMs: TIMEOUT_MS, isAlive: () => true });
  assert.deepEqual(reclaimed.map((r) => [r.session_id, r.outcome]), [["quiet", "timeout"]]);
  assert.equal(row(db, "busy").is_active, 1);
});

/* ---------------- 不结算 EXP ---------------- */

test("回收不发 EXP：崩溃不该被结算成一次成功的收工", () => {
  const db = makeDb();
  seedSession(db, { idleMs: TIMEOUT_MS + 1000, pid: 777, confirmed: true });
  reclaimZombies(db, { now: NOW, timeoutMs: TIMEOUT_MS, isAlive: () => false });
  const logs = db.prepare("SELECT COUNT(*) AS n FROM exp_logs").get() as { n: number };
  assert.equal(logs.n, 0);
  // outcome 也必须落在 outcomeBonus() 给 0 分的那一边
  assert.ok(["orphaned", "timeout"].includes(row(db).outcome as string));
});
