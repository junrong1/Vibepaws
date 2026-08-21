/**
 * 设置窗口的 preload —— 与宠物窗口分开是刻意的（最小权限）：
 * 宠物窗口只能「打开设置」，改设置的能力只存在于设置窗口里；反过来，
 * 设置窗口也拿不到拖拽和命中测试那几个通道。
 *
 * 这里只暴露**壳层**设定（窗口怎么摆、界面语言）。预算、阈值、宠物名、session goal
 * 属于 Core，页面直接走 HTTP（/api/settings），不经过主进程 —— 那些设置在
 * `npm run ui` 的浏览器预览里同样要能改。
 *
 * CommonJS（.cjs）：sandbox 模式下的 preload 只支持 CJS，而仓库根是 "type": "module"。
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vibepaws", {
  isElectron: true,
  /** 读壳偏好：{ allSpaces, clickThrough, locale, osLocale, platform } */
  getPrefs: () => ipcRenderer.invoke("vibepaws:prefs-get"),
  /** 写壳偏好（部分字段即可），返回写入后的完整偏好 */
  setPrefs: (patch) => ipcRenderer.invoke("vibepaws:prefs-set", patch),
  /** 把宠物放回右下角（换了显示器 / 拖丢了的出口） */
  resetPosition: () => ipcRenderer.invoke("vibepaws:reset-position"),
});
