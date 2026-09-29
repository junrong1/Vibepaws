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

test("设置窗口的页面与它的样式表都在同一个 server 上（浏览器预览也能改设置）", async () => {
  await withServer(async (base) => {
    const page = await fetch(`${base}/settings.html`);
    assert.equal(page.status, 200);
    // 同一条 CSP：settings.css / settings.js / i18n.js 全是同源，页面不需要外网
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    for (const asset of ["/settings.css", "/settings.js", "/i18n.js"]) {
      assert.equal((await fetch(base + asset)).status, 200, `${asset} 必须能加载，否则设置窗口是一张白纸`);
    }
  });
});

test("Den 的页面与它的脚本、样式都在同一个 server 上，而且页面里没有内联脚本 / 样式（CSP 会挡掉）", async () => {
  await withServer(async (base) => {
    const page = await fetch(`${base}/den.html`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    const html = await page.text();
    // script-src 'self' / style-src 'self'，没有 'unsafe-inline'：内联的一行都跑不起来，页面就是一张白纸
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), "den.html 里有内联 <script>");
    assert.ok(!/<style[\s>]/i.test(html), "den.html 里有内联 <style>");
    assert.ok(!/\sstyle=/i.test(html), "den.html 里有 style 属性");
    for (const asset of ["/den.css", "/den.js", "/health/den.js", "/i18n.js"]) {
      assert.equal((await fetch(base + asset)).status, 200, `${asset} 必须能加载，否则 Den 是一张白纸`);
    }
  });
});

/* ---------------- 永远允许（KTD13）：代理绝不是通往授予的一条路 ---------------- */

/** 一个假的 Core：只记下它收到了什么，回 200 */
async function fakeCore(): Promise<{ port: number; seen: Array<{ url: string; headers: Record<string, unknown> }>; close: () => Promise<void> }> {
  const { createServer } = await import("node:http");
  const seen: Array<{ url: string; headers: Record<string, unknown> }> = [];
  const srv = createServer((req, res) => {
    seen.push({ url: req.url ?? "", headers: { ...req.headers } });
    req.resume();
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as { port: number }).port;
  return { port, seen, close: () => new Promise((r) => srv.close(() => r())) };
}

test("代理不转发 X-Vibepaws-Grant：调用方自己带上的也会被丢掉，只剩 token 与 content-type", async () => {
  const core = await fakeCore();
  try {
    await withServer(async (base) => {
      const r = await fetch(`${base}/api/action`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-vibepaws-grant": "f".repeat(64), authorization: "Bearer forged" },
        body: JSON.stringify({ action: "dismiss", id: 1 }),
      });
      assert.equal(r.status, 200);
    }, core.port);
    assert.equal(core.seen.length, 1);
    const h = core.seen[0]!.headers;
    assert.equal(h["x-vibepaws-grant"], undefined, "grant 头永远不经过这个代理");
    assert.equal(h.authorization, undefined);
    assert.ok("x-vibepaws-token" in h);
  } finally {
    await core.close();
  }
});

test("代理直接拒绝授予路由（大小写、结尾斜杠、编码过的写法都算），Core 根本收不到这个请求", async () => {
  const core = await fakeCore();
  try {
    await withServer(async (base) => {
      for (const path of ["/api/rules/grant", "/api/RULES/Grant", "/api/rules/grant/", "/api/rules/%67rant", "/api/rules/grant?x=1"]) {
        const r = await fetch(base + path, {
          method: "POST",
          headers: { "content-type": "application/json", "x-vibepaws-grant": "f".repeat(64) },
          body: JSON.stringify({ id: 1 }),
        });
        assert.equal(r.status, 403, path);
      }
      // 列表与撤销照常代理：收回权限在浏览器预览里也要能做
      assert.equal((await fetch(`${base}/api/rules`)).status, 200);
    }, core.port);
    assert.deepEqual(core.seen.map((s) => s.url), ["/api/rules"]);
  } finally {
    await core.close();
  }
});
