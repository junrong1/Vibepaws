/**
 * Den 窗口的 preload（U13）—— 第三扇窗口、第三份桥，最小权限照旧：
 * Den 的数据全在 Core，页面经 UI server 的 /api/* 直接去拿（`npm run ui` 的浏览器预览里一样能看），
 * 所以这里一个读数据的通道都没有。它只能请壳做页面自己做不了的事：
 *   · 打开设置窗口（分数关着时那句「打开设置」）；
 *   · 存周卡（U14）：递一个 PNG data URL，主进程验过之后弹保存对话框、写文件，只回文件名。
 * 拖拽、命中测试、壳偏好、「永远允许」一概拿不到；主进程那边每个通道还要再认一次发送方（fromDen）。
 *
 * CommonJS（.cjs）：sandbox 模式下的 preload 只支持 CJS，而仓库根是 "type": "module"。
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vibepaws", {
  isElectron: true,
  /** 打开设置窗口 */
  openSettings: () => ipcRenderer.send("vibepaws:open-settings"),
  /** 存周卡 → { ok, file? , reason? }（reason: cancelled | invalid | write | sender） */
  saveCard: (dataUrl, suggestedName) => ipcRenderer.invoke("vibepaws:save-card", dataUrl, suggestedName),
});
