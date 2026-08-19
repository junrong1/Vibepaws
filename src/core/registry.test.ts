/**
 * Session Registry 单测：source 生命周期（startup/resume/fork/clear/compact）+ 聚合。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { applySchema } from "../db/schema.ts";
import { SessionRegistry, projectShortName } from "./registry.ts";
import type { CoreEvent } from "./events.ts";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function ev(partial: Partial<CoreEvent>): CoreEvent {
  return {
    event_id: partial.event_id ?? `e-${Math.random().toString(36).slice(2)}`,
    seq: 0,
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

test("startup 新建 session", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ payload: { source: "startup", cwd: "/Users/x/my-app" } }));
  const rows = reg.listSessions();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.title, "my-app");
  assert.equal(rows[0]!.is_active, true);
});

test("resume 复用同一 session，不新建", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ payload: { source: "startup" } }));
  reg.handle(ev({ event_type: "session_finished", payload: { reason: "completion", outcome: "success" } }));
  reg.handle(ev({ payload: { source: "resume" } }));
  const rows = reg.listSessions();
  assert.equal(rows.length, 1, "resume 应复用同一 session");
  assert.equal(rows[0]!.is_active, true);
});

test("fork 新建 session 且 parent 指向原 session", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ event_id: "a", session_id: "orig", payload: { source: "startup" } }));
  reg.handle(
    ev({
      event_id: "b",
      session_id: "forked",
      payload: { source: "fork", parent_session_id: "orig" },
    }),
  );
  const rows = reg.listSessions();
  assert.equal(rows.length, 2);
  const forked = rows.find((r) => r.session_id === "forked")!;
  const orig = rows.find((r) => r.session_id === "orig")!;
  // forked 是第二条插入，parent_id 指向第一条（orig）的 id=1
  assert.equal(forked.parent_id, 1);
  assert.equal(orig.outcome, null);
});

test("clear 重置 context/token，不新建", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ payload: { source: "startup" } }));
  reg.handle(ev({ event_type: "token_update", payload: { tokens: 5000 } }));
  reg.handle(ev({ event_type: "context_update", payload: { context_pct: 88 } }));
  reg.handle(ev({ payload: { source: "clear" } }));
  const rows = reg.listSessions();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.token_used, 0);
  assert.equal(rows[0]!.context_pct, 0);
});

test("compact 不新建 session", () => {
  const db = makeDb();
  const reg = new SessionRegistry({ db });
  reg.handle(ev({ payload: { source: "startup" } }));
  reg.handle(ev({ payload: { source: "compact" } }));
  assert.equal(reg.listSessions().length, 1);
});

test("projectShortName 取最后一段", () => {
  assert.equal(projectShortName("/Users/x/my-app/"), "my-app");
  assert.equal(projectShortName("C:\\dev\\proj"), "proj");
});
