/**
 * Vibepaws preload — 渲染层与壳之间唯一的桥（issue #8）。
 *
 * 为什么需要它：Electron 20+ 默认 sandbox + contextIsolation，渲染层里
 * `window.process` 是 undefined。ui/app.js 原来用 `window.process?.versions?.electron`
 * 判断「我在不在 Electron 里」，判断结果恒为 false —— 于是浏览器兜底的
 * window.moveTo 拖拽和 CSS `-webkit-app-region: drag` 同时生效，互相打架。
 * 现在壳的存在由 contextBridge 显式声明，渲染层不必再猜。
 *
 * CommonJS（.cjs）而非 ESM：sandbox 模式下的 preload 只支持 CJS，
 * 而仓库根 package.json 是 "type": "module"，扩展名必须显式区分。
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vibepaws", {
  /** 渲染层据此选择「主进程拖拽」还是「浏览器兜底拖拽」 */
  isElectron: true,
  /** 开始拖拽：主进程记录光标与窗口原点的偏移，之后自己跟随光标 */
  dragStart: () => ipcRenderer.send("vibepaws:drag-start"),
  /** 结束拖拽：主进程停止跟随 */
  dragEnd: () => ipcRenderer.send("vibepaws:drag-end"),
  /**
   * 命中测试：光标此刻压着的是「真东西」（宠物 / 浮层 / 气泡）还是透明空白。
   * 窗口恒为 300×430，浮层收起时宠物头顶那 180px 是空的 —— 透明不等于穿透，
   * 不上报的话那片空白会把点击全吃掉。主进程据此开关 setIgnoreMouseEvents。
   */
  setHit: (over) => ipcRenderer.send("vibepaws:hit", Boolean(over)),
});
