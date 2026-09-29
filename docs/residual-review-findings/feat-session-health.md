# Known residuals — feat/session-health

Source: ce-code-review run `20260929-230531-bdd39d08` (base 091bc76, reviewed head 784ddcd), 9 reviewers.
Fixes applied after review: bc8f9ea (frontend), 0d7f77f (grant hardening), f454a19 (core/reliability).
Accepted by the user on 2026-09-29 for follow-up rather than fixing before ship.

## Unfixed actionable findings

| # | Sev | File | Finding | Suggested fix |
|---|-----|------|---------|---------------|
| 1 | P1 | `src/core/server.ts:1` | File crosses 1,100 lines; grant/reset/uninstall/coaching/journal/health handlers live in one class behind a ~20-branch if-chain (maintainability) | Extract handlers into `src/core/routes/*.ts` with a narrow `{db, cfg, grantSecret}` context; replace the if-chain with a route table |
| 2 | P2 | `ui/app.js:1` | Grew ~1,080 → ~1,680 lines; bubble, session-row and nameplate DOM inline (maintainability) | Move bubble DOM and session-row DOM into `ui/health/*_dom.js` modules with init functions |
| 3 | P3 | `src/db/schema.ts:388` | `ADDED_COLUMNS` add + backfill are not in one transaction; a crash between them skips the backfill permanently (data-migration) | Wrap each column add and its backfill in a single transaction |

## Accepted security residuals (always-allow grants)

- Allowlisted commands still have flag-level escapes: `git diff/log/show --output=<file>` writes files; `go test -exec`, `go build -toolexec`, `cargo --config runner=` run arbitrary commands; npm/make test targets run project scripts by design.
- Bare read-only tool grants (`Read`, `Grep`, `Glob`, `LS`, `NotebookRead`, `WebSearch`) are not path-scoped.
- Narrow TOCTOU window between the `lstat` symlink check and the atomic write of `.claude/settings.local.json`.
- Reused notification id after `reset(data)`: the pinned preview narrows but does not fully close the window; closing it needs the renderer to echo back the displayed rule.
- The supervised agent runs as the same OS user and can edit `.claude/settings.local.json` directly; Vibepaws surfaces such rules as "not granted through Vibepaws" but cannot prevent the edit.
- An agent holding the API token can forge a `permission_required` event; the shell secret proves a human clicked, not that the request was real (the bubble names the project and rule).

## Deferred plan units (user decision)

- U15 (permission-decision spike), U8 (global shortcut + nonactivating panel), U11 (permission return path). When U8 lands, the global shortcut must exclude `always_allow` (R19).
