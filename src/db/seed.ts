/**
 * 宠物内容注册表种子数据（架构 §2.7）。
 *
 * 正式宠物来自 ui/pets/index.json —— 由 scripts/build_assets.py 从 pet_assests/ 的
 * 原图生成并提交进仓库。渲染层读的是同一个文件（ui/pets/registry.js），所以
 * 「表里有哪些宠物」和「界面能画哪些宠物」不会漂。
 *
 * 老的程序生成宠物（id 1~6）和进化家族（10~12）留在表里但**不再进 starter 池**：
 * 已经分配到它们的老库照样画得出来（ui/pets/procedural.js 兜底），新库只会滚到
 * 有素材的那批。
 */
import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** 与渲染层共用的素材清单。定位方式对齐 src/ui/server.ts 的 I18N_FILE ——
 *  打包后 resources/src/db/ → resources/ui/ 同样成立（package.json 的 extraResources 已经带上 ui）。 */
const SPRITE_INDEX = fileURLToPath(new URL("../../ui/pets/index.json", import.meta.url));

export interface PetTypeSeed {
  id: number;
  name: string;
  rarity: "common" | "uncommon" | "rare" | "legendary";
  sprite_pack: string;
  starter: 0 | 1;
  evolution_meta: Array<{ from_level: number; conditions?: string[]; to_stage: string }>;
}

/**
 * 程序生成的宠物 + 进化家族。保留是为了老库不炸，不是为了继续分配。
 * 进化家族三阶目前只有配色差别，重做美术是后续的事。
 */
export const LEGACY_PET_TYPES: PetTypeSeed[] = [
  { id: 1, name: "Pixel Cat", rarity: "common", sprite_pack: "pixelcat", starter: 0, evolution_meta: [] },
  { id: 2, name: "Byte Pup", rarity: "common", sprite_pack: "bytepup", starter: 0, evolution_meta: [] },
  { id: 3, name: "Git Raccoon", rarity: "common", sprite_pack: "gitraccoon", starter: 0, evolution_meta: [] },
  { id: 4, name: "Turbo Turtle", rarity: "uncommon", sprite_pack: "turboturtle", starter: 0, evolution_meta: [] },
  { id: 5, name: "Mono Fox", rarity: "uncommon", sprite_pack: "monofox", starter: 0, evolution_meta: [] },
  { id: 6, name: "Shell Slug", rarity: "rare", sprite_pack: "shellslug", starter: 0, evolution_meta: [] },
  {
    id: 10, name: "Spark Sprite", rarity: "rare", sprite_pack: "sparksprite", starter: 0,
    evolution_meta: [{ from_level: 5, conditions: ["health>=0.7"], to_stage: "11" }],
  },
  {
    id: 11, name: "Flare Sprite", rarity: "rare", sprite_pack: "flaresprite", starter: 0,
    evolution_meta: [{ from_level: 10, conditions: ["health>=0.7"], to_stage: "12" }],
  },
  { id: 12, name: "Nova Sprite", rarity: "legendary", sprite_pack: "novasprite", starter: 0, evolution_meta: [] },
];

interface SpriteManifest {
  id: number;
  slug: string;
  name: string;
  rarity: PetTypeSeed["rarity"];
  starter: boolean;
}

/** 读素材清单。读不到就返回空数组 —— 由 petTypeSeeds() 决定怎么退。 */
export function spriteRoster(): PetTypeSeed[] {
  let parsed: { pets?: SpriteManifest[] };
  try {
    parsed = JSON.parse(readFileSync(SPRITE_INDEX, "utf8")) as { pets?: SpriteManifest[] };
  } catch {
    return [];
  }
  const pets = Array.isArray(parsed.pets) ? parsed.pets : [];
  return pets.map((p) => ({
    id: p.id,
    name: p.name,
    rarity: p.rarity,
    sprite_pack: p.slug,
    starter: p.starter ? 1 : 0,
    evolution_meta: [],
  }));
}

/**
 * 最终要写进表里的全部宠物类型。
 *
 * 素材清单缺失（没跑过 `npm run assets`）时，让老宠物重新当 starter：否则
 * starter 池是空的，新库一只宠物都分不出来。
 */
export function petTypeSeeds(): PetTypeSeed[] {
  const sprites = spriteRoster();
  const legacy: PetTypeSeed[] = LEGACY_PET_TYPES.map((p) => ({
    ...p,
    starter: sprites.length === 0 && p.id <= 6 ? 1 : 0,
  }));
  return [...legacy, ...sprites];
}

/**
 * 幂等写入。
 *
 * 以前这里是「表非空就直接 return」—— 那意味着**老库永远拿不到新宠物**：
 * 加了素材、改了稀有度、把老宠物挪出 starter 池，全都只对全新安装生效。
 * 改成按 id upsert 之后，内容更新对所有库一视同仁。
 */
export function seedPetTypes(db: Database.Database): number {
  const seeds = petTypeSeeds();
  const upsert = db.prepare(
    `INSERT INTO pet_types(id, name, rarity, sprite_pack, evolution_meta, starter)
     VALUES(?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name, rarity=excluded.rarity, sprite_pack=excluded.sprite_pack,
       evolution_meta=excluded.evolution_meta, starter=excluded.starter`,
  );
  const run = db.transaction((rows: PetTypeSeed[]) => {
    for (const p of rows) {
      upsert.run(p.id, p.name, p.rarity, p.sprite_pack, JSON.stringify(p.evolution_meta), p.starter);
    }
  });
  run(seeds);
  const starters = seeds.filter((p) => p.starter === 1).length;
  console.log(`[vibepaws] seeded ${seeds.length} pet types (${starters} starters)`);
  return seeds.length;
}

/** 兼容旧引用 */
export const PET_TYPES = LEGACY_PET_TYPES;
