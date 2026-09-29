/**
 * 周卡（U14）在壳这一侧的那一半：Den 递过来一个 data URL，主进程把它存成文件。
 *
 * 为什么要壳来存：Den 跑在一个 accessory 档的进程里（不占 Dock、没有菜单栏），页面里那一招
 * `<a download>` 在 Electron 里要么什么都不发生、要么弹一个不属于任何窗口的系统对话框；
 * 而且「存到哪」应该由一个真正的保存对话框问用户，而不是悄悄落进下载目录。
 *
 * 这里只收一样东西：一个 PNG 的 data URL，而且要自己验一遍 —— preload 是桥，不是信任边界：
 *   · 前缀必须是 data:image/png;base64,（不收别的类型、不收 URL、不收路径）；
 *   · 解码前先看长度，解码后再看字节数（一张 1200×630 的卡远小于上限）；
 *   · 解出来的前 8 个字节必须是 PNG 签名 —— 前缀说自己是 PNG 不算数；
 *   · 文件名只取建议名的形状（vibepaws-week-YYYY-MM-DD.png），渲染层给什么别的都换成默认名。
 *
 * 不 import electron —— 和 launch.js / grant.js 一样，这里的每个导出都要能在 node 测试进程里直接跑。
 */

export const CARD_DATA_PREFIX = "data:image/png;base64,";
/** 解码后的上限：8 MB。一张卡实际是几十到几百 KB，留足余量也不让一次误传吃掉内存 */
export const CARD_MAX_BYTES = 8 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const NAME_RE = /^vibepaws-week-(\d{4}-\d{2}-\d{2}|week)\.png$/;
export const DEFAULT_CARD_NAME = "vibepaws-week.png";

/**
 * data URL → PNG 字节。
 * @returns {{ ok: true, bytes: Buffer } | { ok: false, reason: "type" | "size" | "encoding" | "signature" }}
 */
export function decodeCardDataUrl(value, maxBytes = CARD_MAX_BYTES) {
  if (typeof value !== "string" || !value.startsWith(CARD_DATA_PREFIX)) return { ok: false, reason: "type" };
  const b64 = value.slice(CARD_DATA_PREFIX.length);
  // base64 每 4 个字符 3 个字节：先按长度拦，别为一个超大的串去分配内存
  if (b64.length === 0 || (b64.length / 4) * 3 > maxBytes + 3) return { ok: false, reason: "size" };
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0) return { ok: false, reason: "encoding" };
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length > maxBytes) return { ok: false, reason: "size" };
  if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    return { ok: false, reason: "signature" };
  }
  return { ok: true, bytes };
}

/** 渲染层建议的文件名：只认 vibepaws-week-YYYY-MM-DD.png 这一种形状，别的一律换成默认名 */
export function cardFileName(suggested) {
  return typeof suggested === "string" && NAME_RE.test(suggested) ? suggested : DEFAULT_CARD_NAME;
}
