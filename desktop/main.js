/**
 * Vibepaws 桌面宠物壳（Electron）— npm run desktop
 * 架构 D5：Core 独立守护进程，本壳只是 UI 客户端（SSE 消费）。
 * 特性：透明无边框窗口、always-on-top、右下角驻留、可拖拽、
 *       点击穿透开关（托盘）、点击宠物呼出浮层。
 * 说明：Tauri v2（架构 D6 首选）待本机 Rust 工具链就绪后替换本壳，
 *       渲染层（ui/）与通信协议（SSE）不变，替换成本仅壳层。
 */
import { app, BrowserWindow, Tray, Menu, screen, nativeImage } from "electron";
import { spawn } from "node:child_process";
import { existsSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

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
    frame: false,
    resizable: false,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    webPreferences: { backgroundThrottling: false },
  });
  win.setAlwaysOnTop(true, "floating");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
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
  // 保持置顶（防被其他窗口压下去）
  setInterval(() => {
    if (win && !win.isDestroyed()) win.setAlwaysOnTop(true, "floating");
  }, 30_000);
}

function toggleClickThrough() {
  clickThrough = !clickThrough;
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
    { label: t("tray.show"), click: () => win?.show() },
    { label: t("tray.quit"), click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

function createTray() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" rx="4" fill="#58a6ff"/><circle cx="5" cy="8" r="2" fill="#fff"/><circle cx="11" cy="8" r="2" fill="#fff"/></svg>`;
  const img = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
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
