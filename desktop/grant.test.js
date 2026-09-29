/**
 * 壳这一侧的「永远允许」（U9 / KTD13）。主进程本身没法在 node 测试里跑，
 * 所以请求怎么拼、什么情况下根本不发，都在 grant.js 里、在这里测。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { GRANT_SECRET_HEADER, newGrantSecret, readCoreToken, requestGrant } from "./grant.js";

function recorder(response = { ok: true, status: 200, body: { ok: true, rule: "Edit", project: "my-app" } }) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: response.ok, status: response.status, json: async () => response.body };
  };
  return { calls, fetchImpl };
}

test("grant secret 是 64 个十六进制字符，每次都不一样", () => {
  const a = newGrantSecret();
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, newGrantSecret());
});

test("请求直连 Core（不经 UI server），带 token + grant 头，body 里只有 id", async () => {
  const { calls, fetchImpl } = recorder();
  const r = await requestGrant({ id: 7, secret: "s".repeat(64), token: "tok", corePort: 17893, fetchImpl });
  assert.deepEqual(r, { ok: true, status: 200, data: { ok: true, rule: "Edit", project: "my-app" }, reason: undefined });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:17893/api/rules/grant");
  assert.equal(calls[0].init.headers[GRANT_SECRET_HEADER], "s".repeat(64));
  assert.equal(calls[0].init.headers["x-vibepaws-token"], "tok");
  assert.deepEqual(JSON.parse(calls[0].init.body), { id: 7 });
});

test("渲染层传来的不是整数 id（对象、字符串、一整条规则）→ 一个请求都不发", async () => {
  for (const id of ["7", { id: 7, rule: "Bash(*)" }, 7.5, null, undefined]) {
    const { calls, fetchImpl } = recorder();
    const r = await requestGrant({ id, secret: "s".repeat(64), token: "tok", corePort: 1, fetchImpl });
    assert.equal(r.ok, false);
    assert.equal(r.reason, "bad_id");
    assert.equal(calls.length, 0);
  }
});

test("手里没有 secret（Core 是 adopted 的 / 还没起来）或没有 token → 不发请求", async () => {
  for (const [secret, token] of [[null, "tok"], ["s".repeat(64), ""]]) {
    const { calls, fetchImpl } = recorder();
    const r = await requestGrant({ id: 1, secret, token, corePort: 1, fetchImpl });
    assert.deepEqual([r.ok, r.reason], [false, "unavailable"]);
    assert.equal(calls.length, 0);
  }
});

test("Core 拒了（403 / 409）或者连不上：ok=false，并带回原因", async () => {
  const { fetchImpl } = recorder({ ok: false, status: 409, body: { error: "destructive" } });
  assert.deepEqual(
    await requestGrant({ id: 1, secret: "s".repeat(64), token: "t", corePort: 1, fetchImpl }),
    { ok: false, status: 409, data: { error: "destructive" }, reason: "destructive" },
  );
  const offline = await requestGrant({
    id: 1, secret: "s".repeat(64), token: "t", corePort: 1,
    fetchImpl: async () => { throw new Error("ECONNREFUSED"); },
  });
  assert.deepEqual([offline.ok, offline.reason], [false, "core_offline"]);
});

test("token 从 Core 的数据目录里读；读不到就是空串", () => {
  const seen = [];
  assert.equal(readCoreToken("/work", (p) => { seen.push(p); return "  tok\n"; }), "tok");
  assert.equal(seen[0], "/work/.vibepaws/api_token");
  assert.equal(readCoreToken("/work", () => { throw new Error("ENOENT"); }), "");
});
