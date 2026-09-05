#!/usr/bin/env node
/**
 * 打包前把 dsh 插件预转译成 CommonJS，和 .ts 并排放在 src/adapters/ 下。
 *
 * 为什么必须在**打包时**做：转译要 `import typescript`，而 typescript 是 devDependency，
 * 不在 .app 里。运行时再转译，就等于要求 app 携带一个 22MB 的编译器，只为了「用户可能
 * 会装 dsh」这一件事。
 *
 * 生成物是 gitignore 的：源码只有 .ts 一份（ESM + 类型 + 单测），.cjs 是产物。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { transpileDshPlugin } from "../src/adapters/dsh_compile.ts";

const dir = join(import.meta.dirname, "..", "src", "adapters");
const src = join(dir, "dsh_plugin.ts");
const out = join(dir, "dsh_plugin.cjs");

const cjs = transpileDshPlugin(readFileSync(src, "utf-8"));
writeFileSync(out, cjs);
// 转译静默产出一个空文件是可能的（源码读错、TS 版本换了），而那种插件 dsh 加载不会报错，
// 只会安静地什么都不做 —— 所以这里当场念一遍
if (!cjs.includes("exports") || cjs.length < 200) {
  throw new Error(`转译结果不像一个 CJS 模块（${cjs.length} 字节）—— 不要把它打进包里`);
}
console.log(`[vibepaws] ✓ dsh 插件已预转译 → ${out} (${cjs.length} 字节)`);
