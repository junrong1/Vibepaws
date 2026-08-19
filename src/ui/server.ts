/**
 * Vibepaws UI 静态服务器 — npm run ui
 * 服务 ui/ 静态文件 + 代理 Core API（/api/sse /api/state /api/exp /api/action），避免 CORS。
 */
import { createServer, request as httpRequest } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname, normalize } from "node:path";

const UI_DIR = join(process.cwd(), "ui");
const corePortArg = process.argv.indexOf("--core-port");
const portArg = process.argv.indexOf("--port");
const CORE_PORT = corePortArg >= 0 ? Number(process.argv[corePortArg + 1]) : 17893;
const CORE = `http://127.0.0.1:${CORE_PORT}`;
const UI_PORT = portArg >= 0 ? Number(process.argv[portArg + 1]) : 5173;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function coreToken(): string {
  try {
    return readFileSync(join(process.cwd(), ".vibepaws", "api_token"), "utf-8").trim();
  } catch {
    return "";
  }
}

const server = createServer((req, res) => {
  const url = (req.url ?? "/").split("?")[0] ?? "/";

  if (url.startsWith("/api/")) {
    proxyToCore(req, res);
    return;
  }

  let rel = (url === "/" ? "/index.html" : url) ?? "/index.html";
  const filePath = normalize(join(UI_DIR, rel));
  if (!filePath.startsWith(UI_DIR)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }
  if (!existsSync(filePath)) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  res.writeHead(200, { "content-type": MIME[extname(filePath)] ?? "application/octet-stream" });
  res.end(readFileSync(filePath));
});

function proxyToCore(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
  const url = (req.url ?? "/").split("?")[0] ?? "/";
  // UI 命名空间 → Core 端点映射：/api/sse → /sse，其余 /api/* → /api/*
  const targetPath = url === "/api/sse" ? "/sse" : url;
  const target = new URL(targetPath, CORE);
  const headers: Record<string, string> = {
    "x-vibepaws-token": coreToken(),
  };
  if (req.headers["content-type"]) headers["content-type"] = req.headers["content-type"] as string;

  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    // SSE：流式转发
    if (target.pathname.endsWith("/sse")) {
      const up = httpRequest(
        target,
        { method: "GET", headers },
        (upRes) => {
          res.writeHead(upRes.statusCode ?? 200, {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
          });
          upRes.pipe(res);
        },
      );
      up.on("error", () => res.end());
      up.end();
      return;
    }
    fetch(target.toString(), {
      method: req.method ?? "GET",
      headers,
      body: body.length ? body : undefined,
    })
      .then(async (up) => {
        res.writeHead(up.status ?? 502, {
          "content-type": up.headers.get("content-type") ?? "application/json",
        });
        res.end(await up.text());
      })
      .catch(() => {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "core offline" }));
      });
  });
}

server.listen(UI_PORT, "127.0.0.1", () => {
  console.log(`[vibepaws-ui] http://127.0.0.1:${UI_PORT}  (core → ${CORE})`);
});
