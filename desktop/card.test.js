/**
 * 周卡在壳这一侧（U14）：主进程只把一个验过的 PNG data URL 写成文件。
 * 主进程本身没法在 node 测试里跑，所以「收什么、不收什么」都在 card.js 里、在这里测。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { CARD_DATA_PREFIX, DEFAULT_CARD_NAME, cardFileName, decodeCardDataUrl } from "./card.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest-of-png")]);
const url = (bytes) => CARD_DATA_PREFIX + bytes.toString("base64");

test("一个真 PNG 的 data URL 解得出原样的字节", () => {
  const r = decodeCardDataUrl(url(PNG));
  assert.equal(r.ok, true);
  assert.ok(r.ok && r.bytes.equals(PNG));
});

test("别的类型、别的 scheme、不是字符串 —— 一律不收", () => {
  for (const v of [
    "data:image/jpeg;base64," + PNG.toString("base64"),
    "data:text/html;base64,PGgxPg==",
    "file:///etc/passwd",
    "/Users/x/card.png",
    null,
    42,
    { toString: () => url(PNG) },
  ]) {
    assert.equal(decodeCardDataUrl(v).ok, false, String(v));
  }
});

test("前缀说自己是 PNG 不算数：字节开头不是 PNG 签名就拒", () => {
  const r = decodeCardDataUrl(url(Buffer.from("not a png at all")));
  assert.deepEqual(r, { ok: false, reason: "signature" });
});

test("超过上限的在解码之前就被拦下；坏的 base64 不收", () => {
  assert.deepEqual(decodeCardDataUrl(url(PNG), 8), { ok: false, reason: "size" });
  assert.deepEqual(decodeCardDataUrl(CARD_DATA_PREFIX + "A".repeat(4000), 100), { ok: false, reason: "size" });
  assert.deepEqual(decodeCardDataUrl(CARD_DATA_PREFIX + "@@@@"), { ok: false, reason: "encoding" });
  assert.deepEqual(decodeCardDataUrl(CARD_DATA_PREFIX), { ok: false, reason: "size" });
});

test("文件名只认建议名的形状：路径、别的扩展名一律换成默认名", () => {
  assert.equal(cardFileName("vibepaws-week-2026-09-29.png"), "vibepaws-week-2026-09-29.png");
  for (const bad of ["../../x.png", "/tmp/vibepaws-week-2026-09-29.png", "vibepaws-week-2026-09-29.png.app", "card.png", null]) {
    assert.equal(cardFileName(bad), DEFAULT_CARD_NAME, String(bad));
  }
});
