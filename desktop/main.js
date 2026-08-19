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
import { existsSync } from "node:fs";
import { join } from "node:path";

const CORE_PORT = 17893;
const UI_PORT = 5173;
const WIN_W = 210;
const WIN_H = 250;

let win = null;
let tray = null;
let uiServer = null;
let clickThrough = false;

function repoRoot() {
  // dev 模式：electron desktop/main.js 的 cwd 即仓库根
  return process.cwd();
}

function spawnUiServer() {
  return new Promise((resolve, reject) => {
    const entry = join(repoRoot(), "src", "ui", "server.ts");
    uiServer = spawn(
      "node",
      ["--experimental-strip-types", entry, "--port", String(UI_PORT), "--core-port", String(CORE_PORT)],
      { cwd: repoRoot(), stdio: ["ignore", "pipe", "pipe"] },
    );
    uiServer.stdout?.on("data", (d) => console.log(`[ui-server] ${String(d).trim()}`));
    uiServer.stderr?.on("data", (d) => console.error(`[ui-server] ${String(d).trim()}`));
    uiServer.on("exit", (code) => console.log(`[ui-server] exited ${code}`));

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

function ensureCore() {
  try {
    return existsSync(join(repoRoot(), ".vibepaws", "api_token"));
  } catch {
    return false;
  }
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
  win.loadURL(`http://127.0.0.1:${UI_PORT}/`);
  win.on("closed", () => {
    win = null;
  });
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
    { label: `点击穿透：${clickThrough ? "开" : "关"}`, click: toggleClickThrough },
    { label: "显示宠物", click: () => win?.show() },
    { label: "退出 Vibepaws", click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
}

function createTray() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" rx="4" fill="#58a6ff"/><circle cx="5" cy="8" r="2" fill="#fff"/><circle cx="11" cy="8" r="2" fill="#fff"/></svg>`;
  const img = nativeImage.createFromDataURL(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`);
  tray = new Tray(img);
  tray.setToolTip("Vibepaws — 你的 coding pet");
  updateTrayMenu();
  tray.on("click", () => {
    if (win) {
      win.isVisible() ? win.hide() : win.show();
    }
  });
}

app.whenReady().then(async () => {
  await spawnUiServer();
  const coreReady = ensureCore();
  console.log(coreReady ? "[vibepaws] Core 检测到" : "[vibepaws] 未检测到 Core — 请先 npm run core");
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
