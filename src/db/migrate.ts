/**
 * Vibepaws 迁移入口：npm run db:init
 * 在 <project>/.vibepaws/vibepaws.db 初始化 9 张表（幂等）。
 */
import Database from "better-sqlite3";
import { mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { applySchema, SCHEMA_VERSION } from "./schema.ts";
import { seedPetTypes } from "./seed.ts";

export const DATA_DIR = join(process.cwd(), ".vibepaws");
export const DB_PATH = join(DATA_DIR, "vibepaws.db");

/** 打开数据库（自动建目录 + 建表），返回 db 实例。 */
export function openDb(): Database.Database {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  applySchema(db);
  seedPetTypes(db);
  return db;
}

/** 仅迁移（供 db:init 脚本使用），不持有连接。 */
export function migrate(): void {
  const db = openDb();
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => (r as { name: string }).name) as string[];
  console.log(`[vibepaws] db ready: ${DB_PATH}`);
  console.log(`[vibepaws] schema v${SCHEMA_VERSION}, tables(${tables.length}): ${tables.join(", ")}`);
  db.close();
}

// 直接运行时执行迁移
if (import.meta.url === `file://${process.argv[1]}`) {
  migrate();
}
