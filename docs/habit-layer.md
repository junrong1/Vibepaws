# Habit-Driven Pet Layer

Vibepaws v0.2 (schema v4) learns a **user-level working-habit profile** from the event stream it
already collects, then uses it to drive pet behavior, bubble voice, and (optionally) evolution.

Spec: `docs/handoff-habit-layer.md`.

## What it does

- `HabitEngine` (`src/core/habit.ts`) folds events into a per-day rollup
  (`behavior_daily`) and periodically recomputes a single-row, decayed profile
  (`habit_profile`).
- The profile has 8 dimensions: `chronotype`, `cadence`, `depth`, `precision`,
  `context_hygiene`, `responsiveness`, `outcome_bias`, `tool_affinity`.
- Below 5 sessions / 2 active days the profile reports `ready: false` and the UI stays
  neutral (cold start).
- `GET /api/habit` exposes the profile; it also rides the existing SSE `pet_state` push
  under `habit`.
- `ui/behavior.js` maps the profile to animation parameters; `ui/voice.js` maps it to
  bubble emoji/pacing. Both fall back to neutral when `habit.ready` is false.
- `evolution_meta.conditions` may gate on `chronotype=…`, `cadence=…`, `depth>=…`,
  `precision>=…`, `context_hygiene>=…` in addition to the existing `health>=0.7`.
- Settings → Budget & warnings has a **"Learn my work habits"** toggle (`habit_enabled`,
  default on).
- `POST /api/reset` accepts `scope=habit` to clear only the habit tables.

## Privacy guarantees

1. **No raw content.** `behavior_daily` / `habit_profile` store only counts, sums, and a few
   category labels. Never prompts, code, file paths, command text, or project names.
2. **Whitelist unchanged.** The ingress payload whitelist was not widened.
3. **Local only.** Everything stays in `.vibepaws/vibepaws.db`; no network egress.
4. **Forget-able.** `scope=habit` clears `behavior_daily` + `habit_profile`; `scope=data`
   clears them with everything else.
5. **Opt-out.** Setting `habit_enabled=0` stops all folding and forces a neutral UI.

## Signal limitations (recorded decisions)

- **No commit/test signal.** The whitelist has `tool_name` but no command text, so
  "shipper" is proxied by `sessions.outcome` (`success`/`partial`/`abandoned`). We did
  **not** add a `tool_category` field or touch adapters (decision D1).
- **No `memories` coupling.** Habit insights do not write `memories` rows yet (D2).
- **Decay** is exponential with a 14-day half-life; categorical dims use raw window
  counts, continuous dims use decayed sums (D4).

## Files

- `src/core/habit.ts`, `src/core/habit.test.ts`
- `src/db/schema.ts` (v4), `src/core/reset.ts`, `src/core/exp.ts`, `src/core/settings.ts`
- `src/core/server.ts`, `src/core/events.ts`
- `ui/behavior.js`, `ui/voice.js` (+ tests), `ui/app.js`, `ui/pets/render.js`
- `ui/settings.html`, `ui/settings.js`, `src/i18n/messages.js`
- `src/simulator/scenarios.ts` (`night_owl_burst`), `src/simulator/habit.test.ts`
