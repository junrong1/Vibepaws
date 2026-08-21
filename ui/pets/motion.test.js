/**
 * 动作配方单测。
 *
 * 这里守的是两件在界面上很难看出、但一出就很丑的事：
 *   ① 任何状态、任何时刻、任何一只宠物，精灵都不能画出 canvas；
 *   ② 状态切换不能瞬移（旧实现所有状态共用一条连续 t，切换时会跳十几个像素）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CANVAS, MOTION, BLEND_MS, motionAt, spriteAabb } from "./motion.js";

/** Core 认定的 7 个宠物状态（src/core/events.ts 的 PET_STATES） */
const PET_STATES = ["idle", "working", "needs-you", "warning", "finished", "tired", "level-up"];

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL("./index.json", import.meta.url)), "utf8"),
);
const roster = manifest.pets;

/** 采样：每个状态跨 3 个周期密集取点 */
function samples(state) {
  const period = MOTION[state].period;
  const out = [];
  for (let i = 0; i <= 360; i++) out.push((period * 3 * i) / 360);
  return out;
}

test("7 个状态都有配方", () => {
  for (const s of PET_STATES) {
    assert.ok(MOTION[s], `${s} 没有动作配方 —— 状态会退化成 idle`);
  }
  assert.equal(Object.keys(MOTION).length, PET_STATES.length, "配方表和状态表不同步");
});

test("素材清单非空且每只都有锚点", () => {
  assert.ok(roster.length > 0, "ui/pets/index.json 是空的 —— 跑 npm run assets");
  for (const p of roster) {
    assert.ok(p.w > 0 && p.h > 0, `${p.slug} 尺寸异常`);
    assert.ok(p.anchor.feetX >= 0 && p.anchor.feetX <= 1, `${p.slug} feetX 越界`);
    // 长边恰好 160：build_assets.py 按 max(画布宽, 画布高) 定缩放比
    assert.equal(Math.max(p.w, p.h), 160, `${p.slug} 长边不是 160`);
  }
});

test("每只宠物都有 7 个状态帧", () => {
  for (const p of roster) {
    for (const s of PET_STATES) {
      // 缺帧不会崩（渲染层回落到 base），但那个状态就「看起来没变化」——
      // 这种静默退化只有断言抓得住
      assert.ok(p.frames?.[s], `${p.slug} 缺 ${s} 帧 —— 跑 scripts/gen_states.py`);
    }
    assert.ok(p.base, `${p.slug} 缺 base`);
  }
});

test("所有帧共用一套几何：锚点固定在脚底正中", () => {
  // 各帧同宽同高同锚点，是「切状态时宠物不会横向漂移/浮起来」的保证。
  // 一只宠物只有一份 w/h/anchor，所以这里断言的是那份值本身合规。
  for (const p of roster) {
    assert.equal(p.anchor.feetX, 0.5, `${p.slug} 身体中心没对齐到画布正中`);
    assert.equal(p.anchor.feetY, 1.0, `${p.slug} 脚底没贴画布底边`);
  }
});

test("任何状态下精灵都不画出 canvas", () => {
  for (const p of roster) {
    for (const state of PET_STATES) {
      for (const t of samples(state)) {
        const m = motionAt(state, t, p.h, p.motion);
        const b = spriteAabb(m, p.w, p.h, p.anchor.feetX);
        const where = `${p.slug} / ${state} / t=${t.toFixed(0)}`;
        assert.ok(b.y0 >= 0, `${where} 顶部出界 y0=${b.y0.toFixed(1)}`);
        assert.ok(b.y1 <= CANVAS, `${where} 底部出界 y1=${b.y1.toFixed(1)}`);
        assert.ok(b.x0 >= 0, `${where} 左侧出界 x0=${b.x0.toFixed(1)}`);
        assert.ok(b.x1 <= CANVAS, `${where} 右侧出界 x1=${b.x1.toFixed(1)}`);
      }
    }
  }
});

test("位移只往上：脚不会插进地板", () => {
  for (const state of PET_STATES) {
    for (const t of samples(state)) {
      const m = motionAt(state, t, 160);
      assert.ok(m.oy <= 1e-9, `${state} 在 t=${t.toFixed(0)} 往下位移了 ${m.oy.toFixed(2)}`);
    }
  }
});

test("一次性动作会结束，循环动作不会", () => {
  for (const state of PET_STATES) {
    const { once, period } = MOTION[state];
    const cycles = once === true ? 1 : typeof once === "number" ? once : null;
    if (cycles === null) {
      assert.equal(motionAt(state, period * 1000, 160).done, false, `${state} 不该结束`);
    } else {
      assert.equal(motionAt(state, period * cycles - 1, 160).done, false, `${state} 提前结束了`);
      assert.equal(motionAt(state, period * cycles, 160).done, true, `${state} 没有结束`);
    }
  }
});

test("结束后停在中立姿态", () => {
  for (const state of PET_STATES) {
    const { once, period } = MOTION[state];
    if (!once) continue;
    const cycles = once === true ? 1 : once;
    const m = motionAt(state, period * cycles + 500, 160);
    assert.equal(m.ox, 0, `${state} 结束后还留着横向位移`);
    assert.equal(m.oy, 0, `${state} 结束后还留着纵向位移`);
    assert.equal(m.rot, 0, `${state} 结束后还留着旋转`);
  }
});

test("状态切换经插值后位移连续", () => {
  // 每帧 ~16ms，插值窗口内单帧位移不该超过这个像素数
  const MAX_JUMP = 4;
  const mix = (a, b, k) => a + (b - a) * k;
  for (const from of PET_STATES) {
    for (const to of PET_STATES) {
      if (from === to) continue;
      const fromAt = MOTION[from].period * 0.25; // 挑一个位移不为零的相位
      const a = motionAt(from, fromAt, 160);
      let prev = { ox: a.ox, oy: a.oy };
      for (let dt = 0; dt <= BLEND_MS; dt += 16) {
        const k = Math.min(1, dt / BLEND_MS);
        const b = motionAt(to, dt, 160);
        const cur = {
          ox: mix(motionAt(from, fromAt + dt, 160).ox, b.ox, k),
          oy: mix(motionAt(from, fromAt + dt, 160).oy, b.oy, k),
        };
        const jump = Math.hypot(cur.ox - prev.ox, cur.oy - prev.oy);
        assert.ok(jump <= MAX_JUMP, `${from}→${to} 在 dt=${dt} 跳了 ${jump.toFixed(1)}px`);
        prev = cur;
      }
    }
  }
});
