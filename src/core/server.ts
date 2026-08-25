/**
 * Vibepaws Core 服务器 — 架构 D5：独立守护进程，UI 只是客户端。
 * 端点：
 *   GET  /health           健康检查
 *   POST /events           收事件（X-Vibepaws-Token 校验 + ingestEvent）
 *   GET  /sse              事件流（pet_state / notification / event 三类推送）
 *   GET  /api/state        当前聚合状态 JSON
 *   GET  /api/sessions     全部 session 视图
 *   GET  /api/exp          宠物 EXP/等级
 *   GET  /api/hookstats    采集通道开销（字节 / 延迟 / 恒为 0 的模型调用，见 core/hookstats.ts）
 *   GET  /api/settings     设置窗口的全部数据（可调项 + 取值范围 + 宠物 + 活跃 session）
 *   POST /api/settings     改设置（宠物名 / 预算 / 阈值 / 每日上限）
 *   POST /api/session      改单个 session 的 goal / budget_tokens
 *   GET  /api/reset        重置预览（本地数据足迹：行数 + 库文件大小）
 *   POST /api/reset        重置本地数据（scope=pet|data，需要 confirm）
 *   GET  /api/uninstall    卸载预览（哪些 agent 配置里还留着我们的 hooks）
 *   POST /api/uninstall    移除 adapter hooks（需要 confirm；dry_run 只算不写）
 *
 * 后台循环：僵尸 session 回收（G10，见 core/reclaim.ts）—— 启动时一次 + 60s 一轮。
 */
import { createServer } from "node:http";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { openDb, DATA_DIR } from "../db/migrate.ts";
import {
  getApiToken,
  readSettings,
  applySettingsPatch,
  parseSettingsPatch,
  parseSessionPatch,
  getZombieTimeoutMin,
  SETTINGS_LIMITS,
  DEFAULT_BUDGET_TOKENS,
  DEFAULT_DAILY_EXP_CAP,
  DEFAULT_CONTEXT_WARN_PCTS,
  DEFAULT_ZOMBIE_TIMEOUT_MIN,
  type VibepawsSettings,
} from "./settings.ts";
import { reclaimZombies, SWEEP_INTERVAL_MS, type ReclaimedSession } from "./reclaim.ts";
import { HookMeter, hookMsOf, type HookStats } from "./hookstats.ts";
import { writeApiToken } from "./token.ts";
import { dataFootprint, resetLocalData, type ResetScope } from "./reset.ts";
import {
  scan as scanAdapters,
  uninstallAdapters,
  type UninstallAgent,
  type HookTarget,
} from "../adapters/uninstall.ts";
import { ingestEvent, upsertAgent } from "./ingress.ts";
import { SessionRegistry } from "./registry.ts";
import { NotificationEngine } from "./notifications.ts";
import { ExpEngine, TIRED_HEALTH_THRESHOLD } from "./exp.ts";
import type { AdapterView, AgentId, CoreEvent, PetState, PetStatePush, SessionView } from "./events.ts";

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
  /**
   * 扫 adapter 配置时当作「项目级」的目录。安装器用的是它自己的 cwd，
   * 所以默认对齐 process.cwd()。
   */
  repoRoot?: string;
  /**
   * 用户级配置的根（默认真实 home）。**测试必须传**：/api/uninstall 会同时清
   * 项目级与用户级，只换掉 repoRoot 的测试照样会去卸开发机上真实的全局 hooks。
   */
  home?: string;
}

const DEFAULT_PORT = 17893;
/** SSE 心跳间隔：让死连接尽快暴露，也避免中间层把空闲流掐掉 */
const SSE_PING_MS = 15_000;
/** 状态推送合并窗口：一次工具调用可能连发数条事件，没必要各推一次全量状态 */
const STATE_COALESCE_MS = 80;
/** mute 时长上限（分钟）：24h。没有上限时一次误传就能把通知静音到下个世纪 */
const MAX_MUTE_MINUTES = 24 * 60;
/** 请求体上限：这些端点收的都是几十字节的小 JSON，没有理由为任何一方缓冲兆级数据 */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * 采集通道开销 + 它的自证方式。
 *
 * `endpoint` 是给界面用的：那一段文案的重点是「别信这扇窗口，自己 curl 一下」，
 * 而页面并不知道 Core 落在哪个端口上（打包版是动态的）。
 */
export interface HookStatsView extends HookStats {
  endpoint: string;
}

/** 设置窗口一次拿全的数据（GET /api/settings 与 POST 的响应共用） */
export interface SettingsView {
  settings: VibepawsSettings;
  /** 取值范围与默认值：界面拿它设 input 的 min/max，不必再抄一份常量 */
  limits: typeof SETTINGS_LIMITS;
  defaults: {
    budget_tokens: number;
    daily_exp_cap: number;
    context_warn_pcts: number[];
    zombie_timeout_min: number;
  };
  pet: {
    name: string;
    custom_name: string | null;
    species: string | null;
    level: number;
    exp: number;
    next_level_exp: number;
  };
  /** 只给活跃 session：给一个已经结束的 session 设目标/预算没有任何意义 */
  sessions: SessionView[];
  /** 采集通道开销。跟着设置窗口的 5 秒轮询走，界面不必为它多发一次请求 */
  hooks: HookStatsView;
}

export class VibepawsServer {
  port: number;
  host: string;
  db: ReturnType<typeof openDb>;
  registry: SessionRegistry;
  notifications: NotificationEngine;
  exp: ExpEngine;
  /** 采集通道开销计量（landscape 0.12）：每次 POST /events 记一条 */
  hookMeter = new HookMeter();
  token: string;
  repoRoot: string;
  home: string;
  private sseClients = new Set<import("node:http").ServerResponse>();
  private ssePing: ReturnType<typeof setInterval> | null = null;
  private stateFlush: ReturnType<typeof setTimeout> | null = null;
  private zombieSweep: ReturnType<typeof setInterval> | null = null;
  private httpServer: import("node:http").Server | null = null;

  constructor(cfg: ServerConfig = {}) {
    this.port = cfg.port ?? DEFAULT_PORT;
    this.host = cfg.host ?? "127.0.0.1";
    this.db = cfg.db ?? openDb();
    this.repoRoot = cfg.repoRoot ?? process.cwd();
    this.home = cfg.home ?? homedir();
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
          // 采集通道开销（landscape 0.12）。文案说「自己 curl 一下」，
          // 所以它必须是一条独立可读的路由，而不只是设置窗口里的一段字。
          if (url === "/api/hookstats") {
            sendJson(res, 200, this.hookStatsSnapshot());
            return;
          }
          if (url === "/api/action" && req.method === "POST") {
            this.handleAction(req, res);
            return;
          }
          if (url === "/api/settings") {
            if (req.method === "POST") this.handleSettingsPatch(req, res);
            else sendJson(res, 200, this.settingsSnapshot());
            return;
          }
          if (url === "/api/session" && req.method === "POST") {
            this.handleSessionPatch(req, res);
            return;
          }
          // 危险区。写操作都在 token 之后、且额外要一个显式 confirm ——
          // 本机任何网页都能 fetch 到这个端口，「删除全部数据」不该是一次
          // 拼错的 URL 就能触发的事。
          if (url === "/api/reset") {
            if (req.method === "POST") this.handleReset(req, res);
            else sendJson(res, 200, { footprint: dataFootprint(this.db) });
            return;
          }
          if (url === "/api/uninstall") {
            if (req.method === "POST") this.handleUninstall(req, res);
            else sendJson(res, 200, this.uninstallSnapshot());
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
      // 起来的第一件事就是扫一遍（G10）：上一次 Core 退出时还 is_active=1 的那些
      // session，绝大多数已经随着它们的 agent 一起没了。等 60 秒才扫的话，用户
      // 打开 App 看到的第一屏是一堆幻影会话，宠物还在为它们「工作」。
      this.sweepZombies();
      this.startZombieSweep();
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

  /**
   * 僵尸 session 回收（G10）。60s 一轮 + 启动时一次。
   *
   * 这是 `SessionEnd` 收不到时唯一的退出边：`kill -9`、崩溃、合盖睡一晚、
   * 直接关掉终端窗口，都不会有任何事件告诉 Core「结束了」。
   * 返回被回收的 session（测试与日志用）。
   */
  sweepZombies(): ReclaimedSession[] {
    let reclaimed: ReclaimedSession[] = [];
    try {
      reclaimed = reclaimZombies(this.db, { timeoutMs: getZombieTimeoutMin(this.db) * 60_000 });
    } catch (err) {
      // sweep 是后台计时器：它抛出去就是 uncaught exception，整个 Core 陪它一起死。
      // 一轮扫不动远好于 Core 挂掉 —— 下一轮 60 秒后自己会再来。
      console.error("[vibepaws] zombie sweep failed:", err);
      return [];
    }
    if (reclaimed.length === 0) return reclaimed;
    for (const s of reclaimed) {
      console.log(
        `[vibepaws] reclaimed ${s.agent}/${s.session_id} as ${s.outcome} ` +
          `(silent ${Math.round(s.idle_ms / 60_000)}m)`,
      );
    }
    // 宠物的聚合状态刚变了（可能正是从「需要你」松开）—— 别等下一个事件才告诉界面
    this.broadcastState();
    return reclaimed;
  }

  private startZombieSweep(): void {
    if (this.zombieSweep) return;
    this.zombieSweep = setInterval(() => this.sweepZombies(), SWEEP_INTERVAL_MS);
    this.zombieSweep.unref?.(); // 后台清理不该成为进程退不出去的原因
  }

  /** 优雅收摊：断开 SSE、停掉计时器、关掉监听（测试与未来的重启都要用） */
  close(): Promise<void> {
    this.stopSsePing();
    if (this.zombieSweep) clearInterval(this.zombieSweep);
    this.zombieSweep = null;
    if (this.stateFlush) clearTimeout(this.stateFlush);
    this.stateFlush = null;
    for (const client of [...this.sseClients]) client.end();
    this.sseClients.clear();
    const server = this.httpServer;
    this.httpServer = null;
    return new Promise((resolve) => (server ? server.close(() => resolve()) : resolve()));
  }

  private handlePostEvents(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
    // 计时从进入处理器开始（含读 body），到响应写完为止 —— 这一段正是 hook 在等的东西
    const startedAt = process.hrtime.bigint();
    readJsonBody(req, res, "invalid json", (parsed, bytes) => {
      // ingestEvent 自己会校验信封与白名单：这里不必先信任 body 的形状
      const r = this.handleEvent(parsed as CoreEvent);
      sendJson(res, r.ok ? 200 : (r.code ?? 400), r.ok ? { ok: true, reason: r.reason ?? "ok" } : { error: r.reason });
      // 被拒的事件也算：它照样花了 hook 的字节与毫秒，
      // 只报成功的那部分会让这个面板显得比真相好看。
      this.hookMeter.record({
        bytes,
        coreMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
        hookMs: hookMsOf(parsed),
      });
    });
  }

  /**
   * 设置窗口的写入口。校验先全部做完再落库：一份 patch 里有个读不成的值时，
   * 不该有一半设置已经生效了 —— 那种「部分成功」在界面上完全看不出来。
   */
  private handleSettingsPatch(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): void {
    readJsonBody(req, res, "bad body", (body) => {
      const parsed = parseSettingsPatch(body);
      if (parsed.invalid.length > 0) {
        sendJson(res, 400, { error: "invalid settings", fields: parsed.invalid });
        return;
      }
      const changed = applySettingsPatch(this.db, parsed.settings);
      if (parsed.pet_name !== undefined) {
        this.exp.renamePet(parsed.pet_name);
        changed.push("pet_name");
      }
      // 改完阈值/预算要重新武装闩锁，否则新设置要等下一个 session 才看得见效果
      if (changed.includes("context_warn_pcts")) this.notifications.resetLatches("context");
      if (changed.includes("budget_tokens")) this.notifications.resetLatches("budget");
      // 静默阈值同理：刚从 15 分钟调到 2 分钟的用户，等的是「现在就把那个僵尸收掉」，
      // 而不是「下一轮 sweep 也许会」。
      if (changed.includes("zombie_timeout_min")) this.sweepZombies();
      // 名字改了要立刻反映到宠物脚下的名牌上
      if (changed.includes("pet_name")) this.broadcastState();
      sendJson(res, 200, { ok: true, changed, clamped: parsed.clamped, ...this.settingsSnapshot() });
    });
  }

  /** 单个 session 的 goal / budget（G17：session 在终端里诞生，录入时机只能由界面提供） */
  private handleSessionPatch(
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
  ): void {
    readJsonBody(req, res, "bad body", (body) => {
      const { agent, session_id } = (body ?? {}) as { agent?: unknown; session_id?: unknown };
      if (typeof agent !== "string" || typeof session_id !== "string" || !agent || !session_id) {
        sendJson(res, 400, { error: "agent and session_id required" });
        return;
      }
      const parsed = parseSessionPatch(body);
      if (parsed.invalid.length > 0) {
        sendJson(res, 400, { error: "invalid session settings", fields: parsed.invalid });
        return;
      }
      const session = this.registry.updateSession(agent, session_id, parsed.patch);
      if (!session) {
        sendJson(res, 404, { error: "session not found" });
        return;
      }
      // 预算是里程碑的分母：换了分母就该按新分母重新报一次，而不是沿用旧闩锁
      if (parsed.patch.budget_tokens !== undefined) {
        this.notifications.resetLatches("budget", agent, session_id);
      }
      this.broadcastState(); // goal 会进 session 视图，浮层与设置窗口都该立刻看到
      sendJson(res, 200, { ok: true, clamped: parsed.clamped, session });
    });
  }

  /**
   * 重置本地数据（PRD 发布标准「用户可以删除本地宠物数据」）。
   *
   * 清表之后必须把内存里的三处状态一起收拾干净，否则「重置了」只对了一半：
   *   · 通知引擎的去重窗口与阈值闩锁 —— 不清的话重置后的第一批事件会被当成复读吞掉
   *   · registry 的 correction 启发式 —— 不清的话新 session 会继承旧 session 的「反复改同一个文件」
   *   · 宠物本身 —— pets 行删掉了，得当场滚一只新的，而不是等下一次快照兜底
   */
  resetLocalData(scope: ResetScope): { deleted: Record<string, number>; vacuumed: boolean } {
    const result = resetLocalData(this.db, scope);
    this.notifications.forgetAll();
    this.registry.forgetAll();
    this.exp.ensurePet();
    this.broadcastState();
    return { deleted: result.deleted, vacuumed: result.vacuumed };
  }

  private handleReset(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
    readJsonBody(req, res, "bad body", (body) => {
      const { scope, confirm } = (body ?? {}) as { scope?: unknown; confirm?: unknown };
      if (confirm !== true) {
        sendJson(res, 400, { error: "confirmation required" });
        return;
      }
      if (scope !== "pet" && scope !== "data") {
        sendJson(res, 400, { error: "scope must be pet or data" });
        return;
      }
      const result = this.resetLocalData(scope);
      // 顺带回一份新的设置视图与足迹：界面不用再追一次请求就能显示「现在是空的」
      sendJson(res, 200, {
        ok: true,
        scope,
        ...result,
        footprint: dataFootprint(this.db),
        ...this.settingsSnapshot(),
      });
    });
  }

  /** 卸载预览：哪些 agent 配置里还留着我们写进去的东西（G09） */
  uninstallSnapshot(): { targets: HookTarget[] } {
    return { targets: scanAdapters({ repoRoot: this.repoRoot, home: this.home }) };
  }

  /**
   * 移除 adapter hooks。
   *
   * 这是唯一一个会改**用户其他工具的配置文件**的端点，所以它比其他写操作多两道门：
   * confirm 必须显式为 true，且 dry_run 走的是一条一个字节都不写的路径 ——
   * 界面先拿 dry_run 的结果给用户看「会动哪几个文件」，再让他按第二下。
   */
  private handleUninstall(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
    readJsonBody(req, res, "bad body", (body) => {
      const { confirm, dry_run, agents } = (body ?? {}) as {
        confirm?: unknown;
        dry_run?: unknown;
        agents?: unknown;
      };
      const dryRun = dry_run === true;
      if (!dryRun && confirm !== true) {
        sendJson(res, 400, { error: "confirmation required" });
        return;
      }
      let list: UninstallAgent[] | undefined;
      if (Array.isArray(agents)) {
        list = agents.filter((a): a is UninstallAgent => a === "claude_code" || a === "codex" || a === "pi");
        if (list.length === 0) {
          sendJson(res, 400, { error: "unknown agents" });
          return;
        }
      }
      const report = uninstallAdapters({ repoRoot: this.repoRoot, home: this.home, agents: list, dryRun });
      sendJson(res, 200, { ok: true, ...report, ...this.uninstallSnapshot() });
    });
  }

  /** 采集通道开销 + 复核它的那条命令要打给谁 */
  hookStatsSnapshot(): HookStatsView {
    return { ...this.hookMeter.snapshot(), endpoint: `http://${this.host}:${this.port}/api/hookstats` };
  }

  /** 设置窗口一次拿全的数据 */
  settingsSnapshot(): SettingsView {
    const pet = this.exp.getPetSnapshot();
    return {
      settings: readSettings(this.db),
      limits: SETTINGS_LIMITS,
      defaults: {
        budget_tokens: DEFAULT_BUDGET_TOKENS,
        daily_exp_cap: DEFAULT_DAILY_EXP_CAP,
        context_warn_pcts: [...DEFAULT_CONTEXT_WARN_PCTS],
        zombie_timeout_min: DEFAULT_ZOMBIE_TIMEOUT_MIN,
      },
      pet: {
        name: pet.name ?? "vibepaws",
        custom_name: pet.custom_name,
        species: pet.species,
        level: pet.level,
        exp: pet.exp,
        next_level_exp: pet.next_level_exp,
      },
      sessions: this.registry.listSessions().filter((s) => s.is_active),
      hooks: this.hookStatsSnapshot(),
    };
  }

  /** UI 浮层动作：mute / unmute / dismiss / actioned */
  private handleAction(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse): void {
    readJsonBody(req, res, "bad body", (parsed) => {
      const { action, minutes, project_id, session_id, id } = (parsed ?? {}) as {
        action?: string;
        minutes?: number;
        project_id?: string;
        session_id?: string;
        id?: number;
      };
      // 时长必须收敛到合理区间：脏值不该变成「静音到下个世纪」或「静音 -5 分钟」
      const m = clampMinutes(minutes);
      const bad = (reason: string): void => {
        sendJson(res, 400, { error: reason });
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
      sendJson(res, 200, { ok: true, ...this.notifications.muteStatus() });
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

  /**
   * 已接入的 adapter。界面靠它区分「没装 hooks」和「装了但 agent 还没动」——
   * 在这之前两者都是一只闲着的宠物，用户没有任何办法看出自己装漏了。
   */
  listAdapters(): AdapterView[] {
    const rows = this.db
      .prepare(`SELECT agent, adapter_version, capabilities, connected_at, last_event_at FROM agents ORDER BY agent`)
      .all() as Array<{
        agent: AgentId;
        adapter_version: string | null;
        capabilities: string;
        connected_at: string | null;
        last_event_at: string | null;
      }>;
    return rows.map((r) => ({
      agent: r.agent,
      adapter_version: r.adapter_version,
      capabilities: safeParseArray(r.capabilities),
      connected_at: r.connected_at,
      last_event_at: r.last_event_at,
    }));
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
      adapters: this.listAdapters(),
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

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/**
 * 读一个 JSON 请求体。四个 POST 端点共用，顺带把三件事一起收拾干净：
 *   · 体积上限 —— 这些端点收的都是几十字节的小 JSON，没有理由为任何一方缓冲兆级数据；
 *   · 解析失败回 400，处理器自己抛异常回 500 —— 原来两者混在同一个 try 里，
 *     业务代码的 bug 会被伪装成「请求体坏了」；
 *   · 处理器的异常**必须**在这里兜住：它跑在 req 的 'end' 回调里，
 *     外层 createServer 那个 try 早就返回了，漏出去就是 uncaught exception —— 整个 Core 挂掉。
 *
 * 顺手把读到的字节数交给处理器：`/events` 的开销计量要的就是这个数（landscape 0.12），
 * 而这里是唯一真的数过它的地方。
 */
function readJsonBody(
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  badMessage: string,
  onBody: (parsed: unknown, bytes: number) => void,
): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let aborted = false;
  req.on("data", (chunk: Buffer) => {
    if (aborted) return;
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      aborted = true;
      sendJson(res, 413, { error: "body too large" });
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (aborted) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      sendJson(res, 400, { error: badMessage });
      return;
    }
    try {
      onBody(parsed, size);
    } catch (err) {
      console.error("[server] body handler error:", err);
      if (!res.headersSent) sendJson(res, 500, { error: "internal" });
      else res.end();
    }
  });
}

/** capabilities 列是 JSON 文本：老库里可能是脏值，解析失败当没有能力声明，别让状态推送整个炸掉 */
function safeParseArray(raw: string | null): string[] {
  try {
    const v = JSON.parse(raw ?? "[]") as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
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
