/**
 * 日志（journal）—— 每一段收工一张纯文本收据，每一次进化一行（U12 / R23 / R24 / R29）。
 *
 * ## 真相在库里，文件是导出（KTD9）
 * 行存在 memories（schema.ts 那张表头有每一列的说明）；`<data>/journal/<YYYY-MM>.md` 是从这些行
 * 渲染出来的。反过来的话，reset 删得掉行、删不掉一份当作记录的 markdown ——「删除全部本地数据」
 * 之后还剩一整本散文历史。所以：
 *   · 写行在前、写文件在后。文件写失败（磁盘满、目录被删、权限）只记一条日志，行上 rendered_at
 *     留空，下一次写的时候补上 —— **绝不**从事件链里抛出去（ingress 会吞，但吞掉的同时
 *     exp.handle 与气泡广播也一起跳过了）
 *   · 只追加。文件不在了就连表头一起重建；用户手改过的文件原样留着，新条目接在末尾
 *   · reset（两个 scope 都是）删行，也删这个目录里**我们起的名字**（YYYY-MM.md）的文件，别的一概不碰
 *
 * ## 一段收工一行
 * clear / resume 复用同一行 session，每一次收工都会把 finished_at 重写一遍 —— 所以唯一既不丢段、
 * 也不重复的粒度是「每条收工事件」。session_finished 被处理的那一刻，这一行 session 的本段列就是
 * 这一段的终值（下一段开始时 registry.startSegment 才清零），这里当场取走。
 * 幂等靠 memories.idem_key 的唯一索引（session:<agent>:<session>:<segment>）：重放同一条收工、
 * 同一段来第二条收工、Core 写到一半重启，都写不出第二行。
 * 被回收的（orphaned / timeout）与没结算的段不写（R9 / R10）。
 *
 * ## 隐私
 * 行里只有项目**短名**（projectShortName），原始 project_id（绝对路径）根本不进这张表；
 * 文件名只有 basename（ingress 已经削过一遍，这里渲染前再洗一次换行与分隔符）。
 *
 * 渲染出来的文字固定英文：与 notifications 落库的 title/body 同一个道理（DB 与导出和界面语言解耦），
 * 而且 `grep "score 8"` 在哪台机器上都是同一个写法。Den（U13）读的是 /api/journal 的行，按 locale 出字。
 */
import type Database from "better-sqlite3";
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, rmSync } from "node:fs";
import { join } from "node:path";
import { healthView, petScore, scoreSegment, segmentDurationMs, FACTOR_NAMES, type SegmentInput } from "./health.ts";
import { inputsForRows, localDayKey, SEGMENT_COLUMNS, type SegmentRowWithKey } from "./health_query.ts";
import { isEditTool, isReclaimed } from "./events.ts";
import type { HealthFactorName, JournalEntryView, JournalView, SessionHealthView } from "./events.ts";
import { projectShortName } from "./registry.ts";

/** 数据目录下的子目录名：`<data>/journal/2026-09.md` */
export const JOURNAL_DIR_NAME = "journal";
/** 我们起的文件名。reset 只删长这样的文件 —— 目录里别的东西（用户自己放的笔记）一概不碰 */
export const JOURNAL_FILE_RE = /^\d{4}-(0[1-9]|1[0-2])\.md$/;
/** 一条收据最多列几个文件名：一段改了两百个文件的重构，收据上不需要两百行 */
export const JOURNAL_MAX_FILES = 10;
/** 列文件名时最多扫多少个不同的 (file, tool)：给「一段跑了一整天」的 session 兜底 */
const FILE_SCAN_LIMIT = 500;

/** `?month=` 的形状（YYYY-MM） */
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/* ================= 写行 ================= */

/** 进化（R29）：exp.ts 在换形态的那一刻交过来 */
export interface EvolutionRecord {
  petId: number;
  fromTypeId: number;
  toTypeId: number;
  /** 物种名（pet_types.name）；查不到就是 null，渲染成 #id */
  fromForm: string | null;
  toForm: string | null;
  level: number;
  /** 满足门槛的那个健康分（0.5–1.0） */
  health: number;
  /** ISO；缺省 = 现在 */
  at?: string;
}

/** 进化门槛（exp.ts checkEvolution 的 `health>=0.7`）。只用于渲染「凭什么」，判定不在这里 */
export const EVOLUTION_HEALTH_GATE = 0.7;

function sessionKey(agent: string, sessionId: string, segment: number): string {
  return `session:${agent}:${sessionId}:${segment}`;
}

/**
 * 本段改过的文件（basename，按第一次出现的顺序，去重）。只看编辑类工具（isEditTool）——
 * 读过的文件不是「这一段做了什么」。
 *
 * 时间窗只有下界（segment_started_at 放宽一秒，与 health_query 的报错口径一致）：这里只在收工
 * 那一刻被调用，此刻之前收到的、本段开始之后的事件都属于这一段；上界用 finished_at 的话，
 * adapter 的时钟与 Core 的 received_at 一错开就会把最后几条编辑漏掉。
 */
export function filesTouched(
  db: Database.Database,
  agent: string,
  sessionId: string,
  segmentStartedAt: string | null,
): { files: string[]; total: number } {
  if (!segmentStartedAt) return { files: [], total: 0 };
  const rows = db
    .prepare(
      `SELECT json_extract(payload_json, '$.file') AS file, json_extract(payload_json, '$.tool_name') AS tool, MIN(id) AS first
       FROM events
       WHERE agent=? AND session_id=? AND event_type='agent_working'
         AND json_extract(payload_json, '$.file') IS NOT NULL
         AND julianday(received_at) >= julianday(?) - 1.0/86400
       GROUP BY file, tool ORDER BY first LIMIT ${FILE_SCAN_LIMIT}`,
    )
    .all(agent, sessionId, segmentStartedAt) as Array<{ file: unknown; tool: unknown }>;
  const seen: string[] = [];
  for (const r of rows) {
    if (typeof r.file !== "string" || !isEditTool(r.tool)) continue;
    const name = cleanName(r.file);
    if (name && !seen.includes(name)) seen.push(name);
  }
  return { files: seen.slice(0, JOURNAL_MAX_FILES), total: seen.length };
}

/**
 * 一段收工 → 一行日志。返回写进去的那一行（的视图）；什么都没写 → null：
 * 没有这个 session、这一段没结算、被回收了、没有分数，或者这一段已经写过（幂等）。
 * 调用方是 server 的事件链（session_finished 在 registry.handle 之后、exp.handle 之前）。
 */
export function recordFinish(db: Database.Database, agent: string, sessionId: string): JournalEntryView | null {
  const row = db
    .prepare(`SELECT ${SEGMENT_COLUMNS}, project_id FROM sessions WHERE agent=? AND agent_session_id=?`)
    .get(agent, sessionId) as (SegmentRowWithKey & { project_id: string }) | undefined;
  if (!row) return null;
  return insertSegmentRow(db, row, inputsForRows(db, [row])[0]!);
}

function insertSegmentRow(
  db: Database.Database,
  row: SegmentRowWithKey & { project_id: string },
  input: SegmentInput,
): JournalEntryView | null {
  if (!input.settled || input.finishedAt === null || isReclaimed(input.outcome)) return null;
  const result = scoreSegment(input);
  if (!result || result.unsettled || result.score === null) return null;
  const view = healthView(result)!;
  const { files, total } = filesTouched(db, row.agent, row.agent_session_id, input.startedAt);
  const project = projectShortName(row.project_id);
  const at = input.finishedAt;
  const summary = `${project} · score ${fmtScore(result.score)} · segment ${row.segment}`;
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO memories(session_id, kind, safe_summary, idem_key, occurred_at, day, agent, agent_session_id,
         segment, project, started_at, finished_at, duration_ms, outcome, score, pet_score, factors_json, omitted_json,
         evidence_json, input_json, files_json, files_total)
       VALUES(?, 'session', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      summary,
      sessionKey(row.agent, row.agent_session_id, row.segment),
      at,
      localDayKey(new Date(at)),
      row.agent,
      row.agent_session_id,
      row.segment,
      project,
      input.startedAt,
      at,
      segmentDurationMs(input),
      input.outcome,
      result.score,
      petScore(result),
      JSON.stringify(view.factors),
      JSON.stringify(view.omitted),
      JSON.stringify(view.evidence),
      JSON.stringify(input),
      JSON.stringify(files),
      total,
    );
  if (info.changes === 0) return null; // 这一段写过了
  return entryById(db, Number(info.lastInsertRowid));
}

/** 进化 → 一行日志（R29）。同一只宠物同一对形态只记一次 */
export function recordEvolution(db: Database.Database, e: EvolutionRecord): JournalEntryView | null {
  const at = e.at ?? new Date().toISOString();
  const summary = `evolution · ${formName(e.fromForm, e.fromTypeId)} → ${formName(e.toForm, e.toTypeId)} · health ${e.health.toFixed(2)}`;
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO memories(kind, safe_summary, idem_key, occurred_at, day, from_type_id, to_type_id,
         from_form, to_form, level, health)
       VALUES('evolution', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      summary,
      `evolution:${e.petId}:${e.fromTypeId}:${e.toTypeId}`,
      at,
      localDayKey(new Date(at)),
      e.fromTypeId,
      e.toTypeId,
      e.fromForm,
      e.toForm,
      e.level,
      e.health,
    );
  if (info.changes === 0) return null;
  return entryById(db, Number(info.lastInsertRowid));
}

/** 只跑一次的收养（见 adoptSettledSessions）：设置里记一笔。reset(data) 连设置一起清，那时 sessions 也空了 */
const ADOPTED_KEY = "journal_adopted";

/**
 * 升级到有日志的版本时，把 sessions 里**已经结算**的那些段收养成日志行（每行只剩最后一段，
 * 前面的段早就丢了，这是能救回来的全部）。不收养的话，升级当天的健康与 Den 的一周历史
 * 会突然变空 —— 历史的来源刚从 sessions 换成了日志。
 *
 * 只跑一次（settings.journal_adopted）：否则 reset(pet) 删掉的日志会在下一次启动时
 * 从还留着的 sessions 里原样长回来。幂等键照旧生效，跑两次也写不出重复的行。
 * 返回收养了几段。
 */
export function adoptSettledSessions(db: Database.Database, opts: { once?: boolean } = {}): number {
  const once = opts.once ?? true;
  if (once) {
    const done = db.prepare("SELECT value FROM settings WHERE key=?").get(ADOPTED_KEY) as { value: string } | undefined;
    if (done) return 0;
  }
  const rows = db
    .prepare(
      `SELECT ${SEGMENT_COLUMNS}, project_id FROM sessions
       WHERE is_active=0 AND finished_at IS NOT NULL
         AND (outcome IS NULL OR outcome NOT IN ('orphaned','timeout'))
       ORDER BY finished_at`,
    )
    .all() as Array<SegmentRowWithKey & { project_id: string }>;
  const inputs = inputsForRows(db, rows);
  let adopted = 0;
  db.transaction(() => {
    rows.forEach((r, i) => {
      if (insertSegmentRow(db, r, inputs[i]!)) adopted += 1;
    });
    if (once) db.prepare("INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)").run(ADOPTED_KEY, new Date().toISOString());
  })();
  return adopted;
}

/* ================= 读行 ================= */

interface MemoryRow {
  id: number;
  kind: string;
  occurred_at: string | null;
  day: string | null;
  agent: string | null;
  agent_session_id: string | null;
  segment: number | null;
  project: string | null;
  started_at: string | null;
  finished_at: string | null;
  duration_ms: number | null;
  outcome: string | null;
  score: number | null;
  pet_score: number | null;
  factors_json: string | null;
  omitted_json: string | null;
  evidence_json: string | null;
  files_json: string | null;
  files_total: number | null;
  from_type_id: number | null;
  to_type_id: number | null;
  from_form: string | null;
  to_form: string | null;
  level: number | null;
  health: number | null;
}

const ENTRY_COLUMNS = `id, kind, occurred_at, day, agent, agent_session_id, segment, project, started_at, finished_at,
  duration_ms, outcome, score, pet_score, factors_json, omitted_json, evidence_json, files_json, files_total,
  from_type_id, to_type_id, from_form, to_form, level, health`;

function parseJson<T>(raw: string | null, fallback: T): T {
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function toView(r: MemoryRow): JournalEntryView {
  const kind = r.kind === "evolution" ? "evolution" : "session";
  return {
    id: r.id,
    kind,
    at: r.occurred_at ?? "",
    day: r.day ?? "",
    project: r.project,
    agent: r.agent,
    session_id: r.agent_session_id,
    segment: r.segment,
    started_at: r.started_at,
    finished_at: r.finished_at,
    duration_ms: r.duration_ms,
    outcome: r.outcome,
    score: r.score,
    pet_score: r.pet_score,
    factors: parseJson<Record<HealthFactorName, number | null> | null>(r.factors_json, null),
    omitted: parseJson<HealthFactorName[]>(r.omitted_json, []),
    evidence: parseJson<SessionHealthView["evidence"] | null>(r.evidence_json, null),
    files: parseJson<string[]>(r.files_json, []),
    files_total: r.files_total ?? 0,
    evolution:
      kind === "evolution"
        ? {
            from_type_id: r.from_type_id ?? 0,
            to_type_id: r.to_type_id ?? 0,
            from: formName(r.from_form, r.from_type_id ?? 0),
            to: formName(r.to_form, r.to_type_id ?? 0),
            level: r.level ?? 0,
            health: r.health ?? 0,
          }
        : null,
  };
}

function entryById(db: Database.Database, id: number): JournalEntryView | null {
  const r = db.prepare(`SELECT ${ENTRY_COLUMNS} FROM memories WHERE id=?`).get(id) as MemoryRow | undefined;
  return r ? toView(r) : null;
}

/** `?month=` → YYYY-MM。没传 → 本地的这个月；形状不对 → null（调用方回 400） */
export function parseJournalMonth(raw: string | null, now: Date = new Date()): string | null {
  if (raw === null || raw === "") return localDayKey(now).slice(0, 7);
  return MONTH_RE.test(raw) ? raw : null;
}

/**
 * GET /api/journal 的数据：一个本地月的条目（从早到晚），可按项目短名筛。
 * 顺带给出有条目的月份与这个月出现过的项目 —— Den 的月份切换与项目筛选不必再扫一遍。
 * `file` 是导出文件相对数据目录的路径（没配目录或还没写出来 → null）；绝对路径不出 Core。
 */
export function journalView(
  db: Database.Database,
  opts: { month: string; project?: string | null; dir?: string | null },
): JournalView {
  const like = `${opts.month}-%`;
  const project = opts.project ? opts.project : null;
  const rows = db
    .prepare(
      `SELECT ${ENTRY_COLUMNS} FROM memories
       WHERE kind IN ('session','evolution') AND day LIKE ?
         AND (? IS NULL OR project = ?)
       ORDER BY occurred_at, id`,
    )
    .all(like, project, project) as MemoryRow[];
  const months = (
    db
      .prepare(
        `SELECT DISTINCT substr(day, 1, 7) AS m FROM memories
         WHERE kind IN ('session','evolution') AND day IS NOT NULL ORDER BY m DESC`,
      )
      .all() as Array<{ m: string }>
  ).map((r) => r.m);
  const projects = (
    db
      .prepare(
        `SELECT DISTINCT project FROM memories
         WHERE kind='session' AND day LIKE ? AND project IS NOT NULL ORDER BY project`,
      )
      .all(like) as Array<{ project: string }>
  ).map((r) => r.project);
  const name = `${opts.month}.md`;
  const file = opts.dir && existsSync(join(opts.dir, name)) ? `${JOURNAL_DIR_NAME}/${name}` : null;
  return { month: opts.month, months, projects, entries: rows.map(toView), file };
}

/* ================= 渲染 ================= */

/** 换行、制表、控制字符一律换成空格：一个文件名不该能在收据里另起一行、伪造一条条目 */
function cleanText(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

/** 文件名 / 项目短名：再削一次分隔符（它们本该已经是 basename 了，这里是渲染前的最后一道） */
function cleanName(s: string): string {
  return cleanText(s).replace(/[\\/]+/g, "_");
}

function formName(name: string | null, typeId: number): string {
  return name ? cleanText(name) : `#${typeId}`;
}

function fmtScore(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/** 本地时间 YYYY-MM-DD HH:MM */
function fmtLocal(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  return `${localDayKey(d)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function fmtClock(iso: string | null): string {
  if (!iso) return "?";
  return fmtLocal(iso).slice(11);
}

/** 时长：45s / 12m / 3h 05m */
export function fmtDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "?";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/**
 * 一条条目 → markdown。标题行带分数：`grep "score 8" journal/*.md` 就是「这个月八十几分的段」。
 *
 *   ### 2026-09-29 14:32 · my-app · score 82
 *
 *   - claude_code · segment 2 · 14:29 → 14:32 (3m)
 *   - context 12 · focus 25 · response 20 · outcome 25
 *   - outcome success · peak context 88% · repeat edits 0 · response median 2m (1 wait) · errors 0
 *   - files: app.ts, README.md
 */
export function renderEntry(e: JournalEntryView): string {
  if (e.kind === "evolution" && e.evolution) {
    const v = e.evolution;
    return [
      `### ${fmtLocal(e.at)} · evolution · ${v.from} → ${v.to}`,
      "",
      `- evolved from ${v.from} into ${v.to} at Lv.${v.level}`,
      `- health ${v.health.toFixed(2)} (gate ≥ ${EVOLUTION_HEALTH_GATE.toFixed(2)})`,
      "",
    ].join("\n");
  }
  const lines = [`### ${fmtLocal(e.at)} · ${cleanName(e.project ?? "?")} · score ${e.score === null ? "?" : fmtScore(e.score)}`, ""];
  lines.push(
    `- ${cleanText(e.agent ?? "?")} · segment ${e.segment ?? "?"} · ${fmtClock(e.started_at)} → ${fmtClock(e.finished_at)} (${fmtDuration(e.duration_ms)})`,
  );
  if (e.factors) {
    lines.push(`- ${FACTOR_NAMES.map((f) => `${f} ${e.factors![f] === null ? "–" : e.factors![f]}`).join(" · ")}`);
  }
  if (e.omitted.length > 0) lines.push(`- omitted (no data): ${e.omitted.join(", ")}`);
  const ev = e.evidence;
  if (ev) {
    const parts = [`outcome ${cleanText(e.outcome ?? "?")}`];
    if (ev.context_peak !== null) parts.push(`peak context ${Math.round(ev.context_peak)}%`);
    parts.push(`repeat edits ${ev.repeat_edits}`);
    if (ev.response_median_ms !== null) {
      parts.push(`response median ${fmtDuration(ev.response_median_ms)} (${ev.response_samples} wait${ev.response_samples === 1 ? "" : "s"})`);
    }
    parts.push(`errors ${ev.error_count}`);
    lines.push(`- ${parts.join(" · ")}`);
  }
  if (e.files.length > 0) {
    const more = e.files_total > e.files.length ? ` (+${e.files_total - e.files.length} more)` : "";
    lines.push(`- files: ${e.files.map(cleanName).join(", ")}${more}`);
  }
  lines.push("");
  return lines.join("\n");
}

/** 新建一个月份文件时的表头 */
function fileHeader(month: string): string {
  return (
    `# Vibepaws journal · ${month}\n\n` +
    "<!-- Written by Vibepaws: one entry per finished session segment, and one per evolution. " +
    "New entries are appended at the end; your own edits are left alone. " +
    "\"Delete all local data\" and \"new pet\" remove this file. -->\n\n"
  );
}

/** 文件末尾是不是换行（手改过的文件可能不是）：只读最后一个字节，不把整个月读进内存 */
function endsWithNewline(path: string): boolean {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return true;
    const buf = Buffer.alloc(1);
    readSync(fd, buf, 0, 1, size - 1);
    return buf[0] === 0x0a;
  } finally {
    closeSync(fd);
  }
}

/**
 * 把还没写进文件的行（rendered_at IS NULL）按顺序追加到各自的月份文件，成功一条标一条。
 * 失败（目录建不了、磁盘满、某个月的文件被改成只读）记一条日志 —— 行还在，rendered_at 留空，下一次补。
 * 失败按**月**隔离：一个写不进去的月份文件只让这个月剩下的行等下一次，别的月份照写
 * （同一个月里跳过后面的行，是为了不在文件里留下乱序的条目）。
 *
 * 一条 = 一个事务：先标 rendered_at，再追加；追加抛了事务回滚，标记跟着撤掉。于是「写进文件了
 * 却没标上」只剩一种可能：追加成功之后、COMMIT 之前进程没了 —— 原来的「追加之后标记那一步抛了」
 * 那条路（下一次再追加一遍，文件里出现两张一样的收据）不存在了。
 * **不抛**：它跑在事件链里。返回这次写出去了几条。
 */
export function flushJournal(db: Database.Database, dir: string | null): number {
  if (!dir) return 0;
  let rows: MemoryRow[];
  try {
    rows = db
      .prepare(
        `SELECT ${ENTRY_COLUMNS} FROM memories
         WHERE kind IN ('session','evolution') AND rendered_at IS NULL AND day IS NOT NULL
         ORDER BY occurred_at, id`,
      )
      .all() as MemoryRow[];
    if (rows.length === 0) return 0;
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch (err) {
    // 与事件 spool 同一个习惯：写不进去就记一笔，不让它变成别人的异常
    console.error("[vibepaws] journal write failed (rows kept, will retry on next entry):", err);
    return 0;
  }
  const mark = db.prepare("UPDATE memories SET rendered_at=? WHERE id=?");
  const writeOne = db.transaction((id: number, path: string, text: string) => {
    mark.run(new Date().toISOString(), id);
    appendFileSync(path, text);
  });
  const failed = new Set<string>();
  let written = 0;
  for (const r of rows) {
    const entry = toView(r);
    const month = entry.day.slice(0, 7);
    if (!MONTH_RE.test(month) || failed.has(month)) continue;
    const path = join(dir, `${month}.md`);
    try {
      // 文件不在（第一次、被用户删了）→ 连表头一起建；在 → 只追加，前面是什么一个字节都不动
      const prefix = !existsSync(path) ? fileHeader(month) : endsWithNewline(path) ? "\n" : "\n\n";
      writeOne(r.id, path, prefix + renderEntry(entry));
      written += 1;
    } catch (err) {
      failed.add(month);
      console.error(`[vibepaws] journal write failed for ${month} (rows kept, will retry on next entry):`, err);
    }
  }
  return written;
}

/**
 * 删掉日志目录里我们起的名字的文件（reset 用）。只删 JOURNAL_FILE_RE 匹配的**普通文件**，
 * 不递归、不删目录本身、不跟任何用户给的路径走。返回删了几个。
 */
export function clearJournalFiles(dir: string | null): number {
  if (!dir || !existsSync(dir)) return 0;
  let removed = 0;
  let names: import("node:fs").Dirent[] = [];
  try {
    names = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    console.error("[vibepaws] journal dir unreadable during reset:", err);
    return 0;
  }
  for (const d of names) {
    if (!d.isFile() || !JOURNAL_FILE_RE.test(d.name)) continue;
    try {
      rmSync(join(dir, d.name));
      removed += 1;
    } catch (err) {
      console.error(`[vibepaws] could not remove journal file ${d.name}:`, err);
    }
  }
  return removed;
}

/* ================= 事件链上的那一处 ================= */

/**
 * server 手里的日志：写行 + 追加文件，两件事都**不抛**。
 * `dir` 为 null = 只写行不写文件（注入 db 的测试与嵌入场景：它们不该往真实数据目录里写东西）。
 */
export class Journal {
  private db: Database.Database;
  readonly dir: string | null;

  constructor(db: Database.Database, dir: string | null) {
    this.db = db;
    this.dir = dir;
  }

  /** session_finished 之后调用（server 的事件链里唯一的一处） */
  onFinish(agent: string, sessionId: string): JournalEntryView | null {
    let entry: JournalEntryView | null = null;
    try {
      entry = recordFinish(this.db, agent, sessionId);
    } catch (err) {
      console.error("[vibepaws] journal row failed:", err);
      return null;
    }
    if (entry) flushJournal(this.db, this.dir);
    return entry;
  }

  /** 进化的那一刻（exp.ts 的 onEvolve） */
  onEvolution(e: EvolutionRecord): JournalEntryView | null {
    let entry: JournalEntryView | null = null;
    try {
      entry = recordEvolution(this.db, e);
    } catch (err) {
      console.error("[vibepaws] journal evolution row failed:", err);
      return null;
    }
    if (entry) flushJournal(this.db, this.dir);
    return entry;
  }

  /** 启动时：收养老 session（只一次）+ 把上次没写出去的行补上 */
  catchUp(): void {
    try {
      adoptSettledSessions(this.db);
    } catch (err) {
      console.error("[vibepaws] journal adoption failed:", err);
    }
    flushJournal(this.db, this.dir);
  }

  /** reset：删我们的月份文件（行由 reset.ts 删） */
  clearFiles(): number {
    return clearJournalFiles(this.dir);
  }
}
