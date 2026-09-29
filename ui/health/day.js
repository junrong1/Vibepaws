/**
 * 本地日历日键（YYYY-MM-DD）。与 core/health_query.ts 的 localDayKey 同一个口径：
 * 按**本地**年月日取，不按 UTC —— 23:50 收工的那一段落在用户过的那一天。
 * Den 与周卡共用这一份：日界线要是有一处改了，三处（Core / Den / 周卡）必须一起改。
 * 纯函数，不碰 DOM。
 *
 * @param {Date|string|number} at
 * @returns {string}
 */
export function localDayKey(at) {
  const d = at instanceof Date ? at : new Date(at);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
