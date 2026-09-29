/**
 * 项目名脱敏（R26）：一个路径分隔符都不许进 Den / 周卡。纯函数，不碰 DOM。
 * Core 给的已经是 projectShortName() 的短名，这里是最后一道：控制字符去掉、
 * 只留最后一段（POSIX 与 Windows 两种分隔符都算）。空的、全是分隔符的 → "?"。
 */

/** 周卡上项目短名的长度上限（字符）：再长的名字到了卡上也是被省略号截掉，不如早点截 */
const MAX_NAME_CHARS = 40;

/**
 * 最后一段，不截长度 —— Den 用它：Journal 的项目筛选要把这个名字原样交回 Core，截了就对不上。
 * @param {unknown} raw
 */
export function shortName(raw) {
  const s = String(raw ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ");
  const parts = s.split(/[\\/]+/).map((p) => p.trim()).filter(Boolean);
  return parts.at(-1) ?? "?";
}

/**
 * 上卡用：shortName 再截到上限。
 * @param {unknown} raw
 */
export function redactProject(raw) {
  const name = shortName(raw);
  const chars = [...name];
  return chars.length > MAX_NAME_CHARS ? chars.slice(0, MAX_NAME_CHARS).join("") : name;
}
