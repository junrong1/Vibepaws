/**
 * Vibepaws UI 静态服务器 — 可复用（npm run ui 与 Electron 桌面壳共用）。
 * 服务 ui/ 静态文件 + 代理 Core API（/api/sse /api/state /api/exp /api/action），避免 CORS。
 */
import { createServer, request as httpRequest, type Server } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, extname, resolve, sep } from "node:path";
import { readApiToken } from "../core/token.ts";

/** 文案目录（src/i18n/messages.js）：Core 与渲染层共用同一份，见 issue #3 / #6。 */
const I18N_FILE = fileURLToPath(new URL("../i18n/messages.js", import.meta.url));

/**
 * 身份标记路由。桌面壳启动时要确认「5173 上的服务是我自己」——
 * 5173 是 Vite 的默认端口，用户手边随时可能有一个前端 dev server 占着它；
 * 只要探测到 200 就加载的话，宠物窗口里会渲染出别人的应用。
 */
const MARKER_PATH = "/__vibepaws";
const MARKER_BODY = JSON.stringify({ service: "vibepaws-ui", version: "0.1.0" });

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

/**
 * 页面在 Electron 里以本地 http 加载，只用到同源脚本/样式与同源 fetch/SSE。
 * 把这条收紧成显式策略：宠物窗口不该有任何理由去连外网。
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
].join("; ");

export interface UiServerOptions {
  uiDir?: string;
  corePort?: number;
  /** 0 = 让系统分配空闲端口（返回值里给出真实端口） */
  port?: number;
  host?: string;
}

export function startUiServer(
  opts: UiServerOptions = {},
): Promise<{ server: Server; port: number; corePort: number }> {
  const uiDir = opts.uiDir ?? join(process.cwd(), "ui");
  const corePort = opts.corePort ?? 17893;
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 5173;

  function coreToken(): string {
    return readApiToken();
  }

  const server = createServer((req, res) => {
    const rawUrl = req.url ?? "/";
    const url = rawUrl.split("?")[0] ?? "/";

    if (url === MARKER_PATH) {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(MARKER_BODY);
      return;
    }

    if (url.startsWith("/api/")) {
      proxyToCore(req, res);
      return;
    }

    // 文案目录不在 ui/ 下（Core 也要 import 它），单独走一条路由
    if (url === "/i18n.js") {
      res.writeHead(200, { "content-type": MIME[".js"] as string, ...staticHeaders(".js") });
      res.end(readFileSync(I18N_FILE));
      return;
    }

    serveStatic(url, res);
  });

  function staticHeaders(ext: string): Record<string, string> {
    const headers: Record<string, string> = {
      "cache-control": "no-store", // 本地文件，宁可每次读盘也别让改动被缓存挡住
      "x-content-type-options": "nosniff",
    };
    if (ext === ".html") headers["content-security-policy"] = CSP;
    return headers;
  }

  function serveStatic(url: string, res: import("node:http").ServerResponse): void {
    // 先解码：`%2e%2e%2f` 这类编码过的穿越要在规范化之前还原，才能被下面的前缀检查拦住
    let rel: string;
    try {
      rel = decodeURIComponent(url === "/" ? "/index.html" : url);
    } catch {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("bad request");
      return;
    }
    if (rel.includes("\0")) {
      res.writeHead(400, { "content-type": "text/plain" });
      res.end("bad request");
      return;
    }
    const uiRoot = resolve(uiDir);
    const filePath = resolve(join(uiRoot, rel));
    if (filePath !== uiRoot && !filePath.startsWith(uiRoot + sep)) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("forbidden");
      return;
    }
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }
    const ext = extname(filePath);
    res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream", ...staticHeaders(ext) });
    res.end(readFileSync(filePath));
  }

  function proxyToCore(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
    const rawUrl = req.url ?? "/";
    const [path = "/", query] = rawUrl.split("?");
    const targetPath = path === "/api/sse" ? "/sse" : path;
    const target = new URL(targetPath + (query ? `?${query}` : ""), `http://127.0.0.1:${corePort}`);
    const headers: Record<string, string> = { "x-vibepaws-token": coreToken() };
    if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"] as string;

    if (targetPath === "/sse") {
      proxySse(req, res, target, headers);
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      fetch(target.toString(), {
        method: req.method ?? "GET",
        headers,
        body: body.length ? body : undefined,
      })
        .then(async (up) => {
          res.writeHead(up.status ?? 502, {
            "content-type": up.headers.get("content-type") ?? "application/json",
            "cache-control": "no-store",
          });
          res.end(await up.text());
        })
        .catch(() => {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "core offline" }));
        });
    });
  }

  /**
   * SSE 代理。
   *
   * 关键约束：回给浏览器的头必须是 200 + text/event-stream。原来的写法在 Core
   * 连不上时直接 `res.end()`，浏览器收到「200 + 没有 content-type」——按 EventSource
   * 规范这叫 fail the connection，它会永久关闭、**不再重连**。于是「Core 启动晚于
   * 宠物窗口」或「Core 重启过一次」之后，通知就再也不会来了；而 5 秒轮询还在成功
   * 刷新 session 列表，连接指示灯照样是绿的，用户完全看不出气泡已经死了。
   *
   * 所以：等上游给出结论再决定响应内容，两条路都以合法 SSE 头收场 ——
   * 通了就转发，不通就发一条 core_offline 并正常结束（正常结束的流会让浏览器
   * 按规范自动重连，Core 一起来就自己接上）。
   */
  function proxySse(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    target: URL,
    headers: Record<string, string>,
  ): void {
    const SSE_HEADERS = {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    };
    /** Core 接了连接却不回响应头（事件循环卡死）的兜底 */
    const UPSTREAM_HEAD_TIMEOUT_MS = 3000;
    /** 连上之后的静默上限。Core 每 15s 发一次心跳，45s 一个字节都没有 = 它卡住了 */
    const UPSTREAM_IDLE_TIMEOUT_MS = 45_000;

    const offline = (status: number): void => {
      if (res.writableEnded) return;
      if (!res.headersSent) res.writeHead(200, SSE_HEADERS);
      res.write(`event: core_offline\ndata: ${JSON.stringify({ status })}\n\n`);
      res.end();
    };

    const up = httpRequest(target, { method: "GET", headers }, (upRes) => {
      up.setTimeout(0); // 头已经到了，换成下面的静默超时
      if ((upRes.statusCode ?? 500) >= 400) {
        // 401/404 等：告诉界面「连上了但被拒」，然后结束本次连接等重连
        upRes.resume();
        offline(upRes.statusCode ?? 500);
        return;
      }
      res.writeHead(200, SSE_HEADERS);
      res.write(": proxy connected\n\n");
      upRes.setTimeout(UPSTREAM_IDLE_TIMEOUT_MS, () => {
        // 静默超时：结束这条流，浏览器会重连；真的卡死就会在下一轮走 offline 分支，
        // 界面于是变成「连不上」，而不是一直亮着绿灯却收不到任何气泡。
        upRes.destroy();
        res.end();
      });
      upRes.pipe(res);
      upRes.on("error", () => res.end());
    });
    up.setTimeout(UPSTREAM_HEAD_TIMEOUT_MS, () => up.destroy());
    up.on("error", () => offline(0));
    // 客户端（页面刷新 / 重连）断开时必须掐掉上游请求，
    // 否则每次重连都会在 Core 那边留下一个永远收不到 close 的 SSE 客户端。
    const abort = (): void => {
      up.destroy();
    };
    req.on("close", abort);
    res.on("close", abort);
    up.end();
  }

  return new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise); // EADDRINUSE 必须让调用方知道，而不是静静地卡住
    server.listen(port, host, () => {
      server.removeListener("error", rejectPromise);
      const actual = (server.address() as { port: number } | null)?.port ?? port;
      // 机器可读的一行：桌面壳从 stdout 里解析真实端口
      console.log(`[vibepaws-ui] listening port=${actual} core=${corePort} url=http://${host}:${actual}`);
      resolvePromise({ server, port: actual, corePort });
    });
  });
}

// CLI 入口：npm run ui
if (import.meta.url === `file://${process.argv[1]}`) {
  const argValue = (name: string): string | undefined => {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const corePort = Number(argValue("core-port") ?? 17893);
  const port = Number(argValue("port") ?? 5173);
  const uiDir = argValue("ui-dir");
  startUiServer({ corePort, port, uiDir }).catch((err: unknown) => {
    console.error(`[vibepaws-ui] 启动失败: ${String(err)}`);
    process.exit(1);
  });
}
