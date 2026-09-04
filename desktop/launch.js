/**
 * 启动期的三件事：找到能跑 Core 的 node、决定崩溃后什么时候重拉、判断登录项装不装得上。
 *
 * 单独成文件而不是塞进 main.js，是因为这三件事都**只在别人的机器上出错**：
 * 开发机上 node 在 PATH 里、Core 从不崩、登录项从来没人装过。所以它们必须是
 * 纯函数 + 可注入的探测器，能在 `npm test` 里把那些环境一个个摆出来。
 *
 * 不 import electron —— 这里的每个导出都要能在 node 测试进程里直接跑。
 */
import { posix, win32 } from "node:path";

/**
 * Core / UI server / hook 命令全都跑在 `node --experimental-strip-types` 上，
 * 而这个 flag 在 22.6 之前不存在。低于这条线的 node 不是「慢一点」，是根本起不来。
 */
export const NODE_FLOOR = { major: 22, minor: 6 };

/** `v22.14.0` / `22.14.0` / 目录名 `v22.14.0` → 结构化版本；解析不出来返回 null。 */
export function parseNodeVersion(text) {
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(String(text ?? "").trim());
  if (!m) return null;
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return { major, minor, patch, raw: `v${major}.${minor}.${patch}` };
}

export function meetsNodeFloor(v) {
  if (!v) return false;
  if (v.major !== NODE_FLOOR.major) return v.major > NODE_FLOOR.major;
  return v.minor >= NODE_FLOOR.minor;
}

function descByVersion(a, b) {
  return b.v.major - a.v.major || b.v.minor - a.v.minor || b.v.patch - a.v.patch;
}

/**
 * 候选 node 可执行文件，按「越可能是用户自己那个」排序。
 *
 * 为什么不能只信 PATH：**从登录项启动时根本没有用户的 PATH**。launchd 给的是
 * `/usr/bin:/bin:/usr/sbin:/sbin`，nvm / fnm / volta / homebrew 一个都不在里面。
 * 自启是这个功能的全部意义，所以版本管理器的安装位置必须显式枚举 ——
 * 否则「开机自启」的实际效果是每天开机看到一次「Core 未连接」。
 *
 * @param {{env?: Record<string,string|undefined>, platform?: string, home?: string,
 *          listDir?: (dir: string) => string[]}} opts
 * @returns {string[]} 绝对路径，已去重
 */
export function nodeCandidates({ env = {}, platform = "darwin", home = "", listDir = () => [] } = {}) {
  const win = platform === "win32";
  const exe = win ? "node.exe" : "node";
  // 目标平台的分隔符，而不是**当前**平台的 —— 否则这个函数只能在它自己的平台上被测
  const join = (...parts) => (win ? win32 : posix).join(...parts);
  const out = [];
  const push = (p) => {
    if (p && !out.includes(p)) out.push(p);
  };

  // 显式覆盖：装了多个 node 又想指定哪个的唯一出口（也是这个函数的测试后门）
  push(env.VIBEPAWS_NODE);
  // dev：npm 把「跑 npm 的那个 node」写进环境变量，它必然就是 `npm run core` 会用的那个。
  // 排除 electron —— ELECTRON_RUN_AS_NODE 的 ABI 与 better-sqlite3 的预编译产物对不上。
  if (env.npm_node_execpath && !/electron/i.test(env.npm_node_execpath)) push(env.npm_node_execpath);

  for (const dir of String(env.PATH ?? "").split(win ? ";" : ":")) {
    if (dir) push(join(dir, exe));
  }

  const fixed = win
    ? ["C:\\Program Files\\nodejs", join(home, "AppData\\Local\\Volta\\bin")]
    : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", join(home, ".volta/bin")];
  for (const dir of fixed) push(join(dir, exe));

  // 版本管理器：目录名就是版本号，新的排前面
  const managed = [
    { root: join(home, ".nvm/versions/node"), bin: ["bin"] },
    { root: join(home, ".fnm/node-versions"), bin: ["installation", "bin"] },
    { root: join(home, "Library/Application Support/fnm/node-versions"), bin: ["installation", "bin"] },
    { root: "/usr/local/n/versions/node", bin: ["bin"] },
  ];
  for (const { root, bin } of managed) {
    const dirs = listDir(root)
      .map((name) => ({ name, v: parseNodeVersion(name) }))
      .filter((e) => e.v && meetsNodeFloor(e.v))
      .sort(descByVersion);
    for (const { name } of dirs) push(join(root, name, ...bin, exe));
  }

  return out;
}

/**
 * 逐个探测候选，返回第一个够版本的。
 *
 * 顺带把「找到了但太老」的那些原样带回来 —— 用户装了 node v20 时，
 * 「找不到 node」是错的诊断，「找到 /usr/local/bin/node v20.11.0，但需要 ≥ 22.6」才是。
 *
 * @param {string[]} candidates
 * @param {(path: string) => {major:number,minor:number,patch:number,raw:string} | null} probe
 */
export function findNodeBinary(candidates, probe) {
  const tooOld = [];
  for (const path of candidates) {
    let v = null;
    try {
      v = probe(path);
    } catch {
      continue;
    }
    if (!v) continue;
    if (meetsNodeFloor(v)) return { path, version: v.raw, tooOld };
    if (!tooOld.some((e) => e.version === v.raw)) tooOld.push({ path, version: v.raw });
  }
  return { path: null, version: null, tooOld };
}

/** 连续崩溃几次之后就不再重拉 —— 再拉下去只是把同一个报错刷满日志。 */
export const MAX_CORE_RESTARTS = 5;
/** 拉起来撑过这么久，就认为上一轮崩溃跟这一轮无关，重置计数。 */
export const CORE_HEALTHY_MS = 60_000;

/**
 * 第 attempt 次重启前等多久（毫秒）；超出上限返回 null = 放弃。
 * 指数退避的理由很实在：端口被占、数据库被锁这类原因，等一会儿真的会好；
 * 而「代码有 bug」这类原因，等多久都不会好，所以还要有个上限。
 */
export function restartDelay(attempt) {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > MAX_CORE_RESTARTS) return null;
  return Math.min(500 * 2 ** (attempt - 1), 8000);
}

/**
 * 登录项能不能装。三种装不上的情况，每种都得说出原因 ——
 * 一个点了没反应的开关比一个禁用的开关难查得多。
 *
 * @param {{platform?: string, isPackaged?: boolean, appPath?: string}} opts
 * @returns {{supported: boolean, reason: null | "platform" | "dev" | "volume"}}
 */
export function loginItemSupport({ platform = "darwin", isPackaged = false, appPath = "" } = {}) {
  // Electron 的 setLoginItemSettings 只在 macOS / Windows 上有实现
  if (platform !== "darwin" && platform !== "win32") return { supported: false, reason: "platform" };
  // dev 模式下注册的是 node_modules 里那个 Electron 可执行文件：开机拉起来的是一个空壳
  if (!isPackaged) return { supported: false, reason: "dev" };
  // 直接从 dmg 里双击运行：登录项会指向 /Volumes/…，卷一弹出这条登录项就永久失效
  if (platform === "darwin" && appPath.startsWith("/Volumes/")) return { supported: false, reason: "volume" };
  return { supported: true, reason: null };
}
