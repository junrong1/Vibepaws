/**
 * 宠物内容注册表种子数据（架构 §2.7）。
 * MVP 交付 6 个 starter 宠物 + 1 个完整进化家族（架构 §2.7 的简化：先 6 个，素材后补）。
 * sprite_pack 指向 ui/pets/<pack>.json（数据驱动 sprite）。
 */
import type Database from "better-sqlite3";

export interface PetTypeSeed {
  id: number;
  name: string;
  rarity: "common" | "uncommon" | "rare" | "legendary";
  sprite_pack: string;
  starter: 0 | 1;
  evolution_meta: Array<{ from_level: number; conditions?: string[]; to_stage: string }>;
}

export const PET_TYPES: PetTypeSeed[] = [
  {
    id: 1,
    name: "Pixel Cat",
    rarity: "common",
    sprite_pack: "pixelcat",
    starter: 1,
    evolution_meta: [],
  },
  {
    id: 2,
    name: "Byte Pup",
    rarity: "common",
    sprite_pack: "bytepup",
    starter: 1,
    evolution_meta: [],
  },
  {
    id: 3,
    name: "Git Raccoon",
    rarity: "common",
    sprite_pack: "gitraccoon",
    starter: 1,
    evolution_meta: [],
  },
  {
    id: 4,
    name: "Turbo Turtle",
    rarity: "uncommon",
    sprite_pack: "turboturtle",
    starter: 1,
    evolution_meta: [],
  },
  {
    id: 5,
    name: "Mono Fox",
    rarity: "uncommon",
    sprite_pack: "monofox",
    starter: 1,
    evolution_meta: [],
  },
  {
    id: 6,
    name: "Shell Slug",
    rarity: "rare",
    sprite_pack: "shellslug",
    starter: 1,
    evolution_meta: [],
  },
  {
    id: 10,
    name: "Spark Sprite",
    rarity: "rare",
    sprite_pack: "sparksprite",
    starter: 0,
    evolution_meta: [
      { from_level: 5, conditions: ["health>=0.7"], to_stage: "11" },
    ],
  },
  {
    id: 11,
    name: "Flare Sprite",
    rarity: "rare",
    sprite_pack: "flaresprite",
    starter: 0,
    evolution_meta: [
      { from_level: 10, conditions: ["health>=0.7"], to_stage: "12" },
    ],
  },
  {
    id: 12,
    name: "Nova Sprite",
    rarity: "legendary",
    sprite_pack: "novasprite",
    starter: 0,
    evolution_meta: [],
  },
];

export function seedPetTypes(db: Database.Database): number {
  const count = db.prepare("SELECT COUNT(*) as c FROM pet_types").get() as { c: number };
  if ((count.c ?? 0) > 0) return count.c as number;
  const insert = db.prepare(
    `INSERT INTO pet_types(id, name, rarity, sprite_pack, evolution_meta, starter)
     VALUES(?, ?, ?, ?, ?, ?)`,
  );
  for (const p of PET_TYPES) {
    insert.run(p.id, p.name, p.rarity, p.sprite_pack, JSON.stringify(p.evolution_meta), p.starter);
  }
  console.log(`[vibepaws] seeded ${PET_TYPES.length} pet types`);
  return PET_TYPES.length;
}
