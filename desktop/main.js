/**
 * Vibepaws 桌面宠物壳（Electron）— npm run desktop
 * 架构 D5：Core 独立守护进程，本壳只是 UI 客户端（SSE 消费）。
 * 特性：透明无边框窗口、always-on-top、右下角驻留、可拖拽、
 *       点击穿透开关（托盘）、点击宠物呼出浮层。
 * 说明：Tauri v2（架构 D6 首选）待本机 Rust 工具链就绪后替换本壳，
 *       渲染层（ui/）与通信协议（SSE）不变，替换成本仅壳层。
 */
import { app, BrowserWindow, Tray, Menu, screen, nativeImage, ipcMain, dialog } from "electron";
import { spawn } from "node:child_process";
import { existsSync, appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

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

let win = null;
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
 * 是留给浮层的透明空间，拿左上角当位置，换个尺寸就对不上了。 */
const DEFAULT_PREFS = { allSpaces: true, anchor: null };
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

async function loadI18n() {
  const file = join(resourcesDir(), "src", "i18n", "messages.js");
  try {
    const mod = await import(pathToFileURL(file).href);
    translate = mod.t;
    LOCALE = process.env.VIBEPAWS_LOCALE
      ? mod.normalizeLocale(process.env.VIBEPAWS_LOCALE)
      : mod.normalizeLocale(app.getLocale());
    log(`[vibepaws] locale=${LOCALE} (os=${app.getLocale()})`);
  } catch (e) {
    err(`[vibepaws] 文案目录加载失败，回落英文: ${e}`);
  }
}

const t = (key, params) => translate(LOCALE, key, params);

/* ---------------- Core ---------------- */
async function coreRunning() {
  try {
    const r = await fetch(`http://127.0.0.1:${CORE_PORT}/health`);
    return r.ok;
  } catch {
    return false;
  }
}

let coreProc = null;

function findSystemNode() {
  const candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"];
  for (const c of candidates) {
    try {
      if (existsSync(c)) return c;
    } catch {}
  }
  return null;
}

async function ensureCore() {
  if (await coreRunning()) {
    log("[vibepaws] Core 已在运行");
    return;
  }
  if (!app.isPackaged) {
    log("[vibepaws] Core 未运行 — dev 模式请手动 npm run core（packaged 版会自动拉起）");
    return;
  }
  // packaged：自动拉起 Core（用系统 node 跑，与 better-sqlite3 ABI 兼容；数据目录=userData/.vibepaws）
  const nodePath = findSystemNode();
  if (!nodePath) {
    err("[vibepaws] 找不到系统 node — 请先安装 Node.js ≥ 20，或手动 npm run core");
    return;
  }
  const entry = join(resourcesDir(), "src", "core", "server.ts");
  coreProc = spawn(nodePath, ["--experimental-strip-types", entry, "--port", String(CORE_PORT)], {
    cwd: workDir(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  coreProc.on("error", (e) => err(`[core] spawn failed: ${e}`));
  coreProc.stdout?.on("data", (d) => log(`[core] ${String(d).trim()}`));
  coreProc.stderr?.on("data", (d) => err(`[core] ${String(d).trim()}`));
  // 等待 Core 就绪
  for (let i = 0; i < 40; i++) {
    if (await coreRunning()) {
      log("[vibepaws] Core 已自动拉起");
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  err("[vibepaws] Core 启动失败 — 宠物窗口会显示「Core 未连接」");
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
  win.loadURL(`http://127.0.0.1:${uiPort}/?locale=${encodeURIComponent(LOCALE)}`);
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

function toggleAllSpaces() {
  prefs.allSpaces = !prefs.allSpaces;
  savePrefs();
  applyWindowLevel();
  updateTrayMenu();
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

function toggleClickThrough() {
  clickThrough = !clickThrough;
  // 拖到一半从托盘打开点击穿透：渲染层从此收不到 pointerup，drag-end 永远不会来，
  // 窗口会一直黏着光标。这里主动收尾（stopDrag 末尾会重算穿透状态）。
  stopDrag();
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    {
      label: t("tray.clickthrough", { state: t(clickThrough ? "tray.state.on" : "tray.state.off") }),
      click: toggleClickThrough,
    },
    {
      label: t("tray.allspaces", { state: t(prefs.allSpaces ? "tray.state.on" : "tray.state.off") }),
      click: toggleAllSpaces,
    },
    { label: t("tray.show"), click: () => ensureWindow()?.show() },
    { label: t("tray.reset"), click: resetWindowPosition },
    { label: t("tray.quit"), click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
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
