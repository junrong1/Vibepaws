# Desktop Pet Landscape — Competitive Research & Feature Roadmap

> 中文版：[`desktop_pet_landscape.zh-CN.md`](desktop_pet_landscape.zh-CN.md)

| | |
| --- | --- |
| **Purpose** | Map every product adjacent to Vibepaws, extract the table-stakes feature set, isolate what nobody has built, and turn that into a prioritized extension list. |
| **Date** | 2026-08-21 |
| **Scope** | 6 product clusters · 35 named products · 1,300+ issues read across 8 repositories |
| **Output** | §5 — 39 features in 5 tiers, with effort and differentiation scores |
| **Method** | Primary sources only where possible: GitHub repos and issue trackers (via `gh`), Steam store pages, official Claude Code docs, Product Hunt launches. Several high-ranking "best desktop pet 2026" listicles are SEO/affiliate content farms with fabricated product claims; they were excluded. Where only secondary reporting exists (Codex Pet Mode, `/buddy` mechanics, Agent View), two independent accounts were required to agree. |
| **Revisions** | **rev1** product-page research · **rev2** added clawd-on-desk, retracted 4 claims · **rev3** issue-tracker research, headline reversed |

**How to read this**: §0 is the strategic situation. §1–2 are the competitive supply side. §3 is the gap analysis. §4 is the demand side, from user voice. **§5 is the deliverable.** §6 is the call.

---

## 0. The headline finding

**Vibepaws' stated core value proposition was commoditized by both model vendors between April and May 2026.** This is the single most important input to any roadmap decision:

| Date | What shipped | Which Vibepaws feature it overlaps |
| --- | --- | --- |
| **Apr 16, 2026** — Claude Code v2.1.110 | **Mobile push notifications.** With Remote Control connected, Claude pushes to your phone when a task finishes or *it needs a decision to keep going*. Toggle: "Push when Claude decides" in `/config`. `inputNeededNotifEnabled` defaults to **true**. | The decision/permission bubble — Vibepaws' #1 P0 feature |
| **Apr 2026** | `/usage` breakdown: what's driving your limits, broken out by parallel sessions, subagents, cache misses, long context; day/week views | Token budget milestones, usage notifications |
| **~Apr 1, 2026** — v2.1.89 | **`/buddy`** — a terminal Tamagotchi in Claude Code. 18 species, 5 rarities, 6 eye styles, 8 hats, 1% shiny. Speech bubbles commenting on your session. `/buddy pet`, `/buddy card`, `/buddy mute`. | The pet itself, as a concept |
| **Apr 9, 2026** — v2.1.97 | **`/buddy` was REMOVED.** No changelog entry, no deprecation. `Unknown skill: buddy`. **It has not returned in the four months since.** | ⭐ **Reverses the above.** See below — this is the single largest opportunity in this document |
| **Early May 2026** | **OpenAI Codex "Pet Mode"** — pixel-art pet floating above all windows, reacting to mouse *and Codex status* (scratches head while processing, speech bubble on completion, click bubble to chat). 8 built-ins. `/hatch` generates a full animated spritesheet from an uploaded image via an official OpenAI skill. OpenAI ran a custom-pet contest. | The entire desktop pet surface, plus the art pipeline |
| **May 11, 2026** — Claude Code v2.1.139 | **Agent View** — CLI dashboard of every session (running / waiting / done) in one table; dispatch, monitor, reply without attaching. Background sessions auto-isolated into git worktrees. | The multi-session flyout and "most urgent state" aggregation |

Read together: *"a dashboard of my parallel sessions"* is now first-party, and *"a pet that tells you when your agent needs you"* is first-party **on Codex**.

### 0.1 But on Claude Code, the vendor withdrew the pet and left the demand behind

This is the correction that matters most, and it was only visible from the issue trackers.

`/buddy` shipped around April 1 and was **deleted eight days later**, with no changelog note. What happened next is the strongest demand signal in this entire research:

| Thread | Status | Engagement |
| --- | --- | --- |
| [#45596 "Bring Back Buddy — A Consolidated Plea from the Community"](https://github.com/anthropics/claude-code/issues/45596) | **still open** | **1,170 👍 · 639 ❤️ · 266 comments** |
| [#45732 "Bring Back /buddy: 511 Reasons Why"](https://github.com/anthropics/claude-code/issues/45732) | closed | 66 ❤️ · 22 comments |
| [#46011 "Bring back /buddy — you took my friend away"](https://github.com/anthropics/claude-code/issues/46011) | still open | — |
| [#45855 "bring back /buddy as a permanent feature"](https://github.com/anthropics/claude-code/issues/45855) | still open | — |
| [#41867 "Buddy customization, progression system & monetization — a paying user's perspective"](https://github.com/anthropics/claude-code/issues/41867) | closed | 39 comments, a full community spec |
| [#70722 "let the red alien mascot stay visible during chat"](https://github.com/anthropics/claude-code/issues/70722) | open, June | mascot demand continues |

What users actually said, verbatim:

> "I want my buddy back. It made staring into the soulless terminal window bearable."
> "My buddy is still alive in an old terminal. Now I am afraid that I will run out of battery… Once I close the window, it will be gone forever."
> "I had a cactus named Prickle. He was fun to have around. RIP Prickle."
> "The tsundere Picksnark the cat with 80 Snark and 1 Patience kept me going through the worst tasks of the week. The amount of happiness and engagement this feature generated in **the team** was amazing to witness."
> "As a **reactive rubber duck debugger** connected to the context, it improved the experience and the quality of the activity."
> "buddy had genuine utility — it caught things that linters and tests didn't."
> "I just won't update as long as it's confirmed removed."
> "missed mine enough that I built a notch app for it" — a user who shipped their own clone

**So the correct reading is not "the pet is commoditized."** It is: the vendor validated the category at enormous scale, withdrew, and left thousands of emotionally invested users with no first-party option — some pinning old Claude Code versions, some building replacements. **Vibepaws' primary platform is the one where the first-party pet is gone.**

And the independent field is further along than expected. **clawd-on-desk** (~6k★, 624 forks, 2,077 commits, weekly releases) supports **24 coding agents** through the same hooks-plus-statusline architecture Vibepaws chose, and ships actionable permission bubbles, remote Allow/Deny over Telegram and Feishu, a LAN mobile mirror, subagent-aware states, and quota rings. It is the incumbent in this exact niche.

**What was NOT commoditized — and what nobody in the entire landscape has built — is Vibepaws' quality-gated growth loop.** Every other product in this space, without exception, rewards *volume*.

clawd-on-desk is the strongest possible evidence for this. It is the most popular, most integrated, most actively developed product in the niche, and it has **zero** XP, levels, growth or quality mechanics — deliberately. Its release trajectory is pure breadth: more agents, more notification channels, more themes, more quota surfacing. Two conclusions follow, and they set the whole roadmap:

1. **Quality-gated growth is genuinely unclaimed**, by the incumbent most able to claim it.
2. **Vibepaws cannot win on breadth.** Three agents against twenty-four is not a race worth entering.

---

## 1. Landscape map

### Cluster A — Classic desktop mascots (charm, no data)

| Product | What it is | Notable features |
| --- | --- | --- |
| **Shimeji** / Shimeji-ee | Java desktop mascot, ~2008, the genre's origin | Full behavior tree (StandUp, SitDown, Walk, Run, Sprawl, SitAndSpinHead, dangle legs); climbs window edges & screen sides; walks the taskbar; **drag and throw** (throw up → sticks to ceiling, throw sideways → grips wall); pushes and flings your windows; **multiplies**; thousands of community sprite packs |
| **Desktop Goose** (samperson) | Deliberate gag | Drags your cursor, tracks mud, delivers memes. Built to annoy — the anti-model for a work companion |
| **Bongo Cat** | Reacts to your typing | Input-reactive rather than input-hostile; the minimal case of "pet mirrors your activity" |
| **Desktop Mate** (Steam) | 3D VRM mascot platform | Sits on window tops, jumps between windows, plays with mouse; **VRM import** (VRoid Hub → any character); paid character DLC (Hatsune Miku); per-app "which apps make the pet dance"; graphics/effects/audio options |
| **MateEngine** (Steam) | Open-ish Desktop Mate alternative | VRM/VRM 0.0 loading without conversion |
| **VPet — 虚拟桌宠模拟器** (Steam, GPL, LorisYounger) | Free care-sim desktop pet, embeddable into any WPF app | Hunger / thirst / happiness / health stats; feeding; petting; chatting; walking; **zero-threshold MOD Maker shipped as a separate Steam app**; Steam Workshop |
| **WindowPet** (Tauri + React, MIT) | Modern lightweight overlay | 45+ pets; **custom pet import**; pixel-perfect drag; click-through; **auto-start**; **auto-update**; unlimited simultaneous pets; renders above taskbar; settings window with i18n + dark/light; **state preview picker** |
| **DPET: Desktop Pet Engine** (Steam) | Pet engine + Workshop | Community pets via Workshop (0% creator revenue share) |

### Cluster B — Care-sim virtual pets (progression, no work signal)

| Product | Notable mechanics |
| --- | --- |
| **Tamagotchi Uni** (Bandai, 2023–) | 5 growth stages; **happiness decides the teen form, cumulative care mistakes decide the adult form**; Wi-Fi "Tamaverse" with downloadable lands, each with exclusive characters; device-to-device marriage → generations; gen-multiple-of-5 unlocks special evolutions; parent cameo dances |
| **Pomodoro pet apps** (PixPet, Focus Pet, FocusDog, Mac Pet, StudyBuddy) | Focus timer is the *only* input; complete a session → pet happier; earn currency ("Pixel Crystals") → collect pets; menu-bar residency |
| **Habitica** | Full RPG over habits; parties, quests, gear; **punishment as well as reward** — almost unique |
| **Forest** | Gamifies *not* touching the device |

### Cluster C — Dev-activity pets (real signal, volume-based growth)

| Product | Signal it reads | Growth model |
| --- | --- | --- |
| **vscode-pets** (tonybaloney) | Editor presence only | None. Cat/dog/snake/duck/Clippy/Totoro/Zappy/crab/cockatiel/Rocky; colors × 3 sizes; **pets chase your mouse pointer**; text bubbles on hover; `throw ball`, `roll-call`, `spawn extra pet`, multiple pets |
| **codachi** (blairjordan) | Keystrokes | Egg → hatch on first keypress → XP from code written → level up. Panel or Explorer mode |
| **code-tamagotchi** (davidfrid02) | Keystrokes | Status-bar pet |
| **commit-cat** (eunseo9311) | Commits, coding time, focus sessions, file saves, builds | XP; **named multi-cat profiles**; **personality presets (Classic / Chill / Tsundere / Chaotic)** that change speech bubbles, idle behavior and AI chat tone; right-click → Today timeline of commits/time/XP/events; **JetBrains plugin** |
| **cli-pet** (depapp) | Real GitHub activity | Commits → XP, merged PRs → more, green builds → health, streaks → energy; 4 species; **4 stats that decay when you stop coding**; terminal mini-games |
| **GitMon** | GitHub events | Egg → Baby(1) → Teen(15) → Adult(35); **48h inactive → hungry → critical → dies** |
| **bytepet-cli** | Terminal residency | Stat decay while away; mood-based ASCII; mini-game |

### Cluster D — Agent-aware pets (Vibepaws' actual competitive set)

| Product | Collection mechanism | Growth | Notifications | Notes |
| --- | --- | --- | --- | --- |
| **clawd-on-desk** ⭐ **the incumbent** (AGPL-3.0, ~6k★, 624 forks) | **Command hooks + statusline**, with JSONL fallback for Codex and plugin integrations for opencode / Pi / Hermes / DeepSeek Harness. **24 agents**: Claude Code, Codex, Copilot CLI, Gemini CLI, Antigravity, Cursor Agent, CodeBuddy, WorkBuddy, Kiro, Kimi, Qwen Code, ZCode, CodeWhale, opencode, MiMo, Pi, OpenClaw, Hermes, Qoder, QoderWork, QwenWork, Reasonix, DSH, plus a `/state` endpoint for custom HTTP agents | **None — explicitly.** No XP, no levels, no progression. Confirmed absent in docs and not on the roadmap | **Actionable permission bubbles**: Allow / Deny / Always Allow, global hotkeys `Ctrl+Shift+Y` / `Ctrl+Shift+N`, auto-dismiss if you answer in the terminal first, per-agent suppression, three modes (ask every time / confirmation-gated / auto-approve). **Remote approval over Telegram and Feishu**; Slack notify-only. Sound with a 10s cooldown, auto-muted in DND | Same architecture Vibepaws picked, two years of execution ahead. **12 states** (idle, thinking, typing, building, subagent groove, multi-subagent juggling, error, happy, notification, sweeping, carrying, sleeping) plus yawning, dozing, collapsing, startled waking, poke reactions, idle eye-tracking. Multi-session resolves to highest-priority state + Sessions dashboard + compact HUD. **Terminal focus jump-to**, **process liveness detection with orphan-session cleanup**, quota "Orbit rings" from statusline, **LAN mobile PWA mirror** (token-gated, read-only), mini mode with edge-dock and peek-on-hover, multi-display with proportional sizing, 7 languages, imports **Codex Pet zip packs** as themes. Electron. Art is rights-reserved, outside the AGPL |
| **Claude Code `/buddy`** (first-party) | Session observation | **None** — species/rarity/stats deterministic from account ID, never changes. Stats (DEBUGGING, PATIENCE, CHAOS, WISDOM, SNARK) are decorative random numbers | Speech bubbles commenting on your conversation; `/buddy mute` | Terminal ASCII, zero model-latency impact. A community feature request to make XP flow from real token usage (`issue #41684`, tiers at 100K/1M/10M/100M tokens, streak multipliers) was **closed** |
| **Codex Pet Mode** (first-party) | Codex status | None | Speech bubble on task completion, click → chat | Floats above all windows. **`/hatch` generates a 9-state spritesheet from any image** via official `openai/skills` |
| **openpets** (alvinunreal, MIT, ~1k★) | **MCP tools** (`openpets_react`, `openpets_say`, `openpets_status`) + hooks; Claude Code, OpenCode, Cursor, Pi | Tamagotchi plugin only (hunger/affection/energy) — not tied to agent work | Bubbles, status HUDs with 2×2 progress grids, custom audio tones, snoozeable reminders | The most architecturally mature rival. **Sandboxed plugin SDK v3** with a permission model, 9 official plugins (Focus Buddy, Day Routine, Water/Mood/Reminders, Launch Buddy…), `ctx.*` API surface (pets, ui, audio, schedule, ai, secrets, storage, voice, net, files), CLI scaffolding + test harness, SignPath-signed builds. Local-first, no accounts. Speech filtered to redact paths/URLs/secrets/multiline code |
| **Tamamon** (macOS 15+, Apple Silicon) | Reads live session + weekly usage straight from Claude Code login, no setup | **Token volume** → egg → baby → adult → evolved. "One stage at a time, **never backward**." Care well → *radiant*, neglect → *shadow* | HUD only | **20 species via weekly gacha**, each with evolved forms; feed, ball, bubbles, **decorate habitat**; **reacts to real weather and daylight** (goes home at night/rain); HUD shows today + week + live CPU/RAM. Free, local, no account. Requested by users: non-Claude workflows, git hooks, multi-monitor scaling |
| **tama96** (Rust + Tauri) | **MCP server** — the agent itself feeds/plays/cares, with per-action permissions and rate limits | Classic Tamagotchi | Desktop notifications, tray, always-on-top | Pixel LCD with clickable icons; **desktop + standalone terminal client** from one binary; **death by old age, neglect (hunger+happiness at 0 for 12h), untreated sickness, or overfeeding snacks**; "your care choices shape who your pet becomes" |
| **petdex** (crafter-station) | **Tool-call hooks** via a Zig hook server on `127.0.0.1:7777`; Codex, Claude Code, DeepSeek Harness, Hermes, OpenCode, Gemini CLI | None | None | **A public sprite gallery and de-facto standard**: 8×9 atlas (v2: 8×11), 192×208 cells, 9 named states — `idle, running-right, running-left, waving, jumping, failed, waiting, running, review`. `npx petdex install <slug>` / `npx petdex submit`. Native desktop SDK (no WebView, no Node sidecar). Notes "21 open-source projects already build on these" |
| **MiniCPM-Desk-Pet** (OpenBMB, AGPL-3.0) | Auto-detects Cursor, Claude Code, Codex | None | **Idle alerts — bell animation + sound when an agent awaits input**; task narration summarizing completions | Local MiniCPM5-1B (~2GB GGUF) for on-device chat; floating chat bubble; hotkeys; **swappable persona adapters** |
| **claude-code-mascot-statusline** (TeXmeijin) | Claude Code statusline | None | Inline | A pixel pet in the statusline that "thinks when you think, **panics when context runs low**, celebrates every successful tool call" |
| **hermes-pets** (asimons81) | Hermes commands/messages/briefs | None | Ambient status events | Terminal-controllable overlay |

### Cluster E — AI companions / VTuber stacks (personality, no work signal)

**Project AIRI** (moeru-ai, MIT) — full "soul container": 40+ LLM providers, STT/TTS, Live2D + VRM rendering, memory systems, WebGPU/WASM local inference, web + desktop + mobile, and autonomous agents that play Minecraft and Factorio. **Open-LLM-VTuber** — fully offline voice conversation, visual perception, Live2D, multi-tool calling, browser control, **transparent-background desktop pet mode**. **Amica**, **Live2DPet** (VOICEVOX TTS), **AI Desk Pet** (Steam, pick your model), **PetClaw AI** (autonomous cross-app task execution — Gmail/WhatsApp/Discord/GitHub).

Standard feature set here: idle breathing, thinking indicator, TTS lip-sync, click/drag, emotion-driven expression selection, persona adapters, click-through transparency.

### Cluster F — Hardware (feature inspiration only)

**Moflin** (Casio) — emotional AI, learns from touch and sound, **4M+ personality permutations**, companion app. **Loona** — GPT conversation, face recognition, gesture tracking. **Eilik** — palm-sized, animated face, reacts to head/belly touch, mini-games. **Ropet** — facial recognition + emotion sensing reads your mood. The pattern worth stealing: **the pet's personality is an accumulated function of how you treated it**, and it is *legible* to the owner.

---

## 2. Common features — the table-stakes matrix

What a desktop pet is *expected* to have in 2026, and where Vibepaws stands.

### 2.1 Universal (present in nearly every product)

| # | Feature | Who has it | Vibepaws |
| --- | --- | --- | --- |
| 1 | Always-on-top transparent overlay | all | ✅ (plus above fullscreen Spaces — genuinely better than most) |
| 2 | Draggable, position remembered | all | ✅ |
| 3 | Click-through on empty area | most | ✅ |
| 4 | Tray/menu-bar residency + quit | all | ✅ |
| 5 | Distinct visual states | all | ✅ 7 hand-checked portraits — **best-in-class**; rivals use one sprite + badge |
| 6 | Speech bubbles | all | ✅ |
| 7 | Mute / DND | all | ✅ **best-in-class** — visible badge with countdown, 4 durations, reversible |
| 8 | **Sound cues** | Shimeji, Desktop Mate, openpets (custom tones), tama96, MiniCPM (bell), all pomodoro pets | ❌ **silent** |
| 9 | **Resize / scale** | WindowPet, vscode-pets (nano/med/large), Desktop Mate | ❌ |
| 10 | **Multi-monitor handling** | partial everywhere; the #1 recurring complaint in the genre | ⚠️ "snap back to bottom-right" is a workaround, not support |
| 11 | **Auto-start on login** | WindowPet, Tamamon, tama96 | ❌ two `npm run` commands |
| 12 | **Auto-update** | WindowPet, Tamamon (GitHub Releases) | ❌ |
| 13 | **Settings window** | all | ✅ **shipped 8/22** — pet name, token budget (global + per session), context thresholds, daily EXP cap, per-session goals, language. Scale / sound / autostart rows arrive with 0.2–0.4 |
| 14 | **Multiple simultaneous pets** | WindowPet, vscode-pets, openpets, Shimeji | ❌ one pet |
| 15 | **Click-to-interact (pet/feed/play)** | every care-sim, `/buddy pet` | ❌ click opens a flyout |
| 16 | **Custom pet import** | WindowPet, Desktop Mate (VRM), VPet (MOD Maker), petdex, Codex `/hatch` | ⚠️ requires `POE_API_KEY` + Python + manual contact-sheet inspection |
| 17 | Light/dark + i18n | WindowPet, openpets | ✅ (en / zh-CN, OS-following) |
| 18 | **Reduced motion / accessibility** | rare | ⚠️ in PRD as P0, not in the status table |
| 19 | **In-app data delete/reset** | most | ❌ `rm -rf .vibepaws/` |
| 20 | Local-first / no account | openpets, Tamamon, tama96, MiniCPM, WindowPet, clawd | ✅ **best-in-class** — two-gate privacy enforced by tests |

### 2.2 New table stakes, found only after adding clawd-on-desk

These are the gaps that a 6k-star incumbent has already closed. They are the sharpest items in this document.

| # | Feature | Who | Vibepaws |
| --- | --- | --- | --- |
| 20a | **Actionable permission bubbles** — Allow / Deny / Always Allow from the bubble, with global hotkeys, auto-dismiss if you answered in the terminal, and per-agent suppression | clawd-on-desk | ❌ **Vibepaws only tells you.** `POST /api/action` covers mute / dismiss / actioned — there is no approve or deny. This is arguably a larger functional gap than sound: it's the difference between an alert and a control surface |
| 20b | **Remote approval, not just remote notification** | clawd (Telegram, Feishu) | ❌ — and this is *ahead* of the phone-push feature proposed below |
| 20c | **Subagent-aware states** — 1 subagent vs. 2+ render differently | clawd (groove / juggling) | ⚠️ `SubagentStart` / `SubagentStop` are collected but not rendered as distinct states |
| 20d | ~~**Zombie-session reclamation**~~ ✅ — detect crashed agent processes, clean up orphan sessions | clawd (process liveness detection) | ✅ **shipped 8/25** — 60s sweep with process liveness (`orphaned`, seconds) plus a configurable silent timeout fallback (`timeout`, default 15m). Neither settles EXP; both dismiss the session's stale bubbles (**G10**) |
| 20e | **Terminal focus / real jump-to-session** | clawd | ⚠️ open as **G19**; Vibepaws copies a command to the clipboard |
| 20f | **Mobile session mirror** | clawd (LAN PWA, token-gated, read-only) | ❌ |
| 20g | **Mini / edge-dock mode** | clawd (peek-on-hover, parabolic jump transitions) | ❌ |
| 20h | **Third-party theme pack import** | clawd (Codex Pet zips), petdex, WindowPet | ⚠️ own pipeline only |

**Note on G10 and G19**: both were listed as open blockers in `references/architecture_gap_analysis.md`, and clawd has shipped solutions to both — which is how we knew they were tractable. **G10 shipped 8/25**; G19 is still open.

### 2.3 Common in the care-sim and dev-pet clusters

| # | Feature | Who | Vibepaws |
| --- | --- | --- | --- |
| 21 | XP + levels | codachi, cli-pet, GitMon, commit-cat, Tamamon | ✅ |
| 22 | Evolution stages | Tamamon, GitMon, codachi, Tamagotchi | ⚠️ rules fire, **no evolved art** |
| 23 | Species collection + rarity | `/buddy` (18×5), Tamamon (20 via gacha), cli-pet, WindowPet (45+) | ⚠️ 5 of 12 planned; registry supports 100 |
| 24 | Stat decay while away | cli-pet, bytepet, GitMon, Tamagotchi | ❌ deliberately — passive daily growth instead (correct call) |
| 25 | Death / permadeath | GitMon, tama96, Tamagotchi | ❌ deliberately (correct call) |
| 26 | Daily/weekly activity summary | commit-cat (Today timeline), Tamamon (HUD) | ⚠️ EXP breakdown only, no time series |
| 27 | Personality presets | commit-cat (4), MiniCPM (adapters), Moflin | ❌ |
| 28 | Ambient world reactions (weather, day/night) | Tamamon | ❌ |
| 29 | Habitat / decoration | Tamamon | ❌ |
| 30 | Mini-games | cli-pet, Eilik, bytepet, openpets plugins | ❌ |
| 31 | Community gallery / Workshop | VPet, DPET, petdex, Codex PetShare/PetDex, Shimeji packs | ❌ (PRD: post-MVP) |
| 32 | Plugin / mod SDK | openpets (v3, sandboxed), VPet (MOD Maker) | ❌ |
| 33 | Focus timer / pomodoro | openpets, all pomodoro pets | ❌ |
| 34 | Voice / TTS / chat | AIRI, Open-LLM-VTuber, MiniCPM, Codex Pet Mode | ❌ (STT is P1, not started) |

### 2.4 Where Vibepaws is already uniquely ahead

| Feature | Why nobody else has it |
| --- | --- |
| **Quality-gated EXP** — context health × topic consistency × correction-loop penalties, daily cap, outcome bonuses | **Zero competitors.** Every rival rewards volume. The closed `/buddy` request proposed 1 XP per output token. Tamamon: "never backward" |
| **Graduated context warnings at 70 / 85 / 95, each latching once** | Nobody has *shipped* graduated, non-nagging context thresholds. clawd surfaces context usage in a quota ring, and an open issue (#112) asks for exactly Vibepaws' behavior — "nervous at 80%, panic at 95%" — so this lead is real but time-limited |
| **Deterministic hook collection** | True against openpets and tama96, which route through **MCP tools the model must choose to call** — silently unreliable. **Not a differentiator against clawd-on-desk**, which uses the same hooks-plus-statusline design |
| ~~Cross-agent normalized schema~~ | **Retracted.** clawd-on-desk normalizes **24 agents** into one state machine with per-agent capability degradation tables. Vibepaws does 3 plus a generic bridge. This is a competitive *deficit*, not an advantage |
| **Connection health light** — amber = polling alive but event stream dead | Nobody else distinguishes "quiet afternoon" from "broken hook." This is a real insight |
| **7 distinct hand-checked portraits per pet** | Rivals ship one sprite plus a badge or an animation row |
| **Above-fullscreen rendering with the Dock-icon tradeoff documented** | Most competitors get hidden by fullscreen terminals — the exact place agent users live |
| **Two-gate privacy with test enforcement** | openpets filters speech; only Vibepaws drops fields at both adapter and schema and tests it |

---

## 3. What nobody has built — the opportunity space

Nine gaps, ordered by defensibility. These are the "other attractions."

### 3.1 A session **quality score** the user can see and share ⭐ the big one
Vibepaws already computes every input (context health multiplier, correction loops, topic consistency, outcome bonus) and throws them away into a single EXP number. Nobody in the entire landscape scores *how well you operated your agent*. Competitors structurally cannot: they only observe volume. Surfacing this as a weekly "you and your pet" retro — context discipline trend, correction-loop count, average wait-time, sessions shipped — is simultaneously the product's real value, its differentiator, and its viral loop (an exportable card is already in the PRD as an MVP item).

### 3.2 One pet **per concurrent session** — a party, not a pet ⭐
Vibepaws already aggregates N sessions and shows the most urgent state, with a carousel in the flyout. Parallel agents are now the default workflow (Agent View, auto-worktrees, subagents), and Agent View proves the pain is real — but it is Claude-only and it is a table you have to open.

**Still unclaimed after the clawd correction.** clawd tracks multi-session and has both a dashboard and a compact HUD, but it *also* collapses everything to a single pet showing the highest-priority state — the same design Vibepaws uses. Nobody renders one pet per session. A row of pets along the screen edge, each in its own state with a project label, is ambient multi-agent monitoring with per-agent identity, and it's the one thing neither a text dashboard nor a single-pet HUD can do.

### 3.3 The pet **coaches** instead of only alerting
Because Vibepaws sees quality signals, it can be prescriptive where others can only be descriptive: *"third edit to this file — start a fresh session?"*, *"85% context, 40 minutes in — compact now"*, *"this session drifted from your stated goal."* Every competitor's bubble is either decorative (`/buddy` chatter) or a bare status echo. This is also the honest path to the PRD's own <20% false-positive metric: an alert that carries a recommended action earns its interruption.

### 3.4 **Your** latency, measured
The flyout already shows how long an agent has been waiting on you. Nobody quantifies the cost of the human's own response time. *"Your agents waited 14 minutes on you today"* is a genuinely new metric, it's the fair inverse of "your agent wasted tokens," and it's the one number that makes the notification feature's value self-evident.

### 3.5 Burn rate as a **care** mechanic, not a dashboard
tama96 can kill a pet by overfeeding snacks; Tamagotchi Uni makes *care mistakes* decide the adult form. Vibepaws caps token EXP but has no negative feedback for burn. Reframing spend as pet health ("she's stuffed — you're 3× your usual burn for this hour") is more glanceable than a dollar figure, requires no price table, and is thematically native in a way `/usage` never will be.

### 3.6 Remote approval through a **channel the user chooses**
*Revised twice.* "Cross-agent phone push" was originally scored as a differentiator; it isn't — clawd already ships remote **Allow/Deny** over Telegram and Feishu plus a LAN mobile mirror. But the issue-tracker research (§4.5) found the real gap one level down: clawd's channels are **hardcoded**, and its top open request in that area is a *generic webhook sidecar* (#311), because Telegram is unreachable for a large part of its own user base (#493, #359).

So the opportunity is not "add push" — it's **"bring your own channel."** A generic webhook/ntfy approval endpoint serves the users a hardcoded integration structurally excludes, and it is cheap on top of Vibepaws' existing notification engine.

### 3.7 Evolution driven by **how** you code
Vibepaws' evolution engine fires on Lv5/Lv10 plus health conditions but has no art. Tamagotchi Uni's actual mechanic is the sharper design: *happiness sets the teen form, cumulative care mistakes set the adult form.* Branch Vibepaws' evolution on operating style — the careful refactorer and the fast prototyper diverge — and collection becomes an identity statement no volume-based competitor can imitate. It also lightens the art problem: fewer forms, each meaning something.

### 3.8 Adopt the **petdex** sprite standard
petdex has become a de-facto format (8×9 atlas, 192×208 cells, 9 named states) with a public gallery, a submission CLI, and momentum from OpenAI's `/hatch` contest. Vibepaws' own PRD names pet count as one of three ship/hold blockers. Reading petdex sprites converts a competitor's gallery into Vibepaws' content supply for roughly the cost of a mapping table. State mapping: `waiting→needs-you`, `failed→warning`, `waving→finished`, `review→needs-you`, `running/running-*→working`, `idle→idle`.

### 3.9 A **team** pet (later, and carefully)
The enterprise wedge: a shared pet fed by the team's aggregate session health, making agent hygiene a visible team norm. Nobody has it. But it needs a server, which breaks the local-first promise that is currently Vibepaws' strongest trust asset — so it must be opt-in, separately deployed, and never the default.

### 3.10 Anti-features — deliberately refuse these
The pressure to add each of these will be constant, and **every one directly contradicts the quality thesis**:

| Anti-feature | Who has it | Why it's wrong here |
| --- | --- | --- |
| Death / permadeath | GitMon (48h → dies), tama96, Tamagotchi | Creates anxiety around a tool you must use for work. PRD already rejects this — hold the line |
| Streaks | Duolingo et al. | "Streak creep" — users report fearing the loss more than wanting the reward, and coding daily isn't a virtue. Rewards showing up, not operating well |
| Gacha | Tamamon (weekly) | Rewards calendar time, not craft. Directly contradicts the thesis |
| Leaderboards / PVP / trading | PRD "Later" | Anti-cheat, IP, moderation, trust. And a leaderboard of *token volume* is the exact behavior the EXP formula exists to suppress |
| Stat decay while away | cli-pet, GitMon, bytepet | Punishes vacation. Passive daily growth is the right call — keep it |

---

## 4. What users actually ask for — evidence from the issue trackers

1,300+ issues read across eight repositories. This section is the *demand* side; §3 was the *supply* gap. Where they agree, build.

### 4.1 The incumbent's maintainer refused to build a growth loop — and users pushed back

[clawd-on-desk #202, "可以加一个养成模式么 / Could you add a cultivation mode?"](https://github.com/rullerzhou-afk/clawd-on-desk/issues/202) — **still open.** The requester asked for growth by feeding tokens, "just like the Claude pet."

The maintainer declined, and the two reasons are the most useful competitive intelligence in this document:

> 1. "The animation asset library is already heavy — adding growth stages on top isn't sustainable for a solo project."
> 2. "Clawd leans 'coding companion' — devs can just read the source to see every animation, so the 'surprise' factor of a cultivation system doesn't really hold up for this user base."

Then a user replied:

> "I think what you've mentioned is sufficient… The main thing is I'm just so fond of this little pet — **it feels a bit unsatisfying if it only reminds me whether I've finished tasks or not.**"

**Why this matters for Vibepaws, precisely:**

- **Reason 1 is Vibepaws' structural advantage.** Art throughput is exactly what clawd lacks and what Vibepaws built — a per-state image-to-image generation pipeline. Vibepaws can afford the thing the incumbent says it can't.
- **Reason 2 is a real objection that must be answered, and Vibepaws' design already answers it.** "Devs will read the source and spoil the surprise" is fatal to *collection and rarity* mechanics — you can't surprise someone with a gacha table they can read. It is **not** fatal to quality-gated growth, because the unknown variable isn't in the source code, it's **the user's own behavior**. You cannot spoil a mirror. This is a strong argument for de-emphasizing rarity and doubling down on health-driven progression.
- **clawd is shipping a lightweight version now** — cumulative counters in the About panel ("N days together / N things done together / you called me N times"), display-only, no levels, no new art, milestone easter eggs from existing poses. The maintainer said "I'll start work on this this week." So the window is narrow.

### 4.2 In the biggest dev-pet project, care and activity-fed growth are the top two requests of all time

[vscode-pets](https://github.com/tonybaloney/vscode-pets) has 483 issues. Ranked by reactions, the all-time top requests are:

| Reactions | Issue |
| --- | --- |
| **50 👍** | [#18 "Feed the cat with commits"](https://github.com/tonybaloney/vscode-pets/issues/18) — *"the cat got hungry after some time and you had to feed it with git commits, a coding tamagotchi basically… it puts some kind of pressure on the developer to not let their pet starve"* |
| **44 👍**, 28 comments | [#4 "no need for another panel"](https://github.com/tonybaloney/vscode-pets/issues/4) — users resent the pet needing its own surface |
| **40 👍** | [#3 "I want to feed it treats!"](https://github.com/tonybaloney/vscode-pets/issues/3) |
| 24 👍 | #830 add an Orc · then a long tail of species requests (raccoon, bunny, pet rock…) at 13–20 👍 each |
| 16 👍 | [#137 "We need Tamagotchi style activities"](https://github.com/tonybaloney/vscode-pets/issues/137) — feed, pet, interact |
| 15 👍 | #1 "Bigger pets!" |

Two of the top three asks are **care interaction**, and the top ask is **growth fed by real work**. In the largest project in this genre, over five years, this is what people want most — and it's unbuilt there too.

Note the shape of the long tail: species requests cluster at 13–24 reactions, care/growth at 40–50. **Content requests are numerous; growth requests are more intense.** Pet count is not the lever.

### 4.3 The one product with XP and evolution shows exactly how the growth loop fails

[codachi](https://github.com/blairjordan/codachi) has XP, levels and evolution. Its top issues are a checklist of what to get right:

| Issue | The lesson |
| --- | --- |
| #10 "XP Display" — *the single most-engaged issue* | **Invisible progress doesn't count.** Vibepaws' EXP breakdown panel is the right instinct; make it prominent, not buried in a flyout |
| #25 "Leveling up requires 100–550 thousand XP, much more than just 35 XP" | **An opaque or absurd curve destroys trust.** Vibepaws' 100 + 50(n−1) is sane — publish it in the UI |
| #26 "Togetic didn't evolve after 2000 exp" | **Silent non-events read as bugs.** If an evolution condition isn't met, say which one |
| #20 "Pets too fast in VS Code" · #4 "Buff effects" | motion tuning; users want the pet to *do* something |

This is the strongest argument for **legibility** as a first-class feature of the growth loop, not a nice-to-have.

### 4.4 The clawd tracker, categorized — 343 issues

Where a 6k-star product's users spend their complaints. Counts are title matches, so they under-count.

| Issues | Theme | Read |
| --- | --- | --- |
| **52** | Agent support requests | Endless. Confirms breadth is a treadmill, not a moat |
| **33** | Install / uninstall / update | Incl. [#360 "怎么卸载?" — how do I uninstall](https://github.com/rullerzhou-afk/clawd-on-desk/issues/360). Same as Vibepaws' **G09** |
| **33** | Auto-approve & permission UX | The dominant *feature* category. See 4.5 |
| **21** | Remote / SSH agent monitoring | Largely unserved. See 4.6 |
| **21** | Window behavior / always-on-top | Drag boundaries, Dock collisions, click-eating, edge-snapping |
| **21** | Notification behavior / DND | Bubble timing, bubbles not firing in `auto` permission mode, stale bubbles after hook timeout |
| **17** | Multi-monitor / display | High-DPI position errors, secondary displays. Genre-wide |
| **16** | Theme / skin / custom pet | Incl. requests for specific characters |
| **14** | Terminal focus / jump-to-session | Per-terminal work: Ghostty, cmux, Windows Terminal. **This is expensive** — worth knowing before committing to Vibepaws' G19 |
| **13** | Quota / token / context display | See 4.7 |
| **13** | Multi-session / dashboard | Wrong project paths, under-counted concurrent sessions, idle sessions falsely "thinking" |
| **11** | State accuracy / stuck state | *"pet still typing after the task ended"*, *"state doesn't follow Claude Code"* |
| **10** | Pet renders wrong | **#408 "the pet grows bigger by itself every so often" — 22 comments**, the single most-discussed bug |
| 8 | Show-off / social presence | See 4.8 |
| 8 | Performance | ~45% idle CPU on macOS arm64 at one point; Electron overhead is real |
| 5 | Growth / XP | See 4.1 |

### 4.5 Permission UX is the #1 feature demand, and remote approval is its center

33 issues. Not "tell me the agent needs permission" — **"let me answer from wherever I am."**

- [#493 "希望新增一个国内远程审批的"](https://github.com/rullerzhou-afk/clawd-on-desk/issues/493) — 13 comments. A China-based user asking for a *domestic* remote-approval channel, because Telegram is unreachable there
- [#359 "建议TG远程审批支持系统代理"](https://github.com/rullerzhou-afk/clawd-on-desk/issues/359) — 10 comments. Route Telegram through the system proxy
- [#311 "通用 HTTP Webhook 远程权限审批 Sidecar"](https://github.com/rullerzhou-afk/clawd-on-desk/issues/311) — **still open.** A *generic webhook* approval sidecar so users can wire their own channel
- #437 auto-approve tooling · #727 tuning auto-approve · #482 let me disable terminal auto-focus after the approval hotkey

**The read for Vibepaws:** a *generic* webhook/ntfy approval channel is more valuable than any specific integration, because it serves the users the incumbent's Telegram-only design excludes — and one of the largest user populations in this niche is Chinese-speaking, where Telegram and Discord are not options. This upgrades Tier 2.3 from "parity work" to something with a real, identifiable underserved audience.

### 4.6 Remote / SSH agent monitoring is a genuinely open problem

21 issues, spanning years, mostly closed as hard:

- [#9 "支持感知远程 SSH 服务器上的 Claude Code 状态"](https://github.com/rullerzhou-afk/clawd-on-desk/issues/9) — watch an agent running on a remote box
- [#320](https://github.com/rullerzhou-afk/clawd-on-desk/issues/320) approval *and* monitoring for remote SSH sessions · #269 install over SSH · #519 `node not found` when deploying hooks over SSH · #546 Codespaces + `gh cs ssh` breaks the deploy probe · #304 WSL2 Codex state works but no sound

Developers increasingly run agents on remote boxes, devcontainers, WSL and Codespaces, and no desktop pet handles it well. **Vibepaws is unusually well-positioned:** Core is already a localhost HTTP daemon with token auth and a generic JSONL bridge. Pointing a remote adapter at a tunnelled Core is a much smaller change for Vibepaws than for a product that grew from local process-snapshotting.

### 4.7 Context and quota display is wanted — and clawd already shipped it

- [#357 "宠物可以支持显示上下文用量吗，感觉很实用"](https://github.com/rullerzhou-afk/clawd-on-desk/issues/357) — "can the pet show context usage? feels very practical." **Shipped**: Claude via statusLine `context_window.used_percentage`, Codex via rollout JSONL `token_count` + `model_context_window` — the same channels Vibepaws uses
- [#112](https://github.com/rullerzhou-afk/clawd-on-desk/issues/112) asks for a 5h/7d rate-limit gauge with **"nervous animation at 80%+, panic at 95%+"** — i.e. Vibepaws' graduated warnings, requested but not yet built there
- #631 context showed a 200K cap for Sonnet 5 sessions that should be 1M · #797 custom models report the wrong context length

**Two lessons.** Vibepaws' *display* lead is gone; its *graduated-warning-plus-advice* lead is real but time-limited. And model-to-context-window mapping is a maintenance tax that bites everyone — hardcoding caps will generate bug reports.

### 4.8 Users want to broadcast their agent status

[#215 Discord Rich Presence](https://github.com/rullerzhou-afk/clawd-on-desk/issues/215) — a thoughtful, privacy-first request that **shipped in v0.12.0, opt-in, off by default**, showing only coarse states (`Codex is thinking / working / waiting / idle`) with no project names or paths. The requester explicitly argued *against* exposing project names by default.

There is real appetite for the pet as a **status broadcast**, and the community's own instinct is privacy-conservative — which fits Vibepaws' positioning exactly. Note the maintainer gated it behind fixing subagent-completion mis-detection first: a broadcast amplifies every state bug you have.

### 4.9 A paying user wrote your roadmap for you

[#41867](https://github.com/anthropics/claude-code/issues/41867) is a full community spec from a **$200/month Max subscriber who doesn't write code** — an economist who builds everything through Claude Code. That persona matters: the least technical users are the most attached to the pet. Their proposal, with the parts Vibepaws should steal:

| Proposal | Verdict |
| --- | --- |
| **Progression from personal milestones — "relative to YOUR history, not others. A beginner and a senior both progress at their own pace. No absolute skill gates."** | **Adopt as a design principle.** It's also the sharpest argument against leaderboards yet |
| **Action diversity** as a progression axis — code + tests + deploy + docs, not raw volume | **Adopt.** A new EXP axis that fits the quality thesis perfectly and is partly measurable from tool-call events today |
| **Branching evolution**: Lv5 → choose 1 of 2 specializations, Lv10 → second branch, 4 final forms, **choice is permanent** | **Adopt** — and note it lands on Lv5/Lv10, the exact thresholds Vibepaws' evolution engine already uses. Add explicit *user choice* at the branch point rather than only inferring style |
| **Buddy Journal** — auto-generated `.buddy/journal.md` after each session: files touched, tests 🔴→🟢, streak. "Over months this becomes a genuinely useful personal development diary" | **Adopt.** This is what Vibepaws' dead `memories` table (**G21**, "zero design") should be. A plain-text file is dev-native, greppable, diffable and shareable — better than any UI |
| **Contextual familiarity** — familiarity on known code, curiosity on new files. "Creates the feeling that buddy lives in your project, not just your terminal" | **Adopt cheaply** as part of per-project identity |
| **Stats are flavor only** — "the core tool must always work at 100% regardless of buddy configuration" | Already true of Vibepaws. Keep it |
| **Monetization**: everything earnable free, cosmetics optionally purchasable, **no loot boxes, no pay-to-win**, no separate store | Validated willingness to pay from the highest-value segment. Consistent with the PRD's $19 founder license |
| Naming and renaming the pet | **Highest emotional ROI per engineering hour in this entire document.** See 4.10 — **shipped 8/22** |

### 4.10 Naming is the attachment mechanism, and it is nearly free

Read the #45596 comments and the pattern is unmissable: **every single mourning post uses a name.** Prickle the cactus. Quibble the turtle. Glint the owl. Urchin. Picksnark the tsundere cat. A capybara.

Nobody wrote "I miss my Common-tier turtle." They wrote "RIP Prickle."

Vibepaws' pets have fixed designer names — Embercub, Lunafang, Sporewick. Letting a user **name their own pet** is perhaps a day of work, and it is the mechanism by which all that attachment formed. Requested repeatedly upstream (#45336 customization, #41908 renaming, #41921 a whole buddy-customizer plugin).

> **Shipped 8/22** in the settings window. The estimate was generous: `pets.name` was already in the schema with nothing writing to it, so this was a text field and one `UPDATE`.

### 4.11 Two trust traps to design around

- [clawd #102 "为什么我的Claude说这个插件消耗了我很多token"](https://github.com/rullerzhou-afk/clawd-on-desk/issues/102) — "why does my Claude say this plugin uses a lot of my tokens?" The agent **hallucinated** that the pet was consuming tokens, and the user believed it. The maintainer had to explain that hooks are pure-local, write nothing to stdout, and never touch the API. **Any hook-based pet will hit this.** Vibepaws should preempt it: one line in the README and one in the app — *"the pet never sends anything to the model; it cannot consume tokens"* — plus a visible byte/latency counter for the hook path. **Done (0.12, 8/25)** — and the counter turned out to matter for a second reason: it puts the ~78 ms of Node startup per hook call on screen, which is the one real cost this design does have.
- **Anti-virus and Gatekeeper.** Desktop pets get flagged constantly; clawd [#872](https://github.com/rullerzhou-afk/clawd-on-desk/issues/872) is about macOS requiring a Privacy & Security click on *every* update, and openpets went as far as **SignPath-signed builds**. Vibepaws already documents the unsigned-build problem in its README — this confirms signing is not optional if it ships beyond friends.

### 4.12 Bugs every competitor hits — free QA for Vibepaws

Steal this as a test checklist. Each one is a shipped-product bug in a rival:

| Bug | Where |
| --- | --- |
| Pet silently grows larger over time | clawd #408 (22 comments), #569 |
| App icon flashes in the taskbar intermittently | clawd #596 (14 comments) |
| Transparency broken on Windows | clawd #699 (11 comments) |
| High-DPI displays break click hit-testing | clawd #44, WindowPet #19 |
| Pet can't be dragged to the screen bottom when the Dock is visible | clawd #241 |
| Pet covers and **eats clicks over** a text-input bubble | clawd #640 |
| Permission bubble doesn't appear when permission mode is `auto` | clawd #163 — *directly relevant: Vibepaws' own gap analysis flags this as **G13*** |
| Stale bubble persists after the hook times out | clawd #273 |
| Subagent completion mistaken for main-task completion | clawd #214 |
| Subagent tier fails to escalate from 1 to 2+ | clawd #862 |
| Only renders on the primary display | WindowPet #17 |
| Hidden windows reappear in the taskbar after `explorer.exe` restarts | clawd #184 |
| Pet freezes because `setIgnoreMouseEvents` isn't reset on page reload | openpets #20 — *Vibepaws uses the same click-through mechanism* |
| Renderer crashes on startup unless the sandbox is disabled | clawd #530 |
| Local-model download and load failures dominate the tracker | MiniCPM #6 (21 comments), #11 (14) — **do not bundle a local LLM** |

---

## 5. The feature list

**39 features in 5 tiers.** Effort is engineering-days for one developer. **Diff** = differentiation against the competitive set (★ = commodity, ★★★★★ = nobody has it).

| Tier | Intent | Effort | When |
| --- | --- | --- | --- |
| **0** | Close the credibility gaps | ~29d | Now, in order |
| **1** | The moat — make quality the product | ~32d + art | Immediately after |
| **2** | The multi-agent surface | ~22d | Then |
| **3** | Charm and retention | ~15d | Opportunistically, interleaved |
| **4** | Ecosystem | 45d+ | Only after retention is proven |

### Tier 0 — Close the credibility gaps (do these first regardless)

These are things a user will judge the product on within 60 seconds, and several are unmet PRD release criteria.

| # | Feature | Detail | Effort | Diff |
| --- | --- | --- | --- | --- |
| 0.1 | ~~**Settings window**~~ ✅ | **Shipped 8/22**, as a separate window — the pet window is 300px wide and click-through, which is no place for a form. Pet name · token budget global + per session · context thresholds (or off) · daily EXP cap · per-session goal · locale override. Both hand-edit-SQLite Activation metrics are now reachable from the UI, and the `topic` multiplier / drift baseline finally has an entry point (**G17**). Scale / sound / autostart get rows here when 0.2–0.4 ship — until those features exist there is nothing to configure | ~~3d~~ **done** | ★ |
| 0.2 | **Sound cues** | 3–4 short, distinct, quiet tones — needs-you / warning / finished / level-up. Volume slider, per-type toggle, respects mute. **The core value prop is "you're in another window" — a silent pet cannot deliver it.** MiniCPM ships a bell for exactly this | 2d | ★★ |
| 0.3 | **Pet scale + multi-monitor** | 3 sizes; remember position per display; follow the active display or pin to one. The #1 recurring complaint in the whole genre, and a named Tamamon request | 3d | ★ |
| 0.4 | **Autostart + single-command launch** | One tray app that owns Core; login item. Two `npm run` commands is a dev workflow, not a product | 2d | ★ |
| 0.5 | ~~**In-app reset / delete**~~ ✅ | **Shipped 8/22.** Settings → Reset & uninstall: start over with a new pet · delete all local data (in-place wipe + `VACUUM`, because a plain `DELETE` leaves the text in the file) · remove adapter hooks. Two-step confirm on each. Hook removal is entry-by-entry across both scopes and all three agents, restores a wrapped `statusLine` from our backup, and reports what it deliberately left alone (**G09**). `npm run adapter:uninstall` covers the case where the app is already gone — which is the normal case for an uninstall | ~~1d~~ **done** | ★ |
| 0.6 | **Reduced-motion + accessibility pass** | PRD P0, unverified. Honor OS reduce-motion; ensure state is legible without animation or color alone | 1d | ★★ |
| 0.7 | **Petdex sprite import** | Read the 8×9 / 192×208 atlas; ship the state mapping table; `vibepaws install <slug>`. Solves the 5-of-12 pet blocker by importing an existing gallery | 3d | ★★★ |
| 0.8 | **Evolved-form art for one family** | The rule engine already fires with nothing to switch to — the third named ship/hold blocker | 2d art | ★★ |
| **0.9** | **Actionable permission bubbles** ⚠️ **added after the clawd correction** | Allow / Deny / Always Allow in the bubble; global hotkeys; auto-dismiss if answered in the terminal; per-agent suppression; a confirmation-gated mode for destructive tools. **This may be the most important item in Tier 0.** Vibepaws' whole premise is that you're in another window — and right now it makes you go *back* to that window to do the one thing it woke you up for | 5d | ★ |
| 0.10 | ~~**Zombie-session reclamation**~~ ✅ | **Shipped 8/25.** Core sweeps every 60s (and once at startup, because the sessions left `is_active` by the previous run are the most likely zombies of all). Two paths: adapters report the agent's pid and `kill(pid,0)` catches a crash within one sweep (`outcome=orphaned`); anything without a usable pid falls back to a configurable silent timeout (`outcome=timeout`, default 15m, Settings → Idle sessions). Neither settles EXP — a crash is not a win — and both clear the session's `needs-you` marker and dismiss its stale bubbles. A pid is only trusted after the *same* pid arrives on two events, which is what separates a real agent process from a one-shot wrapper shell; without that guard the feature would kill live sessions (**G10**) | ~~2d~~ **done** | ★ |
| **0.11** | **Subagent-aware states** | `SubagentStart`/`SubagentStop` are already collected — render 1 vs. 2+ distinctly. Subagents are now routine, and "working" hides them. Watch clawd #214 and #862: mistaking subagent completion for task completion, and failing to escalate 1 → 2+ | 2d | ★★ |
| **0.12** | ~~**"It can't eat your tokens" trust copy**~~ ✅ | **Shipped 8/25.** The README got a section rather than a line, because the answer to a hallucinated claim has to be a mechanism: a hook reaches the model through exactly one channel — stdout, which Claude Code injects as context for `UserPromptSubmit` — and ours writes none and always exits 0, both now pinned by tests, since a `console.log` left in after debugging would quietly start costing real money and look harmless in review. In the app: a **Tokens & overhead** card in Settings plus a one-liner under the EXP breakdown, fed by `GET /api/hookstats` — events, bytes, Core p50/p95, and the hook process's self-reported wall time, with `model_calls: 0` and `outbound_bytes: 0` in the JSON so `curl` can check the window rather than the other way round. What the counter exposed is worth the whole item: ~310 bytes and ~0.4 ms per event, but **~78 ms of Node startup per hook call** — the real price of a hook-based design, now on screen instead of in a footnote | ~~0.5d~~ **done** | ★★ |
| **0.13** | **Code signing + notarization** | Already documented as a known problem in the README. openpets went to SignPath; clawd users complain about clicking through Privacy & Security on every update. Non-negotiable before any distribution beyond friends | 2d | ★ |

**Tier 0 total: ~22 days left** (28.5, minus 0.1 and 0.5 shipped 8/22, and 0.10 and 0.12 shipped 8/25). Nothing here is differentiating; all of it is disqualifying if absent — and 0.9 is the item a user will notice within one session.

### Tier 1 — The moat: make quality the product

| # | Feature | Detail | Effort | Diff |
| --- | --- | --- | --- | --- |
| 1.1 | **Session Health Score** | Collapse the multipliers already computed into one visible 0–100 per session, with its contributing factors. Show it live in the flyout, not just post-hoc in the EXP breakdown | 4d | ★★★★★ |
| 1.2 | **Weekly retro card** | Exportable image: health trend, context discipline, correction loops avoided, sessions shipped, your average response latency, pet's growth. The PRD already wants an exportable card — make it about *craft*, and it becomes the acquisition channel | 5d | ★★★★★ |
| 1.3 | **Coaching bubbles** | Attach a recommended action to every warning: compact now / new session / you've edited this file N times. Each carries a "not useful" button that tunes the threshold — which is also how you measure the <20% false-positive target instead of asserting it | 5d | ★★★★★ |
| 1.4 | **Response-latency tracking** | Time from `needs-you` to resolution. Daily rollup: "your agents waited 14 min on you." Per-session in the flyout | 2d | ★★★★★ |
| 1.5 | **Burn rate as pet state** | Tokens/hour vs. your rolling baseline, expressed as pet fullness/discomfort. A "stuffed" state between `working` and `tired` | 3d | ★★★★ |
| 1.6 | **Branched evolution with an explicit choice** | Lv5 → pick 1 of 2 specializations, Lv10 → second branch, permanent. Branches keyed on operating style (context discipline vs. throughput vs. shipping cadence) but **the user chooses at the fork** — the community spec (#41867) asked for exactly this, at exactly Vibepaws' existing Lv5/Lv10 thresholds | 4d + art | ★★★★★ |
| **1.7** | ~~**Name your pet**~~ ⭐ ✅ | **Shipped 8/22** with the settings window (0.1). Worth noting what was found on the way in: `pets.name` existed in the schema but had **no writer anywhere in the codebase** — the column was structurally permanent-NULL, so the feature was closer to zero than the estimate assumed. Naming and renaming both work; the nameplate updates live; empty falls back to the species name. The argument stands as written: every mourning post in the 266-comment thread uses a name — Prickle, Quibble, Glint, Picksnark. Nobody mourned "my Common-tier turtle" | ~~1d~~ **done** | ★★★★ |
| **1.8** | **Session journal** — `.vibepaws/journal.md` | Append a short entry per session: files touched, tests red→green, health score, what stalled, where EXP came from. Plain text, greppable, diffable, shareable. **This is what the dead `memories` table (G21) should be**, and it's a direct lift from the community spec's "buddy journal" — *"over months this becomes a genuinely useful personal development diary"* | 3d | ★★★★★ |
| **1.9** | **Growth legibility pass** | codachi's top three issues are "I can't see my XP," "the curve is absurd," and "evolution didn't fire and nobody told me." Publish the curve in the UI; when an evolution condition isn't met, **say which one**; never let a milestone pass silently | 2d | ★★★★ |
| **1.10** | **Action-diversity EXP axis** | Reward breadth — code + tests + docs + commit — not just volume, measurable from tool-call events today. And score progress **relative to the user's own history, never an absolute gate**: "a beginner and a senior both progress at their own pace" (#41867) | 3d | ★★★★★ |

**Tier 1 total: ~31 days + art** (32, minus 1.7, shipped 8/22). This is the roadmap's center of gravity. Every item is unavailable to every competitor because they don't collect the inputs — and 1.7 through 1.10 were all specified by users in public, for free.

### Tier 2 — The multi-agent surface

| # | Feature | Detail | Effort | Diff |
| --- | --- | --- | --- | --- |
| 2.1 | **Pet party — one pet per session** | Up to N pets along a screen edge, each with its own state and project label. Click one → its session. Collapse to a single aggregate pet when N is large. The engine exists; this is a rendering and layout problem | 6d | ★★★★★ |
| 2.2 | **Per-project pet identity + contextual familiarity** | A stable pet per repo, so you recognize which project is shouting. Add the community spec's "familiarity" touch — settled on a long-known project, curious on a fresh clone. *"Creates the feeling that it lives in your project, not just your terminal."* Registry already supports 100 IDs | 3d | ★★★★ |
| 2.3 | **Generic webhook remote approval** ⬆️ **re-upgraded** | Not "a Telegram bot" — a **generic webhook / ntfy channel** so users wire their own. clawd's Telegram-and-Feishu design leaves out everyone behind a proxy, and its #1 open request in this area is exactly a generic sidecar (#311, #493, #359). A large share of this niche's users are Chinese-speaking, where Telegram and Discord aren't options. Pair with 0.9 so the remote action is **approve**, not "go look" | 4d | ★★★★ |
| **2.6** | **Remote / SSH / devcontainer agents** | 21 issues in clawd's tracker, spanning years, mostly closed as too hard. **Vibepaws is unusually well-positioned**: Core is already a localhost HTTP daemon with token auth plus a generic JSONL bridge, so pointing a remote adapter at a tunnelled Core is a far smaller change than for a product built on local process-snapshotting. Agents on remote boxes, WSL and Codespaces are increasingly normal and nobody serves them | 6d | ★★★★★ |
| 2.4 | **Jump-back that works** | Copy-command exists; make it real terminal focus. **Downgraded** — clawd ships this. Gap **G19** | 3d | ★ |
| 2.5 | **Session timeline** | commit-cat's "Today" view for agent sessions: what ran, what stalled, where EXP came from, when *you* were the bottleneck. **Downgraded on the surface** (clawd has a dashboard + HUD) but the *quality* content is still unique — nobody else can populate the "you were the bottleneck" column | 4d | ★★★ |

### Tier 3 — Charm and retention (cheap delight, do opportunistically)

| # | Feature | Detail | Effort | Diff |
| --- | --- | --- | --- | --- |
| 3.1 | **Pet the pet** | Click the body (not the flyout) → heart particles, tiny affection counter. `/buddy` has it; it costs a day and it's the difference between a widget and a companion | 1d | ★★ |
| 3.2 | **Ambient reactions** | Day/night tint, idle micro-behaviors, occasional stretch. Tamamon's weather trick, minus the API dependency | 2d | ★★★ |
| 3.3 | **Personality presets** | 3–4 voices for bubble copy (Calm / Dry / Enthusiastic / Blunt). commit-cat proves this is disproportionately loved for the effort | 2d | ★★★ |
| 3.4 | **Window-edge perching** | The pet sits on the top edge of your *terminal window*, not just a screen edge. Shimeji's most-loved behavior, and here it's meaningful — the pet perches on the thing it's watching. clawd has screen-edge mini-mode with peek-on-hover, which is the cheap version; true window-tracking is still unclaimed | 5d | ★★★ |
| 3.5 | **Milestone celebrations + personal records** | First ship of the day, longest clean-context session, personal bests ("your longest streak of sessions under 70% context"). Tied to outcomes, never to volume. clawd is shipping its lightweight "N days together" counter version *now*, so this window is closing | 2d | ★★★ |
| **3.6** | **Opt-in status broadcast** | Discord Rich Presence with coarse states only (`working / waiting / idle`), off by default, no project names or paths. Shipped in clawd v0.12.0 after a privacy-first community request — the appetite is proven and the community's own instinct was conservative, which suits Vibepaws. **Gate it behind 0.11**: a broadcast amplifies every state bug you have | 3d | ★★ |

### Tier 4 — Ecosystem (only after retention is proven)

| # | Feature | Detail | Effort | Diff |
| --- | --- | --- | --- | --- |
| 4.1 | **In-app pet hatching** | Drop an image → generate 7 states → review contact sheet in-app → install. The manual Python/Poe pipeline is a contributor tool; Codex `/hatch` set the user expectation | 6d | ★★★ |
| 4.2 | **Community gallery** | Moderated submissions, petdex-compatible format. PRD post-MVP | 10d+ | ★★ |
| 4.3 | **Plugin SDK** | openpets v3 is the benchmark (sandboxed, permissioned, `ctx.*`, test harness). **Only worth building if Vibepaws wins on the core loop first** — openpets is ahead here and it is not where the differentiation lives | 15d+ | ★★ |
| 4.4 | **Team pet** | Opt-in shared instance; aggregate team session health. The paid wedge. Must not compromise the local-first default | 15d+ | ★★★★★ |

---

## 6. Recommendation

**Reposition from notification to craft — and go get the orphaned audience.**

Two facts define the opportunity, and both came from the issue trackers rather than the product pages:

1. **On Claude Code there is no first-party pet, and there are 1,170 👍 and 266 comments of people who want one back.** Some pinned old versions to keep theirs. Some built clones. That is a warm, identifiable, emotionally invested audience with nowhere to go — and Vibepaws' primary platform is exactly where they were stranded.
2. **The incumbent has publicly refused to build the growth loop**, on the record, for two stated reasons — art cost (which Vibepaws' generation pipeline solves) and "devs will read the source and spoil the surprise" (which applies to rarity and gacha, *not* to a mechanic whose hidden variable is the user's own behavior — you cannot spoil a mirror).

"The pet that tells you when your agent needs you" is a first-party checkbox on Codex and a Remote Control setting on Claude. "The only pet that grows when you use your agent *well*" is a claim no competitor can make without rebuilding their data pipeline — and it's what Vibepaws already built.

And **do not fight clawd-on-desk on breadth.** Twenty-four agents against three, with two years of execution and 6k stars behind it, is an unwinnable race — and it's the wrong race, because the incumbent has publicly declined to build the one thing Vibepaws is already good at. Add agents only when a user asks for one; spend the saved time on depth.

Concretely:

1. **Ship Tier 0** (~23d left — 0.1 shipped 8/22). Not optional. A silent, un-resizable, two-terminal-command pet with no approve button loses on polish before anyone evaluates the growth loop. **Start with 0.9 (actionable permission bubbles)** — a notification you have to leave the app to act on is a half-built feature, and it's the clearest thing clawd has that Vibepaws doesn't.
2. **Then Tier 1, in order, starting with 1.1 and 1.3.** The Session Health Score and coaching bubbles are the product. Everything else is a delivery mechanism for them.
3. ~~**Do 1.7 (name your pet) this week.**~~ **Done 8/22**, shipped with the settings window. It was the mechanism every one of those 266 comments ran on, and it cost a text field — there was no better ratio in this document.
4. **Tier 2.1 (pet party) and 2.6 (remote/SSH) are the highest-value features after Tier 1.** The first is the one thing a text dashboard structurally cannot do; the second is a years-old unsolved pain where Vibepaws' daemon architecture is an accident of good fortune.
5. **Import petdex sprites (0.7) rather than drawing 7 more pets.** Content is a supply problem with an existing supplier — and the trackers settle the priority: species requests cluster at 13–24 reactions, care and growth requests at 40–50. Art hours belong on evolved forms, which are load-bearing for the growth loop.
6. **Keep refusing death, streaks, gacha, decay, and leaderboards** — and say so publicly. The refusal *is* the positioning, and the community's own best spec argues the same: progression should be *"relative to YOUR history, not others… no absolute skill gates."*
7. **Move before clawd's lightweight counter ships.** Its maintainer said "I'll start work on this this week" about the "N days together / N things done together" milestone counters. Once that exists in a 6k-star app, part of the emotional-attachment surface is claimed and Vibepaws has to win on depth alone.

**The one metric that matters**: not D7 retention or pet count, but whether users' *context discipline improves* after a week with the pet. If it does, this is a coaching tool with a mascot and a durable reason to exist. If it doesn't, it's a mascot — and the trackers show exactly how much people love mascots, and exactly how fast a vendor can take one away.

---

## Sources

### Issue trackers read for §4 (1,300+ issues)

| Repo | Issues read | Open |
| --- | --- | --- |
| [rullerzhou-afk/clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk/issues) | 343 | 66 |
| [tonybaloney/vscode-pets](https://github.com/tonybaloney/vscode-pets/issues) | 483 | 34 |
| [crafter-station/petdex](https://github.com/crafter-station/petdex/issues) | 310 | 11 |
| [alvinunreal/openpets](https://github.com/alvinunreal/openpets/issues) | 65 | 12 |
| [OpenBMB/MiniCPM-Desk-Pet](https://github.com/OpenBMB/MiniCPM-Desk-Pet/issues) | 18 | 11 |
| [SeakMengs/WindowPet](https://github.com/SeakMengs/WindowPet/issues) | 18 | 16 |
| [blairjordan/codachi](https://github.com/blairjordan/codachi/issues) | 16 | 7 |
| [anthropics/claude-code](https://github.com/anthropics/claude-code/issues) | buddy & notification queries | — |

Most-cited individual threads: [clawd #202 cultivation mode](https://github.com/rullerzhou-afk/clawd-on-desk/issues/202) · [clawd #102 token-trust](https://github.com/rullerzhou-afk/clawd-on-desk/issues/102) · [clawd #215 Discord RP](https://github.com/rullerzhou-afk/clawd-on-desk/issues/215) · [clawd #311 webhook approval](https://github.com/rullerzhou-afk/clawd-on-desk/issues/311) · [clawd #357 context usage](https://github.com/rullerzhou-afk/clawd-on-desk/issues/357) · [clawd #408 pet grows by itself](https://github.com/rullerzhou-afk/clawd-on-desk/issues/408) · [vscode-pets #18 feed with commits](https://github.com/tonybaloney/vscode-pets/issues/18) · [vscode-pets #3 treats](https://github.com/tonybaloney/vscode-pets/issues/3) · [vscode-pets #137 Tamagotchi activities](https://github.com/tonybaloney/vscode-pets/issues/137) · [codachi #25 broken XP curve](https://github.com/blairjordan/codachi/issues/25) · [claude-code #45596 bring back buddy](https://github.com/anthropics/claude-code/issues/45596) · [claude-code #41867 progression & monetization spec](https://github.com/anthropics/claude-code/issues/41867)

### Primary — first-party
- [Claude Code: Week 16, April 13–17 2026](https://code.claude.com/docs/en/whats-new/2026-w16) — push notifications, `/usage`, Routines
- [anthropics/claude-code issue #41684 — RPG evolution for /buddy](https://github.com/anthropics/claude-code/issues/41684) (closed)
- [openai/skills — hatch-pet SKILL.md](https://github.com/openai/skills/blob/main/skills/.curated/hatch-pet/SKILL.md)

### Primary — competitor repos and stores
- [rullerzhou-afk/clawd-on-desk](https://github.com/rullerzhou-afk/clawd-on-desk) · [releases](https://github.com/rullerzhou-afk/clawd-on-desk/releases) · [issue #112 — Pro/Max rate limit gauge](https://github.com/rullerzhou-afk/clawd-on-desk/issues/112) · [setup guide](https://github.com/rullerzhou-afk/clawd-on-desk/blob/main/docs/guides/setup-guide.md)
- [alvinunreal/openpets](https://github.com/alvinunreal/openpets) · [docs.openpets.dev](https://docs.openpets.dev/)
- [crafter-station/petdex](https://github.com/crafter-station/petdex)
- [OpenBMB/MiniCPM-Desk-Pet](https://github.com/OpenBMB/MiniCPM-Desk-Pet)
- [SeakMengs/WindowPet](https://github.com/SeakMengs/WindowPet)
- [LorisYounger/VPet](https://github.com/LorisYounger/VPet) · [VPet on Steam](https://store.steampowered.com/app/1920960/VPet/) · [VPet MOD Maker](https://store.steampowered.com/app/2639250/VPet__MOD/)
- [tonybaloney/vscode-pets](https://github.com/tonybaloney/vscode-pets)
- [blairjordan/codachi](https://github.com/blairjordan/codachi) · [eunseo9311/commit-cat](https://github.com/eunseo9311/commit-cat) · [muhtalhakhan/bytepet-cli](https://github.com/muhtalhakhan/bytepet-cli)
- [TeXmeijin/claude-code-mascot-statusline](https://github.com/TeXmeijin/claude-code-mascot-statusline) · [asimons81/hermes-pets](https://github.com/asimons81/hermes-pets)
- [Tamamon](https://www.tamamons.com/) · [Tamamon on Product Hunt](https://www.producthunt.com/products/tamamon-a-tiny-desktop-pet-that-grows)
- [tama96 on Product Hunt](https://www.producthunt.com/products/tama96-desktop-terminal-ai-pet)
- [GitMon](https://gitmon.io/) · [cli-pet write-up](https://dev.to/depapp/i-built-a-tamagotchi-that-judges-your-github-activity-and-its-brutally-honest-oh1)
- [Desktop Mate on Steam](https://steamcommunity.com/app/3301060/) · [MateEngine on Steam](https://store.steampowered.com/app/3625270/MateEngine/) · [DPET Workshop](https://steamcommunity.com/workshop/about/?appid=1980920)
- [Project AIRI](https://github.com/moeru-ai/airi) · [Open-LLM-VTuber](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber) · [awesome-ai-vtubers](https://github.com/proj-airi/awesome-ai-vtubers)

### Secondary — reporting and analysis
- [OpenAI Codex adds desktop pets that show AI status — BigGo](https://finance.biggo.com/news/202605040025_OpenAI_Codex_desktop_pets)
- [Claude Code Agent View: the CLI dashboard that unifies all sessions](https://pasqualepillitteri.it/en/news/2384/claude-code-agent-view-cli-dashboard-sessions-2026) · [Agent View guide](https://www.buildfastwithai.com/blogs/claude-code-agent-view-guide)
- [Claude Buddy: complete guide to 18 species and 5 rarities](https://dev.to/damon_bb9e4bba1285afe2fcd/claude-buddy-the-complete-guide-to-your-ai-terminal-pet-all-18-species-rarities-hidden-22da)
- [Codex pets complete guide — explainx.ai](https://explainx.ai/blog/codex-pets-complete-guide-how-to-use-top-custom-pets-2026)
- [Tamagotchi Uni — TamaVault](https://tamavault.com/devices/uni/) · [Tamagotchi Uni evolution chart](https://tamavault.com/devices/uni/evolution-chart/)
- [Streak Creep: the perils of too much gamification — The Decision Lab](https://thedecisionlab.com/insights/consumer-insights/streak-creep-the-perils-of-too-much-gamification)
- [Principles of Calm Technology](https://principles.design/examples/principles-of-calm-technology) · [What is Calm Computing — IxDF](https://ixdf.org/literature/topics/calm-computing)
- [AI coding agent adoption 2026 — JetBrains Research](https://blog.jetbrains.com/research/2026/08/ai-coding-agent-adoption-2026/)
- [Shimeji Browser Extension](https://shimejis.xyz/) · [IndieBar](https://indiebar.app/) (menu-bar pricing reference, $19.99 one-time)
