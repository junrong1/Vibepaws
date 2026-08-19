/**
 * Vibepaws Core 服务器 — 架构 D5：独立守护进程，UI 只是客户端。
 * 端点：
 *   GET  /health           健康检查
 *   POST /events           收事件（X-Vibepaws-Token 校验 + ingestEvent）
 *   GET  /sse              事件流（pet_state / notification / event 三类推送）
 *   GET  /api/state        当前聚合状态 JSON
 *   GET  /api/sessions     全部 session 视图
 *   GET  /api/exp          宠物 EXP/等级
 */
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDb, DATA_DIR } from "../db/migrate.ts";
import { getApiToken } from "./settings.ts";
import { writeApiToken } from "./token.ts";
import { ingestEvent, upsertAgent } from "./ingress.ts";
import { SessionRegistry } from "./registry.ts";
import { NotificationEngine } from "./notifications.ts";
import { ExpEngine } from "./exp.ts";
import type { CoreEvent, PetStatePush } from "./events.ts";

export interface ServerConfig {
  port?: number;
  host?: string;
  /** 测试用：外部注入 db/引擎 */
  db?: ReturnType<typeof openDb>;
  registry?: SessionRegistry;
}

const DEFAULT_PORT = 17893;

export class VibepawsServer {
  port: number;
  host: string;
  db: ReturnType<typeof openDb>;
  registry: SessionRegistry;
  notifications: NotificationEngine;
  exp: ExpEngine;
  token: string;
  private sseClients = new Set<import("node:http").ServerResponse>();

  constructor(cfg: ServerConfig = {}) {
    this.port = cfg.port ?? DEFAULT_PORT;
    this.host = cfg.host ?? "127.0.0.1";
    this.db = cfg.db ?? openDb();
    this.token = getApiToken(this.db);
    // token 双写（cwd/.vibepaws + ~/.vibepaws），供任意 cwd 的 hook/simulator 读取
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeApiToken(this.token);

    this.notifications = new NotificationEngine(this.db);
    this.exp = new ExpEngine(this.db);
    this.registry = cfg.registry ?? new SessionRegistry({ db: this.db, onUpdate: () => this.broadcastState() });

    // 事件分发链：ingress → registry → notifications/exp → SSE
    this.notifications.onEvent = (ev: CoreEvent) => {
      this.registry.handle(ev);
      this.exp.handle(ev);
      this.broadcastNotification(ev);
    };
  }

  /** 事件入口（HTTP 与 simulator 共用） */
  handleEvent(ev: CoreEvent): { ok: boolean; code?: number; reason?: string } {
    const r = ingestEvent(ev, { db: this.db, onEvent: this.notifications.onEvent });
    if (r.ok && ev.event_type === "adapter_status") {
      upsertAgent(this.db, ev);
    }
    return r;
  }

  start(): Promise<void> {
    return new Promise((resolve) => {
      const server = createServer((req, res) => {
        const url = (req.url ?? "/").split("?")[0];
        try {
          if (url === "/health") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ok: true, service: "vibepaws-core", version: "0.1.0", time: new Date().toISOString() }));
            return;
          }
          if (url === "/events" && req.method === "POST") {
            this.handlePostEvents(req, res);
            return;
          }
          if (url === "/sse") {
            this.handleSse(req, res);
            return;
          }
          if (url === "/api/state") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(this.buildStatePush()));
            return;
          }
          if (url === "/api/sessions") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ sessions: this.registry.listSessions() }));
            return;
          }
          if (url === "/api/exp") {
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ ...this.exp.getPetSnapshot(), logs: this.exp.expLogs() }));
            return;
          }
          if (url === "/api/action" && req.method === "POST") {
            this.handleAction(req, res);
            return;
          }
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "not found" }));
        } catch (err) {
          console.error("[server] handler error:", err);
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "internal" }));
        }
      });

      server.listen(this.port, this.host, () => {
        console.log(`[vibepaws] Core listening on http://${this.host}:${this.port}`);
        console.log(`[vibepaws] API token: ${this.token.slice(0, 8)}… (写入 ${join(DATA_DIR, "api_token")})`);
        resolve();
      });
    });
  }

  private handlePostEvents(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
    const header = (req.headers["x-vibepaws-token"] as string) || (req.headers.authorization ?? "").replace(/^Bearer /, "");
    if (header !== this.token) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const parsed = JSON.parse(body);
        const r = this.handleEvent(parsed);
        res.writeHead(r.ok ? 200 : (r.code ?? 400), { "content-type": "application/json" });
        res.end(JSON.stringify(r.ok ? { ok: true, reason: r.reason ?? "ok" } : { error: r.reason }));
      } catch (err) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid json" }));
      }
    });
  }

  /** UI 浮层动作：mute / dismiss / actioned */
  private handleAction(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        const { action, minutes, project_id, session_id, id } = JSON.parse(body) as {
          action?: string;
          minutes?: number;
          project_id?: string;
          session_id?: string;
          id?: number;
        };
        const m = minutes ?? 30;
        switch (action) {
          case "mute":
            this.notifications.muteGlobal(m);
            break;
          case "mute_project":
            if (project_id) this.notifications.muteProject(project_id, m);
            break;
          case "mute_session":
            if (session_id) this.notifications.muteSession(session_id, m);
            break;
          case "dismiss":
            if (id) this.notifications.dismiss(id);
            break;
          default:
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "unknown action" }));
            return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "bad body" }));
      }
    });
  }

  private handleSse(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");
    this.sseClients.add(res);
    req.on("close", () => this.sseClients.delete(res));
    // 连接即推送当前状态
    this.sendSse(res, "pet_state", this.buildStatePush());
  }

  private sendSse(res: import("node:http").ServerResponse, type: string, data: unknown): void {
    res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  broadcastState(): void {
    const push = this.buildStatePush();
    for (const client of this.sseClients) this.sendSse(client, "pet_state", push);
  }

  private broadcastNotification(ev: CoreEvent): void {
    const notif = this.notifications.getForEvent(ev);
    for (const client of this.sseClients) this.sendSse(client, "notification", notif ?? { skip: true, event: ev.event_type });
  }

  private buildStatePush(): PetStatePush {
    const pet = this.exp.getPetSnapshot();
    const sessions = this.registry.listSessions();
    return {
      type: "pet_state",
      pet: {
        pet_type_id: pet.pet_type_id,
        name: pet.name ?? "vibepaws",
        level: pet.level,
        exp: pet.exp,
        state: pet.state,
        health_score: pet.health_score,
      },
      sessions,
      needs_you: sessions.filter((s) => s.is_active && s.state === "needs-you"),
      warning: sessions.filter((s) => s.is_active && s.state === "warning"),
      working: sessions.filter((s) => s.is_active && s.state === "working"),
      idle: sessions.filter((s) => s.is_active && s.state === "idle"),
    };
  }
}

// CLI 入口：npm run core
if (import.meta.url === `file://${process.argv[1]}`) {
  const portArg = process.argv.findIndex((a) => a === "--port");
  const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : DEFAULT_PORT;
  const server = new VibepawsServer({ port });
  server.start();
  void readFileSync;
}
