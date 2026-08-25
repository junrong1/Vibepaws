/**
 * 僵尸 session 回收 —— gap analysis G10。
 *
 * `SessionEnd` 在 `kill -9`、崩溃、笔记本休眠、终端窗口被直接关掉的情况下**不会触发**。
 * 于是 `sessions.is_active` 永不复位：一个已经不存在的 agent 会永远被算进宠物的聚合
 * 状态里。叠加 G02（needs-you 没有解除边）之后更糟 —— 一个崩在权限弹窗上的 session
 * 会把宠物永久钉在「需要你」上，而用户点开浮层看到的是一个早就不存在的会话。
 *
 * 两条回收路径，都由 Core 的 60s sweep 驱动：
 *
 *   1. **进程探活**（快，秒级）—— adapter 上报 agent 的 pid，`kill(pid, 0)` 说它没了，
 *      那就是没了，不必等静默超时。
 *   2. **静默超时**（兜底，默认 15 分钟）—— 没有 pid（generic bridge、手动发射器、
 *      升级前的老库）或 pid 还活着但一直没动静时的唯一依据。
 *
 * 两条路径都写 `is_active=0` + 一个**非成功**的 outcome，并且**不发 `session_finished`
 * 事件** —— 那条事件会走 EXP 引擎的 outcome bonus。把崩溃结算成 +20 EXP 等于教用户
 * 「崩了也算赢」，而这个产品的整个成长曲线就是拿「健康的会话」当唯一快车道的。
 *
 * ## 为什么 pid 需要「确认」才敢用
 *
 * hook 是 agent 的子进程，所以 `process.ppid` 就是 agent —— 前提是中间那层 `sh -c`
 * 真的 exec 掉了自己。这一点在真实世界里不保证（命令里出现重定向、管道，或者某个
 * 平台的 shell 不做这个优化，ppid 就会是那个**一闪而过**的 shell）。而一个转瞬即逝的
 * ppid 是最坏的输入：它在 60 秒后必然是「死的」，于是我们会去回收一个**正在干活**的
 * session —— 用户眼睁睁看着宠物把还在跑的会话判死。
 *
 * 判别方法很便宜：包装 shell 每次 hook 都是**新的** pid，而 agent 进程的 pid
 * 在整个会话里**不变**。所以只有「同一个 pid 被两条不同事件报到过」才置
 * `agent_pid_confirmed=1`，只有 confirmed 的 pid 才参与探活。拿不到确认时自动退回
 * 静默超时 —— 慢一点，但不会错杀。
 *
 * pid 复用（老 pid 被系统分给了别的进程）只会让探活**误判为活着**，也就是退回静默
 * 超时那条路。方向是安全的：宁可晚 15 分钟回收，也不要错杀。
 */
import type Database from "better-sqlite3";
import type { SessionOutcome } from "./events.ts";

/** sweep 周期：G10 的建议值。宠物被钉住的最坏情况 = 这个周期 + 判定阈值 */
export const SWEEP_INTERVAL_MS = 60_000;

/** 静默超时默认值（分钟）。用户可在设置窗口里改，见 settings.ts */
export const DEFAULT_ZOMBIE_TIMEOUT_MIN = 15;

/**
 * 探活的最小静默期。进程都死了为什么还要等？
 * 因为「事件已经到了 Core、进程随后正常退出」是一个完全合法的时序 ——
 * 最典型的就是 bridge 把离线期间的 JSONL 补发进来。刚收到事件就按「进程没了」
 * 结算，会把这一类正常收尾也标成崩溃。30 秒足够把这两件事分开。
 */
export const LIVENESS_GRACE_MS = 30_000;

/** 一次 sweep 回收掉的 session（调用方拿它写日志 / 推 SSE） */
export interface ReclaimedSession {
  agent: string;
  session_id: string;
  project_id: string;
  title: string | null;
  outcome: Extract<SessionOutcome, "orphaned" | "timeout">;
  /** 最后一次事件到回收之间的静默时长（毫秒），写日志用 */
  idle_ms: number;
}

export interface ReclaimOptions {
  /** 静默超时（毫秒）。默认 DEFAULT_ZOMBIE_TIMEOUT_MIN 分钟 */
  timeoutMs?: number;
  /** 注入点：测试用假时钟，不必真的等 15 分钟 */
  now?: number;
  /** 注入点：测试用假探活，不必真的去杀进程 */
  isAlive?: (pid: number) => boolean;
}

/**
 * 进程还在吗。`kill(pid, 0)` 不发信号，只做「进程存不存在 + 我有没有权限」的检查：
 *   ESRCH → 没有这个进程 = 死了
 *   EPERM → 有这个进程，只是不属于当前用户 = **活着**（别把它当死的）
 * 非法 pid（0 / 负数 / 非整数）一律当「不知道」→ 返回 true，交给静默超时兜底：
 * 未知绝不能等于「可以回收」。
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return true; // 0/1/脏值：不可判定
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface ActiveRow {
  agent: string;
  agent_session_id: string;
  project_id: string;
  title: string | null;
  last_event_at: string;
  agent_pid: number | null;
  agent_pid_confirmed: number;
}

/**
 * 记录 / 确认 agent pid（每条带 pid 的事件都走一遍，由 Registry 调用）。
 *
 * 规则：
 *   · 没带 pid → 什么都不做（**不能**清掉已经确认过的 pid：同一个 session 的事件
 *     来自多个通道 —— hook、statusline、bridge 补发 —— 只有跑在 agent 子进程里的
 *     那一路知道 pid。不知道的那几路应当保持沉默，而不是把已确认的结论擦掉）
 *   · pid 和库里那个一样 → confirmed=1（同一个 pid 出现两次 = 它不是一闪而过的包装进程）
 *   · pid 变了 → 换成新的，confirmed 归零（重新开始确认）
 */
export function notePid(db: Database.Database, agent: string, sessionId: string, pid: unknown): void {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) return;
  db.prepare(
    `UPDATE sessions
        SET agent_pid_confirmed = CASE WHEN agent_pid = ? THEN 1 ELSE 0 END,
            agent_pid = ?
      WHERE agent = ? AND agent_session_id = ?`,
  ).run(pid, pid, agent, sessionId);
}

/**
 * 扫一遍活着的 session，把僵尸收掉。返回被收掉的那些（空数组 = 什么都没变）。
 *
 * 只读 + 判定 + 写回三步都在这里，是为了让它可以拿假时钟和假探活单测 ——
 * 一个「15 分钟后才生效」的规则如果只能靠真实时间验证，实际上就是没被验证过。
 */
export function reclaimZombies(db: Database.Database, opts: ReclaimOptions = {}): ReclaimedSession[] {
  const now = opts.now ?? Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_ZOMBIE_TIMEOUT_MIN * 60_000;
  const isAlive = opts.isAlive ?? isProcessAlive;

  const rows = db
    .prepare(
      `SELECT agent, agent_session_id, project_id, title, last_event_at, agent_pid, agent_pid_confirmed
         FROM sessions WHERE is_active = 1`,
    )
    .all() as ActiveRow[];

  const reclaimed: ReclaimedSession[] = [];
  for (const row of rows) {
    const last = new Date(row.last_event_at).getTime();
    // 时间戳读不出来的行按「刚刚活动过」处理：一个坏时间戳不该变成回收的理由
    if (!Number.isFinite(last)) continue;
    const idleMs = now - last;
    if (idleMs < 0) continue; // 时钟回拨 / 未来时间戳：等它自己长回来

    const outcome = classify(row, idleMs, timeoutMs, isAlive);
    if (!outcome) continue;

    reclaim(db, row.agent, row.agent_session_id, outcome, now);
    reclaimed.push({
      agent: row.agent,
      session_id: row.agent_session_id,
      project_id: row.project_id,
      title: row.title,
      outcome,
      idle_ms: idleMs,
    });
  }
  return reclaimed;
}

/** 这个 session 该不该收、按哪种归因收（null = 还活着，别动） */
function classify(
  row: ActiveRow,
  idleMs: number,
  timeoutMs: number,
  isAlive: (pid: number) => boolean,
): ReclaimedSession["outcome"] | null {
  const pid = row.agent_pid;
  if (row.agent_pid_confirmed === 1 && pid !== null && idleMs >= LIVENESS_GRACE_MS && !isAlive(pid)) {
    return "orphaned";
  }
  return idleMs >= timeoutMs ? "timeout" : null;
}

/**
 * 落库。三件事必须一起做，少任何一件「回收」都只完成了一半：
 *   · `is_active=0` + outcome —— 宠物的聚合状态从此不再算它（G10 的正题）
 *   · 清掉 `needs_input_since` —— 不清的话，这个 session 万一被 `--resume` 拉回来，
 *     会带着三小时前的「等你」标记复活，宠物立刻又红一次
 *   · 把它还挂着的气泡标成 dismissed —— 一个已经不存在的会话不该继续在屏幕上
 *     求人回答。这正是「orphan cleanup」里 orphan 的部分
 *
 * `last_event_at` **不动**：它是「什么时候没声了」的唯一证据，也是下一轮 sweep
 * 的判定依据。刷新它等于把静默时长清零。
 */
function reclaim(
  db: Database.Database,
  agent: string,
  sessionId: string,
  outcome: ReclaimedSession["outcome"],
  now: number,
): void {
  const at = new Date(now).toISOString();
  db.prepare(
    `UPDATE sessions
        SET is_active = 0, outcome = ?, finished_at = ?,
            needs_input_since = NULL, needs_input_kind = NULL
      WHERE agent = ? AND agent_session_id = ?`,
  ).run(outcome, at, agent, sessionId);
  db.prepare(
    `UPDATE notifications SET status = 'dismissed'
      WHERE agent = ? AND session_id = ? AND status = 'shown'`,
  ).run(agent, sessionId);
}
