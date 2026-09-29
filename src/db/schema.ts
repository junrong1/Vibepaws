/**
 * Vibepaws SQLite schema — 对应 docs/mvp_architecture.md §4
 * 11 张表：pet_types / pets / agents / sessions / events / notifications /
 *          needs_input_waits / exp_logs / memories / settings / rules
 * 隐私：events 仅存 safe_summary + 白名单 payload（第二道隐私闸在写入前）。
 */

export const SCHEMA_VERSION = 9;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS pet_types (
  id            INTEGER PRIMARY KEY,
  name          TEXT NOT NULL,
  rarity        TEXT NOT NULL DEFAULT 'common' CHECK (rarity IN ('common','uncommon','rare','legendary')),
  sprite_pack   TEXT NOT NULL,
  evolution_meta TEXT NOT NULL DEFAULT '[]',  -- JSON: [{from_level, conditions, to_stage}]
  starter       INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS pets (
  id            INTEGER PRIMARY KEY,
  pet_type_id   INTEGER NOT NULL REFERENCES pet_types(id),
  name          TEXT,
  level         INTEGER NOT NULL DEFAULT 1,
  exp           REAL NOT NULL DEFAULT 0,
  state         TEXT NOT NULL DEFAULT 'idle',
  health_score  REAL NOT NULL DEFAULT 1.0,
  daily_exp     REAL NOT NULL DEFAULT 0,
  daily_reset_at TEXT NOT NULL DEFAULT (datetime('now')),
  assigned_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS agents (
  agent         TEXT PRIMARY KEY,           -- claude_code | codex | generic | pi
  adapter_version TEXT,
  capabilities  TEXT NOT NULL DEFAULT '[]', -- JSON 数组：能力声明
  connected_at  TEXT,
  last_event_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id            INTEGER PRIMARY KEY,
  agent         TEXT NOT NULL,
  agent_session_id TEXT NOT NULL,
  project_id    TEXT NOT NULL,
  title         TEXT,
  goal          TEXT,
  budget_tokens INTEGER,
  token_used    INTEGER NOT NULL DEFAULT 0,
  context_pct   REAL NOT NULL DEFAULT 0,
  correction_count INTEGER NOT NULL DEFAULT 0,
  -- 已换算成 EXP 的累计 token 数：token_update 的 tokens 是累计值，
  -- 不记住「已结算到哪」就会每次都按累计值再发一遍 EXP（60k tokens 发出 90 EXP）。
  token_exp_granted INTEGER NOT NULL DEFAULT 0,
  -- agent 卡在「等你」的起始时刻（NULL = 不在等）。
  -- 只靠 notifications 表的 60s 时间窗推断会让宠物在 agent 仍被阻塞时安静下来。
  needs_input_since TEXT,
  needs_input_kind TEXT,
  -- agent 一轮结束、待命的起始时刻（NULL = 不待命）。
  -- 与 needs_input_since 区分：needs_* 是阻塞（等你回答/批准），ready_* 是非阻塞（干完了，等你下一步）。
  ready_since TEXT,
  -- agent 进程的 pid（僵尸回收 G10）。adapter 上报，Core 用 kill(pid,0) 探活。
  -- confirmed：同一个 pid 被两条不同事件报到过才算数 —— 见 core/reclaim.ts 的说明。
  agent_pid     INTEGER,
  agent_pid_confirmed INTEGER NOT NULL DEFAULT 0,
  -- 这个 session 当前在跑几个 subagent（subagent_started 加一，subagent_stopped 减一，下界 0）。
  -- 1 个和 2+ 个要渲染成不同状态（landscape 20c / 0.11），所以存的是**计数**而不是布尔。
  -- 计数天然会漂：漏掉一条 subagent_stopped（hook 超时、进程被 kill）就永远回不到 0。
  -- 三道闸：减法夹 0、session 生命周期事件归零、以及 subagent 态只是 working 的细分 ——
  -- 一个不干活的 session 无论计数多少都显示 idle（见 registry.sessionState）。
  subagent_count INTEGER NOT NULL DEFAULT 0,
  -- 计数从 0 变成 1 的那一刻（NULL = 当前没有 subagent）。界面用它说「派出去多久了」。
  subagent_since TEXT,
  parent_id     INTEGER REFERENCES sessions(id),
  branch        TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1,
  last_event_at TEXT NOT NULL DEFAULT (datetime('now')),
  -- 「真干活」的最近时刻（agent_working / token_update / context_update / subagent_started）。
  -- 与 last_event_at 区分：session_started 这类生命周期事件只刷 last_event_at，不刷它 ——
  -- 否则刚启动、还没干活的 session 会被判成 working（registry.sessionState 的 working/idle 只看它）。
  last_working_at TEXT,
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at   TEXT,
  outcome       TEXT,
  -- ---- 分段（segment）：打分的单位是「一段」，不是这一行 ----
  -- clear / resume / 收工之后再开，都复用同一行 session；不分段的话，第二段会继承第一段的
  -- correction 与峰值，一段还在跑的 session 又带着上一段的 finished_at / outcome ——
  -- 「还没结算」就无从判断。新一段开始时（registry.startSegment）：segment+1、
  -- segment_started_at=那一刻，下面三个「本段」测量列清零，finished_at / outcome 置空。
  -- 上一段的数字不另存：它在 session_finished 那一刻仍原样挂在这一行上（finish 不碰它们），
  -- 由那条事件的消费方（日志 U12）当场取走；下一段开始之前没人会改它们。
  segment       INTEGER NOT NULL DEFAULT 1,
  segment_started_at TEXT,
  -- 本段见过的最高 context 百分比（单调 MAX）。不带百分比的 context_update（Claude Code 的
  -- PreCompact / PostCompact）既不拉低它、也不把它清零 —— 撞到 96% 才压缩的一段依然读作吃紧。
  context_peak  REAL NOT NULL DEFAULT 0,
  -- 本段第一次收到**带百分比**的 context_update 的时刻（NULL = 本段从没报过 context）。
  -- context_peak=0 说不清「很健康」还是「根本不知道」，Context 因子据此决定是省略还是打分（KTD3）。
  context_reported_at TEXT,
  -- 本段里「同一个文件 30s 内又改了一次」的次数，覆盖所有编辑类工具（events.ts 的 isEditTool）。
  -- 与 correction_count 分开：后者喂 topicMultiplier，那条 >=5 的线是对着 Edit-only 计数定的，
  -- 合并之前要先拿真实 session 重新推一遍阈值。这一列只给 Session Health 的 Focus 因子读。
  repeat_edit_count INTEGER NOT NULL DEFAULT 0,
  -- agent 最近报上来的权限模式（NULL = 没报过）。bypassPermissions / acceptEdits 下
  -- 权限事件根本不会来，Response 因子没有样本的原因要能说出来（G13）
  permission_mode TEXT,
  UNIQUE (agent, agent_session_id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(is_active);

CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY,
  event_id      TEXT UNIQUE,
  seq           INTEGER NOT NULL DEFAULT 0,
  agent         TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  severity      TEXT NOT NULL DEFAULT 'low' CHECK (severity IN ('low','medium','high')),
  safe_summary  TEXT NOT NULL,
  payload_json  TEXT NOT NULL DEFAULT '{}', -- 仅白名单字段
  received_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(agent, session_id);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(event_type, received_at);

CREATE TABLE IF NOT EXISTS notifications (
  id            INTEGER PRIMARY KEY,
  event_id      TEXT,
  agent         TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  type          TEXT NOT NULL,             -- decision | permission | context | error | drift | milestone | repeat_edit | ready | evolution
  title         TEXT NOT NULL,
  body          TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'shown' CHECK (status IN ('shown','dismissed','actioned','muted')),
  shown_at      TEXT NOT NULL DEFAULT (datetime('now')),
  actioned_at   TEXT,
  -- 这条通知是怎么结束的（NULL = 还挂着）。status 只说「现在是什么样」，
  -- 说不出「用户在宠物里点的」和「agent 自己往下走了、我们推断用户在终端答了」的区别 ——
  -- 而 Response 因子要的正是前者的时间戳。取值见 core/events.ts 的 NOTIFICATION_RESOLUTIONS。
  resolution    TEXT CHECK (resolution IN ('user_actioned','inferred','timeout','dismissed','muted')),
  resolved_at   TEXT,
  -- ---- 辅导规则（U10 / R22）：误报率是一条查询，不是一句断言 ----
  -- rule_id        发它的那条辅导规则（core/coaching.ts 的 COACHING_RULES；decision / permission / ready 为 NULL）
  -- tier           跨的是哪一档（context 百分比 / 里程碑比例 / 次数）。「没用」按它挪阈值
  -- dismiss_reason 用户怎么评价它：dismissed（普通叉掉）/ not_useful。与 resolution 分开存 ——
  --                resolution 是「第一次结束」，被回收过的行照旧是 timeout，评价是另一件事
  -- shadow         影子模式下命中、但没有弹出来（drift）：status/resolution = muted，靠这一列区分
  rule_id       TEXT,
  tier          REAL,
  dismiss_reason TEXT CHECK (dismiss_reason IN ('dismissed','not_useful')),
  shadow        INTEGER NOT NULL DEFAULT 0,
  -- ---- 「永远允许」的预览钉（U9）：气泡上显示的规则与它要写进的项目（绝对路径，永远不出 Core）----
  -- 按下去时 createGrant 重推一遍，与这里不同（或这里是空的）就拒 —— 用户读到哪一条，写进去的就只能是哪一条
  grant_rule    TEXT,
  grant_project TEXT
);
CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status, shown_at);

-- 每一段「等你」一行（R4 / KTD2）。sessions.needs_input_since 只是一个「现在在不在等」的标记，
-- 清掉的时候不记是什么时候清的 —— 等了多久只能靠重放 events，而 events 没有保留策略、
-- 又会被 reset 清空。这张表是 Response 因子唯一的耐久来源。
--   started_at   进入 needs-you 的那条事件的时间戳（adapter 的时钟）
--   received_at  Core 处理那条事件的时刻。和 started_at 差得远 = 离线缓冲补发的回放，
--                那一段的时长不是用户的真实等待
--   cleared_at   清掉的那一刻（NULL = 还在等）。清的地方有五处，resolution 记是哪一处
--   muted_ms     这段等待里有多久处于静音（气泡根本没出现）。进入时按当时生效的静音截止时刻
--                预填「静音最多覆盖到哪」，关闭时夹到实际时长 —— 所以只有已关闭的行是准的
--   slept_ms     跨过的机器休眠时长。shell 里还没有 powerMonitor，永远是 0（见计划的 Risks）
CREATE TABLE IF NOT EXISTS needs_input_waits (
  id            INTEGER PRIMARY KEY,
  agent         TEXT NOT NULL,
  session_id    TEXT NOT NULL,             -- sessions.agent_session_id（与 notifications 同口径）
  segment       INTEGER NOT NULL DEFAULT 1,
  kind          TEXT,                      -- permission | decision
  started_at    TEXT NOT NULL,
  received_at   TEXT NOT NULL,
  cleared_at    TEXT,
  resolution    TEXT CHECK (resolution IN ('inferred','turn_ended','finished','restarted','timeout')),
  muted_ms      INTEGER NOT NULL DEFAULT 0,
  slept_ms      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_waits_session ON needs_input_waits(agent, session_id, cleared_at);

CREATE TABLE IF NOT EXISTS exp_logs (
  id            INTEGER PRIMARY KEY,
  session_id    INTEGER REFERENCES sessions(id),
  amount        REAL NOT NULL,
  category      TEXT NOT NULL,             -- token | context | topic | outcome | care | self
  note          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_exp_logs_session ON exp_logs(session_id);

-- 日志（journal，U12 / R23 / KTD9）：每一段收工一行、每一次进化一行。**真相在这张表**，
-- journal/<YYYY-MM>.md 只是从这些行渲染出来的导出（见 core/journal.ts）—— reset 删得到行，
-- 删不到一份当作记录的 markdown。
--   kind           session（一段收工）| evolution（进化）
--   idem_key       幂等键：session:<agent>:<agent_session_id>:<segment> / evolution:<pet>:<from>:<to>。
--                  唯一索引在 INDEXES_AFTER_COLUMNS 里建（老库要先补列）。重放同一条收工事件、
--                  Core 写到一半重启，都写不出第二行 —— 靠的是这一列，不是内存里的标记
--   occurred_at    那一刻（段的 finished_at / 进化的时刻，ISO）；day = 它的**本地**日（YYYY-MM-DD），
--                  月份文件与 Den 的筛选都按它
--   project        项目**短名**（projectShortName）。原始 project_id 是绝对路径，这里刻意不存
--   input_json     打分输入（health.SegmentInput）：历史与当天聚合从这里重新打分，口径与活的 session 一致
--   score / pet_score / factors_json / omitted_json / evidence_json  收工那一刻结算的分（收据）
--   files_json     本段改过的文件名（basename，至多 JOURNAL_MAX_FILES 个）；files_total = 去重后的总数
--   from_* / to_* / level / health  进化：从哪个形态到哪个形态、在几级、满足门槛的健康分
--   rendered_at    追加进月份文件的时刻（NULL = 还没写进去：没配目录，或者上次写失败，下次补）
CREATE TABLE IF NOT EXISTS memories (
  id            INTEGER PRIMARY KEY,
  session_id    INTEGER REFERENCES sessions(id),
  kind          TEXT NOT NULL,             -- session | evolution
  safe_summary  TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  idem_key      TEXT,
  occurred_at   TEXT,
  day           TEXT,
  agent         TEXT,
  agent_session_id TEXT,
  segment       INTEGER,
  project       TEXT,
  started_at    TEXT,
  finished_at   TEXT,
  duration_ms   INTEGER,
  outcome       TEXT,
  score         REAL,
  pet_score     REAL,
  factors_json  TEXT,
  omitted_json  TEXT,
  evidence_json TEXT,
  input_json    TEXT,
  files_json    TEXT,
  files_total   INTEGER,
  from_type_id  INTEGER,
  to_type_id    INTEGER,
  from_form     TEXT,
  to_form       TEXT,
  level         INTEGER,
  health        REAL,
  rendered_at   TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key           TEXT PRIMARY KEY,
  value         TEXT NOT NULL
);

-- 「永远允许」的授予（U9 / R20）。这张表是权威：Vibepaws 列出的、能撤销的只有这里的行；
-- <project>/.claude/settings.local.json 里的那一条只是镜像（见 core/rules.ts）。
--   pattern          Bash 的命令前缀（NULL = 不带参数的工具，如 Edit）
--   rule             写进文件的那一条原文，例如 Bash(npm test *)
--   origin           怎么来的。现在只有 bubble —— 授予只能由人在气泡上按出来
--   notification_id  按出它的那条气泡
--   use_count        恒为 0：规则进了文件之后 Claude Code 直接放行，不再有事件可数
-- 不在 reset 的表单里：reset 不碰别的工具的配置文件，删了行，文件里的授予就成了「来历不明」。
CREATE TABLE IF NOT EXISTS rules (
  id            INTEGER PRIMARY KEY,
  agent         TEXT NOT NULL,
  project_id    TEXT NOT NULL,
  tool          TEXT NOT NULL,
  pattern       TEXT,
  rule          TEXT NOT NULL,
  origin        TEXT NOT NULL CHECK (origin IN ('bubble')),
  notification_id INTEGER,
  use_count     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  UNIQUE (agent, project_id, rule)
);
`;

/**
 * v1 之后新增的列。`CREATE TABLE IF NOT EXISTS` 对已存在的库是空操作，
 * 所以老库必须显式补列 —— 否则升级后的代码会对着 v1 的表查不存在的字段。
 */
const ADDED_COLUMNS: Array<{
  table: string;
  column: string;
  ddl: string;
  /** 补列之后立刻跑一次（且只在补列那一次跑）：从老列推出新列的值，老行不该变成「不知道」 */
  backfill?: string;
}> = [
  { table: "sessions", column: "token_exp_granted", ddl: "INTEGER NOT NULL DEFAULT 0" },
  { table: "sessions", column: "needs_input_since", ddl: "TEXT" },
  { table: "sessions", column: "needs_input_kind", ddl: "TEXT" },
  { table: "sessions", column: "ready_since", ddl: "TEXT" },
  { table: "sessions", column: "last_working_at", ddl: "TEXT" },
  { table: "sessions", column: "agent_pid", ddl: "INTEGER" },
  { table: "sessions", column: "agent_pid_confirmed", ddl: "INTEGER NOT NULL DEFAULT 0" },
  { table: "sessions", column: "subagent_count", ddl: "INTEGER NOT NULL DEFAULT 0" },
  { table: "sessions", column: "subagent_since", ddl: "TEXT" },
  { table: "sessions", column: "segment", ddl: "INTEGER NOT NULL DEFAULT 1" },
  {
    table: "sessions",
    column: "segment_started_at",
    ddl: "TEXT",
    // 老行一律当作「还在第一段」：第一段从 session 开始的那一刻算起
    backfill: "UPDATE sessions SET segment_started_at = started_at WHERE segment_started_at IS NULL",
  },
  {
    table: "sessions",
    column: "context_peak",
    ddl: "REAL NOT NULL DEFAULT 0",
    // 老库只记得最后一个值 —— 它是峰值的下界，总比 0 更接近真相
    backfill: "UPDATE sessions SET context_peak = context_pct WHERE context_pct > context_peak",
  },
  {
    table: "sessions",
    column: "context_reported_at",
    ddl: "TEXT",
    // context_pct > 0 只可能来自一条带百分比的 context_update；等于 0 的分不清，留 NULL（不知道）
    backfill: "UPDATE sessions SET context_reported_at = last_event_at WHERE context_reported_at IS NULL AND context_pct > 0",
  },
  { table: "sessions", column: "repeat_edit_count", ddl: "INTEGER NOT NULL DEFAULT 0" },
  { table: "sessions", column: "permission_mode", ddl: "TEXT" },
  // 辅导规则（U10）。老行一律 NULL / 0：它们发出来的时候还没有规则目录，按类型回填 rule_id 会把
  // 「从没被评价过」的老气泡算进误报率的分母，而那些周里根本没有「没用」这个按钮
  { table: "notifications", column: "rule_id", ddl: "TEXT" },
  { table: "notifications", column: "tier", ddl: "REAL" },
  { table: "notifications", column: "dismiss_reason", ddl: "TEXT CHECK (dismiss_reason IN ('dismissed','not_useful'))" },
  { table: "notifications", column: "shadow", ddl: "INTEGER NOT NULL DEFAULT 0" },
  // 「永远允许」的预览钉（U9）。老行一律 NULL = 没有钉过的预览 → 那些气泡上的「永远允许」按了也会被拒（changed）
  { table: "notifications", column: "grant_rule", ddl: "TEXT" },
  { table: "notifications", column: "grant_project", ddl: "TEXT" },
  {
    table: "notifications",
    column: "resolution",
    ddl: "TEXT CHECK (resolution IN ('user_actioned','inferred','timeout','dismissed','muted'))",
    // 老库只有 status：actioned / dismissed / muted 各有唯一对应；shown 仍挂着，保持 NULL
    backfill: `UPDATE notifications SET resolution = CASE status
                 WHEN 'actioned' THEN 'user_actioned'
                 WHEN 'dismissed' THEN 'dismissed'
                 WHEN 'muted' THEN 'muted'
               END
               WHERE resolution IS NULL AND status != 'shown'`,
  },
  {
    table: "notifications",
    column: "resolved_at",
    ddl: "TEXT",
    // 只填得出确定的那部分：actioned 有 actioned_at，muted 在出生那一刻就结束了。
    // 老的 actioned 行实际上 actioned_at 全是 NULL（真实的老库里 68 行无一例外）：退回 shown_at ——
    // 「user_actioned 却没有结束时刻」会让任何按 resolved_at 算的读者把它们丢掉；shown_at 是它的下界。
    // 老的 dismissed 不知道是什么时候叉掉的 —— 编一个时间比留空更糟
    backfill: `UPDATE notifications SET resolved_at = CASE status
                 WHEN 'actioned' THEN COALESCE(actioned_at, shown_at)
                 WHEN 'muted' THEN shown_at
               END
               WHERE resolved_at IS NULL`,
  },
  // 日志（U12）。memories 在这之前是一张没人写的表（G21），老行一律没有这些列 —— 不回填：
  // 没有 idem_key 的老行不参与幂等，也不进历史（它们本来就不存在）
  { table: "memories", column: "idem_key", ddl: "TEXT" },
  { table: "memories", column: "occurred_at", ddl: "TEXT" },
  { table: "memories", column: "day", ddl: "TEXT" },
  { table: "memories", column: "agent", ddl: "TEXT" },
  { table: "memories", column: "agent_session_id", ddl: "TEXT" },
  { table: "memories", column: "segment", ddl: "INTEGER" },
  { table: "memories", column: "project", ddl: "TEXT" },
  { table: "memories", column: "started_at", ddl: "TEXT" },
  { table: "memories", column: "finished_at", ddl: "TEXT" },
  { table: "memories", column: "duration_ms", ddl: "INTEGER" },
  { table: "memories", column: "outcome", ddl: "TEXT" },
  { table: "memories", column: "score", ddl: "REAL" },
  { table: "memories", column: "pet_score", ddl: "REAL" },
  { table: "memories", column: "factors_json", ddl: "TEXT" },
  { table: "memories", column: "omitted_json", ddl: "TEXT" },
  { table: "memories", column: "evidence_json", ddl: "TEXT" },
  { table: "memories", column: "input_json", ddl: "TEXT" },
  { table: "memories", column: "files_json", ddl: "TEXT" },
  { table: "memories", column: "files_total", ddl: "INTEGER" },
  { table: "memories", column: "from_type_id", ddl: "INTEGER" },
  { table: "memories", column: "to_type_id", ddl: "INTEGER" },
  { table: "memories", column: "from_form", ddl: "TEXT" },
  { table: "memories", column: "to_form", ddl: "TEXT" },
  { table: "memories", column: "level", ddl: "INTEGER" },
  { table: "memories", column: "health", ddl: "REAL" },
  { table: "memories", column: "rendered_at", ddl: "TEXT" },
];

/**
 * 建在「后补的列」上的索引。不能写进 SCHEMA_SQL：那一段在补列**之前**跑，老库上这一列还不存在，
 * CREATE INDEX 会直接抛错、Core 起不来。所以在 addMissingColumns 之后再建（IF NOT EXISTS，幂等）。
 */
const INDEXES_AFTER_COLUMNS = [
  // 幂等的依据（R23）：同一段收工只能有一行。NULL 不互相冲突 —— 老行不受影响
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_idem ON memories(idem_key)",
  "CREATE INDEX IF NOT EXISTS idx_memories_day ON memories(kind, day)",
];

interface MigrateDb {
  exec(sql: string): void;
  prepare?(sql: string): { all(...params: unknown[]): unknown[] };
}

/** 幂等补列：读 table_info 而不是 catch 异常，避免把真实错误也吞掉。 */
function addMissingColumns(db: MigrateDb): void {
  if (typeof db.prepare !== "function") return; // 测试里的假 db 只有 exec
  for (const { table, column, ddl, backfill } of ADDED_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (cols.length === 0) continue; // 表不存在（不该发生，建表在前）
    if (cols.some((c) => c.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
    if (backfill) db.exec(backfill);
  }
}

/** 建表 + 补列（幂等）。返回当前 schema 版本。 */
export function applySchema(db: MigrateDb): number {
  db.exec(SCHEMA_SQL);
  addMissingColumns(db);
  for (const sql of INDEXES_AFTER_COLUMNS) db.exec(sql);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return SCHEMA_VERSION;
}
