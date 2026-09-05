/**
 * adapter 安装器单测。
 *
 * 这组测试盯的是「装完之后到底装上没有」，因为这条路径的失败是**安静的**：
 * 安装器打印一行 ✓，配置文件却是空的 / 指向一个不存在的文件，而用户要等到
 * 下一次开 agent、发现宠物一直不动，才知道出了事。
 *   · 全局装完 hooks 必须真的在文件里（曾经会被自己的「清理项目级重复」删光）；
 *   · 写进配置的那条命令必须指向**真实存在**的 hook_agent.ts；
 *   · dry-run 一个字节都不写（连目录都不建）；
 *   · home 必须可注入 —— 否则这里每跑一次都在改开发机上真实的 ~/.claude/settings.json。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectAgents, installAdapter, SOURCE_ROOT } from "./install.ts";

function sandbox(): string {
  return mkdtempSync(join(tmpdir(), "vibepaws-install-"));
}

function claudeSettings(home: string): Record<string, any> {
  return JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8"));
}

test("全局安装之后 hooks 真的在文件里", async () => {
  const home = sandbox();
  try {
    const report = await installAdapter({ selfCheck: false, agent: "claude_code", global: true, home, projectRoot: sandbox() });
    assert.equal(report.ok, true);
    const cfg = claudeSettings(home);
    assert.ok(Object.keys(cfg.hooks ?? {}).length > 5, "hooks 应该被写进去");
    assert.ok(cfg.statusLine, "statusLine 是 Claude Code 的实时 token 通道，要一起装");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("项目根就是 home 时不能把自己刚写的 hooks 清掉", async () => {
  // `cd ~ && 装全局`，或者 Core 的数据目录恰好在 home 下 —— 这时项目级路径和全局路径
  // 是同一个文件。清理「项目级重复」会忠实地把刚写进去的 hooks 全删光，
  // 只剩 statusLine，而安装器还在打印「✓ 写入成功」。
  const home = sandbox();
  try {
    const report = await installAdapter({ selfCheck: false, agent: "claude_code", global: true, home, projectRoot: home });
    assert.equal(report.ok, true);
    const cfg = claudeSettings(home);
    assert.ok(Object.keys(cfg.hooks ?? {}).length > 5, "hooks 被自己的清理逻辑吃掉了");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("写进配置的命令指向真实存在的 hook_agent.ts —— 打包后 cwd 不是仓库根", async () => {
  const home = sandbox();
  try {
    // projectRoot 故意给一个和 src/ 毫无关系的目录，模拟 Core 在 userData 下跑
    await installAdapter({ selfCheck: false, agent: "claude_code", global: true, home, projectRoot: sandbox() });
    const cmd: string = claudeSettings(home).hooks.SessionStart[0].hooks[0].command;
    const entry = cmd.split(" ").find((part) => part.endsWith("hook_agent.ts"));
    assert.ok(entry, `命令里应该有 hook_agent.ts：${cmd}`);
    assert.ok(existsSync(entry!), `hook 指向的文件必须存在：${entry}`);
    assert.ok(entry!.startsWith(SOURCE_ROOT), "路径应该从素材根推出来，而不是从 cwd");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("dry-run 一个字节都不写，连目录都不建", async () => {
  const home = sandbox();
  try {
    const report = await installAdapter({ selfCheck: false, agent: "claude_code", global: true, dryRun: true, home, projectRoot: home });
    assert.equal(report.ok, true);
    assert.equal(report.selfCheck, null, "什么都没写，也就没什么可自检的");
    assert.equal(existsSync(join(home, ".claude")), false, "「只是看看会发生什么」不该留下痕迹");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("四个 agent 都装得出来，且各自落在自己的目录里", async () => {
  for (const agent of ["claude_code", "codex", "pi", "dsh"] as const) {
    const home = sandbox();
    try {
      const report = await installAdapter({ selfCheck: false, agent, global: true, home, projectRoot: sandbox() });
      assert.equal(report.ok, true, `${agent} 安装失败：${report.notes.join(" / ")}`);
      assert.ok(report.file.startsWith(home), `${agent} 应该写在注入的 home 下，实际：${report.file}`);
      assert.ok(existsSync(report.file), `${agent} 说写了 ${report.file}，但文件不在`);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test("认不出来的 agent 不写任何东西，只是说它不认识", async () => {
  const home = sandbox();
  try {
    const report = await installAdapter({ selfCheck: false, agent: "emacs" as never, global: true, home });
    assert.equal(report.ok, false);
    assert.equal(report.file, "");
    assert.equal(existsSync(join(home, ".claude")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("detectAgents 分得清「机器上有这个 agent」和「Vibepaws 装上了」", async () => {
  const home = sandbox();
  const project = sandbox();
  try {
    const before = detectAgents({ home, projectRoot: project });
    assert.deepEqual(
      before.map((a) => [a.agent, a.detected, a.installed]),
      [
        ["claude_code", false, false],
        ["codex", false, false],
        ["pi", false, false],
        ["dsh", false, false],
      ],
      "空 home 上四个都该是「没有、没装」",
    );

    await installAdapter({ selfCheck: false, agent: "claude_code", global: true, home, projectRoot: project });
    const after = detectAgents({ home, projectRoot: project });
    const claude = after.find((a) => a.agent === "claude_code")!;
    assert.equal(claude.detected, true, "配置目录已经在了");
    assert.equal(claude.installed, true, "而且是我们装的");
    assert.ok(claude.files.length > 0, "界面上要说得出装在哪个文件里");
    assert.equal(after.find((a) => a.agent === "codex")!.installed, false, "别的 agent 不该被连带认成已装");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  }
});
