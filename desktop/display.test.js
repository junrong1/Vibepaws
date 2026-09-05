/**
 * display.js 的回归闸。
 *
 * 这里守的每一条都只在**别人的桌上**才会错：两块一模一样的显示器、拔掉扩展屏、
 * 系统里把两块屏对调、把 large 档开在一块很矮的屏上、一份手改坏了的偏好文件。
 * 开发机上一种都不会发生 —— 所以它们只能靠把显示器摆出来测。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PET_SCALES,
  BASE_WINDOW,
  BASE_PET_BOX,
  DISPLAY_DEFAULTS,
  FOLLOW_DWELL_MS,
  anchorToFraction,
  boundsForAnchor,
  defaultAnchor,
  displayKeys,
  displayName,
  displayNameFromKey,
  followStep,
  fractionToAnchor,
  normalizeDisplayPrefs,
  pickHomeKey,
  scaledSizes,
} from "./display.js";

/** 内置屏：菜单栏吃掉顶上 37px，所以 workArea 比 bounds 矮 */
const BUILTIN = {
  id: 1,
  label: "Built-in Retina Display",
  size: { width: 1512, height: 982 },
  bounds: { x: 0, y: 0, width: 1512, height: 982 },
  workArea: { x: 0, y: 37, width: 1512, height: 945 },
  scaleFactor: 2,
};
/** 右边那块外接 4K */
const EXTERNAL = {
  id: 2,
  label: "LG HDR 4K",
  size: { width: 2560, height: 1440 },
  bounds: { x: 1512, y: 0, width: 2560, height: 1440 },
  workArea: { x: 1512, y: 0, width: 2560, height: 1440 },
  scaleFactor: 2,
};

test("显示器的键跨拔插稳定 —— 不含 display.id", () => {
  const key = displayKeys([BUILTIN]).get(1);
  // 同一块屏，重新插上之后 macOS 给了另一个 CGDirectDisplayID
  const replugged = { ...BUILTIN, id: 87654321 };
  assert.equal(displayKeys([replugged]).get(87654321), key, "换了 id 还应该认出是同一块屏");
  assert.ok(!key.includes("display-"), `有型号名时不该退回 id：${key}`);
});

test("两块一模一样的显示器按摆放位置编号，对调时记忆跟着对调", () => {
  const left = { ...EXTERNAL, id: 10, bounds: { ...EXTERNAL.bounds, x: -2560 } };
  const right = { ...EXTERNAL, id: 11, bounds: { ...EXTERNAL.bounds, x: 0 } };
  const keys = displayKeys([right, left]); // 传入顺序故意是乱的
  assert.notEqual(keys.get(10), keys.get(11), "两块屏不能挤进同一个键");
  assert.ok(!keys.get(10).includes("#"), "最左边那块拿不带后缀的键");
  assert.ok(keys.get(11).endsWith("#2"));
  // 在系统设置里把两块屏对调：左边那块现在是 id 11
  const swapped = displayKeys([
    { ...left, id: 11 },
    { ...right, id: 10 },
  ]);
  assert.equal(swapped.get(11), keys.get(10), "现在站在左边的那块，拿的是「左边那块」的位置记忆");
});

test("label 为空时退回 id —— 不能让所有屏挤进同一个键", () => {
  const a = { id: 1, label: "", size: { width: 1920, height: 1080 }, bounds: { x: 0, y: 0 }, scaleFactor: 1 };
  const b = { ...a, id: 2, bounds: { x: 1920, y: 0 } };
  const keys = displayKeys([a, b]);
  assert.notEqual(keys.get(1), keys.get(2));
  assert.equal(displayName(a), "1920×1080", "没有型号名时给人看的也得是点什么");
  assert.equal(displayName(BUILTIN), "Built-in Retina Display");
});

test("钉住的那块屏被拔掉之后，名字仍然说得出来 —— 只剩一个键的时候", () => {
  const key = displayKeys([EXTERNAL]).get(2);
  assert.equal(displayNameFromKey(key), "LG HDR 4K", "界面上不能出现「Pinned to ?」");
  assert.equal(displayNameFromKey(`${key}#2`), "LG HDR 4K #2", "两块同型号时得说出是第几块");
  // 当初就没拿到型号名：编一个不如把键原样交出去
  const anon = displayKeys([{ id: 7, label: "", size: { width: 1920, height: 1080 }, scaleFactor: 1 }]).get(7);
  assert.equal(displayNameFromKey(anon), anon);
  assert.equal(displayNameFromKey(null), "");
});

test("三档尺寸整体缩放窗口与宠物盒子，且都是整数", () => {
  assert.deepEqual(Object.keys(PET_SCALES), ["small", "medium", "large"]);
  assert.deepEqual(scaledSizes("medium"), { window: BASE_WINDOW, petBox: BASE_PET_BOX });
  for (const scale of ["small", "medium", "large", "bogus"]) {
    const s = scaledSizes(scale);
    for (const v of [s.window.width, s.window.height, s.petBox.width, s.petBox.height]) {
      assert.equal(v, Math.round(v), "小数尺寸会让透明窗口做半像素重采样，宠物边缘发虚");
    }
  }
  assert.deepEqual(scaledSizes("bogus"), scaledSizes("medium"), "认不出来的档当 medium");
  assert.ok(scaledSizes("small").petBox.width < scaledSizes("large").petBox.width);
});

test("锚点的比例形式在分辨率变化下仍然指向同一个角落", () => {
  const anchor = defaultAnchor(BUILTIN.workArea, BASE_PET_BOX);
  const frac = anchorToFraction(anchor, BUILTIN.workArea);
  assert.deepEqual(fractionToAnchor(frac, BUILTIN.workArea), anchor, "同一块屏上必须原样还原");

  // 同一块屏换了缩放档位：1512x945 → 1728x1080
  const bigger = { x: 0, y: 42, width: 1728, height: 1080 };
  const moved = fractionToAnchor(frac, bigger);
  assert.ok(moved.x > bigger.x + bigger.width * 0.8, "还在右边");
  assert.ok(moved.y > bigger.y + bigger.height * 0.9, "还在下边");
  const b = boundsForAnchor({ anchor: moved, workArea: bigger, window: BASE_WINDOW, petBox: BASE_PET_BOX });
  assert.ok(b.x >= bigger.x && b.y >= bigger.y, "换分辨率之后不该跑到屏幕外面去");
});

test("锚点夹在工作区内：宠物贴得到左右边缘，浮层不会被菜单栏吃掉", () => {
  const petBox = BASE_PET_BOX;
  const far = boundsForAnchor({
    anchor: { x: 99999, y: 99999 },
    workArea: BUILTIN.workArea,
    window: BASE_WINDOW,
    petBox,
  });
  // 横向按宠物盒子夹：宠物右边缘正好贴住屏幕，窗口那多出来的透明部分探出去无所谓
  assert.equal(far.x + BASE_WINDOW.width / 2 + petBox.width / 2, BUILTIN.workArea.width);
  // 纵向按整扇窗口夹：窗口整个在工作区里，浮层那一段才不会被裁
  assert.equal(far.y + far.height, BUILTIN.workArea.y + BUILTIN.workArea.height);

  const near = boundsForAnchor({ anchor: { x: -500, y: -500 }, workArea: BUILTIN.workArea, window: BASE_WINDOW, petBox });
  assert.equal(near.x + BASE_WINDOW.width / 2 - petBox.width / 2, 0);
  assert.equal(near.y, BUILTIN.workArea.y, "顶边不能压进菜单栏");
});

test("窗口比工作区还高时底边对齐 —— 宁可裁掉浮层，也不能把宠物挤出屏幕", () => {
  // 一块很矮的屏（老投影仪 / 副屏竖排剩下的一条），large 档的窗口比它还高
  const short = { x: 0, y: 0, width: 1280, height: 400 };
  const { window: win, petBox } = scaledSizes("large");
  assert.ok(win.height > short.height, "前提：窗口确实塞不下");
  const b = boundsForAnchor({ anchor: { x: 640, y: 380 }, workArea: short, window: win, petBox });
  assert.equal(b.y + b.height, short.y + short.height, "底边对齐 = 宠物的脚还在屏幕里");
  assert.ok(b.y < short.y, "被裁掉的是宠物头顶那片留给浮层的空白");
});

test("跟随要等光标**停住** —— 一次横穿两块屏不该把宠物拽走", () => {
  let s = { pendingKey: null, pendingSince: 0 };
  const step = (cursorKey, now) => {
    const r = followStep(s, { cursorKey, windowKey: "A", now });
    s = r.state;
    return r.move;
  };
  assert.equal(step("A", 0), null, "光标本来就在宠物这块屏上");
  assert.equal(step("B", 1000), null, "刚进 B，还不够久");
  assert.equal(step("B", 1000 + FOLLOW_DWELL_MS - 1), null);
  assert.equal(step("B", 1000 + FOLLOW_DWELL_MS), "B", "停够了才搬家");

  // 横扫：A → B → C → A，每一步都不到停留时长
  s = { pendingKey: null, pendingSince: 0 };
  assert.equal(step("B", 0), null);
  assert.equal(step("C", 200), null);
  assert.equal(step("B", 400), null, "换过目标屏，计时必须重来");
  assert.equal(step("B", 400 + FOLLOW_DWELL_MS - 1), null);
});

test("光标不在任何一块屏上时什么都不做", () => {
  const r = followStep({ pendingKey: "B", pendingSince: 0 }, { cursorKey: null, windowKey: "A", now: 99999 });
  assert.equal(r.move, null);
  assert.equal(r.state.pendingKey, null);
});

test("记住的那块屏不在了就回主屏 —— 拔掉扩展屏之后宠物必须还看得见", () => {
  const available = ["builtin", "external"];
  assert.equal(pickHomeKey({ available, mode: "follow", lastKey: "external", primaryKey: "builtin" }), "external");
  assert.equal(pickHomeKey({ available, mode: "pin", pinnedKey: "external", primaryKey: "builtin" }), "external");
  // 线拔了
  assert.equal(pickHomeKey({ available: ["builtin"], mode: "pin", pinnedKey: "external", primaryKey: "builtin" }), "builtin");
  assert.equal(pickHomeKey({ available: ["builtin"], mode: "follow", lastKey: "external", primaryKey: "builtin" }), "builtin");
  // 从来没记过
  assert.equal(pickHomeKey({ available, mode: "follow", lastKey: null, primaryKey: "builtin" }), "builtin");
});

test("偏好文件是用户手改的普通 JSON —— 坏值一律回落，不许把 NaN 喂给窗口坐标", () => {
  assert.deepEqual(normalizeDisplayPrefs(undefined), DISPLAY_DEFAULTS);
  assert.deepEqual(normalizeDisplayPrefs("nope"), DISPLAY_DEFAULTS);
  const p = normalizeDisplayPrefs({
    scale: "huge",
    displayMode: "sideways",
    pinnedDisplay: "   ",
    anchors: {
      good: { fx: 0.5, fy: 0.9 },
      overflow: { fx: 4, fy: -2 },
      broken: { fx: "abc", fy: 1 },
      nothing: null,
      "": { fx: 0.1, fy: 0.1 },
    },
  });
  assert.equal(p.scale, "medium");
  assert.equal(p.displayMode, "follow");
  assert.equal(p.pinnedDisplay, null);
  assert.deepEqual(p.anchors, { good: { fx: 0.5, fy: 0.9 }, overflow: { fx: 1, fy: 0 } });
  assert.deepEqual(normalizeDisplayPrefs({ scale: "large", displayMode: "pin", pinnedDisplay: "x" }), {
    ...DISPLAY_DEFAULTS,
    scale: "large",
    displayMode: "pin",
    pinnedDisplay: "x",
  });
});

test("normalizeDisplayPrefs 不复用调用方的对象 —— 默认值被写花过一次就再也查不出来", () => {
  const a = normalizeDisplayPrefs({});
  a.anchors.x = { fx: 0, fy: 0 };
  a.scale = "large";
  assert.deepEqual(DISPLAY_DEFAULTS.anchors, {});
  assert.equal(normalizeDisplayPrefs({}).scale, "medium");
});
