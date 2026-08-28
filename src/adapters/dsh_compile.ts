/**
 * dsh_compile.ts — 把 ESM 的 dsh_plugin.ts 源码转译成 CommonJS。
 *
 * dsh 的 loader 用 require()（internal.import）加载插件入口，ESM 的 `.ts` 会触发
 * Node 的 require(esm)（loadESMFromCJS → importSyncForRequire），在入口正被
 * import() 求值时抛 ERR_REQUIRE_CYCLE_MODULE。转译成 `.cjs` 后，require() 即普通
 * CJS 加载，绕开 require(esm)。
 *
 * 只在安装时调用（install.ts），保留 `.ts` 作为唯一源码（ESM + 类型 + 单测）。
 */
import ts from "typescript";

/** 把 dsh_plugin.ts（ESM TypeScript）转译成 CommonJS JavaScript 源码。 */
export function transpileDshPlugin(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText;
}
