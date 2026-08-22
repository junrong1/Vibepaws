/**
 * 本地数据的重置与删除 —— PRD 发布标准「用户可以删除本地宠物数据」。
 *
 * 在这之前唯一的出口是 README 里那句「删掉 .vibepaws 目录」。那不是一个功能：
 * Core 正开着这个库，把目录删掉只会让它继续往一个已经不在目录树里的 inode 写下去
 * （界面照旧、宠物照旧，直到下次重启才发现一切都没了）。所以删除必须由 Core 自己
 * 在库里做，做完顺手把内存里的状态一起清干净。
 *
 * 两个 scope，是两件不同的事，不要合并：
 *   · pet  —— 换一只新宠物：宠物、EXP 流水、memories。session 列表与设置留着。
 *   · data —— 全部本地数据：连 session / 事件 / 通知 / 设置一起，回到首次启动的样子。
 *
 * 唯一被刻意保留的东西是 `api_token`：删掉它，正在跑的 hook 与 UI server 会在
 * 下一次请求上 401，而用户刚才点的是「删除数据」，不是「把采集通道弄坏」。
 */
import type Database from "better-sqlite3";
import { statSync } from "node:fs";

export type ResetScope = "pet" | "data";

/** 每个 scope 会清掉的表，按**子表在前**排列（sessions 被 exp_logs / memories 引用） */
const TABLES: Record<ResetScope, string[]> = {
  pet: ["exp_logs", "memories", "pets"],
  data: ["exp_logs", "memories", "notifications", "events", "sessions", "agents", "pets"],
};

/** 数据足迹：按钮旁边要能说出「删掉的是多少东西」，否则那两个按钮谁也不敢点 */
export interface DataFootprint {
  events: number;
  sessions: number;
  notifications: number;
  exp_logs: number;
  memories: number;
  agents: number;
  /** 占用字节数（主库 + WAL）；拿不到时 null（内存库、权限） */
  db_bytes: number | null;
}

/**
 * 占用多少磁盘。**必须**把 -wal 算进去：一个长期运行的 Core 手上，WAL 经常比
 * 主库还大（实测 2.6MB 主库配 4.2MB WAL）。只报主库大小会把占用说少三倍，
 * 而这个数字的全部作用就是让用户判断「值不值得点那个删除按钮」。
 */
function diskBytes(db: Database.Database): number | null {
  const path = db.name;
  if (!path || path === ":memory:") return null;
  let total: number | null = null;
  for (const suffix of ["", "-wal"]) {
    try {
      total = (total ?? 0) + statSync(path + suffix).size;
    } catch {
      // 主库读不到 → null；只是没有 WAL → 保持已累计的值
    }
  }
  return total;
}

function count(db: Database.Database, table: string): number {
  try {
    return (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c ?? 0;
  } catch {
    return 0; // 老库缺表不该让整个设置窗口打不开
  }
}

export function dataFootprint(db: Database.Database): DataFootprint {
  return {
    events: count(db, "events"),
    sessions: count(db, "sessions"),
    notifications: count(db, "notifications"),
    exp_logs: count(db, "exp_logs"),
    memories: count(db, "memories"),
    agents: count(db, "agents"),
    db_bytes: diskBytes(db),
  };
}

export interface ResetResult {
  scope: ResetScope;
  /** 每张表真的删掉了多少行（界面照着说「清掉了 12431 条事件」） */
  deleted: Record<string, number>;
  /** VACUUM 成功与否：失败不算重置失败，但「文件没变小」需要有个解释 */
  vacuumed: boolean;
}

/**
 * 执行重置。
 *
 * 事务里一次做完：删一半的库比不删更难解释。删完在事务外收尾 ——
 * 不只是为了让文件变小：SQLite 删行只是把页标记为空闲，页里的**原文还在**。
 * 一个刚刚点了「删除全部数据」的用户，不该在 hex 编辑器里还能翻出自己的
 * session 标题。
 *
 * 收尾是**两步**，而不是一句 VACUUM。WAL 模式下 VACUUM 把重建结果写进 -wal，
 * 主库文件一个字节都不变 —— 实测：VACUUM「成功」之后主库仍是 2.6MB、WAL 仍是
 * 4.2MB，两边都还带着那些被删掉的原文。真正把它们扔掉的是紧跟着的
 * TRUNCATE checkpoint（同一份数据实测降到 90KB）。
 */
export function resetLocalData(db: Database.Database, scope: ResetScope): ResetResult {
  const tables = TABLES[scope];
  const deleted: Record<string, number> = {};

  db.transaction(() => {
    // sessions 自引用（parent_id）：整表删除时父行可能先于子行被删，
    // 外键是立即校验的 —— 先把引用断开，才不会在「删自己的数据」上撞 FK 错误。
    if (tables.includes("sessions")) db.prepare("UPDATE sessions SET parent_id = NULL").run();
    for (const table of tables) {
      try {
        deleted[table] = db.prepare(`DELETE FROM ${table}`).run().changes;
      } catch {
        deleted[table] = 0; // 老库缺表：跳过，不要让整次重置回滚
      }
    }
    if (scope === "data") {
      // api_token 留下（见文件头）；其余设置（预算、阈值、静音状态）一起清掉
      deleted.settings = db.prepare("DELETE FROM settings WHERE key <> 'api_token'").run().changes;
    }
  })();

  let vacuumed = false;
  try {
    db.exec("VACUUM");
    db.pragma("wal_checkpoint(TRUNCATE)");
    vacuumed = true;
  } catch {
    // WAL 里还有别的读者、或磁盘不够：数据已经删了，只是文件没缩
  }
  return { scope, deleted, vacuumed };
}
