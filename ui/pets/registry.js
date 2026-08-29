/**
 * 宠物素材注册表 —— (pet_type_id, 状态) → 精灵帧，取不到就回落到程序生成。
 *
 * ui/pets/index.json 由 scripts/build_assets.py 生成并提交进仓库，是运行时唯一的
 * 真相来源（src/db/seed.ts 读的也是它，两边不会漂）。以前 pet_types.sprite_pack 存着
 * "pixelcat" 之类的值，注释指向 ui/pets/<pack>.json —— 那个文件从来不存在，也没人读。
 *
 * 加载策略：**base 先出，状态帧陆续补**。一只宠物有 8 张图（base + 7 个状态），
 * 等齐了才显示会白等大半秒；而按需加载又会让「切到某个状态」的那一刻没图可画。
 * 所以进门就把整套排队解码，谁先好谁先用，没好的先拿 base 顶着。
 */
import { getProceduralPet } from "./procedural.js";

const INDEX_URL = "/pets/index.json";
/** 本地覆盖清单：与 index.json 同格式，按 id 覆盖/新增（本地专属素材，不入仓库） */
const LOCAL_INDEX_URL = "/pets/index.local.json";

/** id → manifest。null = 还没加载 / 加载失败（两种情况都走兜底） */
let roster = null;
let rosterPromise = null;
/** slug → { images: {name: HTMLImageElement}, failed: boolean } */
const sets = new Map();

/**
 * 加载一次清单（仓库 index.json 是兜底，本地 index.local.json 按 id 覆盖/新增）。
 * 失败**不抛**：素材层挂了不该让整个界面白屏，宠物退回程序生成就行。
 */
export function preload() {
  if (rosterPromise) return rosterPromise;
  rosterPromise = (async () => {
    try {
      const r = await fetch(INDEX_URL, { cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      const data = await r.json();
      const byId = new Map((Array.isArray(data?.pets) ? data.pets : []).map((p) => [p.id, p]));
      // 本地覆盖：不存在（404）就忽略，存在就按 id 覆盖/新增
      try {
        const local = await fetch(LOCAL_INDEX_URL, { cache: "no-store" });
        if (local.ok) {
          const localData = await local.json();
          for (const p of Array.isArray(localData?.pets) ? localData.pets : []) byId.set(p.id, p);
        }
      } catch {
        // 本地覆盖文件读失败：用仓库兜底即可
      }
      roster = byId;
    } catch {
      roster = null; // 全员兜底
    }
    return roster;
  })();
  return rosterPromise;
}

function decode(src) {
  const img = new Image();
  img.src = src;
  // decode() 而不是 onload：onload 之后首次 drawImage 仍可能同步解码，
  // 在动画循环里就是一次可见的卡顿。
  return (img.decode ? img.decode() : Promise.resolve()).then(() => img);
}

function loadSet(manifest) {
  const set = { images: {}, failed: false };
  sets.set(manifest.slug, set);

  decode(`/pets/${manifest.base}`).then(
    (img) => { set.images.base = img; },
    () => { set.failed = true; }, // base 都拿不到才算这只宠物没救了
  );
  for (const [state, path] of Object.entries(manifest.frames ?? {})) {
    // 单个状态帧失败只是这个状态回落到 base，不影响其他状态
    decode(`/pets/${path}`).then((img) => { set.images[state] = img; }, () => {});
  }
  return set;
}

/**
 * 同步取当前该画什么 —— 动画循环里不能 await。
 *
 * 返回三种之一：
 *   { status: "sprite",   manifest, img }  可以画了（img 可能是 base 顶着的）
 *   { status: "loading" }                  base 还在解码：这一帧什么都不画
 *   { status: "fallback", pet }            用程序生成的宠物
 *
 * 「正在解码时不画」是故意的：解码只要几十毫秒（本机 http），先闪一只**别的**
 * 宠物再换成正主，比空一两帧难看得多。
 */
export function get(petTypeId, state) {
  const manifest = roster?.get(petTypeId);
  if (!manifest) return { status: "fallback", pet: getProceduralPet(petTypeId) };

  const set = sets.get(manifest.slug) ?? loadSet(manifest);
  const img = set.images[state] ?? set.images.base;
  if (img) return { status: "sprite", manifest, img };
  if (set.failed) return { status: "fallback", pet: getProceduralPet(petTypeId) };
  return { status: "loading" };
}
