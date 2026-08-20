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
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDb, DATA_DIR } from "../db/migrate.ts";
import { getApiToken } from "./settings.ts";
import { writeApiToken } from "./token.ts";
import { ingestEvent, upsertAgent } from "./ingress.ts";
import { SessionRegistry } from "./registry.ts";
import { NotificationEngine } from "./notifications.ts";
import { ExpEngine, TIRED_HEALTH_THRESHOLD } from "./exp.ts";
import type { CoreEvent, PetState, PetStatePush, SessionView } from "./events.ts";

export interface ServerConfig {
  port?: number;
  host?: string;
  /** 测试用：外部注入 db/引擎 */
  db?: ReturnType<typeof openDb>;
  registry?: SessionRegistry;
  /**
   * 是否把 token 写到 ~/.vibepaws 与 cwd/.vibepaws（hook / simulator 从那里读）。
   * 默认只有「自己开库」的真实 Core 才写 —— 注入 db 的测试/嵌入场景如果也写，
   * 会把用户正在跑的那个 Core 的 token 覆盖掉，真实 hook 从此 401。
   */
  persistToken?: boolean;
}

const DEFAULT_PORT = 17893;
/** SSE 心跳间隔：让死连接尽快暴露，也避免中间层把空闲流掐掉 */
const SSE_PING_MS = 15_000;
/** 状态推送合并窗口：一次工具调用可能连发数条事件，没必要各推一次全量状态 */
const STATE_COALESCE_MS = 80;
/** mute 时长上限（分钟）：24h。没有上限时一次误传就能把通知静音到下个世纪 */
const MAX_MUTE_MINUTES = 24 * 60;

export class VibepawsServer {
  port: number;
  host: string;
  db: ReturnType<typeof openDb>;
  registry: SessionRegistry;
  notifications: NotificationEngine;
  exp: ExpEngine;
  token: string;
  private sseClients = new Set<import("node:http").ServerResponse>();
  private ssePing: ReturnType<typeof setInterval> | null = null;
  private stateFlush: ReturnType<typeof setTimeout> | null = null;
  private httpServer: import("node:http").Server | null = null;

  constructor(cfg: ServerConfig = {}) {
    this.port = cfg.port ?? DEFAULT_PORT;
    this.host = cfg.host ?? "127.0.0.1";
    this.db = cfg.db ?? openDb();
    this.token = getApiToken(this.db);
    // token 双写（cwd/.vibepaws + ~/.vibepaws），供任意 cwd 的 hook/simulator 读取
    if (cfg.persistToken ?? !cfg.db) {
      if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
      writeApiToken(this.token);
    }

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
          // /health 之外全部要 token：/api/* 与 /sse 原来是裸的，任何本机网页都能
          // 读到 session 列表、甚至 POST /api/action 把通知静音掉（用户完全无感）。
          if (!this.authorized(req)) {
            res.writeHead(401, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "unauthorized" }));
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
            res.end(JSON.stringify(this.stateSnapshot()));
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

      this.httpServer = server;
      server.listen(this.port, this.host, () => {
        // port 0（测试/嵌入）时把真实端口写回来，调用方才知道该连哪里
        this.port = (server.address() as { port: number } | null)?.port ?? this.port;
        console.log(`[vibepaws] Core listening on http://${this.host}:${this.port}`);
        console.log(`[vibepaws] API token: ${this.token.slice(0, 8)}… (写入 ${join(DATA_DIR, "api_token")})`);
        resolve();
      });
    });
  }

  private authorized(req: import("node:http").IncomingMessage): boolean {
    const header =
      (req.headers["x-vibepaws-token"] as string) || (req.headers.authorization ?? "").replace(/^Bearer /, "");
    return Boolean(this.token) && header === this.token;
  }

  /** 优雅收摊：断开 SSE、停掉计时器、关掉监听（测试与未来的重启都要用） */
  close(): Promise<void> {
    this.stopSsePing();
    if (this.stateFlush) clearTimeout(this.stateFlush);
    this.stateFlush = null;
    for (const client of [...this.sseClients]) client.end();
    this.sseClients.clear();
    const server = this.httpServer;
    this.httpServer = null;
    return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
  }

  private handlePostEvents(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
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

  /** UI 浮层动作：mute / unmute / dismiss / actioned */
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
        // 时长必须收敛到合理区间：脏值不该变成「静音到下个世纪」或「静音 -5 分钟」
        const m = clampMinutes(minutes);
        const bad = (reason: string): void => {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: reason }));
        };
        switch (action) {
          case "mute":
            this.notifications.muteGlobal(m);
            break;
          case "unmute":
            this.notifications.unmuteGlobal();
            break;
          case "mute_project":
            if (!project_id) return bad("project_id required");
            this.notifications.muteProject(project_id, m);
            break;
          case "unmute_project":
            if (!project_id) return bad("project_id required");
            this.notifications.unmuteProject(project_id);
            break;
          case "mute_session":
            if (!session_id) return bad("session_id required");
            this.notifications.muteSession(session_id, m);
            break;
          case "unmute_session":
            if (!session_id) return bad("session_id required");
            this.notifications.unmuteSession(session_id);
            break;
          case "dismiss":
            if (!Number.isInteger(id)) return bad("id required");
            this.notifications.dismiss(id as number);
            break;
          case "actioned":
            if (!Number.isInteger(id)) return bad("id required");
            this.notifications.actioned(id as number);
            break;
          default:
            return bad("unknown action");
        }
        // 静音状态是 pet_state 的一部分：改完立刻推给界面，按钮不用等下一次轮询
        this.broadcastState();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true, ...this.notifications.muteStatus() }));
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
    const drop = (): void => {
      this.sseClients.delete(res);
      if (this.sseClients.size === 0) this.stopSsePing();
    };
    req.on("close", drop);
    res.on("error", drop); // 对端消失时 write 会报错，别让它冒到 uncaught
    this.startSsePing();
    // 连接即推送当前状态
    this.sendSse(res, "pet_state", this.stateSnapshot());
  }

  /** 心跳：没有它，掉线的连接要等到下一个事件才被发现（可能是几小时后） */
  private startSsePing(): void {
    if (this.ssePing) return;
    this.ssePing = setInterval(() => {
      for (const client of [...this.sseClients]) {
        if (!this.writeSse(client, ": ping\n\n")) this.sseClients.delete(client);
      }
      if (this.sseClients.size === 0) this.stopSsePing();
    }, SSE_PING_MS);
    this.ssePing.unref?.(); // 心跳不该成为进程退不出去的原因
  }

  private stopSsePing(): void {
    if (this.ssePing) clearInterval(this.ssePing);
    this.ssePing = null;
  }

  /** 写一条 SSE 原始帧；对端已断则返回 false（调用方负责摘掉这个 client） */
  private writeSse(res: import("node:http").ServerResponse, frame: string): boolean {
    if (res.writableEnded || res.destroyed) return false;
    try {
      res.write(frame);
      return true;
    } catch {
      return false;
    }
  }

  private sendSse(res: import("node:http").ServerResponse, type: string, data: unknown): void {
    if (!this.writeSse(res, `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)) this.sseClients.delete(res);
  }

  /**
   * 状态推送合并：一次工具调用会连发好几个事件，每个都重算+推送全量状态的话，
   * Core 侧是几百条 SQL，界面侧是连续重绘。合并到一个短窗口里推一次就够。
   */
  broadcastState(): void {
    if (this.stateFlush) return;
    this.stateFlush = setTimeout(() => {
      this.stateFlush = null;
      if (this.sseClients.size === 0) return;
      const push = this.stateSnapshot();
      for (const client of [...this.sseClients]) this.sendSse(client, "pet_state", push);
    }, STATE_COALESCE_MS);
    this.stateFlush.unref?.();
  }

  private broadcastNotification(ev: CoreEvent): void {
    const notif = this.notifications.getForEvent(ev);
    if (!notif) return; // 没有通知就没必要广播「skip」噪音
    for (const client of [...this.sseClients]) this.sendSse(client, "notification", notif);
  }

  /**
   * 宠物聚合状态。原来这里直接用 pets 表里的 state —— 而那一列只会是 idle 或
   * level-up，于是宠物永远是 idle 表情：working/needs-you/warning/finished/tired
   * 全都推不出去，registry.aggregatePetState 成了没人调用的死代码。
   * 优先级：level-up（庆祝）> needs-you > warning > working > finished > tired > idle。
   */
  private derivePetState(petState: PetState, healthScore: number, sessions: SessionView[]): PetState {
    if (petState === "level-up") return "level-up";
    const aggregate = this.registry.aggregatePetState(undefined, sessions);
    if (aggregate !== "idle") return aggregate;
    // 闲下来时才显示「累了」：健康分低说明最近报错/漂移多（README 6.4，无永久死亡）
    return healthScore < TIRED_HEALTH_THRESHOLD ? "tired" : "idle";
  }

  /** 当前聚合状态（/api/state 与 SSE 推送共用；测试直接读它） */
  stateSnapshot(): PetStatePush {
    const pet = this.exp.getPetSnapshot();
    const sessions = this.registry.listSessions();
    return {
      type: "pet_state",
      pet: {
        pet_type_id: pet.pet_type_id,
        name: pet.name ?? "vibepaws",
        level: pet.level,
        exp: pet.exp,
        state: this.derivePetState(pet.state, pet.health_score, sessions),
        health_score: pet.health_score,
        next_level_exp: pet.next_level_exp,
      },
      sessions,
      mute: (({ global_until, global_minutes }) => ({ global_until, global_minutes }))(
        this.notifications.muteStatus(),
      ),
      needs_you: sessions.filter((s) => s.is_active && s.state === "needs-you"),
      warning: sessions.filter((s) => s.is_active && s.state === "warning"),
      working: sessions.filter((s) => s.is_active && s.state === "working"),
      idle: sessions.filter((s) => s.is_active && s.state === "idle"),
    };
  }
}

function clampMinutes(minutes: number | undefined): number {
  const m = Math.round(Number(minutes ?? 30));
  if (!Number.isFinite(m) || m <= 0) return 30;
  return Math.min(m, MAX_MUTE_MINUTES);
}

// CLI 入口：npm run core
if (import.meta.url === `file://${process.argv[1]}`) {
  const portArg = process.argv.findIndex((a) => a === "--port");
  const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : DEFAULT_PORT;
  const server = new VibepawsServer({ port });
  server.start();
}
