/**
 * Event Ingress — 第二道隐私闸 + 幂等 + 落库 + 分发。
 * 职责：校验 token → 白名单过滤 payload → event_id 去重 → 写 events 表 → 回调分发。
 */
import type Database from "better-sqlite3";
import type { CoreEvent, EventPayload } from "./events.ts";

/** payload 白名单：仅允许这些字段进入 Core（与 events.ts 的 EventPayload 对齐） */
const PAYLOAD_WHITELIST: Record<keyof EventPayload, true> = {
  title: true,
  cwd: true,
  source: true,
  tool_name: true,
  kind: true,
  turn_id: true,
  tokens: true,
  cost: true,
  context_pct: true,
  signal_kind: true,
  reason: true,
  outcome: true,
  error_kind: true,
  parent_session_id: true,
  subagent_kind: true,
  capabilities: true,
  adapter_version: true,
  file: true,
  pid: true,
  hook_ms: true,
};

const SEVERITIES = new Set(["low", "medium", "high"]);
const AGENTS = new Set(["claude_code", "codex", "generic", "pi"]);

/** 白名单过滤 payload：未知字段一律丢弃（第二道隐私闸） */
export function sanitizePayload(input: unknown): EventPayload {
  if (input === null || typeof input !== "object") return {};
  const out: EventPayload = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (!(k in PAYLOAD_WHITELIST)) continue; // 丢弃未知字段
    const key = k as keyof EventPayload;
    if (v === undefined || v === null) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      // @ts-expect-error 类型收窄
      out[key] = v;
    } else if (Array.isArray(v)) {
      const strs = v.filter((x) => typeof x === "string");
      // @ts-expect-error capabilities 数组
      out[key] = strs;
    }
  }
  return out;
}

export interface IngressOptions {
  db: Database.Database;
  /** 收到合法事件后的分发回调（Registry / 通知引擎 / EXP 引擎） */
  onEvent: (ev: CoreEvent) => void;
}

/** 校验 + 归一化 + 幂等 + 落库。返回 { ok, code?, reason?, event? } */
export function ingestEvent(raw: unknown, opts: IngressOptions): {
  ok: boolean;
  code?: number;
  reason?: string;
  event?: CoreEvent;
} {
  const { db, onEvent } = opts;
  if (raw === null || typeof raw !== "object") {
    return { ok: false, code: 400, reason: "body must be a JSON object" };
  }
  const obj = raw as Record<string, unknown>;

  const event_id = typeof obj.event_id === "string" ? obj.event_id : "";
  const agent = typeof obj.agent === "string" ? obj.agent : "";
  const session_id = typeof obj.session_id === "string" ? obj.session_id : "";
  const event_type = typeof obj.event_type === "string" ? obj.event_type : "";
  const project_id = typeof obj.project_id === "string" ? obj.project_id : "";
  const safe_summary = typeof obj.safe_summary === "string" ? obj.safe_summary : "";
  // 必须是能解析的时间：下游会拿它算「等了多久」/「刚刚结束」，
  // 一个解析不出来的字符串会一路变成 NaN 比较。
  const rawTimestamp = typeof obj.timestamp === "string" ? obj.timestamp : "";
  const timestamp = rawTimestamp && !Number.isNaN(Date.parse(rawTimestamp))
    ? rawTimestamp
    : new Date().toISOString();
  const severity = typeof obj.severity === "string" ? obj.severity : "low";
  const seq = typeof obj.seq === "number" && Number.isFinite(obj.seq) ? obj.seq : 0;

  if (!event_id || !agent || !session_id || !event_type || !project_id) {
    return { ok: false, code: 400, reason: "missing required fields: event_id/agent/session_id/event_type/project_id" };
  }
  if (!AGENTS.has(agent)) return { ok: false, code: 400, reason: `unknown agent: ${agent}` };
  if (!SEVERITIES.has(severity)) return { ok: false, code: 400, reason: `bad severity: ${severity}` };

  // 幂等：已存在则跳过（仍算成功）
  const dup = db.prepare("SELECT id FROM events WHERE event_id = ?").get(event_id);
  if (dup) return { ok: true, reason: "duplicate", event: undefined };

  const payload = sanitizePayload(obj.payload);

  // 落库（仅 safe_summary + 白名单 payload；原始 hook JSON 永不落库）
  db.prepare(
    `INSERT INTO events(event_id, seq, agent, session_id, event_type, severity, safe_summary, payload_json)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(event_id, seq, agent, session_id, event_type, severity, safe_summary, JSON.stringify(payload));

  const event: CoreEvent = {
    event_id,
    seq,
    agent: agent as CoreEvent["agent"],
    session_id,
    project_id,
    event_type: event_type as CoreEvent["event_type"],
    severity: severity as CoreEvent["severity"],
    safe_summary,
    timestamp,
    payload,
  };

  try {
    onEvent(event);
  } catch (err) {
    console.error("[ingress] dispatch failed:", err);
  }
  return { ok: true, event };
}

/** adapter_status 落库到 agents 表（能力声明） */
export function upsertAgent(db: Database.Database, ev: CoreEvent): void {
  const capabilities = ev.payload.capabilities ?? [];
  db.prepare(
    `INSERT INTO agents(agent, adapter_version, capabilities, connected_at, last_event_at)
     VALUES(?, ?, ?, ?, ?)
     ON CONFLICT(agent) DO UPDATE SET
       adapter_version = excluded.adapter_version,
       capabilities = excluded.capabilities,
       connected_at = COALESCE(agents.connected_at, excluded.connected_at),
       last_event_at = excluded.last_event_at`,
  ).run(ev.agent, ev.payload.adapter_version ?? null, JSON.stringify(capabilities), ev.timestamp, ev.timestamp);
}
