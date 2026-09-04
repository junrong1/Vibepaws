#!/usr/bin/env node
/**
 * 发布产物签名 / 公证验收。
 *
 * 存在的理由：签名这条链上每一环失败的表现都是"用户那边打不开"，而在自己机器上
 * 一切正常 —— 开发机的 app 没有 quarantine 标记，Gatekeeper 根本不评估它。
 * 所以"我这儿能跑"证明不了任何事，必须显式地把 Apple 的判断问出来。
 *
 * 两种模式：
 *   --preflight   构建前体检：有没有证书、公证凭据齐不齐、notarytool 在不在。
 *                 不需要产物，没有证书的机器上也能跑，用来在开始打包之前就知道会不会白打。
 *   （默认）       构建后验收：对 dist/ 里的 .app 和 .dmg 逐项核对签名、hardened runtime、
 *                 授权清单、公证票、以及包内每一个 Mach-O 是否都签到了。
 *
 * 最后一项是这个仓库特有的坑：better-sqlite3 的 .node 是通过 extraResources 进到
 * Contents/Resources 的，不在 asar 里。osx-sign 靠 isbinaryfile 走查目录来发现它们
 * （node_modules/@electron/osx-sign/dist/esm/util.js:114 walkAsync），
 * 一旦哪次打包配置动了让它漏掉，公证会被 Apple 拒，而本地测试完全看不出来。
 *
 * ## 用法
 *   npm run verify:release -- --preflight
 *   npm run verify:release
 *   npm run verify:release -- --app dist/mac-arm64/Vibepaws.app --dmg dist/Vibepaws-0.1.0-arm64.dmg
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

const PREFLIGHT = has("preflight");
const DIST = arg("dist") ?? "dist";

/** 主进程授权清单里必须出现的键。缺了 JIT 那两条，签名后的 app 启动即被内核杀掉。 */
const REQUIRED_ENTITLEMENTS = [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
];

let failures = 0;
let warnings = 0;

function ok(msg: string): void {
  console.log(`✓ ${msg}`);
}
function warn(msg: string): void {
  warnings++;
  console.log(`⚠ ${msg}`);
}
function fail(msg: string): void {
  failures++;
  console.log(`✗ ${msg}`);
}

/**
 * 跑一条命令，stdout / stderr 合并返回，成败只看退出码。
 *
 * 这里踩过一次坑：codesign / spctl 的正文全写在 stderr 上，成功时 stdout 是空的。
 * 早先的实现用 execFileSync 只取 stdout，再拿正则去匹配 "valid on disk" ——
 * 结果是一个签得好好的 app 被报成"校验失败"，而且失败信息还是空的。
 * 退出码才是这些工具唯一可靠的信号。
 */
function run(cmd: string, args: string[]): { ok: boolean; out: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.error) return { ok: false, out: r.error.message };
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

/** 只要输出、不关心成败的场合（读 Authority、读授权清单这类）。 */
function sh(cmd: string, args: string[]): string {
  return run(cmd, args).out;
}

// ─────────────────────────────────────────── preflight

function preflight(): void {
  console.log("[vibepaws] 发布体检 — 构建前\n");

  const identities = sh("security", ["find-identity", "-v", "-p", "codesigning"]);
  const devIdLines = identities.split("\n").filter((l) => l.includes("Developer ID Application"));
  if (devIdLines.length > 0) {
    ok(`找到 Developer ID Application 证书 ${devIdLines.length} 张`);
    for (const l of devIdLines) console.log(`    ${l.trim()}`);
  } else {
    warn('钥匙串里没有 "Developer ID Application" 证书 —— 构建会跳过签名，产出未签名产物');
    console.log("    电脑上没有证书不是错误：本地开发一直是这么跑的。");
    console.log("    只有要分发时才需要，见 docs/release_signing.md");
  }

  const apiKey = process.env.APPLE_API_KEY && process.env.APPLE_API_KEY_ID && process.env.APPLE_API_ISSUER;
  const appleId = process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID;
  const keychainProfile = process.env.APPLE_KEYCHAIN_PROFILE;

  if (apiKey) {
    ok("公证凭据：App Store Connect API key（APPLE_API_KEY / _KEY_ID / _ISSUER）");
  } else if (appleId) {
    ok("公证凭据：Apple ID（APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID）");
  } else if (keychainProfile) {
    ok(`公证凭据：钥匙串档案 ${keychainProfile}`);
  } else {
    warn("没有公证凭据 —— 构建会跳过公证");
    // 半套凭据是真错误：会让 electron-builder 在打包末尾才抛，白等一次完整构建
    const partial: string[] = [];
    for (const v of ["APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER", "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID"]) {
      if (process.env[v]) partial.push(v);
    }
    if (partial.length > 0) fail(`凭据只给了一半：${partial.join(", ")} —— 这会让构建在最后一步才失败`);
  }

  const notarytool = run("xcrun", ["notarytool", "--version"]);
  if (notarytool.ok) ok(`notarytool 可用（${notarytool.out.trim().split("\n").pop()}）`);
  else fail("notarytool 不可用 —— 需要 Xcode 13+ 命令行工具（xcode-select --install）");

  for (const p of ["build/entitlements.mac.plist", "build/entitlements.mac.inherit.plist"]) {
    if (!existsSync(p)) {
      fail(`授权清单缺失：${p}`);
      continue;
    }
    const lint = run("plutil", ["-lint", p]);
    if (lint.ok) ok(`授权清单格式正确：${p}`);
    else fail(`授权清单格式错误：${p} — ${lint.out.trim()}`);
  }
}

// ─────────────────────────────────────────── 构建后验收

function findApp(): string | undefined {
  const explicit = arg("app");
  if (explicit) return existsSync(explicit) ? explicit : undefined;
  if (!existsSync(DIST)) return undefined;
  for (const entry of readdirSync(DIST)) {
    const dir = join(DIST, entry);
    if (!statSync(dir).isDirectory() || !entry.startsWith("mac")) continue;
    for (const child of readdirSync(dir)) {
      if (child.endsWith(".app")) return join(dir, child);
    }
  }
  return undefined;
}

function findDmgs(): string[] {
  const explicit = arg("dmg");
  if (explicit) return existsSync(explicit) ? [explicit] : [];
  if (!existsSync(DIST)) return [];
  return readdirSync(DIST)
    .filter((f) => f.endsWith(".dmg"))
    .map((f) => join(DIST, f));
}

/** 包里所有 Mach-O 文件 —— 每一个都必须单独签名，否则公证被拒。 */
function machoFiles(appPath: string): string[] {
  const all = sh("/bin/sh", ["-c", `find '${appPath}' -type f`]).split("\n").filter(Boolean);
  const out: string[] = [];
  const BATCH = 200;
  for (let i = 0; i < all.length; i += BATCH) {
    const batch = all.slice(i, i + BATCH);
    const args = batch.map((f) => `'${f.replace(/'/g, "'\\''")}'`).join(" ");
    const res = sh("/bin/sh", ["-c", `file ${args}`]);
    for (const line of res.split("\n")) {
      const idx = line.indexOf(": ");
      if (idx < 0) continue;
      const path = line.slice(0, idx);
      const desc = line.slice(idx + 2);
      if (desc.includes("Mach-O")) out.push(path);
    }
  }
  return out;
}

function verifyApp(appPath: string): void {
  console.log(`\n[vibepaws] 验收 app：${appPath}`);

  const verify = run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  if (verify.ok) {
    ok("codesign --verify --deep --strict 通过");
  } else {
    fail(`codesign 校验失败：${verify.out.trim().split("\n").slice(0, 5).join(" / ")}`);
    console.log("    产物很可能根本没签名（本地无证书构建就是这个结果）。");
    return;
  }

  const info = sh("codesign", ["-dv", "--verbose=4", appPath]);
  if (/Signature=adhoc/.test(info)) {
    fail("这是 ad-hoc 签名（codesign -s -），不是 Developer ID —— 能过 --verify，但分发出去照样打不开");
  }
  const authority = info.split("\n").find((l) => l.startsWith("Authority="));
  if (authority?.includes("Developer ID Application")) ok(`签名主体：${authority.replace("Authority=", "").trim()}`);
  else fail(`签名主体不是 Developer ID Application：${authority ?? "（没读到 Authority）"}`);

  const team = info.split("\n").find((l) => l.startsWith("TeamIdentifier="));
  if (team && !team.includes("not set")) ok(team.trim());
  else fail("TeamIdentifier 缺失 —— 不是有效的分发签名");

  if (/flags=.*runtime/.test(info)) ok("hardened runtime 已开启");
  else fail("hardened runtime 没开 —— 公证一定会被拒（codesign flags 里没有 runtime）");

  const ents = sh("codesign", ["-d", "--entitlements", ":-", appPath]);
  for (const key of REQUIRED_ENTITLEMENTS) {
    if (ents.includes(key)) ok(`授权已嵌入：${key}`);
    else fail(`授权缺失：${key} —— 签名后的 app 会启动即崩`);
  }

  const staple = run("xcrun", ["stapler", "validate", appPath]);
  if (staple.ok) ok("公证票已装订到 .app");
  else fail(`.app 没有公证票：${staple.out.trim().split("\n")[0] ?? ""}`);

  const assess = sh("spctl", ["-a", "-vvv", "-t", "exec", appPath]);
  if (assess.includes("accepted")) {
    ok(`Gatekeeper 评估：${assess.split("\n").filter(Boolean).join(" / ").trim()}`);
    if (!assess.includes("Notarized")) warn("Gatekeeper 接受了，但来源不是 Notarized Developer ID");
  } else {
    fail(`Gatekeeper 拒绝：${assess.trim().split("\n").join(" / ")}`);
  }

  const machos = machoFiles(appPath);
  const unsigned: string[] = [];
  for (const f of machos) {
    const r = run("codesign", ["--verify", "--strict", f]);
    if (!r.ok) unsigned.push(f);
  }
  if (unsigned.length === 0) {
    ok(`包内 ${machos.length} 个 Mach-O 全部已签名（含 better-sqlite3 的 .node）`);
  } else {
    fail(`${unsigned.length}/${machos.length} 个 Mach-O 未签名 —— 公证会被 Apple 拒：`);
    for (const f of unsigned.slice(0, 10)) console.log(`    ${f.replace(appPath, "")}`);
  }
}

function verifyDmg(dmgPath: string): void {
  console.log(`\n[vibepaws] 验收 dmg：${dmgPath}`);

  const verify = run("codesign", ["--verify", "--strict", "--verbose=2", dmgPath]);
  if (verify.ok) ok("dmg 已签名");
  else fail(`dmg 未签名或签名无效：${verify.out.split("\n")[0] ?? ""}`);

  const staple = run("xcrun", ["stapler", "validate", dmgPath]);
  if (staple.ok) {
    ok("公证票已装订到 dmg（用户双击 dmg 不会再看到「无法验证开发者」）");
  } else {
    fail("dmg 没有公证票 —— 用户双击 dmg 时仍会被拦；见 build/notarize-dmg.cjs");
  }
}

// ─────────────────────────────────────────── main

if (process.platform !== "darwin") {
  console.error("[vibepaws] 这个脚本只在 macOS 上有意义");
  process.exit(1);
}

if (PREFLIGHT) {
  preflight();
} else {
  console.log("[vibepaws] 发布验收 — 构建后\n");
  const app = findApp();
  if (!app) {
    console.error(`✗ 在 ${DIST}/ 里没找到 .app —— 先跑 npm run dist:mac，或用 --app <路径> 指定`);
    process.exit(1);
  }
  verifyApp(app);

  const dmgs = findDmgs();
  if (dmgs.length === 0) warn(`在 ${DIST}/ 里没找到 .dmg`);
  for (const d of dmgs) verifyDmg(d);
}

console.log();
if (failures > 0) {
  console.log(`[vibepaws] ✗ ${failures} 项不通过${warnings > 0 ? `，${warnings} 项警告` : ""}`);
  process.exit(1);
}
console.log(`[vibepaws] ✓ 全部通过${warnings > 0 ? `（${warnings} 项警告）` : ""}`);
