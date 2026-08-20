/**
 * UI server 单测：静态服务的边界 + SSE 代理在 Core 不在时的行为。
 *
 * 后者是 issue #9 那类「通知彻底不来了」的根因所在：只要这条流回的头不是
 * 200 + text/event-stream，浏览器的 EventSource 就会永久关闭、不再重连。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { startUiServer } from "./server.ts";

/** 起一个 UI server，corePort 指向一个没人监听的端口（= Core 不在） */
async function withServer(
  fn: (base: string) => Promise<void>,
  corePort = 17_899,
): Promise<void> {
  const { server, port } = await startUiServer({ port: 0, corePort });
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(() => resolve(null)));
  }
}

test("身份标记路由：桌面壳靠它确认端口上的服务是自己（5173 常被 Vite 占用）", async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/__vibepaws`);
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as { service: string }).service, "vibepaws-ui");
  });
});

test("Core 不在时，SSE 仍回 200 + text/event-stream + core_offline（否则浏览器永久放弃重连）", async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/api/sse`);
    assert.equal(r.status, 200, "非 200 会让 EventSource fail the connection —— 不再重连");
    assert.match(r.headers.get("content-type") ?? "", /text\/event-stream/);
    const body = await r.text();
    assert.match(body, /event: core_offline/, "界面要能据此显示「连不上 Core」");
  });
});

test("Core 不在时，普通 API 走 502 而不是挂住", async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/api/state`);
    assert.equal(r.status, 502);
    assert.deepEqual(await r.json(), { error: "core offline" });
  });
});

test("静态服务：目录穿越被拒，未知路径 404", async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.equal((await fetch(`${base}/nope.js`)).status, 404);
    // 编码过的穿越也要拦住（先解码再规范化）
    assert.equal((await fetch(`${base}/%2e%2e%2fpackage.json`)).status, 403);
  });
});

test("index.html 带 CSP 与 nosniff（宠物窗口没有理由连外网）", async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/`);
    assert.match(r.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  });
});
