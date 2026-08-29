/**
 * 宠物类型种子单测。
 *
 * 重点守两件事：
 *   ① 表里的宠物和 ui/pets/index.json 一致 —— 渲染层读的是同一个文件，一旦漂了，
 *      界面就会拿到一个没有素材的 pet_type_id，只能画兜底宠物；
 *   ② 内容更新对**老库**也生效。以前 seedPetTypes 是「表非空就 return」，
 *      于是加宠物、改稀有度、把老宠物挪出 starter 池全都只对全新安装有效。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { applySchema } from "./schema.ts";
import { seedPetTypes, petTypeSeeds, spriteRoster, mergePetSeeds, LEGACY_PET_TYPES, type PetTypeSeed } from "./seed.ts";

function makeDb(): Database.Database {
  const db = new Database(":memory:");
  applySchema(db);
  return db;
}

function rows(db: Database.Database) {
  return db
    .prepare("SELECT id, name, rarity, sprite_pack, starter FROM pet_types ORDER BY id")
    .all() as Array<{ id: number; name: string; rarity: string; sprite_pack: string; starter: number }>;
}

test("素材清单里的宠物都进了表，且 sprite_pack = slug", () => {
  const db = makeDb();
  seedPetTypes(db);
  const roster = spriteRoster();
  assert.ok(roster.length > 0, "素材清单是空的 —— 先跑 npm run assets");
  const byId = new Map(rows(db).map((r) => [r.id, r]));
  for (const p of roster) {
    const row = byId.get(p.id);
    assert.ok(row, `pet_type ${p.id} (${p.sprite_pack}) 没写进表`);
    // sprite_pack 以前存的是 "pixelcat" 这种指向不存在文件的值，谁也没读。
    // 现在它必须等于素材目录名 —— 这是表和 ui/pets/ 之间唯一的联系。
    assert.equal(row.sprite_pack, p.sprite_pack);
    // starter 标记必须与清单一致：清单里显式 starter:false 的（本地专属素材，如 denia）
    // 不该被强行要求可抽 —— 之前硬编码 === 1 会因本地多出的素材在本地测试失败。
    assert.equal(row.starter, p.starter, `${p.sprite_pack} 的 starter 标记应与清单一致`);
  }
});

test("程序生成的老宠物留在表里但不再可抽", () => {
  const db = makeDb();
  seedPetTypes(db);
  const byId = new Map(rows(db).map((r) => [r.id, r]));
  for (const legacy of LEGACY_PET_TYPES) {
    const row = byId.get(legacy.id);
    // 留着：老库里已经分配了这些 id 的用户，宠物名字还得查得到
    assert.ok(row, `老 pet_type ${legacy.id} 被删了 —— 老库会查不到名字`);
    assert.equal(row.starter, 0, `老 pet_type ${legacy.id} 仍然在 starter 池里`);
  }
});

test("starter 池恰好等于素材清单", () => {
  const db = makeDb();
  seedPetTypes(db);
  const starters = rows(db).filter((r) => r.starter === 1).map((r) => r.id);
  assert.deepEqual(
    starters,
    spriteRoster().filter((p) => p.starter === 1).map((p) => p.id).sort((a, b) => a - b),
  );
});

test("重复 seed 幂等：不重复插入、不改变内容", () => {
  const db = makeDb();
  seedPetTypes(db);
  const first = rows(db);
  seedPetTypes(db);
  seedPetTypes(db);
  assert.deepEqual(rows(db), first);
});

test("老库也能拿到内容更新（这是 upsert 之前做不到的）", () => {
  const db = makeDb();
  // 模拟 v1 老库：老宠物是可抽的，而且没有任何新宠物
  const insert = db.prepare(
    `INSERT INTO pet_types(id, name, rarity, sprite_pack, evolution_meta, starter)
     VALUES(?, ?, ?, ?, '[]', 1)`,
  );
  for (const p of LEGACY_PET_TYPES) insert.run(p.id, p.name, p.rarity, p.sprite_pack);
  assert.equal(rows(db).filter((r) => r.starter === 1).length, LEGACY_PET_TYPES.length);

  seedPetTypes(db);

  const after = rows(db);
  assert.equal(
    after.filter((r) => r.starter === 1).length,
    spriteRoster().filter((p) => p.starter === 1).length,
    "老库的 starter 池没有被更新",
  );
  for (const legacy of LEGACY_PET_TYPES) {
    assert.equal(after.find((r) => r.id === legacy.id)?.starter, 0);
  }
});

test("petTypeSeeds：id 不重复", () => {
  const ids = petTypeSeeds().map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length, "pet_type id 撞了");
});

test("mergePetSeeds：仓库是兜底，本地覆盖按 id 追加", () => {
  const base: PetTypeSeed[] = [
    { id: 20, name: "A", rarity: "common", sprite_pack: "a", starter: 1, evolution_meta: [] },
    { id: 21, name: "B", rarity: "uncommon", sprite_pack: "b", starter: 1, evolution_meta: [] },
  ];
  const override: PetTypeSeed[] = [
    { id: 25, name: "Local", rarity: "rare", sprite_pack: "local", starter: 0, evolution_meta: [] },
  ];
  const merged = mergePetSeeds(base, override);
  assert.deepEqual(merged.map((p) => p.id), [20, 21, 25]);
});

test("mergePetSeeds：同 id 本地优先覆盖（starter 标记也跟着本地走）", () => {
  const base: PetTypeSeed[] = [
    { id: 20, name: "Base", rarity: "common", sprite_pack: "base", starter: 1, evolution_meta: [] },
  ];
  const override: PetTypeSeed[] = [
    { id: 20, name: "Local", rarity: "rare", sprite_pack: "local", starter: 0, evolution_meta: [] },
  ];
  const merged = mergePetSeeds(base, override);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.name, "Local");
  assert.equal(merged[0]!.starter, 0);
});
