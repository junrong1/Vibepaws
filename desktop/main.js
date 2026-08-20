/**
 * Vibepaws 桌面宠物壳（Electron）— npm run desktop
 * 架构 D5：Core 独立守护进程，本壳只是 UI 客户端（SSE 消费）。
 * 特性：透明无边框窗口、always-on-top、右下角驻留、可拖拽、
 *       点击穿透开关（托盘）、点击宠物呼出浮层。
 * 说明：Tauri v2（架构 D6 首选）待本机 Rust 工具链就绪后替换本壳，
 *       渲染层（ui/）与通信协议（SSE）不变，替换成本仅壳层。
 */
import { app, BrowserWindow, Tray, Menu, screen, nativeImage, ipcMain } from "electron";
import { spawn } from "node:child_process";
import { existsSync, appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

// packaged 模式下把日志写到 userData（GUI 启动的 app stdout 不可见）
function log(line) {
  console.log(line);
  if (app.isPackaged) {
    try {
      const dir = app.getPath("userData");
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, "vibepaws.log"), `${new Date().toISOString()} ${line}\n`);
    } catch {}
  }
}
function err(line) {
  console.error(line);
  if (app.isPackaged) {
    try {
      const dir = app.getPath("userData");
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, "vibepaws.log"), `${new Date().toISOString()} ERR ${line}\n`);
    } catch {}
  }
}

const CORE_PORT = 17893;
const UI_PORT = 5173;
const WIN_W = 210;
const WIN_H = 250;

let win = null;
let tray = null;
let uiServer = null;
let clickThrough = false;

/* ---------------- 壳偏好（issue #4） ----------------
 * 只存「窗口怎么摆」这类壳层设定，与 Core 的 settings 表无关：
 * Core 是守护进程，可能没跑；窗口行为必须在 Core 之前就能决定。
 *
 * allSpaces 默认 true：宠物是「活着的伙伴」，你在哪个桌面干活它就该在哪 ——
 * 尤其是 coding agent 常年跑在全屏 iTerm2 里，那本身就是一个独立 Space，
 * 钉死在启动那张桌面上等于永远看不见。#4 的真正诉求不是「别跟着我」，
 * 而是「这件事得归我管」：所以默认跟随 + 托盘里随时可关。 */
const DEFAULT_PREFS = { allSpaces: true };
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

function repoRoot() {
  // dev 模式：electron desktop/main.js 的 cwd 即仓库根；packaged：资源目录
  return process.cwd();
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

function coreRunning() {
  return new Promise((resolve) => {
    fetch(`http://127.0.0.1:${CORE_PORT}/health`)
      .then((r) => resolve(r.ok))
      .catch(() => resolve(false));
  });
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
  err("[vibepaws] Core 启动失败");
}

function spawnUiServer() {
  return new Promise((resolve, reject) => {
    const entry = join(resourcesDir(), "src", "ui", "server.ts");
    const uiDir = app.isPackaged ? join(resourcesDir(), "ui") : undefined;
    const args = ["--experimental-strip-types", entry, "--port", String(UI_PORT), "--core-port", String(CORE_PORT)];
    if (uiDir) args.push("--ui-dir", uiDir);
    uiServer = spawn(process.execPath, args, {
      cwd: workDir(),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    uiServer.stdout?.on("data", (d) => log(`[ui-server] ${String(d).trim()}`));
    uiServer.stderr?.on("data", (d) => err(`[ui-server] ${String(d).trim()}`));
    uiServer.on("exit", (code) => log(`[ui-server] exited ${code}`));

    let tries = 0;
    const probe = setInterval(async () => {
      tries++;
      try {
        const r = await fetch(`http://127.0.0.1:${UI_PORT}/`);
        if (r.ok) {
          clearInterval(probe);
          resolve(UI_PORT);
        }
      } catch {
        if (tries > 40) {
          clearInterval(probe);
          reject(new Error("ui server did not start"));
        }
      }
    }, 250);
  });
}

function createWindow() {
  const { workArea } = screen.getPrimaryDisplay();
  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    x: workArea.x + workArea.width - WIN_W - 24,
    y: workArea.y + workArea.height - WIN_H - 40,
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
  // 把主进程裁决的 locale 交给渲染层，避免 navigator.language 与 app.getLocale() 打架
  win.loadURL(`http://127.0.0.1:${UI_PORT}/?locale=${encodeURIComponent(LOCALE)}`);
  // 渲染进程 console → 主进程日志（调试用）
  win.webContents.on("console-message", (_e, level, message, line, sourceId) => {
    console.log(`[renderer:${level}] ${message} (${sourceId}:${line})`);
  });
  win.webContents.on("did-fail-load", (_e, code, desc, url) => {
    console.error(`[renderer] load failed ${code} ${desc} ${url}`);
  });
  win.on("closed", () => {
    stopDrag();
    win = null;
  });
  // 诊断：窗口状态与 Canvas 渲染结果
  setTimeout(async () => {
    try {
      const b = win?.getBounds();
      const v = win?.isVisible();
      console.log(`[diag] bounds=${JSON.stringify(b)} visible=${v}`);
      const pixel = await win?.webContents.executeJavaScript(`(() => {
        const c = document.getElementById('pet');
        if (!c) return 'NO_CANVAS';
        const ctx = c.getContext('2d');
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let opaque = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) opaque++;
        return 'canvas=' + c.width + 'x' + c.height + ' opaquePx=' + opaque;
      })()`);
      console.log(`[diag] ${pixel}`);
    } catch (e) {
      console.error(`[diag] ${e}`);
    }
  }, 3000);
  // 保持置顶（防被其他窗口压下去）。顺带重申 workspace 行为：
  // setAlwaysOnTop 会重写窗口的 NSWindow level，之前只重申置顶不重申 workspace，
  // 两者会渐渐不同步。
  setInterval(applyWindowLevel, 30_000);
}

/**
 * 置顶层级 + Spaces 可见性一起施加（issue #4）。
 *
 * 原来这两行是写死的常量，用户没有任何开关；现在读 prefs，托盘里可以随时翻转。
 * 顺序有讲究：先 setAlwaysOnTop（它会重设 collectionBehavior），再设 workspace，
 * 反过来写 workspace 会被随后的置顶调用抹掉 —— 这也是那个 30s 保活 tick
 * 必须走这个函数、而不能只调 setAlwaysOnTop 的原因。
 */
function applyWindowLevel() {
  if (!win || win.isDestroyed()) return;
  win.setAlwaysOnTop(true, "floating");
  win.setVisibleOnAllWorkspaces(prefs.allSpaces, { visibleOnFullScreen: prefs.allSpaces });
}

function toggleAllSpaces() {
  prefs.allSpaces = !prefs.allSpaces;
  savePrefs();
  applyWindowLevel();
  updateTrayMenu();
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

function startDrag() {
  if (!win || win.isDestroyed()) return;
  stopDrag();
  const cursor = screen.getCursorScreenPoint();
  const [wx, wy] = win.getPosition();
  dragOffset = { dx: cursor.x - wx, dy: cursor.y - wy };
  dragTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !dragOffset) return stopDrag();
    const p = screen.getCursorScreenPoint();
    const x = Math.round(p.x - dragOffset.dx);
    const y = Math.round(p.y - dragOffset.dy);
    const [cx, cy] = win.getPosition();
    // 位置没变就别调 setPosition：静止时这个 tick 几乎不花钱
    if (x !== cx || y !== cy) win.setPosition(x, y, false);
  }, DRAG_TICK_MS);
}

function stopDrag() {
  if (dragTimer) clearInterval(dragTimer);
  dragTimer = null;
  dragOffset = null;
}

ipcMain.on("vibepaws:drag-start", (e) => {
  // 只认宠物窗口自己发来的拖拽请求
  if (win && !win.isDestroyed() && e.sender === win.webContents) startDrag();
});
ipcMain.on("vibepaws:drag-end", stopDrag);

function toggleClickThrough() {
  clickThrough = !clickThrough;
  // 拖到一半从托盘打开点击穿透：渲染层从此收不到 pointerup，drag-end 永远不会来，
  // 窗口会一直黏着光标。这里主动收尾。
  stopDrag();
  if (win && !win.isDestroyed()) {
    win.setIgnoreMouseEvents(clickThrough, { forward: true });
  }
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
    { label: t("tray.show"), click: () => win?.show() },
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
    if (win) {
      win.isVisible() ? win.hide() : win.show();
    }
  });
}

app.whenReady().then(async () => {
  loadPrefs();
  await loadI18n();
  await ensureCore();
  await spawnUiServer();
  createWindow();
  createTray();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  // 托盘常驻：不退出
});

app.on("before-quit", () => {
  stopDrag();
  uiServer?.kill();
  coreProc?.kill();
});

// 单实例
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    win?.show();
  });
}
