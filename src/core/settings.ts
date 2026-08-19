/**
 * Vibepaws settings 辅助：读写 settings 表（含 API token 生命周期）。
 */
import type Database from "better-sqlite3";
import { randomBytes } from "node:crypto";

export function getSetting(db: Database.Database, key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setSetting(db: Database.Database, key: string, value: string): void {
  db.prepare(
    "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

/** 获取或生成 API token（安装时写入，防本机其他进程伪造事件） */
export function getApiToken(db: Database.Database): string {
  const existing = getSetting(db, "api_token");
  if (existing) return existing;
  const token = randomToken();
  setSetting(db, "api_token", token);
  return token;
}

export function randomToken(): string {
  return randomBytes(24).toString("hex");
}
