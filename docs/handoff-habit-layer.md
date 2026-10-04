# Hand-off: Habit-Driven Pet Layer

> **For:** the developing agent picking up this work.
> **Repo:** Vibepaws (v0.1.0, `SCHEMA_VERSION=11`).
> **Goal:** learn a **user-level working-habit profile** from the event stream the repo already
> collects, then use it to drive three things — **pet evolution**, **pet behavior**, and **bubble voice**.
> **Status:** implemented (`src/core/habit.ts`, `ui/behavior.js`, `ui/voice.js`, `src/core/exp.ts`).
> The §4/§10 references to `SCHEMA_VERSION=4` are historical plan text; the actual migration landed as v10 → v11.

---

## 1. Mission

Today Vibepaws records rich **per-session** behavior (tokens, context, corrections, wait-times, tools,
outcomes) but nothing aggregates it into a **user** model. Consequently the pet's evolution, animation, and
bubble tone are all static and habit-blind.

Build a **HabitEngine** in Core that folds events into a decayed, user-level **habit profile**, expose it via
API/SSE, and wire it into:

1. **Evolution** — `evolution_meta.conditions` may gate on habit keys (e.g. `chronotype=night_owl`).
2. **Behavior** — the pet's idle variant, energy, wake/sleep window, and reaction thresholds.
3. **Voice** — the bubble's tone/emoji/pacing per notification type.

Non-negotiable constraint: **privacy posture must not regress** (see §7).

---

## 2. What already exists (do not rebuild)

Read these before writing code. They are the single source of truth for patterns you must follow.

| File | What it gives you |
|---|---|
| `src/core/events.ts` | `CoreEvent`, `EventPayload`, `EventType`, `PetStatePush` types. Event types + whitelisted payload fields. |
| `src/core/ingress.ts` | Second privacy gate. `PAYLOAD_WHITELIST` + `sanitizePayload`. Unknown fields are dropped here. |
| `src/core/registry.ts` | Session state machine. `correction_count` heuristic (same file edited <30s). `needs_input_since`/`ready_since` lifecycle. |
| `src/core/exp.ts` | EXP/health/evolution engine. `checkEvolution` reads `evolution_meta`. `healthScore` derives from error/drift count. |
| `src/core/server.ts` | **The dispatch chain** — where HabitEngine must be wired. Also the HTTP/SSE surface. |
| `src/db/schema.ts` | `SCHEMA_SQL`, `SCHEMA_VERSION`, `ADDED_COLUMNS` migration pattern. |
| `src/db/migrate.ts` | `openDb()` — `applySchema(db)` then `seedPetTypes(db)`. |
| `src/db/seed.ts` | `PetTypeSeed` + `evolution_meta` shape. |
| `src/core/reset.ts` | `ResetScope`, `TABLES`, `dataFootprint`, `resetLocalData`. Habit tables must be added here. |
| `src/core/settings.ts` | Normalization pattern for user-editable values (if you add an opt-out). |
| `src/simulator/scenarios.ts` | Event scenarios used to drive the system in tests. |
| `ui/app.js` | Rendering layer entry. SSE `pet_state` consumption. |
| `ui/pets/procedural.js`, `ui/pets/fx.js` | Pure rendering functions + their test style (`ui/**/*.test.js`). |

**Dispatch chain** (in `server.ts` constructor) is where HabitEngine plugs in:

```ts
this.notifications.onEvent = (ev: CoreEvent) => {
  this.registry.handle(ev);
  this.exp.handle(ev);
  this.broadcastNotification(ev);
};
```

Add `this.habit.handle(ev);` here. `ingestEvent` calls `onEvent` for every valid, non-duplicate event, so
HabitEngine sees the same stream as the other two engines.

---

## 3. The habit model — 8 dimensions

All derivable from data already collected. **Core stays deterministic**: it stores numbers + a few category
labels. All presentation (animation/emoji/wording) lives in the rendering layer.

| Dimension | Type | Source (already available) | Rule (initial thresholds — tune later) |
|---|---|---|---|
| `chronotype` | `"early_bird" \| "day" \| "night_owl" \| null` | hour-of-day histogram of `agent_working` + `session_started` timestamps | `night_owl` if ≥40% of activity in `[22,06)` UTC; `early_bird` if ≥40% in `[05,10)`; else `day` |
| `cadence` | `"burst" \| "steady" \| "sparse" \| null` | sessions/day + mean session length (from `sessions.started_at/finished_at`) | `burst`: ≥4 sessions/active-day **and** mean <20 min; `sparse`: <0.5 sessions/active-day; else `steady` |
| `depth` | `number 0..1` | mean session length + context pressure + precision | `0.5·length_factor + 0.3·(1−context_pressure) + 0.2·precision`, where `length_factor = clamp(mean_min/45)` |
| `precision` | `number 0..1` | `sessions.correction_count` | `clamp(1 − (total_corrections / max(1, sessions) / 5))` |
| `context_hygiene` | `number 0..1` | `context_pct > 85` crossings | `1 − (context_85_crossings / max(1, sessions))` |
| `responsiveness` | `number 0..1` | duration of `needs_input_since` (see §5 wait-tracking) | `clamp(1 − mean_wait_ms / 1_800_000)` (30 min → 0) |
| `outcome_bias` | `"shipper" \| "explorer" \| null` | `sessions.outcome` (exclude `orphaned`/`timeout`) | `shipper` if success ratio ≥0.6 (count ≥3); `explorer` if (partial+abandoned) ratio ≥0.5; else null |
| `tool_affinity` | `string[]` (top ≤5) | `payload.tool_name` counts | top 5 by frequency |

### ⚠️ Signal gap you must flag, not silently fake

The payload whitelist does **not** contain command text (by design). Therefore:

- `tool_name` gives you **tool identity** (`Bash`, `Edit`, `Write`, `Read`, `Glob`, `Grep`, MCP names, …) — enough
  for `cli-heavy` vs `edit-heavy` vs `read-heavy`.
- **Commits / test-runs / "shipped" are NOT distinguishable today.** The only proxy is `sessions.outcome`
  (`success`/`partial`/`abandoned`). Do **not** pretend `tool_name === "Bash"` means "commit".

**Decision required:** either (a) accept `outcome` as the only "shipper" proxy for now, or (b) add one new
whitelisted field — recommended: `tool_category?: "commit" | "test" | "build" | "edit" | "read" | "shell" | "other"`
— mapped by the adapters from known tool names, never from command text. If you choose (b), the field must be added
in **three places**: `src/core/events.ts` (`EventPayload`), `src/core/ingress.ts` (`PAYLOAD_WHITELIST`), and each
adapter's mapping (`src/adapters/hook_agent.ts`, `pi_extension.ts`, `dsh_plugin.ts`). Record the decision in the PR.

---

## 4. Data model

Append to `SCHEMA_SQL` in `src/db/schema.ts`, bump `SCHEMA_VERSION` to `4`.

New tables (brand-new → `CREATE TABLE IF NOT EXISTS` is enough; no `ADDED_COLUMNS` entry needed since those only
cover new columns on *existing* tables):

```sql
-- daily rollup: one row per (day, agent), folded from events/sessions
CREATE TABLE IF NOT EXISTS behavior_daily (
  id            INTEGER PRIMARY KEY,
  day           TEXT NOT NULL,                -- 'YYYY-MM-DD' (UTC)
  agent         TEXT NOT NULL,
  sessions      INTEGER NOT NULL DEFAULT 0,
  active_min    REAL NOT NULL DEFAULT 0,
  tokens        INTEGER NOT NULL DEFAULT 0,
  corrections   INTEGER NOT NULL DEFAULT 0,
  errors        INTEGER NOT NULL DEFAULT 0,
  context_85    INTEGER NOT NULL DEFAULT 0,
  wait_ms       INTEGER NOT NULL DEFAULT 0,   -- sum of needs-input durations
  wait_count    INTEGER NOT NULL DEFAULT 0,
  edits         INTEGER NOT NULL DEFAULT 0,   -- tool_name='Edit'
  shells        INTEGER NOT NULL DEFAULT 0,   -- tool_name='Bash'
  reads         INTEGER NOT NULL DEFAULT 0,   -- Read/Glob/Grep
  success       INTEGER NOT NULL DEFAULT 0,
  partial       INTEGER NOT NULL DEFAULT 0,
  abandoned     INTEGER NOT NULL DEFAULT 0,
  UNIQUE (day, agent)
);
CREATE INDEX IF NOT EXISTS idx_behavior_daily_day ON behavior_daily(day);

-- single-row user working-habit profile (aggregated, decayed)
CREATE TABLE IF NOT EXISTS habit_profile (
  id               INTEGER PRIMARY KEY CHECK (id = 1),
  chronotype       TEXT,                        -- 'early_bird' | 'day' | 'night_owl'
  cadence          TEXT,                        -- 'burst' | 'steady' | 'sparse'
  depth            REAL NOT NULL DEFAULT 0.5,
  precision        REAL NOT NULL DEFAULT 0.5,
  context_hygiene  REAL NOT NULL DEFAULT 0.5,
  responsiveness   REAL NOT NULL DEFAULT 0.5,
  outcome_bias     TEXT,                        -- 'shipper' | 'explorer'
  tool_affinity    TEXT NOT NULL DEFAULT '[]',  -- JSON string[]
  sample_days      INTEGER NOT NULL DEFAULT 0,
  sample_sessions  INTEGER NOT NULL DEFAULT 0,
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### Migration

- `SCHEMA_VERSION` → `4`.
- `applySchema` runs `CREATE TABLE IF NOT EXISTS` first, then `addMissingColumns`. New tables need nothing else.
- Existing DBs get the two new empty tables on next `openDb()`. HabitEngine backfills from existing
  `events`/`sessions` on first run (see §5).

### Reset / footprint (`src/core/reset.ts`)

- Add `"behavior_daily", "habit_profile"` to the `data` scope's `TABLES`.
- Add a new scope `"habit"` with `TABLES = ["behavior_daily", "habit_profile"]` (optionally `"memories"` too —
  decide and document). Extend `ResetScope` type to `"pet" | "data" | "habit"`.
- Add `habit: number` to `DataFootprint` (count `behavior_daily`) and to `dataFootprint()`.
- ⚠️ `src/core/reset.test.ts` asserts an exact footprint object. **Update that assertion** or the test will fail.

---

## 5. HabitEngine (Core) — `src/core/habit.ts`

Follow `ExpEngine`'s shape (constructor takes `db`, `handle(ev)`, `getSnapshot()`), but it is **not** an EXP
engine — it's an aggregation engine.

### API

```ts
export interface HabitProfile {
  chronotype: "early_bird" | "day" | "night_owl" | null;
  cadence: "burst" | "steady" | "sparse" | null;
  depth: number;
  precision: number;
  context_hygiene: number;
  responsiveness: number;
  outcome_bias: "shipper" | "explorer" | null;
  tool_affinity: string[];
  sample_days: number;
  sample_sessions: number;
  updated_at: string;
  /** cold-start: false means "not enough data — UI should stay neutral" */
  ready: boolean;
}

export class HabitEngine {
  constructor(db: Database.Database);
  handle(ev: CoreEvent): void;   // fold into behavior_daily + in-memory wait tracking
  recompute(): void;             // aggregate behavior_daily → habit_profile (decayed)
  getProfile(): HabitProfile;
  backfill(): void;              // one-time, from existing events + sessions
}
```

### `handle(ev)` behavior

Fold each event into today's `behavior_daily` row (upsert on `(day, agent)`):

| Event | Fold |
|---|---|
| `session_started` | nothing (lifecycle only); note active time later via `finished_at` |
| `agent_working` | `tool_name` buckets (`Edit`→edits, `Bash`→shells, `Read/Glob/Grep`→reads); record in-memory "last working" time |
| `context_update` | if `context_pct > 85` → `context_85 += 1` |
| `session_error` / `topic_drift_warning` | `errors += 1` |
| `session_finished` | `outcome` bucket (success/partial/abandoned); compute session length → `active_min`; `sessions += 1`; then `recompute()` |

### Wait-tracking (responsiveness) — mirrors `registry.ts`

Keep an in-memory `Map<string, number>` keyed by `${agent}:${session_id}`:

- On **blocking** `decision_required` (kind `question`) or `permission_required`: store `Date.now()`.
- On **any progress event** (`agent_working`, `session_started`, `session_finished`, etc.): if a pending
  timestamp exists, `wait_ms += now − start`, `wait_count += 1`, clear the entry.
- This duplicates the semantics of `sessions.needs_input_since`, but the HabitEngine needs the **durations**,
  which `needs_input_since` only stores as a start time. Use the same "blocking" definition as `registry.ts`.

### `recompute()` — decay + classification

- Aggregate `behavior_daily` over a sliding window (default **14 days**) with linear decay (newer days weigh more)
  OR exponential decay with half-life 14 days. Pick one, document it, keep it a pure function so it's testable.
- Compute the 8 dimensions per §3, write the single `habit_profile` row (id=1, upsert).
- `ready = sample_sessions >= 5` **and** `sample_days >= 2`. Below that, `getProfile()` returns `ready:false` and
  null labels so the UI stays neutral (cold start). Never classify a user from one session.

### `backfill()`

On first construction (or when `habit_profile` is missing and `behavior_daily` is empty but `sessions` is not),
replay existing `events` (ordered by `id`) through `handle()` to seed the rollup. Guard against double-backfill by
checking for existing `behavior_daily` rows first. Keep it idempotent.

### Persistence note

`behavior_daily` is the only granular store. Do **not** store per-event rows in the habit model — `events` already
does that. The profile row is a summary; that is the entire point.

---

## 6. Integration points

### 6.1 Server (`src/core/server.ts`)

- Instantiate `this.habit = new HabitEngine(this.db)` in the constructor (before the dispatch chain).
- In `this.notifications.onEvent`, add `this.habit.handle(ev);` (order vs `exp`/`registry` does not matter, but put
  it after `registry.handle` so `sessions` rows exist if you ever need to read them synchronously).
- Add route:
  ```ts
  if (url === "/api/habit") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ profile: this.habit.getProfile() }));
    return;
  }
  ```
- Include `habit` in `stateSnapshot()` so it rides the existing SSE `pet_state` push (coalesced, cheap). This means
  extending `PetStatePush` in `src/core/events.ts` with `habit?: HabitProfile`.

### 6.2 Evolution (`src/core/exp.ts` + `src/db/seed.ts`)

- `checkEvolution(petId, level)` currently reads `evolution_meta` and matches only `health>=0.7`. Add a habit
  argument (or read the profile once) and support habit condition keys:
  - `chronotype=night_owl`, `chronotype=early_bird`
  - `cadence=burst`, `cadence=steady`
  - `depth>=0.6`, `precision>=0.6`, `context_hygiene>=0.6`
- Keep backward compatibility: a rule with only `health>=0.7` must still fire exactly as today.
- Update `seed.ts` docs/examples to show a habit-gated `evolution_meta` entry. **Do not** change existing starter
  pets' evolution unless asked — new art is a separate concern.

### 6.3 Behavior (`ui/behavior.js`, new)

Pure, unit-testable module (mirror `ui/pets/procedural.js` style). JS, not TS (rendering layer is plain JS).

```js
export function behaviorFor(habit) {
  // → { idleVariant, energy, wakeWindow, reactionMs, fidget, celebrate }
  // see docs/user-habit-analysis.html §03 for the mapping table
}
```

Rules to implement (initial):
- `idleVariant`: `depth>0.6 → "focused"`; `cadence="burst" → "bouncy"`; `cadence="sparse" → "sleepy"`; else `"calm"`.
- `energy`: burst 1.0, steady 0.45, sparse 0.2.
- `wakeWindow`: night_owl `[20,4]`, early_bird `[5,21]`, else `[8,23]` (hours).
- `reactionMs`: `900 - energy*500`.
- `fidget`: `1 - precision`.
- `celebrate`: `outcome_bias === "shipper"`.

### 6.4 Voice (`ui/voice.js`, new)

Pure, unit-testable. Consumes the existing notification `i18n` key/params (see `src/core/notifications.ts`) and
picks a tone variant from habit. `renderBubble(notif, habit)` returns the localized string; `voiceVariant(type,
habit)` returns `{ emoji, pacing }` for `punchy | quiet | gentle | proud | normal`.

- `type==="milestone"` + `tool_affinity` includes test → `{ "✅", proud }`.
- `type==="drift"` → `{ "🤔", gentle }`.
- `depth>0.6` → quiet (no emoji).
- `cadence==="burst"` → `{ "⚡", punchy }`.

### 6.5 Wire into `ui/app.js`

- Read `habit` off the `pet_state` SSE payload; store it alongside the current state.
- Pass `habit` to behavior params and bubble rendering.
- If `habit.ready === false`, render the neutral (current) behavior/voice.

---

## 7. Privacy — hard requirements

1. **No raw content.** `behavior_daily` and `habit_profile` store only counts, sums, and category labels. Never
   prompt, code, file paths, command text, or project names.
2. **Whitelist unchanged** unless you deliberately add `tool_category` per §3 and add it to `PAYLOAD_WHITELIST` in
   `ingress.ts` (and it must still be a fixed vocabulary, never free text).
3. **Local only.** No network egress, no cloud. Everything in `.vibepaws/vibepaws.db`.
4. **Forget-ability.** `/api/reset` with scope `habit` clears the habit tables; `memories` insight rows are also
   cleared if you write any.
5. **Opt-out (recommended).** Add a `habit_enabled` setting (default `"1"`) via the `settings.ts` normalization
   pattern. When `"0"`, HabitEngine stops folding events and the UI stays neutral. This is the cleanest way to
   honor "I don't want my pet to profile me."

---

## 8. Files to create / modify

**Create**
- `src/core/habit.ts` — HabitEngine + `HabitProfile` type + pure dimension functions (export them for tests).
- `src/core/habit.test.ts` — unit tests (see §9).
- `ui/behavior.js` + `ui/behavior.test.js`
- `ui/voice.js` + `ui/voice.test.js`

**Modify**
- `src/db/schema.ts` — two tables + `SCHEMA_VERSION=4`.
- `src/core/reset.ts` — scopes, `TABLES`, `DataFootprint`.
- `src/core/reset.test.ts` — update footprint assertion.
- `src/core/events.ts` — add `HabitProfile` type (or import) + `habit?` on `PetStatePush`.
- `src/core/server.ts` — instantiate + wire engine, `/api/habit`, `habit` in `stateSnapshot()`.
- `src/core/exp.ts` — habit conditions in `checkEvolution`.
- `src/db/seed.ts` — document/example habit-gated `evolution_meta` (optional new rules).
- `src/core/settings.ts` — `habit_enabled` setting (if you add the opt-out).
- `ui/app.js` — consume `habit` from SSE, drive behavior/voice.
- `README.md` / `docs/` — document the new feature + the privacy guarantees.

---

## 9. Tests & acceptance criteria

Follow existing test conventions: `node:test` + `node:assert/strict`, in-memory `better-sqlite3` via
`applySchema(db) + seedPetTypes(db)`, and an `ev(partial)` helper exactly like `src/core/exp.test.ts`.

**Unit (HabitEngine)**
1. `backfill()` from a seeded `events`/`sessions` set produces expected `chronotype`/`cadence`/`outcome_bias`.
2. `handle(agent_working with tool_name="Bash")` increments `shells`, `Edit` increments `edits`.
3. `context_update` with `context_pct=90` increments `context_85`.
4. Wait-tracking: blocking `decision_required` → later `agent_working` folds a `wait_ms` delta.
5. `recompute()` classifies a synthetic night-owl stream as `night_owl`, a burst stream as `burst`, etc.
6. **Cold start:** <5 sessions → `getProfile().ready === false` and null labels.
7. Decay: older `behavior_daily` rows contribute less than recent ones (test the pure decay function).

**Unit (pure dimension functions)** — export `classifyChronotype`, `classifyCadence`, `computePrecision`, etc.,
and test the thresholds directly (this is the cheapest, highest-value coverage).

**Unit (rendering)** — `behaviorFor(profile)` and `voiceVariant(type, profile)` return expected variants for a few
canonical profiles (night-owl/burst, deep/quiet, sparse/sleepy, cold-start/neutral).

**Integration**
- `GET /api/habit` returns the profile with the API token header (reuse `server.test.ts` patterns).
- `stateSnapshot().habit` is present in the SSE payload.
- `/api/reset` with `scope=habit` clears the habit tables and leaves other data intact.

**Definition of done**
- `npm test` green (all existing + new tests; existing `reset.test.ts` footprint updated).
- `npm run typecheck` green.
- Simulator scenario (add or reuse in `src/simulator/scenarios.ts`) drives a full event stream and the resulting
  `habit_profile` is non-trivial and matches expectation.
- A manual `npm run core` + `curl -H "X-Vibepaws-Token: …" http://127.0.0.1:17893/api/habit` shows a sane profile.

---

## 10. Suggested implementation order

1. `schema.ts` tables + version bump (no behavior change yet).
2. `habit.ts` with pure dimension functions + `HabitEngine.handle/recompute/backfill/getProfile` + unit tests.
3. `server.ts` wiring + `/api/habit` + `habit` in SSE; update `events.ts`.
4. `reset.ts` scope + footprint + test fix.
5. `exp.ts` habit conditions + a seed example.
6. `ui/behavior.js` + `ui/voice.js` + `ui/app.js` wiring + tests.
7. Opt-out setting (`habit_enabled`) last, after the feature works.

Keep each step independently shippable and green. Do not land the rendering-layer work before the Core profile is
observable via `/api/habit`.

---

## 11. Open decisions (surface these, don't bury them)

1. **Commit/test signal** (§3) — accept `outcome` proxy, or add `tool_category` to the whitelist + adapters?
2. **`memories` reuse** — should habit insights (e.g. "chronotype=night_owl") also write `memories` rows, or stay
   out of `memories` for now?
3. **Opt-out default** — is profiling on by default with a visible off switch (recommended), or opt-in?
4. **Decay window** — 14-day half-life vs sliding window; confirm with the product owner.

Record the resolution of each in the PR description or a `task_decision` note before merging.
