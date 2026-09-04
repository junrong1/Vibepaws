/**
 * launch.js 的回归闸。
 *
 * 这里守的每一条都只在**别人的机器上**才会错：登录项启动时没有 PATH、
 * 用户的 node 是 nvm 装的、系统 node 是 v20、app 还在 dmg 里没拖出来。
 * 开发机上这四种情况一种都不会发生，所以它们只能靠把环境摆出来测。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  NODE_FLOOR,
  MAX_CORE_RESTARTS,
  parseNodeVersion,
  meetsNodeFloor,
  nodeCandidates,
  findNodeBinary,
  restartDelay,
  loginItemSupport,
} from "./launch.js";

test("版本解析吃得下 `node --version` 的输出和版本管理器的目录名", () => {
  assert.deepEqual(parseNodeVersion("v22.14.0\n"), { major: 22, minor: 14, patch: 0, raw: "v22.14.0" });
  assert.deepEqual(parseNodeVersion("22.6.0"), { major: 22, minor: 6, patch: 0, raw: "v22.6.0" });
  assert.equal(parseNodeVersion(""), null);
  assert.equal(parseNodeVersion("not a version"), null);
  assert.equal(parseNodeVersion(undefined), null);
});

test("22.6 是硬下限 —— --experimental-strip-types 在它之前不存在", () => {
  assert.deepEqual(NODE_FLOOR, { major: 22, minor: 6 });
  assert.equal(meetsNodeFloor(parseNodeVersion("v22.6.0")), true);
  assert.equal(meetsNodeFloor(parseNodeVersion("v22.5.1")), false);
  assert.equal(meetsNodeFloor(parseNodeVersion("v20.19.0")), false, "v20 的 minor 比 6 大，但大版本不够");
  assert.equal(meetsNodeFloor(parseNodeVersion("v24.0.0")), true);
  assert.equal(meetsNodeFloor(null), false);
});

test("显式覆盖 > npm 的 node > PATH > 固定位置", () => {
  const list = nodeCandidates({
    env: { VIBEPAWS_NODE: "/pick/me", npm_node_execpath: "/npm/node", PATH: "/a:/b" },
    platform: "darwin",
    home: "/Users/x",
  });
  assert.deepEqual(list.slice(0, 4), ["/pick/me", "/npm/node", "/a/node", "/b/node"]);
  assert.ok(list.includes("/opt/homebrew/bin/node"));
  assert.ok(list.includes("/usr/bin/node"));
  assert.ok(list.includes("/Users/x/.volta/bin/node"));
});

test("不拿 electron 当 node —— ELECTRON_RUN_AS_NODE 的 ABI 与 better-sqlite3 对不上", () => {
  const list = nodeCandidates({
    env: { npm_node_execpath: "/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron" },
    platform: "darwin",
  });
  assert.ok(!list.some((p) => /electron/i.test(p)));
});

test("PATH 为空也能找到 node —— 登录项启动时就是这个样子", () => {
  // launchd 给的 PATH 里没有 homebrew、没有任何版本管理器
  const list = nodeCandidates({
    env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    platform: "darwin",
    home: "/Users/x",
    listDir: (dir) => (dir === "/Users/x/.nvm/versions/node" ? ["v20.11.0", "v22.14.0", "v23.1.0"] : []),
  });
  assert.ok(list.includes("/opt/homebrew/bin/node"), "homebrew 不在 launchd 的 PATH 里，必须显式枚举");
  const nvm = list.filter((p) => p.includes("/.nvm/"));
  assert.deepEqual(
    nvm,
    ["/Users/x/.nvm/versions/node/v23.1.0/bin/node", "/Users/x/.nvm/versions/node/v22.14.0/bin/node"],
    "nvm 的版本要新的在前，且低于下限的那个（v20）根本不该进候选",
  );
});

test("候选去重且保序 —— 同一个 node 探测两次是白花 spawn", () => {
  const list = nodeCandidates({
    env: { VIBEPAWS_NODE: "/usr/bin/node", npm_node_execpath: "/usr/bin/node", PATH: "/usr/bin:/usr/bin" },
    platform: "darwin",
  });
  assert.equal(list.filter((p) => p === "/usr/bin/node").length, 1);
});

test("Windows 用 node.exe 和分号 PATH", () => {
  const list = nodeCandidates({ env: { PATH: "C:\\a;C:\\b" }, platform: "win32", home: "C:\\Users\\x" });
  assert.deepEqual(list.slice(0, 2), ["C:\\a\\node.exe", "C:\\b\\node.exe"]);
  assert.ok(list.some((p) => p.endsWith("node.exe") && p.includes("nodejs")));
  assert.ok(!list.some((p) => p.endsWith("/node")));
});

test("取第一个够版本的，探不通的候选跳过", () => {
  const versions = { "/a/node": null, "/b/node": "v20.11.0", "/c/node": "v22.14.0", "/d/node": "v24.0.0" };
  const found = findNodeBinary(Object.keys(versions), (p) => parseNodeVersion(versions[p]));
  assert.equal(found.path, "/c/node");
  assert.equal(found.version, "v22.14.0");
});

test("全都太老时把「太老的是谁」带回来 —— 「找不到 node」是错的诊断", () => {
  const found = findNodeBinary(["/a/node", "/b/node"], () => parseNodeVersion("v20.11.0"));
  assert.equal(found.path, null);
  assert.deepEqual(found.tooOld, [{ path: "/a/node", version: "v20.11.0" }], "同一个版本只报一次");
});

test("探测器抛异常不算致命 —— 候选里必然有一堆不存在的路径", () => {
  const found = findNodeBinary(["/nope/node", "/ok/node"], (p) => {
    if (p === "/nope/node") throw new Error("ENOENT");
    return parseNodeVersion("v22.14.0");
  });
  assert.equal(found.path, "/ok/node");
});

test("重启退避：指数增长、有上限、超过次数就放弃", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5].map(restartDelay),
    [500, 1000, 2000, 4000, 8000],
  );
  assert.equal(restartDelay(MAX_CORE_RESTARTS + 1), null, "放弃比无限重拉好 —— 无限重拉只会刷满日志");
  assert.equal(restartDelay(0), null);
});

test("登录项：dev 模式装不了（会注册 node_modules 里那个 Electron）", () => {
  assert.deepEqual(loginItemSupport({ platform: "darwin", isPackaged: false }), {
    supported: false,
    reason: "dev",
  });
});

test("登录项：Linux 上 Electron 没有这个实现", () => {
  assert.deepEqual(loginItemSupport({ platform: "linux", isPackaged: true }), {
    supported: false,
    reason: "platform",
  });
});

test("登录项：还在 dmg 里运行时装了也是白装 —— 卷一弹出就永久失效", () => {
  assert.deepEqual(
    loginItemSupport({ platform: "darwin", isPackaged: true, appPath: "/Volumes/Vibepaws 0.1.0/Vibepaws.app" }),
    { supported: false, reason: "volume" },
  );
  assert.deepEqual(
    loginItemSupport({ platform: "darwin", isPackaged: true, appPath: "/Applications/Vibepaws.app" }),
    { supported: true, reason: null },
  );
  assert.deepEqual(loginItemSupport({ platform: "win32", isPackaged: true, appPath: "C:\\x" }), {
    supported: true,
    reason: null,
  });
});

test("`npm start` 存在，且 npm test 覆盖 desktop/ —— 单命令启动本身也是交付物", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.ok(pkg.scripts.start, "0.4 的交付物就是一条命令：npm start");
  assert.match(pkg.scripts.test, /desktop\/\*\.test\.js/, "壳层现在有测试了，别让它掉出 test glob");
});
