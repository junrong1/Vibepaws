/**
 * 「永远允许」在壳这一侧的那一半（U9 / KTD13）—— 为什么授予只能从这里发起。
 *
 * 威胁模型：agent 能读文件、能发本机 HTTP 请求。
 *   · Core 的 bearer token 写在 cwd/.vibepaws/api_token —— agent 自己的 hook 就在读它；
 *   · UI server 把 /api/* 原样代理给 Core 并替调用方盖上 token，够得着 UI 端口 = 够得着 Core；
 *   · SSE 把每一帧推给每一个连上来的客户端。
 * 所以「持有 token」「能连 UI 端口」「收得到推送」都不能等于「能授予」。授予要的是一样
 * 渲染层有、本机任何 HTTP 调用方都没有的东西：
 *   1. 每次拉起 Core 时现生成一个 32 字节的 grant secret，只放在主进程内存里；
 *   2. 经 Core 子进程的 **stdin** 递过去 —— 不走环境变量（同一用户的进程能读别人的初始环境块，
 *      Node 里 delete process.env 也抹不掉它）、不走命令行参数（ps 看得见）；从不落盘、从不打日志；
 *   3. 宠物窗口只能经 preload 的 IPC 说「对第几号通知按了永远允许」；主进程核对发送方是宠物窗口，
 *      然后**自己**直接打 Core（不经 UI server），带上 token + X-Vibepaws-Grant；
 *   4. 请求体里只有通知 id。工具、项目、命令前缀由 Core 从它自己存的那一行推出来，渲染层说了不算。
 * Core 不是这个壳拉起来的（adopted：`npm run core`、上一次留下的孤儿）→ 壳手里没有它的 secret，
 * 那个 Core 也就没有授予这回事，气泡不给这个选项。
 * 剩下的风险要写明白：同一用户下能调试 / 注入 Electron 主进程的东西，这里挡不住 —— 那已经是整台
 * 机器的问题，不是一个端口的问题。
 *
 * 不 import electron —— 和 launch.js / display.js 一样，这里的每个导出都要能在 node 测试进程里直接跑。
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** 与 src/core/rules.ts 的 GRANT_SECRET_HEADER / GRANT_CHANNEL_ENV 同名（那边是 TS，这里不 import 它） */
export const GRANT_SECRET_HEADER = "x-vibepaws-grant";
export const GRANT_CHANNEL_ENV = "VIBEPAWS_GRANT_CHANNEL";

/** 64 个十六进制字符。Core 那边按同一个形状验，短了 / 空了都当作没有 */
export function newGrantSecret() {
  return randomBytes(32).toString("hex");
}

/** Core 的 token 在它的数据目录里（cwd/.vibepaws/api_token）。读不到返回空串 */
export function readCoreToken(workDir, read = readFileSync) {
  try {
    return String(read(join(workDir, ".vibepaws", "api_token"), "utf-8")).trim();
  } catch {
    return "";
  }
}

/**
 * 替宠物窗口向 Core 要一次授予。
 *
 * @param {{ id: unknown, secret: string|null, token: string, corePort: number,
 *           fetchImpl?: typeof fetch, timeoutMs?: number }} opts
 * @returns {Promise<{ ok: boolean, status: number, data?: any, reason?: string }>}
 */
export async function requestGrant({ id, secret, token, corePort, fetchImpl = fetch, timeoutMs = 4000 }) {
  // 只认一个整数：渲染层传别的形状（对象、字符串、一整条规则）都不往下走
  if (!Number.isInteger(id)) return { ok: false, status: 0, reason: "bad_id" };
  if (!secret || !token) return { ok: false, status: 0, reason: "unavailable" };
  try {
    const r = await fetchImpl(`http://127.0.0.1:${corePort}/api/rules/grant`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-vibepaws-token": token, [GRANT_SECRET_HEADER]: secret },
      body: JSON.stringify({ id }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await r.json().catch(() => null);
    return { ok: r.ok && Boolean(data?.ok), status: r.status, data, reason: r.ok ? undefined : data?.error };
  } catch {
    return { ok: false, status: 0, reason: "core_offline" };
  }
}
