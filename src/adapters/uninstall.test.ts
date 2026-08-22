/**
 * adapter 卸载器单测（gap analysis G09）。
 *
 * 这组测试盯的是「卸载会不会顺手吃掉别人的东西」——那类 bug 的代价是用户的配置，
 * 不是我们的功能：
 *   · 别人的 hooks 必须一条不少地留下来（同一个文件里可以有好几个工具）；
 *   · 用户自己的 statusLine 要从备份里捞回来，而不是被一起删掉；
 *   · 只叫 statusline.ts 的第三方脚本不算我们的（这一条是独占字段，认错就是删别人的）；
 *   · dry-run 必须一个字节都不写。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isVibepawsEntry,
  isVibepawsStatusLine,
  rewriteJson,
  inspect,
  scan,
  remove,
  uninstallAdapters,
  purgeDataDirs,
  targetPaths,
} from "./uninstall.ts";

/**
 * 每个用例一套**完整的**假路径：仓库根 + home。
 *
 * 这不是洁癖。本文件的第一版只传了 repoRoot —— 而卸载器的每个入口都同时覆盖
 * 项目级与用户级，于是测试跑完之后，开发机上真实的 ~/.vibepaws 被删掉了，
 * 全局 hooks 也一起被卸了（要重装才回来）。任何一个只传一半沙箱的调用都是同一个 bug。
 */
function sandbox(): { repoRoot: string; home: string } {
  const base = mkdtempSync(join(tmpdir(), "vibepaws-uninstall-"));
  const repoRoot = join(base, "repo");
  const home = join(base, "home");
  mkdirSync(repoRoot, { recursive: true });
  mkdirSync(home, { recursive: true });
  return { repoRoot, home };
}

/** 我们写进去的样子（install.ts：hooks 按事件合并 + statusLine 覆盖式写入） */
function installedClaude(root: string): string {
  return JSON.stringify(
    {
      hooks: {
        SessionStart: [{ matcher: "", hooks: [{ type: "command", command: `node --experimental-strip-types ${root}/src/adapters/hook_agent.ts --agent=claude_code` }] }],
        PreToolUse: [
          { matcher: "", hooks: [{ type: "command", command: "my-own-linter --check" }] },
          { matcher: "", hooks: [{ type: "command", command: `node --experimental-strip-types ${root}/src/adapters/hook_agent.ts --agent=claude_code` }] },
        ],
      },
      statusLine: { type: "command", command: `node --experimental-strip-types ${root}/src/adapters/statusline.ts`, padding: 0 },
      permissions: { allow: ["Bash(ls:*)"] },
    },
    null,
    2,
  );
}

test("hook 条目识别：我们的 command 认得出，别人的碰不着", () => {
  assert.equal(isVibepawsEntry({ hooks: [{ command: "node --experimental-strip-types /x/src/adapters/hook_agent.ts" }] }), true);
  assert.equal(isVibepawsEntry({ hooks: [{ command: "/opt/vibepaws/bin/collect" }] }), true);
  assert.equal(isVibepawsEntry({ hooks: [{ command: "my-own-linter --check" }] }), false);
  assert.equal(isVibepawsEntry(null), false);
});

test("statusLine 识别只认我们自己的路径（第三方的 statusline.ts 不是我们的）", () => {
  assert.equal(isVibepawsStatusLine({ command: "node /x/src/adapters/statusline.ts" }), true);
  // 用户自己写了个同名脚本 —— statusLine 是独占字段，认错就是把别人的状态栏删掉
  assert.equal(isVibepawsStatusLine({ command: "node ~/dotfiles/statusline.ts" }), false);
  assert.equal(isVibepawsStatusLine({ command: "ccusage statusline" }), false);
  assert.equal(isVibepawsStatusLine(undefined), false);
});

test("改写：移除我们的 hooks，别人的一条不动，空掉的事件键顺手清掉", () => {
  const root = "/Users/x/Vibepaws";
  const out = rewriteJson(installedClaude(root), null);
  assert.equal(out.removed_hooks, 2);
  const parsed = JSON.parse(out.text) as Record<string, any>;
  assert.equal(parsed.hooks.SessionStart, undefined, "只剩我们那一条的事件键应该整个消失，而不是留个空数组");
  assert.equal(parsed.hooks.PreToolUse.length, 1);
  assert.equal(parsed.hooks.PreToolUse[0].hooks[0].command, "my-own-linter --check");
  assert.deepEqual(parsed.permissions, { allow: ["Bash(ls:*)"] }, "我们不认识的字段不该被动过");
});

test("改写：hooks 全是我们的时候删掉整个 hooks 字段（不留 \"hooks\": {}）", () => {
  const raw = JSON.stringify({
    hooks: { Stop: [{ hooks: [{ command: "node /x/src/adapters/hook_agent.ts" }] }] },
    model: "opus",
  });
  const parsed = JSON.parse(rewriteJson(raw, null).text) as Record<string, unknown>;
  assert.equal("hooks" in parsed, false);
  assert.equal(parsed.model, "opus", "其他设置要留着 —— 这是用户的 settings.json，不是我们的");
});

test("statusLine：用户原来那条从备份里还原回去", () => {
  const root = "/Users/x/Vibepaws";
  const backup = JSON.stringify({ statusLine: { type: "command", command: "ccusage statusline" } });
  const out = rewriteJson(installedClaude(root), backup);
  assert.equal(out.removed_status_line, true);
  assert.equal(out.restored_status_line, true);
  const parsed = JSON.parse(out.text) as Record<string, any>;
  assert.equal(parsed.statusLine.command, "ccusage statusline");
});

test("statusLine：备份里本来就没有状态栏 → 删掉我们这条，不留一个空对象", () => {
  const out = rewriteJson(installedClaude("/Users/x/Vibepaws"), JSON.stringify({ model: "opus" }));
  assert.equal(out.restored_status_line, false);
  assert.equal("statusLine" in (JSON.parse(out.text) as object), false);
});

test("statusLine：备份也坏了不该让卸载失败（只是不还原）", () => {
  const out = rewriteJson(installedClaude("/Users/x/Vibepaws"), "{ this is not json");
  assert.equal(out.removed_status_line, true);
  assert.equal(out.restored_status_line, false);
});

test("扫描：只报「还有东西可清」的位置，没装过的位置不出现在界面上", () => {
  const { repoRoot, home } = sandbox();
  mkdirSync(join(repoRoot, ".claude"), { recursive: true });
  writeFileSync(join(repoRoot, ".claude", "settings.json"), installedClaude(repoRoot));

  const targets = scan({ repoRoot, home, agents: ["claude_code"] });
  assert.equal(targets.length, 1, "只有项目级那一个位置有东西 —— 用户级是空的假 home");
  assert.equal(targets[0]!.scope, "project");
  assert.equal(targets[0]!.hooks, 2);
  assert.equal(targets[0]!.status_line, true);
});

test("扫描：干净的仓库什么都不报（codex / pi 位置都不存在）", () => {
  const { repoRoot, home } = sandbox();
  assert.deepEqual(scan({ repoRoot, home, agents: ["codex"] }), []);
  assert.deepEqual(scan({ repoRoot, home, agents: ["pi"] }), []);
  assert.deepEqual(scan({ repoRoot, home }), [], "全 agent 扫描在干净沙箱里也必须是空的");
});

test("读不成 JSON 的配置要报出来，不能静静跳过（那就是残留）", () => {
  const { repoRoot: root, home } = sandbox();
  mkdirSync(join(root, ".codex"), { recursive: true });
  writeFileSync(join(root, ".codex", "hooks.json"), "{ half a file");
  const target = scan({ repoRoot: root, home, agents: ["codex"] }).find((t) => t.scope === "project");
  assert.ok(target);
  assert.equal(target.unreadable, true);
  const result = remove(target);
  assert.equal(result.changed, false, "读不成就不该动它");
  assert.ok(result.error, "但必须带着理由回来");
  assert.equal(readFileSync(join(root, ".codex", "hooks.json"), "utf-8"), "{ half a file");
});

test("dry-run 一个字节都不写", () => {
  const { repoRoot: root, home } = sandbox();
  mkdirSync(join(root, ".claude"), { recursive: true });
  const file = join(root, ".claude", "settings.json");
  const before = installedClaude(root);
  writeFileSync(file, before);
  mkdirSync(join(root, ".pi", "extensions"), { recursive: true });
  const plugin = join(root, ".pi", "extensions", "vibepaws.ts");
  writeFileSync(plugin, "// vibepaws pi extension");

  const report = uninstallAdapters({ repoRoot: root, home, agents: ["claude_code", "pi"], dryRun: true });
  assert.equal(report.dry_run, true);
  assert.ok(report.results.some((r) => r.changed), "dry-run 仍要算出「会发生什么」");
  assert.equal(readFileSync(file, "utf-8"), before);
  assert.equal(existsSync(plugin), true, "插件文件在 dry-run 下不该被删");
});

test("真跑一遍：hooks 清掉、pi 插件删掉、废弃 skill 目录也删掉", () => {
  const { repoRoot: root, home } = sandbox();
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(join(root, ".claude", "settings.json"), installedClaude(root));
  mkdirSync(join(root, ".pi", "extensions"), { recursive: true });
  writeFileSync(join(root, ".pi", "extensions", "vibepaws.ts"), "// vibepaws");
  mkdirSync(join(root, ".pi", "skills", "vibepaws"), { recursive: true });
  writeFileSync(join(root, ".pi", "skills", "vibepaws", "SKILL.md"), "# old");

  uninstallAdapters({ repoRoot: root, home, agents: ["claude_code", "pi"] });

  const parsed = JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf-8")) as Record<string, any>;
  assert.equal(parsed.hooks.PreToolUse.length, 1, "别人的 hook 必须活着");
  assert.equal("statusLine" in parsed, false);
  assert.equal(existsSync(join(root, ".pi", "extensions", "vibepaws.ts")), false);
  assert.equal(existsSync(join(root, ".pi", "skills", "vibepaws")), false);

  // 幂等：再跑一次没有可清的了
  assert.deepEqual(uninstallAdapters({ repoRoot: root, home, agents: ["claude_code", "pi"] }).results, []);
});

test("备份仍在时，报告要把它说出来（用户的原始配置在那里）", () => {
  const { repoRoot: root, home } = sandbox();
  mkdirSync(join(root, ".claude"), { recursive: true });
  writeFileSync(join(root, ".claude", "settings.json"), installedClaude(root));
  writeFileSync(join(root, ".claude", "settings.json.vibepaws.bak"), JSON.stringify({ model: "opus" }));
  const report = uninstallAdapters({ repoRoot: root, home, agents: ["claude_code"] });
  assert.ok(report.notes.some((n) => n.key === "uninstall.note.backups"));
});

test("数据目录：dry-run 不删，真跑才删（卸载的最后一步）", () => {
  const { repoRoot: root, home } = sandbox();
  for (const dir of [join(root, ".vibepaws"), join(home, ".vibepaws")]) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "api_token"), "deadbeef");
  }

  const dry = purgeDataDirs({ repoRoot: root, home, dryRun: true });
  assert.deepEqual(dry.map((p) => p.deleted), [true, true], "dry-run 也要报告「会删」");
  assert.equal(existsSync(join(root, ".vibepaws")), true);
  assert.equal(existsSync(join(home, ".vibepaws")), true);

  purgeDataDirs({ repoRoot: root, home });
  // 仓库根与用户级两处都要清：只删一处的卸载会留下一个还带着 api_token 的目录
  assert.equal(existsSync(join(root, ".vibepaws")), false);
  assert.equal(existsSync(join(home, ".vibepaws")), false);
});

test("目标清单覆盖项目级与用户级（只清一个 scope 等于没卸载）", () => {
  const paths = targetPaths({ repoRoot: "/tmp/repo", home: "/tmp/home" });
  assert.ok(paths.every((p) => p.file.startsWith("/tmp/")), "home 必须是参数：默认值会指向开发机真实的家目录");
  for (const agent of ["claude_code", "codex", "pi"] as const) {
    const scopes = paths.filter((p) => p.agent === agent).map((p) => p.scope);
    assert.ok(scopes.includes("project"));
    assert.ok(scopes.includes("global"));
  }
  // inspect 对不存在的路径必须是安全的（扫描会走遍全部 8 个位置）
  assert.equal(inspect(paths[0]!).exists, false);
});
