/**
 * hooks 配置单测：注册给 agent 的事件集合，必须和 hook_agent 认识的事件集合对齐。
 *
 * 为什么这组测试值得存在：claudeHooksConfig 曾经漏掉 Stop。
 * hook_agent 的 MATCHER_MAP 有 Stop→decision_required，Core 的通知引擎拿 kind:"Stop"
 * 当作 decision_required 的头号用例（notifications.test.ts 里 8 处断言），
 * 唯独没人让 Claude Code 把这个 hook 发出来 —— 于是「agent 说完了，该你了」这条
 * 最该响的提醒，对所有 Claude Code 用户都是死的，而且看起来只是宠物比较安静。
 * 两张表分别改、没人比对，就会再漏一次。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeHooksConfig, codexHooksConfig, adapterStatusEvent, adapterVersion, capabilities } from "./hooks.ts";
import { normalizeHook } from "./hook_agent.ts";

/** 配置片段里注册的事件名 */
function registeredEvents(cfg: Record<string, unknown>): string[] {
  return Object.keys(cfg.hooks as Record<string, unknown>);
}

test("Claude Code 注册了 Stop —— 「一轮说完了，该你了」的唯一即时信号", () => {
  const events = registeredEvents(claudeHooksConfig("/repo"));
  assert.ok(events.includes("Stop"), "缺 Stop：SessionEnd 只在会话退出时发，Notification 要等 60s 空闲");
});

test("两个 agent 注册的每个事件，hook_agent 都认识（否则事件发出来被静默丢弃）", () => {
  for (const [name, cfg] of [
    ["claude_code", claudeHooksConfig("/repo")],
    ["codex", codexHooksConfig("/repo")],
  ] as const) {
    for (const hookEvent of registeredEvents(cfg)) {
      const ev = normalizeHook({ hook_event_name: hookEvent, session_id: "s", cwd: "/p" }, name);
      assert.ok(ev, `${name} 注册了 ${hookEvent}，但 normalizeHook 返回 null —— 这个 hook 白发了`);
    }
  }
});

test("decision_required 能从 Claude Code 真实注册的 hook 里产生（不只是 Codex 能）", () => {
  const claudeEvents = registeredEvents(claudeHooksConfig("/repo"));
  const producers = claudeEvents.filter((hookEvent) => {
    const ev = normalizeHook({ hook_event_name: hookEvent, session_id: "s", cwd: "/p" }, "claude_code");
    return ev?.event_type === "decision_required";
  });
  assert.ok(
    producers.length > 0,
    "Claude Code 注册的 hook 里没有一个产生 decision_required —— 宠物永远不会喊「该你了」",
  );
});

test("hook 命令用绝对路径（安装后从任意项目目录触发都要能找到 hook_agent）", () => {
  const cfg = claudeHooksConfig("/Users/demo/Vibepaws");
  const cmd = JSON.stringify(cfg.hooks);
  assert.ok(cmd.includes("/Users/demo/Vibepaws/src/adapters/hook_agent.ts"), "hook 命令必须是绝对路径");
});

test("adapterStatusEvent：带能力声明与版本，且 session_id 固定（重复上报覆盖同一行）", () => {
  const a = adapterStatusEvent("claude_code", "/repo");
  const b = adapterStatusEvent("claude_code", "/repo");
  assert.equal(a.event_type, "adapter_status");
  assert.equal(a.session_id, b.session_id, "固定 session_id：这是声明不是会话，不该每次新建一行");
  assert.deepEqual(a.payload.capabilities, capabilities("claude_code"));
  assert.equal(a.payload.adapter_version, adapterVersion());
  assert.notEqual(a.event_id, b.event_id, "event_id 要各不相同，否则第二次上报会被幂等去重吃掉");
});

test("adapterVersion 跟 package.json 走（写死常量会和发布版本漂移）", () => {
  assert.match(adapterVersion(), /^\d+\.\d+\.\d+/);
});
