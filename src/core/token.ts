/**
 * API token 共享读取（dev 与打包版兼容）：
 * - dev：cwd/.vibepaws/api_token（仓库根）
 * - packaged：Core 在 userData，token 双写（cwd/.vibepaws + ~/.vibepaws）
 * hook_agent / simulator / ui-server 统一从这里读，任意 cwd 都能找到。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** 可能存放 token 的位置（按优先级）：~/.vibepaws 优先（任意模式都双写这里，始终是当前 Core 的 token） */
export function tokenCandidates(): string[] {
  return [
    join(homedir(), ".vibepaws", "api_token"),
    join(process.cwd(), ".vibepaws", "api_token"),
  ];
}

export function readApiToken(): string {
  for (const p of tokenCandidates()) {
    try {
      const t = readFileSync(p, "utf-8").trim();
      if (t) return t;
    } catch {
      // 继续找下一个
    }
  }
  return "";
}

/** 写入 token（双写：cwd/.vibepaws + ~/.vibepaws，供任意 cwd 的 hook 读取） */
export function writeApiToken(token: string): void {
  for (const p of tokenCandidates()) {
    try {
      mkdirSync(join(p, ".."), { recursive: true });
      writeFileSync(p, token, { mode: 0o600 });
    } catch (err) {
      console.warn(`[token] 无法写入 ${p}: ${String(err)}`);
    }
  }
}
