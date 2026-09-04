/**
 * Vibepaws 桌面宠物壳（Electron）— npm start
 * 架构 D5：Core 是独立守护进程，本壳是它的 UI 客户端（SSE 消费）**兼监护人**：
 * 找 node、拉起 Core、崩了重拉、退出时收摊（0.4「一个托盘应用负责 Core」）。
 * 特性：透明无边框窗口、always-on-top、右下角驻留、可拖拽、
 *       点击穿透开关（托盘）、点击宠物呼出浮层、开机自启。
 * 说明：Tauri v2（架构 D6 首选）待本机 Rust 工具链就绪后替换本壳，
 *       渲染层（ui/）与通信协议（SSE）不变，替换成本仅壳层。
 */
import { app, BrowserWindow, Tray, Menu, screen, nativeImage, nativeTheme, ipcMain, dialog } from "electron";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  MAX_CORE_RESTARTS,
  CORE_HEALTHY_MS,
  findNodeBinary,
  loginItemSupport,
  nodeCandidates,
  parseNodeVersion,
  restartDelay,
} from "./launch.js";

// packaged 模式下把日志写到 userData（GUI 启动的 app stdout 不可见）
function writeLog(prefix, line) {
  if (!app.isPackaged) return;
  try {
    const dir = app.getPath("userData");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "vibepaws.log"), `${new Date().toISOString()} ${prefix}${line}\n`);
  } catch {}
}
function log(line) {
  console.log(line);
  writeLog("", line);
}
function err(line) {
  console.error(line);
  writeLog("ERR ", line);
}

const CORE_PORT = 17893;
/** UI server 的首选端口；被占用时改用系统分配的空闲端口（见 pickPort） */
const PREFERRED_UI_PORT = 5173;
/** UI server 的身份标记路由（见 src/ui/server.ts）：确认端口上的服务是我们自己 */
const UI_MARKER_PATH = "/__vibepaws";

/** 宠物本体占的那一块，贴在窗口底部（= 从前的「收起态窗口」）。CSS 里 #stage 的高度必须与之一致。 */
const PET_BOX = { width: 210, height: 250 };
/**
 * 窗口尺寸**恒定**：浮层那份高度永远留着，开关浮层只改 CSS，不动窗口。
 * 为什么不能跟着浮层缩放，见下面 PANEL_GEOMETRY_NOTE。
 */
const WINDOW_SIZE = { width: 300, height: 430 };
/** 设置窗口：普通有边框窗口，够放下一个表单又不至于铺满屏幕 */
const SETTINGS_SIZE = { width: 480, height: 660 };

let win = null;
let settingsWin = null;
let tray = null;
let uiServer = null;
let uiPort = PREFERRED_UI_PORT;
let clickThrough = false;
/** 光标此刻是否压在「真的要吃点击」的东西上（宠物 / 浮层 / 气泡）。见 applyMouseIgnore */
let cursorOverHit = true;
/** UI server 就绪前不许建窗口：那时 uiPort 还是默认值，会加载错的地址 */
let uiReady = false;
let levelKeepAlive = null;

/* ---------------- 壳偏好（issue #4） ----------------
 * 只存「窗口怎么摆」这类壳层设定，与 Core 的 settings 表无关：
 * Core 是守护进程，可能没跑；窗口行为必须在 Core 之前就能决定。
 *
 * allSpaces 默认 true：宠物是「活着的伙伴」，你在哪个桌面干活它就该在哪。
 * #4 的真正诉求不是「别跟着我」，而是「这件事得归我管」：默认跟随 + 托盘里随时可关。
 *
 * 它只管「跟不跟着你换桌面」这一件事。「你全屏时我还在不在」由 applyWindowLevel
 * 无条件保证，不受这个开关影响 —— 这两件事曾经是同一个布尔值，于是把开关关掉
 * 等于让宠物在全屏终端里彻底消失，而 coding agent 基本都活在全屏终端里。
 *
 * anchor 存的是窗口**底部中心**（= 宠物脚下那一点）的屏幕坐标，而不是左上角：
 * 位置的语义是「宠物站在哪」，而不是「窗口的左上角在哪」—— 窗口的宽高里有一大半
 * 是留给浮层的透明空间，拿左上角当位置，换个尺寸就对不上了。
 *
 * locale 也存在这里（"auto" | "en" | "zh-CN"）而不是 Core 的 settings 表：
 * 主进程在建托盘菜单时就要知道用哪种语言，那一刻 Core 可能还没起来。 */
const DEFAULT_PREFS = { allSpaces: true, anchor: null, locale: "auto" };
let prefs = { ...DEFAULT_PREFS };

function prefsFile() {
  return join(app.getPath("userData"), "window-prefs.json");
}

function loadPrefs() {
  try {
    prefs = { ...DEFAULT_PREFS, ...JSON.parse(readFileSync(prefsFile(), "utf8")) };
  } catch {
    prefs = { ...DEFAULT_PREFS };
  }
}

function savePrefs() {
  try {
    mkdirSync(app.getPath("userData"), { recursive: true });
    writeFileSync(prefsFile(), JSON.stringify(prefs, null, 2));
  } catch (e) {
    err(`[vibepaws] 偏好写入失败: ${e}`);
  }
}

function resourcesDir() {
  // packaged：app.asar 旁边的 resources/（src/、ui/ 以真实文件存在，node 可执行）
  return app.isPackaged ? process.resourcesPath : process.cwd();
}

function workDir() {
  // packaged：数据目录用 userData（.vibepaws 建在这里），cwd 不可靠
  return app.isPackaged ? app.getPath("userData") : process.cwd();
}

/* ---------------- i18n（issue #3 / #6） ----------------
 * 主进程是 locale 的唯一裁决者：app.getLocale() 拿到的是 OS 语言，
 * 再通过 ?locale= 传给渲染层，保证托盘菜单与宠物界面永远同一种语言。
 * 文案目录与 Core 共用 src/i18n/messages.js（打包后在 resources/src 下，不在 asar 里）。 */
let LOCALE = "en";
let translate = (_locale, key) => key;
let normalizeLocale = (tag) => (String(tag ?? "").toLowerCase().startsWith("zh") ? "zh-CN" : "en");

/**
 * 生效语言：环境变量 > 设置窗口里选的 > 系统语言。
 * 环境变量排第一是给开发/截图用的（VIBEPAWS_LOCALE=zh npm run desktop），
 * 它显式到不该被一个持久化偏好推翻。
 */
function resolveLocale() {
  if (process.env.VIBEPAWS_LOCALE) return normalizeLocale(process.env.VIBEPAWS_LOCALE);
  if (prefs.locale && prefs.locale !== "auto") return normalizeLocale(prefs.locale);
  return normalizeLocale(app.getLocale());
}

async function loadI18n() {
  const file = join(resourcesDir(), "src", "i18n", "messages.js");
  try {
    const mod = await import(pathToFileURL(file).href);
    translate = mod.t;
    normalizeLocale = mod.normalizeLocale;
    LOCALE = resolveLocale();
    log(`[vibepaws] locale=${LOCALE} (os=${app.getLocale()} pref=${prefs.locale})`);
  } catch (e) {
    err(`[vibepaws] 文案目录加载失败，回落英文: ${e}`);
  }
}

const t = (key, params) => translate(LOCALE, key, params);

/**
 * 切界面语言。不重启进程 —— 三处要一起换，少一处就会混语言（issue #6）：
 * 托盘菜单（主进程出字）、宠物窗口、设置窗口本身（后两个的 locale 是 URL 参数，
 * 只能重载才能换）。
 */
function applyLocalePref(pref) {
  prefs.locale = pref === "en" || pref === "zh-CN" ? pref : "auto";
  savePrefs();
  const next = resolveLocale();
  if (next === LOCALE) return;
  LOCALE = next;
  updateTrayMenu();
  if (tray) tray.setToolTip(t("tray.tooltip"));
  if (win && !win.isDestroyed()) win.loadURL(petUrl());
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.setTitle(t("settings.title"));
    settingsWin.loadURL(settingsUrl());
  }
}

/* ---------------- Core（0.4：一个托盘应用负责它的整个生命周期） ----------------
 *
 * 从前 dev 和 packaged 走两条路：packaged 自动拉起 Core，dev 打一行「请手动 npm run core」。
 * 于是「怎么启动 Vibepaws」这个问题有两个答案，而其中一个是两条命令 —— 那是开发流程，
 * 不是产品。现在两边同一条路：壳负责找 node、拉起 Core、看着它、退出时收摊。
 *
 * 三个状态要分清，因为它们的**收摊责任不同**：
 *   · running  —— 我们拉起来的，退出时我们杀掉；崩了我们重拉。
 *   · adopted  —— 端口上本来就有一个（`npm run core`，或上一次壳被 kill -9 留下的孤儿）。
 *                 沿用它，但**绝不杀它**：杀掉一个不是自己拉起来的进程，等于把用户
 *                 另一个终端里正在跑的东西掐了。
 *   · failed   —— node 找不到 / 版本不够 / 连续崩溃到放弃。宠物窗口会显示「Core 未连接」。
 */
let coreProc = null;
/** "starting" | "running" | "adopted" | "failed" —— 托盘里那一行显示的就是它 */
let coreState = "starting";
let coreRestarts = 0;
let coreRestartTimer = null;
let coreStartedAt = 0;
/** before-quit 之后 Core 的退出是我们要的，不该触发重拉 */
let quitting = false;
/** undefined = 还没找过；null = 找过了，没有够版本的 */
let nodeBinary = undefined;
let nodeErrorShown = false;

async function coreRunning() {
  try {
    const r = await fetch(`http://127.0.0.1:${CORE_PORT}/health`);
    return r.ok;
  } catch {
    return false;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function listDir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** 3 秒够任何一个 node 打印自己的版本号；探不通的候选路径在列表里是常态，不是异常。 */
function probeNode(path) {
  const r = spawnSync(path, ["--version"], { encoding: "utf8", timeout: 3000 });
  if (r.error || r.status !== 0) return null;
  return parseNodeVersion(r.stdout);
}

/**
 * 找一个能跑 Core 的 node。**不能用 Electron 自己**（ELECTRON_RUN_AS_NODE）：
 * better-sqlite3 的预编译产物是按系统 node 的 ABI 编的，Electron 加载它会直接报
 * NODE_MODULE_VERSION 不匹配。UI server 没这个约束，所以它仍然跑在 Electron 里。
 */
function resolveNode() {
  if (nodeBinary !== undefined) return nodeBinary;
  const candidates = nodeCandidates({
    env: process.env,
    platform: process.platform,
    home: homedir(),
    listDir,
  });
  const found = findNodeBinary(candidates, probeNode);
  nodeBinary = found.path;
  if (found.path) {
    log(`[vibepaws] Core 将由 ${found.path} (${found.version}) 运行`);
  } else {
    err(`[vibepaws] 在 ${candidates.length} 个候选位置里没找到 node ≥ 22.6`);
    for (const old of found.tooOld) err(`[vibepaws]   ${old.path} 是 ${old.version}，太老`);
    reportNodeMissing(found.tooOld);
  }
  return nodeBinary;
}

/**
 * 这个错必须弹出来。它只有一个成因（机器上没有够版本的 node），只有一个解法（去装），
 * 而从 GUI 启动时 stdout 没人看得见 —— 不弹的话用户看到的是一只永远「Core 未连接」的宠物。
 * 一次运行只弹一次：开机自启的场景下，每次重试都弹一个模态框是灾难。
 */
function reportNodeMissing(tooOld) {
  if (nodeErrorShown) return;
  nodeErrorShown = true;
  const detail = tooOld.length ? `${tooOld[0].path} — ${tooOld[0].version}` : "";
  try {
    dialog.showErrorBox(t("core.node.missing.title"), t("core.node.missing.body", { found: detail }));
  } catch {}
}

function setCoreState(next) {
  if (coreState === next) return;
  coreState = next;
  updateTrayMenu();
}

function spawnCore() {
  const node = resolveNode();
  if (!node) {
    setCoreState("failed");
    return false;
  }
  const entry = join(resourcesDir(), "src", "core", "server.ts");
  const child = spawn(node, ["--experimental-strip-types", entry, "--port", String(CORE_PORT)], {
    cwd: workDir(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  coreProc = child;
  coreStartedAt = Date.now();
  child.on("error", (e) => {
    err(`[core] spawn failed: ${e}`);
    // spawn 本身失败时不保证还有 exit 事件；不接这一下，状态会永远停在 starting
    onCoreExit(child, null, "spawn-error");
  });
  child.stdout?.on("data", (d) => log(`[core] ${String(d).trim()}`));
  child.stderr?.on("data", (d) => err(`[core] ${String(d).trim()}`));
  child.on("exit", (code, signal) => onCoreExit(child, code, signal));
  return true;
}

/** 等 Core 的 /health 通。它已经退了就立刻返回 —— exit 处理器会接手重拉。 */
async function waitForCore(timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await coreRunning()) {
      setCoreState(coreProc ? "running" : "adopted");
      return true;
    }
    if (!coreProc) return false;
    await sleep(250);
  }
  return false;
}

function onCoreExit(child, code, signal) {
  // 上一代进程的迟到讣告：restartCore 已经把 coreProc 换掉了，别拿它去重拉
  if (child !== coreProc) return;
  coreProc = null;
  if (quitting) return;
  // 撑过一分钟才崩的，跟启动期那串连崩不是一回事，计数重来
  if (Date.now() - coreStartedAt >= CORE_HEALTHY_MS) coreRestarts = 0;
  coreRestarts += 1;
  const delay = restartDelay(coreRestarts);
  if (delay === null) {
    err(`[vibepaws] Core 连崩 ${MAX_CORE_RESTARTS} 次（最后 code=${code} signal=${signal}）—— 不再重拉，托盘里可手动重启`);
    setCoreState("failed");
    return;
  }
  err(`[vibepaws] Core 退出（code=${code} signal=${signal}），${delay}ms 后第 ${coreRestarts} 次重拉`);
  setCoreState("starting");
  coreRestartTimer = setTimeout(async () => {
    coreRestartTimer = null;
    if (quitting) return;
    // 这段时间里用户可能自己起了一个（或者端口被别的东西占了）——
    // 先探一下再决定，否则就是拿 EADDRINUSE 去撞一个活着的 Core
    if (await coreRunning()) {
      coreRestarts = 0;
      setCoreState("adopted");
      return;
    }
    if (spawnCore()) await waitForCore();
  }, delay);
}

async function ensureCore() {
  if (await coreRunning()) {
    setCoreState("adopted");
    log("[vibepaws] Core 已在运行 —— 沿用它（退出时不会关掉它）");
    return;
  }
  setCoreState("starting");
  if (!spawnCore()) return;
  if (!(await waitForCore())) {
    err("[vibepaws] Core 未能就绪 —— 宠物窗口会显示「Core 未连接」");
  }
}

/**
 * adopted 的那一路没有 exit 事件可听 —— 它不是我们的子进程，用户在自己的终端里
 * Ctrl-C 一下，壳这边是完全静默的：宠物从此不动，托盘上还写着「运行中」。
 * 所以 adopted 期间要自己探活；探不到就接管（这正是「一个托盘应用负责 Core」的意思）。
 * 我们自己拉起来的那一路不走这里 —— 那边有 exit 事件，比轮询快也比轮询准。
 */
const CORE_WATCH_MS = 5000;
let coreWatch = null;

function startCoreWatch() {
  if (coreWatch) return;
  coreWatch = setInterval(async () => {
    if (quitting || coreProc || coreState !== "adopted") return;
    if (await coreRunning()) return;
    err("[vibepaws] 外部启动的 Core 不见了 —— 接管，改由本应用拉起");
    await ensureCore();
  }, CORE_WATCH_MS);
}

/** 托盘里的手动出口：装完 node、或者放弃重拉之后，不必退出整个 app 重来。 */
async function restartCore() {
  if (coreRestartTimer) {
    clearTimeout(coreRestartTimer);
    coreRestartTimer = null;
  }
  coreRestarts = 0;
  nodeBinary = undefined; // 用户很可能刚把 node 装上，缓存的「没找到」得作废
  nodeErrorShown = false;
  const mine = coreProc;
  if (!mine && coreState === "adopted") {
    // 点了「重启 Core」但那个 Core 不是我们拉起来的 —— 不去动它，只重新探一次活。
    // 想真的重启它，得回到起它的那个终端：那里才有它的日志和 Ctrl-C。
    log("[vibepaws] Core 不是本应用启动的 —— 只重新探活，不去杀它");
  }
  if (mine) {
    // 先摘掉引用再杀：否则 exit 处理器会把这次主动重启当成崩溃，又排一次退避重拉
    coreProc = null;
    mine.kill();
    // 端口要一小会儿才放开；不等的话新进程一起来就 EADDRINUSE
    for (let i = 0; i < 20 && (await coreRunning()); i++) await sleep(100);
  }
  setCoreState("starting");
  await ensureCore();
}

/* ---------------- UI server ---------------- */
function portFree(port) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

function ephemeralPort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * 5173 是 Vite 的默认端口 —— 我们的用户几乎人人手边都有个前端 dev server。
 * 端口被占时既不能硬等（UI server 起不来），也不能盲目探测（会把别人的应用
 * 加载进宠物窗口），所以：占用就换一个空闲端口。
 */
async function pickUiPort() {
  if (await portFree(PREFERRED_UI_PORT)) return PREFERRED_UI_PORT;
  const port = await ephemeralPort();
  log(`[vibepaws] ${PREFERRED_UI_PORT} 已被占用，UI server 改用 ${port}`);
  return port;
}

async function startUiServer() {
  const port = await pickUiPort();
  const entry = join(resourcesDir(), "src", "ui", "server.ts");
  const uiDir = app.isPackaged ? join(resourcesDir(), "ui") : undefined;
  const args = ["--experimental-strip-types", entry, "--port", String(port), "--core-port", String(CORE_PORT)];
  if (uiDir) args.push("--ui-dir", uiDir);
  const child = spawn(process.execPath, args, {
    cwd: workDir(),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  uiServer = child;
  child.stdout?.on("data", (d) => log(`[ui-server] ${String(d).trim()}`));
  child.stderr?.on("data", (d) => err(`[ui-server] ${String(d).trim()}`));
  child.on("error", (e) => err(`[ui-server] spawn failed: ${e}`));
  child.on("exit", (code) => log(`[ui-server] exited ${code}`));
  await waitForUiServer(port, child);
  return port;
}

/**
 * 等 UI server 就绪。三处旧问题一起修：
 *   ① 超时判断写在 catch 里 —— 服务器返回非 200 时两个分支都不走，
 *      Promise 永远不 settle，于是「启动了但一个窗口都没有」；
 *   ② 不验证身份 —— 端口上是别人的应用也会照样加载；
 *   ③ 子进程秒退（EADDRINUSE 等）不算失败，还在傻等 10 秒。
 */
function waitForUiServer(port, child) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      child.off("exit", onExit);
      fn(value);
    };
    const onExit = (code) => finish(reject, new Error(`ui server exited early (code ${code})`));
    child.once("exit", onExit);

    let tries = 0;
    const timer = setInterval(async () => {
      tries++;
      try {
        const r = await fetch(`http://127.0.0.1:${port}${UI_MARKER_PATH}`);
        if (r.ok) {
          const body = await r.json().catch(() => null);
          if (body?.service === "vibepaws-ui") return finish(resolve, port);
          return finish(reject, new Error(`port ${port} is served by another app`));
        }
      } catch {
        /* 还没起来，继续等 */
      }
      if (tries > 40) finish(reject, new Error("ui server did not start in time"));
    }, 250);
  });
}

/* ---------------- 窗口 ---------------- */
function clamp(v, lo, hi) {
  return Math.round(Math.max(lo, Math.min(v, hi)));
}

function areaForPoint(point) {
  return screen.getDisplayNearestPoint(point).workArea;
}

/**
 * 由「宠物脚下的锚点」算出窗口左上角。
 *
 * 横向按**宠物盒子**夹、纵向按**窗口**夹，两条边界故意不一样：
 * 窗口比宠物宽 90px，多出来的是全透明且点击穿透的空白，按窗口夹的话宠物就贴不到
 * 屏幕左右边缘了（每边少 45px）。纵向多出来的 180px 是浮层要用的，探出屏幕会被裁掉，
 * 所以纵向必须按整个窗口夹。
 */
function boundsFromAnchor(anchor, size = WINDOW_SIZE) {
  const point = { x: Math.round(anchor.x), y: Math.round(anchor.y) };
  const area = areaForPoint(point);
  const cx = clamp(point.x, area.x + PET_BOX.width / 2, area.x + area.width - PET_BOX.width / 2);
  const y = clamp(point.y - size.height, area.y, area.y + area.height - size.height);
  return { x: Math.round(cx - size.width / 2), y, width: size.width, height: size.height };
}

function defaultAnchor() {
  const { workArea } = screen.getPrimaryDisplay();
  return {
    // 用 PET_BOX 而不是 WINDOW_SIZE：默认位置说的是「宠物离右下角多远」，
    // 拿窗口宽度算会把宠物往左推 45px（那 45px 是透明的，用户只看得见宠物）。
    x: workArea.x + workArea.width - 24 - PET_BOX.width / 2,
    y: workArea.y + workArea.height - 40,
  };
}

function currentAnchor() {
  if (!win || win.isDestroyed()) return null;
  const b = win.getBounds();
  return { x: b.x + b.width / 2, y: b.y + b.height };
}

let anchorSaveTimer = null;
/** 位置持久化：拖动期间每帧都会触发 moved，攒一下再写盘 */
function scheduleAnchorSave() {
  if (anchorSaveTimer) clearTimeout(anchorSaveTimer);
  anchorSaveTimer = setTimeout(() => {
    anchorSaveTimer = null;
    const anchor = currentAnchor();
    if (!anchor) return;
    prefs.anchor = anchor;
    savePrefs();
  }, 500);
}

/**
 * 拿到（必要时创建）宠物窗口。托盘点击、activate、second-instance 都走这里 ——
 * 它是唯一的创建入口，避免和启动流程各建一个窗口：那样 `win` 只指向后建的那个，
 * 先建的那扇透明置顶窗口谁也管不到（拖不动、关不掉、托盘也切不了）。
 */
function ensureWindow() {
  if (win && !win.isDestroyed()) return win;
  if (!uiReady) return null; // 还没有可加载的地址，等 boot() 建
  createWindow();
  return win;
}

function createWindow() {
  // 上次放在哪就还在哪（换过显示器 / 分辨率变了会被 clamp 回可见区域）
  const anchor = prefs.anchor ?? defaultAnchor();
  const bounds = boundsFromAnchor(anchor);
  win = new BrowserWindow({
    ...bounds,
    transparent: true,
    // 透明窗口显式给一个全透明底色：让合成器每帧都有东西可清，
    // 而不是复用上一帧的 tile —— 快速拖动时的残影来源之一（issue #8）。
    backgroundColor: "#00000000",
    frame: false,
    resizable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    webPreferences: {
      backgroundThrottling: false,
      preload: fileURLToPath(new URL("preload.cjs", import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  applyWindowLevel();
  applyMouseIgnore();
  // 「宠物不见了」最难查的一点是壳层状态完全不可见 —— 把它打出来
  log(`[vibepaws] window level=screen-saver allSpaces=${prefs.allSpaces} fullScreen=always`);
  // 把主进程裁决的 locale 交给渲染层，避免 navigator.language 与 app.getLocale() 打架
  win.loadURL(petUrl());
  // 渲染进程 console → 主进程日志（调试用）。Electron 28+ 传的是单个 details 对象，
  // 老签名 (event, level, message, line, sourceId) 只会打印出一串 undefined。
  win.webContents.on("console-message", (details, ...legacy) => {
    const message = details?.message ?? legacy[1];
    const level = details?.level ?? legacy[0];
    const source = details?.sourceId ?? legacy[3];
    const lineNo = details?.lineNumber ?? legacy[2];
    log(`[renderer:${level}] ${message} (${source}:${lineNo})`);
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    err(`[renderer] load failed ${code} ${desc} ${url}`);
  });
  win.on("closed", () => {
    stopDrag();
    stopHitRescue();
    win = null;
  });
  if (process.env.VIBEPAWS_DEBUG) runCanvasDiagnostic();
  // 保持置顶（防被其他窗口压下去）。顺带重申 workspace 行为：
  // setAlwaysOnTop 会重写窗口的 NSWindow level，之前只重申置顶不重申 workspace，
  // 两者会渐渐不同步。
  if (levelKeepAlive) clearInterval(levelKeepAlive);
  levelKeepAlive = setInterval(applyWindowLevel, 30_000);
}

/** 诊断：窗口状态与 Canvas 渲染结果（VIBEPAWS_DEBUG=1 才跑） */
function runCanvasDiagnostic() {
  setTimeout(async () => {
    try {
      log(`[diag] bounds=${JSON.stringify(win?.getBounds())} visible=${win?.isVisible()}`);
      const pixel = await win?.webContents.executeJavaScript(`(() => {
        const c = document.getElementById('pet');
        if (!c) return 'NO_CANVAS';
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let opaque = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) opaque++;
        return 'canvas=' + c.width + 'x' + c.height + ' opaquePx=' + opaque;
      })()`);
      log(`[diag] ${pixel}`);
    } catch (e) {
      err(`[diag] ${e}`);
    }
  }, 3000);
}

/**
 * 让壳进程定档 accessory（= NSUIElement）：不占 Dock、没有菜单栏。
 *
 * 这不是「桌宠不该有 Dock 图标」的洁癖。macOS 10.14 起，regular 档的进程拿不到
 * NSWindowCollectionBehaviorFullScreenAuxiliary —— 窗口在别人的全屏 Space 里
 * 根本不会出现。Electron 知道这件事，所以 setVisibleOnAllWorkspaces 会私自
 * TransformProcessType 来回切档；代价是每次调用窗口和 Dock 都闪一下，而我们有个
 * 30s 保活 tick 在调它，等于每 30 秒闪一次宠物。
 * 启动时一次性定档，之后所有调用都带 skipTransformProcessType，两个问题一起了结。
 */
function becomeAccessoryApp() {
  if (process.platform !== "darwin") return;
  app.setActivationPolicy("accessory");
}

/**
 * 置顶层级 + Spaces 可见性一起施加（issue #4）。
 *
 * 原来这两行是写死的常量，用户没有任何开关；现在读 prefs，托盘里可以随时翻转。
 * 顺序有讲究：先 setAlwaysOnTop（它会重设 collectionBehavior），再设 workspace，
 * 反过来写 workspace 会被随后的置顶调用抹掉 —— 这也是那个 30s 保活 tick
 * 必须走这个函数、而不能只调 setAlwaysOnTop 的原因。
 *
 * level 从 floating 提到 screen-saver：floating 是 NSFloatingWindowLevel(3)，
 * 只压得住**同一个 Space 里**的普通窗口。别的 app 进原生全屏后独占一个 Space，
 * level 3 在那儿排不上号。桌宠这类常驻浮层的通行做法就是顶到 screen-saver(1000)。
 *
 * visibleOnFullScreen 恒为 true，不再跟着 allSpaces 走 —— 这是两个不同的问题，
 * 见 DEFAULT_PREFS 上面那段。
 */
function applyWindowLevel() {
  if (!win || win.isDestroyed()) return;
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(prefs.allSpaces, {
    visibleOnFullScreen: true,
    skipTransformProcessType: true,
  });
}

function setAllSpaces(value) {
  prefs.allSpaces = Boolean(value);
  savePrefs();
  applyWindowLevel();
  updateTrayMenu();
}

function toggleAllSpaces() {
  setAllSpaces(!prefs.allSpaces);
}

/* ---------------- PANEL_GEOMETRY_NOTE：窗口为什么不跟着浮层缩放 ----------------
 * 浮层要占宠物**上方**的空间，而宠物脚下那一点必须钉死不动 —— 这两条加起来，
 * 意味着窗口一变高，左上角就得同时往上挪同样的距离。
 *
 * 而 macOS 上「改尺寸」和「改原点」落到窗口服务器时不保证在同一个事务里。
 * setBounds 只是一次调用，合成器却会出现一帧「新尺寸 + 旧原点」：窗口高度已经
 * 从 430 变成 250，左上角还停在 anchor−430，于是底部对齐的内容整块往上跳
 * 180px，下一帧才回到正确位置。一帧 16ms 的位移看起来就是宠物「闪」了一下 ——
 * 关浮层大概三次里有两次会闪。（实测：录屏 60fps，第 186、287 帧各一帧。）
 *
 * 两个端点状态都是「底部对齐」，所以任何中间态都必然错位 —— 换句话说，只要窗口
 * 在开关浮层时改变几何形状，这一帧就消不掉。于是这里的选择是让它**不改**：
 * 窗口恒为 300×430，浮层那 180px 高度一直留着，开关浮层纯粹是 CSS 的事，
 * 主进程一次几何调用都不发。
 *
 * 代价是收起时宠物头顶多出一片透明区域。透明不等于穿透，所以配一套命中测试
 * （applyMouseIgnore）把它交回桌面 —— 顺带把收起态本来就存在的那圈死区也一起消了。 */

/**
 * 点击穿透的唯一出口。两个来源合成一个结论：
 *   · 托盘开关 clickThrough：用户主动要「整扇窗都别挡我」；
 *   · cursorOverHit：光标压着的是空白还是真东西（渲染层每次 mousemove 报一次）。
 *
 * forward:true 是这套东西能成立的前提 —— 穿透期间 Chromium 依然收得到 mousemove，
 * 渲染层才有机会发现「光标进宠物了」并把交互要回来。没有它，一旦穿透就再也没有
 * 任何事件能把状态翻回来，宠物会彻底点不动。
 */
function applyMouseIgnore() {
  if (!win || win.isDestroyed()) return;
  const ignore = clickThrough || !cursorOverHit;
  win.setIgnoreMouseEvents(ignore, { forward: true });
  // 只有「因为压在空白处才穿透」需要兜底；托盘开关是用户主动要的，不许抢回来
  if (ignore && !clickThrough) startHitRescue();
  else stopHitRescue();
  if (process.env.VIBEPAWS_DEBUG) log(`[hit] ignore=${ignore} overHit=${cursorOverHit} clickThrough=${clickThrough}`);
}

/**
 * 命中测试的兜底。
 *
 * 穿透期间，唯一能把交互要回来的信道就是 forward 过来的 mousemove。万一它在某个
 * 系统版本上不来，状态就永久卡在穿透 —— 宠物再也点不动，而且从日志上完全看不出来。
 * 所以这里不信那条信道：光标只要落进宠物那 210×250 的盒子，就无条件恢复交互。
 * 纯几何判断，不依赖渲染层。
 *
 * 两种失败模式不对称：多挡住一点桌面只是烦，宠物点不动是这个 app 没法用了。
 * 20Hz 且只在穿透期间跑；getCursorScreenPoint 是同步 CG 调用，几微秒。
 */
const HIT_RESCUE_MS = 50;
let hitRescueTimer = null;

function startHitRescue() {
  if (hitRescueTimer || !win || win.isDestroyed()) return;
  hitRescueTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return stopHitRescue();
    const b = win.getBounds();
    // 宠物盒子贴在窗口底部中央（与 CSS 里的 #stage 一致）
    const x = b.x + (b.width - PET_BOX.width) / 2;
    const y = b.y + b.height - PET_BOX.height;
    const p = screen.getCursorScreenPoint();
    if (p.x < x || p.x >= x + PET_BOX.width || p.y < y || p.y >= y + PET_BOX.height) return;
    cursorOverHit = true;
    applyMouseIgnore(); // 里面会把这个 timer 停掉
  }, HIT_RESCUE_MS);
}

function stopHitRescue() {
  if (hitRescueTimer) clearInterval(hitRescueTimer);
  hitRescueTimer = null;
}

function resetWindowPosition() {
  prefs.anchor = defaultAnchor();
  savePrefs();
  const target = ensureWindow();
  if (!target || target.isDestroyed()) return;
  // 只挪位置、不改尺寸：纯粹的移动是原子的，不会出现 PANEL_GEOMETRY_NOTE 里那一帧错位
  const { x, y } = boundsFromAnchor(prefs.anchor);
  target.setPosition(x, y, false);
  target.show();
}

/* ---------------- 拖拽（issue #8） ----------------
 * 旧实现两条腿同时跑：CSS `-webkit-app-region: drag` + 渲染层 window.moveTo
 * （因为 sandbox 下 window.process 恒为 undefined，本该跳过的兜底分支一直在跑）。
 * 两套机制争夺同一个窗口位置 —— 这是「拖起来不跟手」和「拖久了出现多重残影」的来源。
 *
 * 新实现只有一条腿，且位置计算完全在主进程：
 * 渲染层只报「开始/结束」，主进程按住光标屏幕坐标跟随。这样绕开了旧兜底里
 * 「用 clientX 算位移」的反馈环 —— 窗口一动 clientX 就变，位移越算越飘。
 */
const DRAG_TICK_MS = 8; // 125Hz，盖住 120Hz ProMotion
let dragTimer = null;
let dragOffset = null;

/** 拖拽跟的是**锚点**（宠物脚下那一点），不是窗口左上角 —— 这样边界判定和
 *  boundsFromAnchor 共用同一套规则：宠物贴得到屏幕左右边缘，也不会被拖进菜单栏。 */
function startDrag() {
  if (!win || win.isDestroyed()) return;
  stopDrag();
  const cursor = screen.getCursorScreenPoint();
  const b = win.getBounds();
  dragOffset = { dx: cursor.x - (b.x + b.width / 2), dy: cursor.y - (b.y + b.height) };
  dragTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !dragOffset) return stopDrag();
    const p = screen.getCursorScreenPoint();
    const { x, y } = boundsFromAnchor({ x: p.x - dragOffset.dx, y: p.y - dragOffset.dy });
    const [cx, cy] = win.getPosition();
    // 位置没变就别调 setPosition：静止时这个 tick 几乎不花钱
    if (x !== cx || y !== cy) win.setPosition(x, y, false);
  }, DRAG_TICK_MS);
}

function stopDrag() {
  if (dragTimer) clearInterval(dragTimer);
  dragTimer = null;
  dragOffset = null;
  // 拖拽期间命中测试是冻结的（见 vibepaws:hit），松手后按最后一次上报的状态收尾
  applyMouseIgnore();
}

ipcMain.on("vibepaws:drag-start", (e) => {
  // 只认宠物窗口自己发来的拖拽请求
  if (win && !win.isDestroyed() && e.sender === win.webContents) startDrag();
});
ipcMain.on("vibepaws:drag-end", (e) => {
  if (win && !win.isDestroyed() && e.sender !== win.webContents) return;
  stopDrag();
  scheduleAnchorSave(); // 松手即记住新位置
});
ipcMain.on("vibepaws:hit", (e, over) => {
  if (win && !win.isDestroyed() && e.sender !== win.webContents) return;
  cursorOverHit = Boolean(over);
  // 拖拽中一律不动：这时候光标经常已经滑出宠物本体，一穿透就收不到 pointerup，
  // drag-end 永远不来，窗口从此黏着光标。
  if (dragOffset) return;
  applyMouseIgnore();
});

function setClickThrough(value) {
  clickThrough = Boolean(value);
  // 拖到一半打开点击穿透：渲染层从此收不到 pointerup，drag-end 永远不会来，
  // 窗口会一直黏着光标。这里主动收尾（stopDrag 末尾会重算穿透状态）。
  stopDrag();
  updateTrayMenu();
}

function toggleClickThrough() {
  setClickThrough(!clickThrough);
}

/* ---------------- 设置窗口（landscape 表格第 13 项） ----------------
 * 为什么是独立窗口而不是浮层里的一页：宠物窗口恒为 300×430、无边框、透明，
 * 还要靠命中测试把空白处的点击交回桌面 —— 一个表单要的宽度、可聚焦输入框、
 * 系统级复制粘贴，跟这三条约束条条相冲。
 *
 * 页面本身由同一个 UI server 提供（/settings.html），所以 `npm run ui` 的浏览器
 * 预览里也能改 Core 那部分设置；只有「窗口怎么摆 / 界面语言」这一段需要壳。 */
function petUrl() {
  return `http://127.0.0.1:${uiPort}/?locale=${encodeURIComponent(LOCALE)}`;
}

function settingsUrl() {
  return `http://127.0.0.1:${uiPort}/settings.html?locale=${encodeURIComponent(LOCALE)}`;
}

/**
 * macOS：accessory 档的进程不显示菜单栏，于是 ⌘C/⌘V 这些**键位等价**也无处可依 ——
 * 而设置窗口里有两个文本框，粘贴不了目标和名字是说不过去的。
 * 主菜单只在第一次打开设置窗口时装（启动路径一个字节都不动，全屏 Space 那套行为
 * 由 becomeAccessoryApp + applyWindowLevel 保证，与主菜单无关）。
 * 右键菜单是同一件事的第二条路：万一某个系统版本上键位等价真的不生效，还有出口。
 */
let editMenuInstalled = false;
function ensureEditMenu() {
  if (editMenuInstalled || process.platform !== "darwin") return;
  editMenuInstalled = true;
  try {
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }]));
  } catch (e) {
    err(`[vibepaws] 编辑菜单安装失败（复制粘贴要走右键菜单）: ${e}`);
  }
}

function attachEditContextMenu(target) {
  target.webContents.on("context-menu", () => {
    if (target.isDestroyed()) return;
    Menu.buildFromTemplate([
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { type: "separator" },
      { role: "selectAll" },
    ]).popup({ window: target });
  });
}

function openSettings() {
  if (!uiReady) {
    // UI server 还没起来就没有可加载的地址；托盘里点了没反应比报错更难查
    dialog.showErrorBox(t("tray.startfailed.title"), t("tray.startfailed.body", { error: "ui server not ready" }));
    return;
  }
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  ensureEditMenu();
  settingsWin = new BrowserWindow({
    ...SETTINGS_SIZE,
    minWidth: 360,
    minHeight: 420,
    title: t("settings.title"),
    show: false,
    // 首帧底色跟着系统深浅走：浅色系统里先闪一块纯黑会像另一个应用
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0d1117" : "#f6f8fa",
    webPreferences: {
      preload: fileURLToPath(new URL("preload-settings.cjs", import.meta.url)),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  settingsWin.loadURL(settingsUrl());
  settingsWin.once("ready-to-show", () => {
    if (!settingsWin || settingsWin.isDestroyed()) return;
    log(`[vibepaws] settings window opened (${settingsUrl()})`);
    settingsWin.show();
    // accessory 档的进程默认不会被激活 —— 不 focus 的话窗口出来了却收不到键盘输入
    if (process.platform === "darwin") app.focus({ steal: true });
    settingsWin.focus();
  });
  settingsWin.webContents.on("console-message", (details) => {
    log(`[settings:${details?.level}] ${details?.message} (${details?.sourceId}:${details?.lineNumber})`);
  });
  settingsWin.webContents.on("did-fail-load", (_e, code, desc, url) => {
    err(`[settings] load failed ${code} ${desc} ${url}`);
  });
  attachEditContextMenu(settingsWin);
  settingsWin.on("closed", () => {
    settingsWin = null;
  });
}

/** 只认设置窗口自己发来的偏好写入 */
function fromSettings(e) {
  return Boolean(settingsWin && !settingsWin.isDestroyed() && e.sender === settingsWin.webContents);
}

/* ---------------- 开机自启（0.4） ----------------
 * 真值存在操作系统里，不存在我们的 window-prefs.json 里 —— 用户随时可以在
 * 「系统设置 → 通用 → 登录项」里把它关掉，那一刻任何自己记的一份都会开始撒谎。
 * 所以每次都现读，写完之后也以回读的结果为准。 */
function loginItemState() {
  const support = loginItemSupport({
    platform: process.platform,
    isPackaged: app.isPackaged,
    appPath: app.getPath("exe"),
  });
  if (!support.supported) return { ...support, enabled: false };
  try {
    return { ...support, enabled: Boolean(app.getLoginItemSettings().openAtLogin) };
  } catch (e) {
    err(`[vibepaws] 读登录项失败: ${e}`);
    return { supported: false, reason: "platform", enabled: false };
  }
}

function setOpenAtLogin(value) {
  const state = loginItemState();
  if (!state.supported) return state;
  try {
    // openAsHidden = false：宠物就是这个产品本身，开机后藏起来等于没启动。
    // 它的窗口不抢焦点、不进 Dock（accessory 档），所以「出现」本身不打扰任何人。
    app.setLoginItemSettings({ openAtLogin: Boolean(value), openAsHidden: false });
  } catch (e) {
    err(`[vibepaws] 写登录项失败: ${e}`);
  }
  const next = loginItemState();
  log(`[vibepaws] 开机自启 → ${next.enabled ? "on" : "off"}`);
  updateTrayMenu();
  return next;
}

function prefsPayload() {
  const login = loginItemState();
  return {
    allSpaces: prefs.allSpaces,
    clickThrough,
    locale: prefs.locale ?? "auto",
    /** 「跟随系统」那一项要说出来跟随的是什么 */
    osLocale: normalizeLocale(app.getLocale()),
    platform: process.platform,
    openAtLogin: login.enabled,
    /** 装不上时开关要禁用**并说出原因** —— 一个点了没反应的开关比一个灰的难查得多 */
    openAtLoginSupported: login.supported,
    openAtLoginReason: login.reason,
  };
}

ipcMain.on("vibepaws:open-settings", (e) => {
  if (win && !win.isDestroyed() && e.sender !== win.webContents) return;
  openSettings();
});

ipcMain.handle("vibepaws:prefs-get", (e) => {
  const ok = fromSettings(e);
  // 壳桥通不通是「窗口那一段设置能不能用」的唯一前提，而它坏掉时界面只是安静地
  // 显示「在浏览器里打开的」—— 从外面看不出区别，所以 debug 模式下把它打出来
  if (process.env.VIBEPAWS_DEBUG) log(`[settings] prefs-get accepted=${ok}`);
  return ok ? prefsPayload() : null;
});

ipcMain.handle("vibepaws:prefs-set", (e, patch) => {
  if (!fromSettings(e) || !patch || typeof patch !== "object") return null;
  if (typeof patch.allSpaces === "boolean") setAllSpaces(patch.allSpaces);
  if (typeof patch.clickThrough === "boolean") setClickThrough(patch.clickThrough);
  if (typeof patch.openAtLogin === "boolean") setOpenAtLogin(patch.openAtLogin);
  const payload = prefsPayload();
  if (typeof patch.locale === "string") {
    payload.locale = patch.locale === "en" || patch.locale === "zh-CN" ? patch.locale : "auto";
    // 换语言会重载这扇窗口 —— 先把这次调用的返回值发出去，再重载，
    // 否则页面在拿到响应之前就被销毁，invoke 那边等到的是一个 rejected promise。
    setTimeout(() => applyLocalePref(patch.locale), 0);
  }
  return payload;
});

ipcMain.handle("vibepaws:reset-position", (e) => {
  if (!fromSettings(e)) return null;
  resetWindowPosition();
  return prefsPayload();
});

function updateTrayMenu() {
  if (!tray) return;
  const login = loginItemState();
  const template = [
    // Core 的状态排第一：壳活着而 Core 没活着时，宠物只是安静地什么都不做 ——
    // 「为什么它不动」的答案必须在第一屏，而不是在 userData 里的日志文件中
    { label: t("tray.core", { state: t(`tray.core.state.${coreState}`) }), enabled: false },
    { label: t("tray.core.restart"), click: () => void restartCore() },
    { type: "separator" },
    {
      label: t("tray.clickthrough", { state: t(clickThrough ? "tray.state.on" : "tray.state.off") }),
      click: toggleClickThrough,
    },
    {
      label: t("tray.allspaces", { state: t(prefs.allSpaces ? "tray.state.on" : "tray.state.off") }),
      click: toggleAllSpaces,
    },
  ];
  // 装不上时不列这一项：托盘菜单没有地方解释「为什么这条是灰的」，
  // 而设置窗口里有 —— 那边的开关会带着原因一起禁用
  if (login.supported) {
    template.push({
      label: t("tray.autostart", { state: t(login.enabled ? "tray.state.on" : "tray.state.off") }),
      click: () => setOpenAtLogin(!login.enabled),
    });
  }
  template.push(
    { label: t("tray.show"), click: () => ensureWindow()?.show() },
    // 不给 accelerator：托盘菜单里的快捷键在 macOS 上只是显示出来、并不会真的生效，
    // 印一个按了没反应的 ⌘, 比不印更糟
    { label: t("tray.settings"), click: openSettings },
    { label: t("tray.reset"), click: resetWindowPosition },
    { label: t("tray.quit"), click: () => app.quit() },
  );
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

/* 托盘图标：必须是 PNG。
 * 这里原来喂的是 SVG data URL —— nativeImage 根本不解析 SVG，得到的是一张
 * 0×0 的空图；Tray 照样建得出来，但菜单栏上什么都不显示，于是托盘菜单里的
 * 点击穿透 / Spaces 开关全都无从点起（用户：「i did not see anything」）。
 * 16px + 32px(@2x) 两个表示，黑色像素 + alpha 走 macOS template image，
 * 深浅色菜单栏都能看清。图案与原 SVG 一致：圆角方块 + 两只挖空的眼睛。 */
const TRAY_ICON_1X =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAUElEQVR42mNggAADIF4PxP+JxOuheuCa35OgGYbfwwxZT4ZmZJeQrRmGB5kB84FYAIrnEyGOYYAAAwIIECFOfQMo9sIQjUaKkzLFmYmi7AwAYPXX5Tm5sIMAAAAASUVORK5CYII=";
const TRAY_ICON_2X =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAqElEQVR42u1XwQ2AIAxkBEdhFDZjBEZiBEbBasAQURqUcDza5H4Nd6HlaJWqQxMcIRDiIIR0plaN2Ah2IOkbbOKqyP0E8gx/F2Enkpc3cdU8gnD2hAMKOLiHdvuX1wEjzxABIoB1LFMYlmEcsze/KcA/eXbDtnvzWQGm8XGZAfmsAC7+5q8vAF4CeBPCn6E4oQiYJgA+ksGHUvhYDl9MlljN4MspbD3fAWSzYQawSPtVAAAAAElFTkSuQmCC";

function trayImage() {
  const img = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_1X}`);
  img.addRepresentation({ scaleFactor: 2, dataURL: `data:image/png;base64,${TRAY_ICON_2X}` });
  // template image 由系统按菜单栏前景色重绘；非 macOS 没有这个概念，保持原样
  if (process.platform === "darwin") img.setTemplateImage(true);
  return img;
}

function createTray() {
  const img = trayImage();
  if (img.isEmpty()) err("[vibepaws] 托盘图标为空 — 菜单栏上会看不到图标");
  tray = new Tray(img);
  tray.setToolTip(t("tray.tooltip"));
  updateTrayMenu();
  tray.on("click", () => {
    const target = ensureWindow();
    if (!target) return;
    target.isVisible() ? target.hide() : target.show();
  });
}

/* ---------------- 启动 ---------------- */
async function boot() {
  loadPrefs();
  // 必须在建窗口之前：accessory 档决定了窗口能不能出现在别人的全屏 Space 里
  becomeAccessoryApp();
  await loadI18n();
  // 托盘先建：UI server 起不来时至少还有个出口（退出 / 重试），
  // 而不是「点了图标什么都没发生」。
  createTray();
  await ensureCore();
  startCoreWatch();
  uiPort = await startUiServer();
  uiReady = true;
  ensureWindow();
}

app.whenReady().then(boot).catch((e) => {
  err(`[vibepaws] 启动失败: ${e}`);
  if (!tray) {
    try {
      createTray();
    } catch {}
  }
  dialog.showErrorBox(t("tray.startfailed.title"), t("tray.startfailed.body", { error: String(e) }));
});

app.on("activate", () => {
  ensureWindow()?.show();
});

app.on("window-all-closed", () => {
  // 托盘常驻：不退出
});

app.on("before-quit", () => {
  quitting = true;
  if (coreRestartTimer) clearTimeout(coreRestartTimer);
  if (coreWatch) clearInterval(coreWatch);
  stopDrag();
  stopHitRescue(); // stopDrag 末尾会重算穿透状态，可能又把兜底 timer 拉起来
  if (levelKeepAlive) clearInterval(levelKeepAlive);
  if (anchorSaveTimer) {
    clearTimeout(anchorSaveTimer);
    const anchor = currentAnchor();
    if (anchor) {
      prefs.anchor = anchor;
      savePrefs();
    }
  }
  uiServer?.kill();
  // adopted 的 Core 在这里是 null —— 别去关一个用户自己在别的终端里跑着的进程
  coreProc?.kill();
});

// 单实例
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    ensureWindow()?.show();
  });
}
