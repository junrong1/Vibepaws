<div align="center">

<img src="ui/pets/embercub/idle.png" width="120" alt="Embercub" />
<img src="ui/pets/lunafang/needs-you.png" width="120" alt="Lunafang" />
<img src="ui/pets/voltroc/working.png" width="120" alt="Voltroc" />
<img src="ui/pets/circuit-witch/level-up.png" width="120" alt="Circuit Witch" />
<img src="ui/pets/sporewick/tired.png" width="120" alt="Sporewick" />

# Vibepaws

**A cute coding pet that watches your AI agents, pings you when they need you, and grows from healthy vibe-coding sessions.**

Local-first · always-on-top · never reads your code

[Quick start](#quick-start-2-minutes) · [Connect your agent](#connect-your-coding-agent) · [How growth works](#how-your-pet-grows) · [Privacy](#privacy-what-leaves-your-machine) · [中文文档](README.zh-CN.md)

</div>

---

## The problem

You start Claude Code, it runs for four minutes, and then it stops — waiting for you to approve one file write. You're in another window. You find out six minutes later.

Or: the session has been going great, you're deep in it, and you don't notice that context is at 94% until the agent starts forgetting the constraint you set twenty messages ago.

Coding agents are good at working. They're bad at getting your attention, and terrible at telling you when they've stopped being useful.

## What Vibepaws does

A small pet sits on your desktop, above your fullscreen terminal. It reads events from your coding agents and turns them into something you can catch out of the corner of your eye:

- **The agent needs you** → the pet looks up at you and a bubble appears, within seconds
- **Context is filling up** → warning at 70%, 85%, 95%, each fired once, not nagged
- **Token budget milestones** → 25% / 50% / 75% / 90% of the budget you set
- **The agent errored or stalled** → you find out now, not on your next window switch
- **The session finished** → the pet earns EXP, levels up, and eventually evolves

The pet also grows — but the growth loop is deliberately built so that **burning tokens does not level up your pet**. Sloppy sessions (context at 96%, correction loops) earn a fraction of the EXP that clean ones do. Healthy usage is the only fast path. See [How your pet grows](#how-your-pet-grows).

And it never sees your code. Prompts, diffs, file paths, and tool inputs are dropped at the adapter and dropped again at the database. See [Privacy](#privacy-what-leaves-your-machine).

It also can't spend your tokens: there is no API key and no model client in it, and the hook prints nothing on stdout — which is the only channel a hook has into your agent's context. That isn't a promise, it's a counter you can read: see [Can it spend my tokens?](#can-it-spend-my-tokens)

## Status

**MVP alpha 0.1** — the core loop works end to end on Claude Code, Codex, pi-coding-agent, and DeepSeek Harness (dsh). Honest state of things:

| | |
| --- | --- |
| ✅ **Works today** | Desktop pet with 7 states · decision & permission bubbles · context warnings · EXP / levels · mute (30m / 2h / project / session) · settings window (budget, warning thresholds, session goals, pet name, language) · 3 pet sizes · per-display position memory with follow-or-pin · hook cost counter · crashed-session cleanup · Claude Code + Codex + pi + dsh adapters · generic JSONL bridge · event simulator · privacy allowlist · signed + notarized macOS release pipeline (bring your own Apple credentials) |
| ⚠️ **Partial** | 5 of 12 planned starter pets · topic-drift heuristics wired but thin · evolution rules fire but evolved-form art isn't drawn yet |
| ❌ **Not yet** | Voice commands (STT) · graphical onboarding wizard · anything social (gallery, leaderboard, trading) |

Full requirement-by-requirement status: [PRD §15](docs/prd_mvp_en.md#15-implementation-status-as-of-2026-08-21).

---

## Quick start (2 minutes)

### 1. Install it

**Download it** — grab `Vibepaws-<version>-arm64.dmg` from [Releases](https://github.com/junrong1/Vibepaws/releases), drag it to **Applications**, open it, and approve it once (see below).

**Or with Homebrew**, which also gives you `brew upgrade` later:

```bash
brew tap junrong1/vibepaws https://github.com/junrong1/Vibepaws
brew trust junrong1/vibepaws        # Homebrew 6 requires this for third-party taps
brew install --cask vibepaws
```

Homebrew does **not** skip the approval step — Homebrew 6 removed `--no-quarantine`, so cask downloads are always quarantined.

To upgrade later, run `brew update` first:

```bash
brew update && brew upgrade --cask vibepaws
```

`brew upgrade` on its own auto-updates at most once every 24 hours (`HOMEBREW_AUTO_UPDATE_SECS`), so a tap you cloned earlier today still serves the version it had then — which is how you end up installing yesterday's build minutes after a new release went out.

Either way: **no Node, no npm** — Core runs on the Node runtime already inside the app.

A pet appears bottom-right with a tray icon in the menu bar. First launch initializes its database, rolls you a **random starter pet**, and writes an API token. Core binds localhost only, and every route except `/health` requires that token.

macOS on Apple Silicon is the tested platform. Intel, Windows and Linux aren't blocked by design, but haven't been exercised.

#### Approving the download

Releases are **ad-hoc signed but not notarized** — notarization needs a paid Apple Developer account, which this project doesn't have. macOS says *"Apple could not verify Vibepaws is free of malware."* To open it:

1. Double-click **Vibepaws** in Applications. macOS blocks it.
2. Open **System Settings → Privacy & Security**, scroll to **Security**.
3. Click **Open Anyway**, then confirm. First launch only.

On macOS Sequoia and later, Control-clicking the app no longer works as a shortcut, so System Settings is the only click-through route. If you'd rather do it in one command, clear the flag yourself:

```bash
xattr -dr com.apple.quarantine /Applications/Vibepaws.app
```

What "not notarized" does *not* mean is unsigned or tampered with. The signature is complete and verifiable — `codesign --verify --deep --strict` passes — which is exactly why you get an approval prompt instead of *"Vibepaws is damaged."* A build with a broken signature offers no approval path at all, so [CI refuses to publish one](.github/workflows/release.yml).

### 2. Start it at login

**Settings → Startup → "Start Vibepaws when I log in"**, or the tray menu. One login item brings up the pet and Core together, so you never think about launching it again.

Move the app to `/Applications` first — a login item pointing inside a mounted `.dmg` dies the moment you eject it.

### 3. Connect your agent

**Settings → Connect your agent.** It lists Claude Code, Codex, pi and DeepSeek Harness, marks which ones it found on this Mac, and connects one in two clicks (the second click confirms, because this writes to *your agent's* config). It shows exactly which file it touched, and backs the original up next to it.

Restart the agent afterwards — hooks are read once at session start.

Prefer the terminal, or want to install into a single project instead of globally?

```bash
npm run adapter:install -- --global      # or drop --global for this project only
```

The command line is also the only way to do a **project-scoped** install: the in-app button installs globally, because a click in a settings window can't say *which* project you meant.

Details and per-agent notes: [Connect your coding agent](#connect-your-coding-agent).

### 4. Watch it work, without an agent (optional)

The simulator emits real events into Core, so you can see every behavior before wiring up anything:

```bash
npm run sim -- --scenario normal              # normal session → working → finished
npm run sim -- --scenario frequent_decisions  # repeated "needs you" → bubbles
npm run sim -- --scenario context_overload    # context 88% → 96% → warnings + EXP penalty
npm run sim -- --scenario correction_loop     # same file edited over and over → correction count
npm run sim -- --scenario multi_session       # 3 parallel sessions → aggregated state + carousel
npm run sim -- --scenario crashed_session     # agent dies mid-question → reclaimed within a minute
```

If the pet reacts to `normal`, your install is good. Now connect a real agent.

---

## Connect your coding agent

One command per agent. The installer backs up your existing config, writes the hook entries, and fires a self-test event so you know immediately whether the channel is live.

```bash
# Claude Code — hooks + statusLine (the live token channel)
npm run adapter:install -- --agent claude_code            # this repo only  → <repo>/.claude/settings.json
npm run adapter:install -- --agent claude_code --global   # all projects    → ~/.claude/settings.json

# Codex
npm run adapter:install -- --agent codex                  # this repo only  → <repo>/.codex/hooks.json
npm run adapter:install -- --agent codex --global         # all projects    → ~/.codex/hooks.json

# pi-coding-agent — installed as a pi extension, not a hook config
npm run adapter:install -- --agent pi                     # this repo only  → <repo>/.pi/extensions/vibepaws.ts
npm run adapter:install -- --agent pi --global            # all projects    → ~/.pi/agent/extensions/vibepaws.ts

# DeepSeek Harness (dsh) — installed as a Cordis plugin
npm run adapter:install -- --agent dsh                    # this repo only  → <repo>/.dsh/extensions/vibepaws.cjs
npm run adapter:install -- --agent dsh --global           # all projects    → ~/.dsh/extensions/vibepaws.cjs
```

**Global or project — pick one.** Switching to `--global` automatically removes Vibepaws' project-level hooks from this repo, because running both means duplicate events: double EXP, double bubbles.

**Per-agent notes:**

- **Claude Code** — `statusLine` is where live token counts come from. It's a Claude-only capability, and it's what makes the token channel real-time instead of end-of-session.
- **Codex** — run `/hooks` inside Codex once to authorize hooks. Tokens are extracted from the SessionEnd transcript, so they arrive at the end of a session rather than continuously.
- **pi-coding-agent** — pi has no config-style hooks, so the stable integration is a **pi extension**. The installer copies `src/adapters/pi_extension.ts` into pi's plugin directory, where it binds to pi lifecycle events and reports state deterministically — same tier as Claude/Codex hooks, not something the model has to remember to do. Any exception inside the plugin is swallowed so it can never interrupt pi. **Open a new `pi` session (or `/reload`) for it to take effect.** A project-level plugin also requires the project to be trusted by pi (confirm at first launch).

  For other harnesses, or an environment where plugins aren't available, there's a manual emitter:

  ```bash
  node --experimental-strip-types src/adapters/pi_agent.ts --event=decision_required
  ```

- **DeepSeek Harness** — dsh is Cordis-based, so the stable integration is a **Cordis plugin** (`src/adapters/dsh_plugin.ts`), the same tier as Claude/Codex hooks and the pi extension. The installer copies the plugin into dsh's plugin directory and writes a patch file; the plugin binds to dsh's lifecycle events (`agent/created`, `session/event`, …) and reports state deterministically. **Load it by booting dsh with the patch overlay** (`dsh web --patch <repo>/.dsh/vibepaws.cordis.yml`, or persist the insert in `~/.dsh/profiles/web/cordis.patch.yml`), then **restart dsh** — plugins load at boot. Errors are reported via `turn/end`, tokens via real `usage` counts, context via token-meter ÷ `contextWindow`. Full guide: [docs/dsh_integration.zh-CN.md](docs/dsh_integration.zh-CN.md).

<details>
<summary><strong>What each agent event maps to</strong></summary>

| Vibepaws event | Claude Code | Codex | pi | dsh |
| --- | --- | --- | --- | --- |
| `session_started` | `SessionStart` | `SessionStart` | `session_start` (startup/resume/fork/reload) | `agent/created` |
| `agent_working` | `UserPromptSubmit`, `PreToolUse` | `UserPromptSubmit`, `PreToolUse` | `before_agent_start`, `tool_execution_start` | `turn/start`, `user/message`, `tool/call` |
| `decision_required` | `Stop`, `Notification` | `Stop` | `agent_settled` (agent is idle, waiting on you) | `turn/end` (blocked) |
| `permission_required` | `PermissionRequest` | `PermissionRequest` | tool approval path | `approval/asked` |
| `token_update` | **statusLine (live)**, `PostToolUse` | `SessionEnd` transcript extraction | `message_end` usage (**real tokens/cost**) | `assistant/message` usage (**real tokens**) |
| `context_update` | statusLine `used_percentage`, `PreCompact`/`PostCompact` | `PreCompact`/`PostCompact` | `session_compact` | token-meter ÷ `contextWindow` |
| `session_error` | `PostToolUseFailure`, `PostToolUse` (error) | `PostToolUse` (error) | `tool_execution_end` (isError) | `turn/end` (error), `tool/result` (error) |
| `session_finished` | `SessionEnd` | `SessionEnd` | `session_shutdown` | `agent/disposed` |

`Stop` is the important one on Claude Code: it's the only immediate "your turn" signal. `SessionEnd` only fires when the session actually exits, and `Notification` is either a permission popup or a 60-second idle timeout.

`SubagentStart` / `SubagentStop` are also collected on both hook-based agents.

Missing events degrade, they don't break: if an agent version stops emitting something, Vibepaws skips that signal or approximates it, and the core loop keeps running.

</details>

### If Core isn't running

Adapters never block your agent and never lose events. When Core is unreachable they append to local JSONL:

- Claude/Codex hooks → `.vibepaws/events/fallback.jsonl` (repo root)
- pi extension → `~/.vibepaws/events/pi_*.jsonl` (user-level — the plugin is self-contained and doesn't know your repo path)
- dsh plugin → `~/.vibepaws/events/dsh_*.jsonl` (user-level, same reason)

Then backfill:

```bash
npm run bridge   # watches both directories, normalizes, forwards to Core
```

The same bridge is the **generic integration path** for any tool that isn't Claude/Codex/pi/dsh: write normalized JSON lines into `.vibepaws/events/`, and they become pet state. The envelope:

```json
{
  "event": "decision_required",
  "agent": "my_tool",
  "session_id": "local-session-id",
  "project_id": "/Users/me/my-app",
  "severity": "high",
  "safe_summary": "Tool permission needed",
  "timestamp": "2026-08-21T10:00:00Z"
}
```

Valid `event` values: `session_started` · `agent_working` · `decision_required` · `permission_required` · `token_update` · `context_update` · `topic_drift_warning` · `session_finished` · `session_error`

---

## Using the pet

### Seven states, seven drawings

Each state is a separate hand-checked portrait of the same pet, generated image-to-image. This is on purpose: posture and expression carry information that a jiggle animation and a corner badge can't. `tired` is heavy eyelids and a slumped body. `needs-you` is looking up, right at you.

<table>
<tr>
<td align="center"><img src="ui/pets/embercub/idle.png" width="76"><br><code>idle</code></td>
<td align="center"><img src="ui/pets/embercub/working.png" width="76"><br><code>working</code></td>
<td align="center"><img src="ui/pets/embercub/needs-you.png" width="76"><br><code>needs-you</code></td>
<td align="center"><img src="ui/pets/embercub/warning.png" width="76"><br><code>warning</code></td>
<td align="center"><img src="ui/pets/embercub/finished.png" width="76"><br><code>finished</code></td>
<td align="center"><img src="ui/pets/embercub/tired.png" width="76"><br><code>tired</code></td>
<td align="center"><img src="ui/pets/embercub/level-up.png" width="76"><br><code>level-up</code></td>
</tr>
</table>

With several sessions running, the pet shows the **most urgent** state across all of them; the flyout breaks them down individually.

### Click the pet

The window expands *upward* — the pet itself doesn't move — and you get:

- **Session list** — click a row to copy that session's jump-back command. `needs-you` rows show how long the agent has been waiting on you.
- **Mute everything** — with a duration
- **EXP breakdown** — where the numbers came from
- **⚙ Settings** — opens the settings window (below)

Close it by clicking the pet again, clicking empty space, pressing `Esc`, or hitting the × in the corner.

### Settings

Tray menu → **Settings…**, or the ⚙ button in the flyout. It's a normal window, not a flyout page — the pet window is a few hundred points wide and click-through, which is no place for a form.

| Section | What's in it |
| --- | --- |
| **Pet** | Name it. Empty falls back to the species name. |
| **Connect your agent** | Which agents are on this Mac, which are connected, and a two-click connect for each — no terminal |
| **Budget & warnings** | Default token budget (in k tokens; `0` turns milestones off) · context warning thresholds (off / early / default / late) · daily EXP cap |
| **Tokens & overhead** | What the pet costs: model API calls (`0`), bytes off this machine (`0`), and the live byte/latency counter for the hook path — see [Can it spend my tokens?](#can-it-spend-my-tokens) |
| **Idle sessions** | How long a session may go silent before Vibepaws closes it out (default 15 minutes) — see [When an agent dies](#when-an-agent-dies-without-saying-so) |
| **Running sessions** | Per-session **goal** and **budget** for every agent session that's currently live |
| **Window** | Show on all Spaces · click-through · **pet size (3 sizes)** · **multi-display behaviour** · language · snap the pet back to the bottom-right |
| **Reset & uninstall** | Start over with a new pet · delete all local data · remove the adapter hooks from your agent's config |

Two things there are worth calling out:

**A session goal is not decoration.** It's the baseline for drift detection and it pays 1.1× EXP (see [How your pet grows](#how-your-pet-grows)). Sessions are born in your terminal, so the settings window is the only place to attach one — set it when you start something you care about.

**Changes take effect immediately, including mid-session.** Set a budget on a session that's already burned 60% and you get the 50% milestone on its next token update, not silence until tomorrow. Everything saves as you leave each field; out-of-range values are clamped and the field shows you what was actually stored.

The Core half of this window (budget, thresholds, goals, pet name) also works from the browser preview at http://127.0.0.1:5173/settings.html. The Window section needs the desktop shell and says so when it can't reach it.

### Reset, delete, uninstall

Everything Vibepaws knows sits on your machine, so taking it back should not require a `rm -rf` you have to look up. The bottom of the settings window has three buttons; each one arms on the first click and only acts on the second (and disarms itself after six seconds).

| Button | What it does | What it leaves alone |
| --- | --- | --- |
| **Start over with a new pet** | Rolls a new starter; drops level, EXP history and memories | Sessions, settings, hooks |
| **Delete all local data** | Sessions, events, notifications, EXP history, budgets and thresholds — then compacts the database file | Adapter hooks, and the API token (deleting it would 401 your running hooks) |
| **Remove adapter hooks** | Takes Vibepaws out of `.claude/settings.json`, `.codex/hooks.json` and pi's extension directory — project-level *and* user-level | Everything else in those files, including other tools' hooks |

Two details worth knowing:

**Deleting means deleting.** SQLite only marks freed pages as reusable, so the text of your session titles would still be sitting in the file after a `DELETE`. Core runs `VACUUM` afterwards, which is what actually throws the pages away.

**Uninstalling hooks matters more than it sounds.** A leftover hook entry fires on every single tool call, forever, paying a process launch to POST a port nobody is listening on. It never blocks your agent, but it does make it permanently slower — and nothing in the config would tell you why. Do this before you delete the app.

There's a CLI for the case where the app is already gone:

```bash
npm run adapter:uninstall -- --dry-run     # print what would be touched, write nothing
npm run adapter:uninstall                  # remove hooks from every scope, all three agents
npm run adapter:uninstall -- --agent pi    # or just one (claude_code | codex | pi, comma-separated)
npm run adapter:uninstall -- --purge-data  # also delete the .vibepaws directories (quit Core first)
```

It backs off from two things on purpose, and says so when it runs: your original config stays in the `*.vibepaws.bak` file next to it, and the project-trust entry in `~/.codex/config.toml` is left alone — rewriting someone's TOML without a TOML parser is how a cleanup turns into an eaten config.

### When an agent dies without saying so

`kill -9`, a crash, closing the terminal window, shutting the laptop — none of these send a goodbye event. Without a way to notice, a session that no longer exists stays "running" forever, and if it happened to die while asking you a permission question, the pet stays pinned on **needs-you** for a session you can never answer.

Core sweeps for that every 60 seconds, and once at startup, because the sessions left running by the previous Core are the likeliest zombies of all. Two ways out:

| | How it's detected | How long it takes |
| --- | --- | --- |
| **process gone** | Adapters report the agent's process id; Core checks whether that process still exists | One sweep — seconds, not minutes |
| **went quiet** | No events at all for longer than your threshold (Settings → Idle sessions, default 15 minutes) | The threshold |

Either way the session closes with **no EXP** — a crash is not a win, and rewarding one would teach the growth loop exactly the wrong lesson — the pet doesn't play its celebration animation, and any bubble still on screen for that session goes away. In the flyout these sessions show a hollow dot and say *process gone* or *went quiet*, so you can tell "it finished" from "it died".

The process check is deliberately careful: a process id is only trusted after the **same** id shows up on two separate events. A hook runs as a child of the agent, so its parent is normally the agent itself — but if a short-lived wrapper shell ends up in between, that id would look dead a minute later and Vibepaws would kill a session that's still working. A real agent process keeps one id for the whole session; a wrapper gets a new one every time. When there's no id to trust — the generic JSONL bridge, or a database from before this shipped — the silent timeout handles it alone.

### Mute is a visible state, not a silent switch

While muted, a 🔕 badge sits at the pet's feet showing the remaining time. Click the badge (or the button again) to bring notifications back. A mute you can't see is a mute you forget you set.

### The connection light

| Light | Meaning |
| --- | --- |
| 🟢 Green | Event stream healthy |
| 🟠 Amber (blinking) | State polling still works, but the event stream is dead — **bubbles won't arrive** |
| 🔴 Red | Can't reach Core at all |

Amber is the important one: without it, a broken hook looks exactly like a quiet afternoon.

### Window behavior

- **Drag** — grab empty space in the pet window. Position is remembered, and always clamped to the visible screen area.
- **Clicks pass through** the empty area around the pet's body, straight to the app underneath. The flyout needs room above the pet, and that room is normally empty space.
- **Pet size** — small, medium, large. The pet, its bubbles, and the flyout scale together, and the pet keeps its footing where it stands, so resizing never moves it.
- **Multiple displays** — each display remembers where you last put the pet, keyed by the monitor itself rather than by an OS display id, so it survives unplugging and replugging. Then pick one of:
  - **Follow the active display** (default) — the pet moves over once your cursor has settled on another screen for about a second. A quick sweep across doesn't drag it along.
  - **Stay on one display** — the pet never moves on its own; drag it to another screen and it stays there instead.

  Positions are stored as a fraction of each display's work area, so changing resolution or scaling keeps the pet in the same corner instead of off-screen. Unplug the display it was living on and it moves to one that still exists.
- **Tray menu** — Core status and restart · click-through toggle · show on all desktops · pet size · display behaviour · start at login · show · settings · snap back to bottom-right · quit
- **Above fullscreen apps** — the pet stays visible over fullscreen iTerm2, fullscreen editors, and so on. This is not affected by the tray toggles. To make it possible the shell keeps no Dock icon, so **quit lives in the tray menu** — a macOS requirement: a process with a Dock icon cannot float over someone else's fullscreen Space.
- **Browser preview** (optional) — `npm run ui`, then open http://127.0.0.1:5173. If 5173 is busy the desktop shell picks a free port automatically (it's Vite's default port, so a stray dev server is likely).

> The shell is Electron today because this environment has no Rust toolchain. Tauri v2 replaces it once Rust is ready — shell layer only; rendering and the SSE protocol don't change.

### Language

The UI follows your OS language: any Chinese variant → Simplified Chinese, everything else → English. Tray menu, pet UI, bubbles, settings window, and the adapter installer all share one message catalog (`src/i18n/messages.js`), so you never get a half-translated screen.

To pick one explicitly, use **Settings → Language** — the tray menu, pet window, and settings window all switch on the spot, no restart. The environment variable still wins over that choice, for scripted runs:

```bash
VIBEPAWS_LOCALE=en npm start      # or zh-CN
```

---

## How your pet grows

The design constraint that shapes everything else: **tokens feed the pet, but wasting tokens must not level it up.**

```text
session_exp = capped_token_exp
            × context_health_multiplier
            × topic_consistency_multiplier
            + outcome_bonus
            + daily_care_bonus
```

**Base rate** — 1 EXP per 1,000 tokens, with a **daily cap of 200 EXP** per pet. Past the cap, more tokens buy you nothing.

**Quality multipliers** — this is where a sloppy session gets expensive:

| Signal | Multiplier |
| --- | --- |
| Context under 70% | **1.10×** |
| Context 70–85% | 1.00× |
| Context 85–95% | 0.75× |
| Context over 95% | **0.50×** |
| Topic consistent with your session goal | 1.10× |
| Repeated correction loop | 0.80× |
| Accepted diff · passing tests · commit · explicit "shipped" | **+20 to +100 EXP** |

**Levels** — Lv1 needs 100 EXP, then +50 per level (Lv2 → 150, Lv3 → 200, …).

**No permadeath.** Unhealthy usage turns the pet `tired` and slows EXP; a break, a fresh session, or shipping something brings it back. The pet also grows a little on its own each day, so a week off your agent isn't a punishment.

**Notification thresholds:**

| Kind | Fires at |
| --- | --- |
| Context warning | 70% · 85% · 95% (configurable, or off) |
| Token budget milestone | 25% · 50% · 75% · 90% of budget |

Each tier latches — you get 70% once, not every 60 seconds. But 70% and 95% are genuinely different messages ("keep an eye on it" vs. "wrap up now"), so both land.

Milestones need a budget to be a percentage of, and there is no default one — set it in [Settings](#settings), globally or per session. Context warnings work without a budget.

---

## Privacy: what leaves your machine

Nothing. There is no cloud sync, no telemetry, and no network destination other than `127.0.0.1`.

Inside your machine, there are two independent gates:

1. **At the adapter** — fields are extracted by allowlist. `tool_input`, prompt text, and `transcript_path` are dropped before anything is sent.
2. **At Core, before persistence** — unknown fields are dropped again by schema. Raw hook JSON is never written to the database.

What that means concretely: bubbles never show raw prompts, source code, secret paths, or file contents. `safe_summary` uses fixed wording (`"Tool permission needed"`), not agent output. This is enforced by tests — see `src/core/privacy.test.ts`.

One field on the allowlist is worth naming because it's new: the agent's **process id**, a local integer used only to answer "is that process still alive?" (see [When an agent dies](#when-an-agent-dies-without-saying-so)). It never leaves `127.0.0.1`, and it can't be turned back into anything you typed.

To delete everything, use **Settings → Reset & uninstall** (see [Reset, delete, uninstall](#reset-delete-uninstall)) — it wipes the database in place and compacts the file, which deleting the directory under a running Core does not do. Without the app, `npm run adapter:uninstall -- --purge-data` does the same from the shell. Everything lives in `.vibepaws/`: the database, your pet, its EXP history, and the API token.

### Can it spend my tokens?

No. There is no API key and no model client anywhere in Vibepaws — no code path in it talks to a model, so there is nothing to bill.

This gets its own section because of [clawd #102](https://github.com/rullerzhou-afk/clawd-on-desk/issues/102): a user asked why *their agent had told them* the desktop pet was consuming a lot of tokens. The agent had made it up, and the user reasonably believed it. Every hook-based pet gets this question eventually, and "trust me" is a poor answer to a claim a language model invented.

So here is the mechanism instead. A hook can reach the model through exactly one channel: **stdout**. Claude Code feeds some of it back into the conversation — `UserPromptSubmit` stdout becomes context, and a non-zero exit turns stderr into feedback. Vibepaws' hook writes nothing to stdout and always exits `0`. Both are pinned by tests in `src/adapters/hook_agent.test.ts`, because one stray `console.log` added while debugging would quietly start costing real tokens and would look completely harmless in review. (The statusLine command does print a line — that's your terminal's status bar, rendered by Claude Code. It isn't sent to the model.)

What it *does* cost, measured on this machine (M-series Mac, Node v25):

| | |
| --- | --- |
| Model API calls | **0** |
| Bytes leaving the machine | **0** |
| Per event | ~310 bytes of JSON over `127.0.0.1` |
| Core, to ingest one | ~0.4 ms (p50) |
| The hook process itself | ~75–80 ms wall clock, nearly all of it Node starting up |

That last row is the honest price of a hook-based design: roughly 80 ms added to a tool call, paid in latency rather than tokens. It's also the number most worth watching, which is why it's on screen instead of in a footnote.

Live numbers are in **Settings → Tokens & overhead**, with a one-line version under the EXP breakdown in the flyout. Don't take that window's word for it either — the same JSON is one request away:

```bash
curl -s -H "x-vibepaws-token: $(cat ~/.vibepaws/api_token)" \
  http://127.0.0.1:17893/api/hookstats
```

Counting starts when Core starts. Byte counts are the request bodies Core actually read; the hook timings are self-reported by each hook process, measured from its own start to the moment it sends.

---

## How it works

```
Your agents                          Vibepaws Core (Node daemon)              Pet shell
─────────────                        ───────────────────────────              ─────────
claude_code hooks ─┐                 ┌──────────────────────────┐
codex hooks ───────┤  HTTP + token   │ Event ingress             │             ┌───────────┐
pi extension ──────┼───────────────► │  ↓ validate / dedup       │   SSE       │ pet state │
generic JSONL ─────┤  127.0.0.1      │ Session registry          │ ──────────► │ bubbles   │
simulator ─────────┘                 │  ↓ aggregate 7 states     │             │ flyout    │
                                     │ Notification engine       │             │ EXP bar   │
        (Core offline?               │ EXP / health / evolution  │             └───────────┘
         → JSONL + bridge)           │ SQLite: pets, sessions,   │
                                     │  events, notifications,   │
                                     │  exp_logs, memories       │
                                     └──────────────────────────┘
```

Core is a standalone daemon and can run headless. The pet shell is just a client — one of several possible ones. Adapters are independent and may be absent; a missing adapter degrades a signal, it doesn't break the loop.

Core's HTTP surface (all routes but `/health` need `X-Vibepaws-Token`):

| Route | Purpose |
| --- | --- |
| `POST /events` | Ingest an event |
| `GET /sse` | Event stream (pet state, notifications, raw events) |
| `GET /api/state` | Current aggregated state |
| `GET /api/sessions` | Session list |
| `GET /api/exp` | EXP breakdown |
| `POST /api/action` | mute / unmute / dismiss / actioned |
| `GET /api/hookstats` | What the collection path costs — events, bytes, latency, and two zeroes |

Design decisions and module-level detail: [`docs/mvp_architecture.md`](docs/mvp_architecture.md) (Chinese).

---

## The pets

Five starter pets ship today, each with all seven state portraits. The registry supports 100 IDs with rarity and evolution metadata from day one.

| Pet | Rarity |
| --- | --- |
| <img src="ui/pets/embercub/idle.png" width="52"> **Embercub** | common |
| <img src="ui/pets/sporewick/idle.png" width="52"> **Sporewick** | common |
| <img src="ui/pets/lunafang/idle.png" width="52"> **Lunafang** | uncommon |
| <img src="ui/pets/voltroc/idle.png" width="52"> **Voltroc** | uncommon |
| <img src="ui/pets/circuit-witch/idle.png" width="52"> **Circuit Witch** | rare |

You get one at random on first launch.

### Adding your own pet

The built assets in `ui/pets/` are **committed to the repo** — running the app and installing dependencies need no Python. You only need the pipeline when adding a pet.

```bash
# 1. Drop your source image into pet_assests/ and add a row to pet_assests/roster.json
#    (id / slug / name / rarity / starter / src)

export POE_API_KEY=...                      # read from the environment only, never committed
npm run states -- --dry-run                 # print what would be generated
npm run states                              # generate all 7 state portraits (skips existing)

npm run assets -- --check                   # inspect only: cutout, components, anchor, accent color
npm run assets                              # write ui/pets/<slug>/*.png and ui/pets/index.json
npm run db:init                             # bring the pet_types table in line
```

`ui/pets/index.json` is the single runtime source of truth — both the renderer (`ui/pets/registry.js`) and `src/db/seed.ts` read it.

**Check the contact sheet.** `npm run assets` also assembles `output/imagegen/pet-states/contact-sheet.png` (checkerboard behind the alpha) — **look at it after every generation run.** The model occasionally paints a ground shadow under the pet's feet despite the prompt forbidding it, and numerically that shadow is indistinguishable from the pet's own large pale areas (saturation, alpha, and flatness heuristics were all tried; each gives either false negatives or false positives). So there's no automated check here: the dirty frame is obvious to your eye on the contact sheet. Delete it and regenerate.

Default model is `nano-banana-pro`. `gpt-image-2` doesn't currently work — Poe's Images API isn't enabled on this account (`403 Images API is not enabled for this user`, for every image model), and `gpt-image-*` over chat/completions disconnects outright. Once it's enabled, `--model gpt-image-2` is all you need.

If an asset is missing, fails to decode, or a `pet_type_id` has no art, the pet falls back to a procedurally drawn form (`ui/pets/procedural.js`). The UI always shows a pet — never an empty window.

State-to-motion mapping lives in the `MOTION` recipe table in `ui/pets/motion.js`. To eyeball one state directly, append `?petstate=<state>` to the pet window's URL instead of reproducing it with the simulator.

---

## Packaging a `.app`

```bash
npm run dist:mac                      # output in dist/
npm run verify:release -- --preflight  # before building: do you have a cert and credentials?
npm run verify:release                 # after building: is it actually signed and notarized?
```

The build is wired for signing and notarization — hardened runtime, entitlements, and a
notarization step for both the `.app` and the `.dmg`. **Credentials are what's missing, not
config.** Without them the build still succeeds and `build/adhoc-sign.cjs` ad-hoc signs the
bundle instead.

That hook matters more than it sounds. Left alone, electron-builder skips signing entirely and
the `.app` ends up with *no* `Contents/_CodeSignature` while its inner binaries still carry
linker ad-hoc signatures — a **malformed** state. Gatekeeper's verdict for malformed is
*"Vibepaws is damaged"*, which offers the user no way forward at all. A complete ad-hoc signature
gets *"Apple could not verify…"* instead, which can be approved in System Settings. Same lack of
trust, completely different outcome.

`npm run verify:release -- --allow-unsigned` checks that unsigned releases are in the good state:
every structural check still has to pass (valid signature, hardened runtime, entitlements, every
Mach-O signed) — only "is it Developer ID" and "is it notarized" drop to warnings.

> **An unsigned build shows up as "damaged" on macOS** ([#1](https://github.com/junrong1/Vibepaws/issues/1)). The build isn't broken — Gatekeeper quarantines any app without an Apple Developer signature and notarization. Two options:
>
> - **For yourself** — clear the quarantine flag after installing:
>   `xattr -dr com.apple.quarantine /Applications/Vibepaws.app`
> - **To distribute** — set the Apple credentials and the same `npm run dist:mac` signs, notarizes, and staples. Tagging `v*` does it in CI. Full runbook: [`docs/release_signing.md`](docs/release_signing.md).

`npm run verify:release` is the honest check. Signing failures are invisible on your own machine —
your build never gets a quarantine flag, so Gatekeeper never evaluates it — which means "it opens
here" proves nothing. The verifier asks macOS directly: signature, hardened runtime, entitlements,
notarization ticket, and whether every Mach-O in the bundle got signed.

---

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Pet never leaves `idle` while an agent is clearly working | The hook isn't running. It needs Node ≥ 22.6 (the app itself doesn't — only the collector inside your agent does). Check `node --version`, then re-run `npm run adapter:install -- --global`. |
| Hooks stopped working after a Node upgrade | The installer writes an absolute interpreter path. It prefers a stable one (`/opt/homebrew/bin/node`), but a version-manager path can still disappear under you. Re-run `npm run adapter:install -- --global`. |
| Connection light is amber | Event stream is dead while polling still works, so bubbles can't arrive. Restart Core, then re-run the adapter installer to re-fire its self-test. |
| Nothing happened after installing the pi adapter | Open a **new** `pi` session or `/reload`. Project-level plugins also need the project trusted by pi. |
| Codex sends nothing | Run `/hooks` inside Codex once to authorize. |
| Double EXP, double bubbles | Both global and project-level hooks are installed. Re-run with `--global`, which cleans up the project-level entries. |
| Token count stays 0 | On Claude Code, tokens come from `statusLine` — reinstall the adapter so it gets configured. On Codex, tokens only arrive at SessionEnd. |
| No token milestone bubbles | No budget is set — set one in Settings (tray → Settings…), globally or on that session. Milestones are relative to a budget; context warnings work without one. |
| Pet disappears over a fullscreen terminal | Shouldn't happen — file it. Note that "show on all desktops" only controls whether it follows you between Spaces. |
| Pet is off-screen after switching monitors | It should come back on its own — unplugging a display moves the pet to a display that still exists. If it doesn't, tray → **Reset pet position**. |
| Pet keeps hopping to whichever screen I'm working on | That's **Displays → Follow the active display**. Switch it to **Stay on one display** (tray or Settings → Window) and it stays put; drag it somewhere else and it stays there instead. |
| Pet won't follow me to my other screen | Follow waits about a second for your cursor to settle, so a quick sweep across won't drag it along. If it never follows, check you're not in **Stay on one display**. |
| "Vibepaws couldn't start Core" on launch | Core normally runs inside the app, so this means that failed *and* there's no Node ≥ 22.6 to fall back on. Installing Node gives it a second path. To force a specific one, set `VIBEPAWS_NODE=/path/to/node`. The reason is in the log. |
| Tray says **Core: not running** | Five restarts in a row failed. Tray → **Restart Core**; the reason is in the log (`~/Library/Application Support/Vibepaws/vibepaws.log` for the packaged app, stdout in dev). |

---

## Development

### Running from source

The `.dmg` is the user path; this is the contributor one. It needs **Node ≥ 22.6** — not because the app does, but because `npm` and the test runner do.

```bash
node --version   # v22.6.0 or higher
npm install
npm start        # transparent always-on-top window, bottom-right, with a tray icon
```

One command. The tray app owns everything else: it starts **Core** (the daemon that ingests events, tracks sessions, runs the notification and EXP engines, and owns the SQLite database) on `127.0.0.1:17893`, starts the local UI server, and stops both when you quit. Core runs on Electron's own bundled Node, the same as in the packaged app — so what you run here is what users get.

If Core dies, the app restarts it (five tries, exponential backoff) and shows its state at the top of the tray menu. If Core is *already* running — you started `npm run core` yourself in another terminal — the app uses that one and leaves it alone when you quit.

`npm start` holds the terminal open. To detach it:

```bash
nohup npm start > /tmp/vibepaws.log 2>&1 &!   # zsh; use `& disown` elsewhere
pkill -f "electron desktop/main.js"           # stop it
```

Keep the redirect — a source run logs only to stdout, while the packaged app writes to `~/Library/Application Support/Vibepaws/vibepaws.log`.

### Tests

```bash
npm test          # registry state machine · notification engine · EXP engine · aggregated state ·
                  # migrations · hook normalization · bridge · privacy · i18n · pet type seed ·
                  # motion recipes (including out-of-range and transition continuity) ·
                  # window placement across displays and pet sizes
npm run typecheck
npm run core:watch    # Core alone, reloading on edit — pair it with `npm start`, which will adopt it
```

Layout:

```
src/core/        daemon: ingress, session registry, notifications, EXP, settings, HTTP + SSE
src/adapters/    claude/codex hook template, pi extension, statusline, generic bridge, installer
src/db/          SQLite schema, migrations, pet type seed
src/simulator/   scenario-driven event generator for QA
src/i18n/        one shared message catalog (zh-CN / en)
ui/              pet renderer: canvas, motion recipes, fx, pet registry, procedural fallback
                 + the settings page (settings.html / .js / .css)
desktop/         Electron shell: transparent window, tray, click-through, settings window,
                 pet scale + multi-display placement, Core supervision (find node → spawn →
                 restart → reap) and the login item
scripts/         Python asset pipeline (only needed when adding pets)
docs/            PRD (en/zh) and technical architecture
```

Tests are Node's built-in runner over `--experimental-strip-types` TypeScript — no build step, no test framework.

---

## Roadmap

**Rest of the MVP window** — remaining starter pets (5 → 12) · evolved-form art · sound cues · drift tuning · STT voice commands as a P1 experiment.

**After that**, gated on retention rather than pet count — exportable pet cards, community pet submissions with moderation, skin packs, public profiles.

**Deliberately deferred** — leaderboards, PVP, trading, rare pet sales. Each brings anti-cheat, IP, moderation, and trust problems, and none of them are worth taking on before daily usage is validated.

Full reasoning, metrics, and release criteria: **[PRD (English)](docs/prd_mvp_en.md)** · **[PRD (中文)](docs/prd_mvp_zh.md)**

## Documentation

| Document | Contents |
| --- | --- |
| [`docs/prd_mvp_en.md`](docs/prd_mvp_en.md) | Product requirements, scope decisions, metrics, roadmap, implementation status |
| [`docs/prd_mvp_zh.md`](docs/prd_mvp_zh.md) | Same, in Chinese |
| [`docs/mvp_architecture.md`](docs/mvp_architecture.md) | Technical architecture: decision log, module design, event schema, data model, degradation |
| [`docs/release_signing.md`](docs/release_signing.md) | Signing and notarizing a release: credentials, one-time setup, CI, verification, troubleshooting |
| [`docs/release_signing.zh-CN.md`](docs/release_signing.zh-CN.md) | Same, in Chinese |
| [`references/event_collection.md`](references/event_collection.md) | Claude Code / Codex hook event research |
| [`references/cc-session.md`](references/cc-session.md) | Session management research across pi / Claude Code / Codex |
| [`references/desktop_pet_landscape.md`](references/desktop_pet_landscape.md) | Competitive research: 35 desktop pets, 1,300+ issues across 8 trackers, and a 39-item prioritized feature roadmap |
| [`references/desktop_pet_landscape.zh-CN.md`](references/desktop_pet_landscape.zh-CN.md) | Same, in Chinese |

## Contributing

The MVP is moving fast and scope is frozen through 2026-09-01, so the most useful contributions right now are **bug reports from real agent sessions** — especially adapter breakage on agent versions other than the ones tested here. Include your agent, its version, and `node --version`.

Pet art contributions are planned but not open yet: they need moderation, copyright, and asset-quality rules first (PRD §16).

## License

Not yet chosen. Until a license file lands, all rights are reserved by the author — treat this repository as source-available for evaluation, not as open source.

<div align="center">

**[中文文档 →](README.zh-CN.md)**

</div>
