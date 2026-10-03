/**
 * Habit 功能端到端验证脚本（对着正在跑的 Core）。
 *
 * 用法：
 *   node --experimental-strip-types scripts/verify_habit.ts
 *
 * 它生成一批**唯一 event_id** 的富事件流（跨 2 个活跃日、6 个短 session、success 为主、
 * 带工具/context 穿越/correction/阻塞等待），POST 到 127.0.0.1:17893，然后读回
 * /api/habit 并断言画像非平凡且符合预期。
 */
import { readApiToken } from "../src/core/token.ts";

const BASE = "http://127.0.0.1:17893";
const RUN = `verify-${Date.now().toString(36)}`;

interface Ev {
  event_id: string;
  seq: number;
  agent: string;
  session_id: string;
  project_id: string;
  event_type: string;
  severity: string;
  safe_summary: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

const agent = "claude_code";
const project = "/Users/demo/api-server";

function iso(d: Date): string {
  return d.toISOString();
}

/** 目标 UTC 时刻（daysAgo 天前、hour 点、偏移秒） */
function at(daysAgo: number, hour: number, sec = 0): Date {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  d.setUTCHours(hour, 0, sec, 0);
  return d;
}

let seq = 0;
function ev(sessionId: string, type: string, at: Date, payload: Record<string, unknown> = {}): Ev {
  seq += 1;
  return {
    event_id: `${RUN}-${seq}`,
    seq,
    agent,
    session_id: sessionId,
    project_id: project,
    event_type: type,
    severity: "low",
    safe_summary: "verify-habit",
    timestamp: iso(at),
    payload,
  };
}

function buildEvents(): Ev[] {
  const out: Ev[] = [];
  // 每个 session：start → (Bash/Edit/Read) → context(90) → finish(success)，约 10 分钟
  const session = (id: string, day: number, start: Date, opts: { corrections?: boolean; wait?: boolean } = {}) => {
    const t = (sec: number) => new Date(start.getTime() + sec * 1000);
    out.push(ev(id, "session_started", t(0), { source: "startup", cwd: project, title: "api-server" }));
    out.push(ev(id, "agent_working", t(30), { tool_name: "Bash" }));
    out.push(ev(id, "agent_working", t(60), { tool_name: "Edit", file: "parser.ts" }));
    if (opts.corrections) {
      // 同文件连续 Edit → registry 的 correction 启发式 +1（再做两次 → +2）
      out.push(ev(id, "agent_working", t(65), { tool_name: "Edit", file: "parser.ts" }));
      out.push(ev(id, "agent_working", t(70), { tool_name: "Edit", file: "parser.ts" }));
    }
    out.push(ev(id, "agent_working", t(90), { tool_name: "Read" }));
    out.push(ev(id, "context_update", t(120), { context_pct: 90 }));
    if (opts.wait) {
      out.push(ev(id, "decision_required", t(150), { kind: "question" }));
      out.push(ev(id, "agent_working", t(160), { tool_name: "Bash" }));
    }
    out.push(ev(id, "session_finished", t(600), { reason: "completion", outcome: "success" }));
  };

  // 2 个活跃日（T-2 / T-1），每天 3 个短 session → 6 sessions / 2 days = burst
  const dayA = at(2, 10);
  const dayB = at(1, 14);
  session(`${RUN}-a1`, 2, dayA);
  session(`${RUN}-a2`, 2, new Date(dayA.getTime() + 20 * 60_000), { corrections: true });
  session(`${RUN}-a3`, 2, new Date(dayA.getTime() + 40 * 60_000), { wait: true });
  session(`${RUN}-b1`, 1, dayB);
  session(`${RUN}-b2`, 1, new Date(dayB.getTime() + 20 * 60_000), { corrections: true });
  session(`${RUN}-b3`, 1, new Date(dayB.getTime() + 40 * 60_000));
  return out;
}

async function main() {
  const token = readApiToken();
  if (!token) {
    console.error("找不到 api_token —— 先确认 Core 正在运行");
    process.exit(1);
  }

  const health = (await fetch(`${BASE}/health`).then((r) => r.json()).catch(() => null)) as { ok?: boolean } | null;
  if (!health?.ok) {
    console.error("Core 不在线（/health 失败）。先 `npm run core` 或 `npm run desktop`。");
    process.exit(1);
  }
  console.log(`[verify] Core 在线：${JSON.stringify(health)}`);

  const events = buildEvents();
  console.log(`[verify] 准备发送 ${events.length} 条唯一事件（run=${RUN}）`);
  let ok = 0;
  for (const e of events) {
    const res = await fetch(`${BASE}/events`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-vibepaws-token": token },
      body: JSON.stringify(e),
    });
    const body = (await res.json()) as { ok?: boolean; error?: string };
    if (body.ok) ok++;
    else console.error(`[verify] ${e.event_id} 被拒：${body.error}`);
  }
  console.log(`[verify] 发送完成：${ok}/${events.length} 成功`);

  await new Promise((r) => setTimeout(r, 300));

  const habit = (await fetch(`${BASE}/api/habit`, {
    headers: { "x-vibepaws-token": token },
  }).then((r) => r.json())) as { profile?: Record<string, unknown> };
  const p = habit.profile ?? {};
  console.log("\n[verify] /api/habit 结果：");
  console.log(JSON.stringify(p, null, 2));

  const failures: string[] = [];
  const expect = (cond: boolean, msg: string) => { if (!cond) failures.push(msg); };
  const in01 = (v: unknown) => typeof v === "number" && v >= 0 && v <= 1;

  // 硬性不变量：画像必须有数据且字段类型/范围合法
  expect(p.ready === true, `ready 应为 true，实际 ${p.ready}`);
  expect((p.sample_sessions as number) >= 5, `sample_sessions 应 >=5，实际 ${p.sample_sessions}`);
  expect((p.sample_days as number) >= 2, `sample_days 应 >=2，实际 ${p.sample_days}`);
  expect(in01(p.depth), `depth 应在 0..1，实际 ${p.depth}`);
  expect(in01(p.precision), `precision 应在 0..1，实际 ${p.precision}`);
  expect(in01(p.context_hygiene), `context_hygiene 应在 0..1，实际 ${p.context_hygiene}`);
  expect(in01(p.responsiveness), `responsiveness 应在 0..1，实际 ${p.responsiveness}`);
  expect(typeof p.cadence === "string" && ["burst", "steady", "sparse"].includes(p.cadence as string),
    `cadence 应为 burst/steady/sparse 之一，实际 ${p.cadence}`);
  expect(typeof p.chronotype === "string" && ["early_bird", "day", "night_owl"].includes(p.chronotype as string),
    `chronotype 应为 early_bird/day/night_owl 之一，实际 ${p.chronotype}`);
  expect(Array.isArray(p.tool_affinity) && (p.tool_affinity as string[]).length > 0,
    "tool_affinity 应为非空数组");
  expect(typeof p.outcome_bias === "string" && ["shipper", "explorer"].includes(p.outcome_bias as string),
    `outcome_bias 应为 shipper/explorer 之一，实际 ${p.outcome_bias}`);

  console.log("\n[verify] 维度解读：");
  const notes: Record<string, string> = {
    chronotype: "作息：day=白天型（要稳定夜猫/早鸟需真实积累数天，见 received_at 说明）",
    cadence: "节奏：burst=突击 / steady=平稳 / sparse=稀疏",
    depth: "深度：越接近 1 越像长时间深工作（短会话+干净 context+高精确）",
    precision: "精确度：越接近 1 越少反复改同一文件",
    context_hygiene: "context 卫生：越接近 1 越少顶到 >85%",
    responsiveness: "响应度：越接近 1 越少让 agent 等你",
    outcome_bias: "结果倾向：shipper=交付型 / explorer=探索型",
    tool_affinity: "工具亲和度：频率前 5 的工具名（来自 payload.tool_name，不含命令文本）",
  };
  for (const [k, note] of Object.entries(notes)) console.log(`  ${k.padEnd(16)} ${note}`);

  if (failures.length === 0) {
    console.log("\n✅ 全部断言通过 —— Habit 功能端到端工作正常。");
  } else {
    console.error("\n❌ 断言失败：");
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[verify] 脚本异常：", err);
  process.exit(1);
});
