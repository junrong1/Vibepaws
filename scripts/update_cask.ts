#!/usr/bin/env node
/**
 * 把 Casks/vibepaws.rb 的 version / sha256 刷成**真实发布产物**的值。
 *
 * 为什么需要一个脚本而不是手抄：cask 里的 sha256 一旦和 release 上挂着的 dmg 对不上，
 * `brew install --cask` 会在下载完之后才报校验失败 —— 用户等了一分钟，拿到的是一句
 * "SHA256 mismatch"，而这看起来像是产物被人动过手脚。手抄一个 64 位十六进制串，
 * 迟早会错一次。
 *
 * 两种用法：
 *   npm run cask:update -- --dmg dist/Vibepaws-0.1.0-arm64.dmg   # 本地构建的产物
 *   npm run cask:update -- --version 0.1.0                       # 去 GitHub Release 上拉
 *
 * dmg 不是可复现构建（时间戳、压缩顺序都会变），所以**发布用的那一份 sha 必须来自
 * 真正上传的那个文件**，不能来自本地随便一次构建。CI 走的是 --dmg，指向它刚上传的那份。
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const CASK = join(import.meta.dirname, "..", "Casks", "vibepaws.rb");
const REPO = "junrong1/Vibepaws";

function sha256(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

async function fetchDmg(version: string): Promise<Uint8Array> {
  const url = `https://github.com/${REPO}/releases/download/v${version}/Vibepaws-${version}-arm64.dmg`;
  console.log(`[vibepaws] 下载 ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载失败 ${res.status} —— release 上有这个文件吗？`);
  return new Uint8Array(await res.arrayBuffer());
}

async function main(): Promise<void> {
  const dmgPath = arg("dmg");
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf-8")) as { version: string };
  const version = arg("version") ?? pkg.version;

  const bytes = dmgPath ? new Uint8Array(readFileSync(dmgPath)) : await fetchDmg(version);
  const hash = sha256(bytes);

  const before = readFileSync(CASK, "utf-8");
  const after = before
    .replace(/^(\s*version\s+)"[^"]*"/m, `$1"${version}"`)
    .replace(/^(\s*sha256\s+)"[^"]*"/m, `$1"${hash}"`);

  if (after === before) {
    console.log(`[vibepaws] cask 已经是最新的（v${version}，${hash.slice(0, 12)}…）`);
    return;
  }
  writeFileSync(CASK, after);
  console.log(`[vibepaws] ✓ cask → v${version}  sha256=${hash.slice(0, 12)}…`);
  // 改完必须自己念一遍：正则替换错了目标（比如改到 caveats 里的字符串）不会报错，
  // 只会在用户 brew install 的时候炸
  const check = readFileSync(CASK, "utf-8");
  if (!check.includes(`version "${version}"`) || !check.includes(`sha256 "${hash}"`)) {
    throw new Error("写回之后没读到期望的值 —— cask 的格式可能变了，请手工确认");
  }
}

await main();
