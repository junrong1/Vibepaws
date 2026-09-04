/**
 * 打包 / 签名配置的回归闸。
 *
 * 这些断言看着琐碎，但它们守的每一条都真的踩过，而且共同点是：
 * 错了不会在本地暴露 —— 开发机上的 app 没有 quarantine 标记，Gatekeeper 根本不评估它，
 * 一切照跑。等发现的时候，已经是用户那边打不开了。
 *
 *   1. hardenedRuntime + 授权清单：少了 allow-jit，签名后的 app 一启动就被内核杀掉。
 *      而未签名的本地构建完全正常 —— 只有签了名才会崩。
 *   2. asar 里不许再出现 better-sqlite3：Core 是外部系统 node 跑的，只会从
 *      Contents/Resources/node_modules 解析，asar 里那份没有任何人 require。
 *      它曾经白占 26 MB，还让必须签名的 Mach-O 数量翻倍（19 → 16）。
 *   3. 预编译产物只留当前架构那一个：多出来的每个 .node 都是一处可能漏签的地方，
 *      而漏签的直接后果是 Apple 拒绝公证。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

type ExtraResource = { from: string; to: string; filter?: string[] };
type Pkg = {
  build: {
    files: string[];
    extraResources: ExtraResource[];
    afterAllArtifactBuild: string;
    mac: {
      hardenedRuntime?: boolean;
      entitlements?: string;
      entitlementsInherit?: string;
      notarize?: boolean;
    };
  };
};

const pkg = JSON.parse(readFileSync("package.json", "utf8")) as Pkg;

/** 缺了这两条，签名后的 app 启动即崩 —— V8 要 JIT，这是 Electron 公证的前置条件。 */
const REQUIRED_ENTITLEMENTS = [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
];

test("mac 构建开着 hardened runtime —— 关掉的话 Apple 直接拒绝公证", () => {
  assert.equal(pkg.build.mac.hardenedRuntime, true, "build.mac.hardenedRuntime 必须显式为 true");
  assert.equal(pkg.build.mac.notarize, true, "build.mac.notarize 必须显式为 true");
});

test("两份授权清单都存在，且都带齐 JIT 授权", () => {
  const paths = [pkg.build.mac.entitlements, pkg.build.mac.entitlementsInherit];
  for (const p of paths) {
    assert.ok(p, "entitlements / entitlementsInherit 都必须在 package.json 里写明");
    assert.ok(existsSync(p), `授权清单文件不存在：${p}`);
    const xml = readFileSync(p, "utf8");
    for (const key of REQUIRED_ENTITLEMENTS) {
      assert.ok(xml.includes(key), `${p} 缺少授权 ${key} —— 签名后的 app 会启动即崩`);
    }
  }
});

test("子进程授权清单不含 com.apple.security.inherit（非沙箱构建里那是无效授权）", () => {
  const p = pkg.build.mac.entitlementsInherit;
  assert.ok(p);
  const xml = readFileSync(p, "utf8");
  assert.ok(!xml.includes("<key>com.apple.security.inherit</key>"), "只有开了 app-sandbox 才该出现这个键");
});

test("dmg 公证钩子挂着且能加载 —— 它是「用户双击 dmg 不被拦」的唯一保证", () => {
  const hook = pkg.build.afterAllArtifactBuild;
  assert.ok(hook, "afterAllArtifactBuild 没配");
  const p = hook.replace(/^\.\//, "");
  assert.ok(existsSync(p), `钩子文件不存在：${p}`);
});

test("壳的测试文件不进包 —— 它只在 npm test 里有意义", () => {
  assert.ok(
    pkg.build.files.includes("!desktop/*.test.js"),
    "desktop/** 会把 launch.test.js 一起打进去：用户装的 app 里不该有测试",
  );
});

test("asar 里排除了 better-sqlite3 —— 否则 26 MB 死重 + 签名面翻倍", () => {
  assert.ok(
    pkg.build.files.includes("!node_modules/better-sqlite3/**"),
    "build.files 必须显式排除 better-sqlite3：Core 用外部 node 跑，只从 Resources/node_modules 解析",
  );
});

test("只随当前架构发一个预编译 .node —— 多一个就多一处可能漏签", () => {
  const bs = pkg.build.extraResources.filter((r) => r.from.includes("better-sqlite3"));
  assert.equal(bs.length, 2, "应当是一条排掉全部 prebuilds、一条按 ${arch} 放回单个 .node");

  const bulk = bs.find((r) => r.filter);
  assert.ok(bulk?.filter?.includes("!prebuilds/**"), "整包那条必须排掉 prebuilds/**");

  const single = bs.find((r) => r.from.endsWith(".node"));
  assert.ok(single, "缺少按架构放回单个 .node 的那条");
  assert.match(single.from, /darwin-\$\{arch\}\.node$/, "必须用 ${arch} 宏，写死架构会让另一个架构的构建拿不到 .node");
});

test("Core 的入口仍然随包发出去 —— 签名配置动过 extraResources，别把 src/ 弄丢了", () => {
  const tos = pkg.build.extraResources.map((r) => r.to);
  for (const need of ["src", "ui"]) {
    assert.ok(tos.includes(need), `extraResources 缺少 ${need}/`);
  }
});
