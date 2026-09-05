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
import { claudeHooksConfig, claudeStatusLineConfig, codexHooksConfig, adapterStatusEvent, adapterVersion, capabilities, hookInterpreter, piCapabilities } from "./hooks.ts";
import { normalizeHook } from "./hook_agent.ts";
import { PI_CAPABILITIES } from "./pi_extension.ts";

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

test("pi：adapterStatusEvent 能力声明与固定 session_id", () => {
  const a = adapterStatusEvent("pi", "/repo");
  assert.equal(a.agent, "pi");
  assert.equal(a.event_type, "adapter_status");
  assert.equal(a.session_id, "adapter-pi");
  assert.deepEqual(a.payload.capabilities, piCapabilities());
  assert.deepEqual(capabilities("pi"), piCapabilities(), "capabilities(pi) 与 piCapabilities 一致");
  assert.equal(a.payload.adapter_version, adapterVersion());
});

test("pi 能力声明与插件真实事件集一致（hooks 与 pi_extension 不能两张皮）", () => {
  assert.deepEqual(piCapabilities(), [...PI_CAPABILITIES]);
  assert.ok(piCapabilities().includes("resume_command"));
  assert.ok(!piCapabilities().includes("permission_required"), "pi 插件没有权限事件，不该在能力里");
});

test("adapterVersion 跟 package.json 走（写死常量会和发布版本漂移）", () => {
  assert.match(adapterVersion(), /^\d+\.\d+\.\d+/);
});

/* ---------------- 解释器（写进用户 agent 配置的那一段） ---------------- */

test("写的是绝对路径而不是裸 node —— 裸 node 由 agent 自己的 PATH 解析，解析到 v20 会静默失败", () => {
  const cmd = hookInterpreter({ execPath: "/opt/homebrew/bin/node", electron: false });
  assert.equal(cmd, "/opt/homebrew/bin/node --experimental-strip-types");
  assert.ok(!/(^|\s)node\s/.test(cmd.replace("/opt/homebrew/bin/node", "")), "命令里不该再出现一个裸 node");
});

test("Homebrew 的 execPath 带版本号，写进去的却该是那条稳定符号链接", () => {
  // brew 装的 node：execPath 是 Cellar 里的真实路径，一次 brew upgrade 就没了
  const cellar = "/opt/homebrew/Cellar/node/25.9.0_2/bin/node";
  const realpath = (p: string) => {
    if (p === "/opt/homebrew/bin/node" || p === cellar) return cellar;
    throw new Error("ENOENT");
  };
  assert.equal(
    hookInterpreter({ execPath: cellar, electron: false, realpath }),
    "/opt/homebrew/bin/node --experimental-strip-types",
    "写 Cellar 路径的话，brew upgrade node 之后 hook 会静默失效",
  );
});

test("稳定路径指向的是**别的** node 时，老实写 execPath —— 宁可将来失效，也不能现在就写错", () => {
  const nvm = "/Users/x/.nvm/versions/node/v22.14.0/bin/node";
  const realpath = (p: string) => {
    if (p === nvm) return nvm;
    if (p === "/opt/homebrew/bin/node") return "/opt/homebrew/Cellar/node/25.9.0_2/bin/node"; // 另一个 node
    throw new Error("ENOENT");
  };
  assert.equal(hookInterpreter({ execPath: nvm, electron: false, realpath }), `${nvm} --experimental-strip-types`);
});

test("realpath 抛错时不炸 —— 装的是 hook，不是解谜游戏", () => {
  const boom = () => {
    throw new Error("EACCES");
  };
  assert.equal(hookInterpreter({ execPath: "/some/node", electron: false, realpath: boom }), "/some/node --experimental-strip-types");
});

test("装在 Electron 下时写 app 自己的二进制 —— 用户一个 node 都不用装", () => {
  const cmd = hookInterpreter({ execPath: "/Applications/Vibepaws.app/Contents/MacOS/Vibepaws", electron: true });
  assert.ok(cmd.startsWith("ELECTRON_RUN_AS_NODE=1 "), "少了它，Electron 会去开一扇窗口而不是当 node 用");
  assert.ok(cmd.includes("/Applications/Vibepaws.app/Contents/MacOS/Vibepaws"));
  assert.ok(cmd.endsWith("--experimental-strip-types"));
});

test("带空格的路径要引起来 —— 这一段是交给 shell 跑的", () => {
  assert.equal(hookInterpreter({ execPath: "/Volumes/My Disk/node", electron: false }), "'/Volumes/My Disk/node' --experimental-strip-types");
  // 单引号自己也得转义，否则一个恶作剧路径就能把命令拆开
  assert.ok(hookInterpreter({ execPath: "/tmp/it's/node", electron: false }).startsWith("'/tmp/it'"));
});

test("卸载认的是路径特征，不是解释器前缀 —— 换了前缀，已经装好的 hook 仍然认得出", () => {
  const hooks = claudeHooksConfig("/repo").hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
  assert.ok(hooks.SessionStart?.[0]?.hooks?.[0]?.command.includes("src/adapters/hook_agent.ts"));
  const sl = (claudeStatusLineConfig("/repo").statusLine as { command: string }).command;
  assert.ok(sl.includes("src/adapters/statusline.ts"), "uninstall.ts 靠这个子串独占识别 statusLine");
});
