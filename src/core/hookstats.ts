/**
 * 采集通道的开销计量（landscape 0.12 / clawd #102）。
 *
 * 为什么这个模块存在：有用户真的相信桌宠在烧他的 token —— 因为 agent 自己
 * **幻觉**出了这件事，而用户没有任何办法反驳它。任何基于 hook 的宠物都会碰到。
 * 断言「我们不花你的 token」是没有用的：那正是被幻觉的那一句话。所以这里数的是
 * 可以被核对的量 —— 每次 hook 到底送来了多少字节、Core 花了多少毫秒、hook 进程
 * 自己花了多少毫秒 —— 并让恒为 0 的两项（模型调用、出网字节）也成为看得见的数字。
 *
 * 计量在 Core 一侧：Core 收到的请求体字节数**就是** hook 送出的字节数，
 * 不需要在采集路径上再加一次 I/O 去测量采集路径的开销。
 *
 * 只统计 Core 启动之后的事件。持久化会把「每条事件一次 DB 写」加到这条路径上 ——
 * 为了让计数器好看一点而给它测量的东西增加开销，那就本末倒置了。
 */

/** 延迟分位数的窗口。宠物跑一天是几千条事件，全留着算分位数没有意义 */
const LATENCY_WINDOW = 200;

export interface HookStats {
  /** 计数起点（Core 启动时刻）—— 界面必须说清窗口，否则「1284」是个无意义的数 */
  since: string;
  /** POST /events 的次数（hook、bridge、simulator 都走这一条） */
  calls: number;
  /** 请求体总字节数 = hook 实际送出的 JSON 字节数 */
  bytes: number;
  /** 分位数的样本数（可能小于 calls：窗口只留最近 LATENCY_WINDOW 条） */
  sample: number;
  /** Core 侧处理耗时（收到请求 → 响应写完），毫秒 */
  core_ms_p50: number | null;
  core_ms_p95: number | null;
  /**
   * hook 进程自报的耗时（进程启动 → 发出这一条），毫秒。
   * 老版 adapter、generic bridge 与 pi extension 不报这个数，所以可能为 null。
   */
  hook_ms_p50: number | null;
  hook_ms_p95: number | null;
  /** 恒为 0 的两项。它们不是凑数的字段 —— 它们就是这个面板要回答的问题 */
  model_calls: 0;
  outbound_bytes: 0;
}

/** 固定容量环形缓冲：每条事件都要写一次，不该是 O(n) 的 shift() */
class Ring {
  private buf: number[] = [];
  private next = 0;
  private readonly cap: number;

  // 构造参数属性（`private cap`）在 --experimental-strip-types 下不可用：
  // strip-only 模式不生成代码，只删类型注解。
  constructor(cap: number) {
    this.cap = cap;
  }

  push(v: number): void {
    if (this.buf.length < this.cap) {
      this.buf.push(v);
      return;
    }
    this.buf[this.next] = v;
    this.next = (this.next + 1) % this.cap;
  }

  values(): number[] {
    return [...this.buf];
  }

  get size(): number {
    return this.buf.length;
  }
}

/**
 * 最近秩分位数（nearest-rank）。样本量在这里是几十到 200，插值法多出来的
 * 精度没有意义，而「p95 是某一次真实观测值」在解释一个信任面板时更好说。
 */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx] ?? null;
}

export interface HookSample {
  /** 请求体字节数 */
  bytes: number;
  /** Core 侧处理毫秒 */
  coreMs: number;
  /** hook 进程自报毫秒（没有就不进分位数窗口） */
  hookMs?: number | null;
}

export class HookMeter {
  readonly since: string;
  private calls = 0;
  private bytes = 0;
  private core = new Ring(LATENCY_WINDOW);
  private hook = new Ring(LATENCY_WINDOW);

  constructor(since: Date = new Date()) {
    this.since = since.toISOString();
  }

  /**
   * 记一次 POST /events。
   *
   * 脏值一律丢弃而不是记 0：`hook_ms` 来自 adapter 上报，也就是来自 Core 之外 ——
   * 一个 NaN 混进窗口，整条分位数曲线就变成 NaN，而界面上看不出是坏数据。
   */
  record(sample: HookSample): void {
    this.calls += 1;
    if (Number.isFinite(sample.bytes) && sample.bytes > 0) this.bytes += sample.bytes;
    if (Number.isFinite(sample.coreMs) && sample.coreMs >= 0) this.core.push(round(sample.coreMs, 2));
    const hookMs = sample.hookMs;
    if (typeof hookMs === "number" && Number.isFinite(hookMs) && hookMs >= 0) this.hook.push(round(hookMs, 1));
  }

  snapshot(): HookStats {
    const core = this.core.values();
    const hook = this.hook.values();
    return {
      since: this.since,
      calls: this.calls,
      bytes: this.bytes,
      sample: core.length,
      core_ms_p50: percentile(core, 50),
      core_ms_p95: percentile(core, 95),
      hook_ms_p50: percentile(hook, 50),
      hook_ms_p95: percentile(hook, 95),
      // 这两个 0 是断言，不是测量值：Core 不含任何模型客户端，也不监听 127.0.0.1 之外的地址。
      // 之所以放进 JSON 而不是只写在文案里，是为了让「curl 一下自己看」这句话真的成立。
      model_calls: 0,
      outbound_bytes: 0,
    };
  }

}

function round(v: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}

/**
 * 从一条**未经校验**的请求体里取 `payload.hook_ms`。
 * 这个数在进 ingress 白名单之前就要用到（响应已经发出去了才计量），
 * 所以这里自己做一次收窄，绝不假设 body 的形状。
 */
export function hookMsOf(body: unknown): number | null {
  if (body === null || typeof body !== "object") return null;
  const payload = (body as { payload?: unknown }).payload;
  if (payload === null || typeof payload !== "object") return null;
  const v = (payload as { hook_ms?: unknown }).hook_ms;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}
