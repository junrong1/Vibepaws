# Vibepaws MVP — Product Requirements Document

> **Positioning** — A cute coding pet that watches your AI agents, pings you when they need you, and grows from healthy vibe-coding sessions.

| Field | Value |
| --- | --- |
| Doc version | v0.2 (scope frozen, implementation in progress) |
| Product version | MVP alpha 0.1 |
| Release window | 2026-08-18 → 2026-09-01 (two weeks) |
| Working title | AI Coding Pet |
| Technical architecture | [`docs/mvp_architecture.md`](./mvp_architecture.md) (Chinese) |
| Chinese version | [`docs/prd_mvp_zh.md`](./prd_mvp_zh.md) |
| User docs | [`README.md`](../README.md) |

**Scope of this document**: the PRD covers **what we build, why, and what counts as done**. How to install and run it lives in the README. Section 15 tracks the implementation status of each requirement as of 2026-08-21 — the PRD is the target, that section is reality, and they are deliberately kept apart.

---

## 1. Product overview

Vibepaws is a local-first, always-on-top desktop pet. It reads events emitted by your coding agents (Claude Code, Codex, pi-coding-agent, plus anything else via a generic bridge) and turns agent state into something you can read at a glance.

The MVP is deliberately built as **"an agent-attention pet with a growth system,"** not a pet marketplace. Desktop pets, coding pets, and state-reactive mascots already exist — the differentiator is not "there is a cute pet." The real wedge is that the pet catches the moments that matter inside an AI agent session, rewards healthy agent usage, and gradually becomes a long-term record of what you shipped.

## 2. Problem

Coding-agent users run long sessions while switching windows, waiting on tool approvals, watching token/context usage, and guessing when to start a fresh session. The results:

- **Missed decisions** — the agent stalls on a tool call awaiting approval; the user is in another window and finds out minutes later
- **Wasted context window** — the user only notices context is full once the agent starts forgetting earlier constraints
- **Topic drift** — a session slides from "fix this bug" into three unrelated things, with nobody calling time
- **Dead waiting time** — the agent finished; the user doesn't know

Vibepaws makes these states visible: it pings you when the agent needs you, warns you before context turns unhealthy, and grows from your AI coding activity.

## 3. Target users

**Primary**

- Vibe coders who use AI coding agents daily
- Solo builders / indie hackers running 1–4 agent sessions at once
- People willing to install a local desktop tool
- People who enjoy playful feedback but still need real workflow value

**Secondary**

- Coding-agent power users juggling many sessions
- Streamers and build-in-public creators who want to show progress

**Not served by the MVP**

- Enterprise teams
- Users who only hand-write code and don't use coding agents
- Users who want a full AI chat companion
- Users mainly looking for a complete game economy

## 4. MVP goals and validation questions

Ship a usable alpha in two weeks that answers four questions:

1. Will users keep the pet running while they vibe code?
2. Do users notice and act on agent decision notifications faster?
3. Is the level-up loop fun **without** encouraging token waste?
4. Can the product support multiple coding agents through one unified event bridge?

## 5. Positioning

**Recommended**

> "A cute coding pet that watches your AI agents, pings you when they need you, and grows from healthy vibe-coding sessions."

**Avoid**

| Framing | Why not |
| --- | --- |
| "AI companion" | Implies chat and emotional dependence — not what the product does |
| "Pokémon for coding" | IP risk, and sets game expectations we don't intend to meet |
| "Token-burning game" | Rewards exactly the behavior we're trying to cap |

## 6. Research-driven scope decisions

| Feature | MVP decision | Rationale |
| --- | --- | --- |
| Common coding-pet behaviors | P0 | Table stakes for a desktop pet. The pet must feel alive. |
| Decision notification bubbles | P0 | Highest core workflow value. |
| Usage / token notifications | P0 | Powers the token-feeding loop and helps users control cost. |
| Context-window-too-large warning | P0 | Strongly differentiating for agent users. |
| Topic drift / suggest new session | P0 alpha | Valuable, but v1 should use conservative heuristics. |
| 100 cute pixel pets | P0 architecture, P1 content | 100 high-quality pets in two weeks isn't realistic. Support 100 IDs; ship a small, finished set. |
| Random pet assignment | P0 | Cheap to build, high delight. |
| Level and EXP bar | P0 | Core retention loop. |
| Token cost feeds the pet | P0, but must be capped | Great theme, but must not reward wasting tokens. |
| Hidden quality EXP mechanic | P0 | The key to making the growth loop healthy. |
| Pet death | Not in MVP | Creates anxiety. Replaced by tired / hibernation states. |
| Passive self-growth | P0 lightweight | Reduces anxiety, provides passive delight. |
| Evolution | P0 limited | Ship one complete evolution family; support more architecturally. |
| STT voice commands | P1 alpha | Useful, but integration and safety risk exceed the notification core loop. |
| Claude Code + Codex support | P0 | The first two agent adapters. |
| pi-coding-agent support | P0 (pulled up from P1) | pi's stable integration path is an extension plugin — same tier as hooks, shippable now. |
| DeepSeek Harness support | P1 / generic bridge | Route through the generic bridge unless stable hooks exist. |
| Community-contributed pets | P1.5 | Important, but needs moderation, copyright, and asset-quality rules. |
| Leaderboard / PVP / rare pet sales | Later | Large scope, plus economy, trust, anti-cheat, and moderation problems. |

## 7. MVP functional requirements

### 7.1 Desktop pet surface — P0

> As a vibe coder, I want to see a cute pet while my AI agent works, so coding feels less cold and I can read state at a glance.

**Requirements**

- Always-on-top desktop pet window with a pixel-style visual language
- Draggable position, click-through mode, Do Not Disturb mode, reduced-motion mode
- Seven states: `idle`, `working`, `needs-you`, `warning`, `finished`, `tired`, `level-up`
- Clicking the pet opens the active session or the notification panel
- Stays visible above fullscreen apps (coding-agent users mostly live in fullscreen terminals)

**Content requirements**

- Ship at least **12** high-quality starter pets
- The data model must support at least **100** pet IDs
- Assign a random starter pet on first launch
- Include rarity metadata from day one: `common`, `uncommon`, `rare`, `legendary`
- No marketplace or trading in the MVP

Polish matters more than pet count in v1.

**Acceptance**: the pet stays visible on the desktop; each of the seven states has a distinguishable visual; when an asset is missing the pet falls back to a procedurally generated form — the UI always shows a pet, never an empty window.

### 7.2 Notification bubbles — P0

> As a coding-agent user, I want the pet to show a bubble when the agent needs me, so I don't miss decisions while doing something else.

**Notification types**

Decision needed · Tool permission needed · Usage/token threshold reached · Context window too large · Topic drift / suggest a new session · Session finished · Agent error or stall

**Bubble behavior**

- Appears near the pet with a short status label and a one-line reason
- Clicking the bubble opens the relevant session or panel
- Bubbles **never** show raw prompts, source code, secret paths, or private file contents
- Users can mute all bubbles for 30 minutes, 2 hours, or for the current project
- Mute must be a **visible, reversible state**, not a silent toggle

**Acceptance**: a decision bubble appears within **5 seconds** of the event arriving; users can dismiss bubbles; users can jump from a bubble to the session; notifications are recorded in local event history.

### 7.3 Usage and context health — P0

> As an agent user, I want the pet to warn me when token usage or context turns unhealthy, so I can control cost and session quality.

**Usage notifications** — token/cost milestone notifications at **25%, 50%, 75%, 90%** of the configured session budget by default. Users can set a per-session budget.

**Context warnings**

| Context used | Message |
| --- | --- |
| 70% | "Context is starting to fill up." |
| 85% | "Keep an eye on token usage — consider summarizing or a new session." |
| 95% | "Wrap up or start a new session soon." |

Each tier fires once (latched) — it must not repeat the same tier every 60 seconds. But 70% → 95% is a genuinely different message and both must land.

**Topic consistency warnings** — by default the MVP does **not** read full prompt history. It uses only safe local signals: a user-defined session goal, project path changes, sudden large shifts in which files are touched, repeated corrections, context usage, and (opt-in) new-task keywords. It suggests; it never forces a new session.

**Acceptance**: users can see the current token budget and context health; the pet's state changes when context turns unhealthy; warnings can be muted per session.

### 7.4 Level and EXP system — P0

> As a user, I want my pet to grow from my AI coding activity, so vibe-coding sessions feel more rewarding.

**Core principle**: tokens may feed the pet, but the product must not reward wasting tokens.

```text
session_exp =
  capped_token_exp
  * context_health_multiplier
  * topic_consistency_multiplier
  + outcome_bonus
  + daily_care_bonus
```

**Base token EXP**: **1 EXP per 1,000 tokens**, with a **daily token EXP cap** per pet (default 200) so users can't level up by burning tokens.

**Quality multipliers**

| Signal | Multiplier |
| --- | --- |
| Context below 70% | 1.10× |
| Context 70–85% | 1.00× |
| Context 85–95% | 0.75× |
| Context above 95% | 0.50× |
| Topic consistent with session goal | 1.10× |
| Repeated correction loop | 0.80× |
| Session produced an accepted diff, passing tests, a commit, or an explicit "shipped" | +20 to +100 EXP |

**Level curve**: Lv1 → 100 EXP, +50 per level after (Lv2 → 150, Lv3 → 200, …).

**Pet health**: **no permadeath in the MVP.** Unhealthy usage turns the pet `tired` and slows EXP gain; the pet recovers when the user takes a break, starts a fresh session, or ships something. The pet also grows slowly on its own each day, so users aren't punished for not using an agent.

**Acceptance**: the EXP bar is visible; users can see why EXP changed; there's a level-up animation; there's a tired state; there is no permadeath.

### 7.5 Evolution — P0 limited

> As a user, I want my pet to evolve after healthy agent usage, so it feels like a long-term companion.

Ship **one complete evolution family**: a base form, an evolved form, and a rare alternate form that appears when quality thresholds are high. All pet IDs support evolution metadata. Evolution is triggered by level **and** quality conditions together.

| Condition | Result |
| --- | --- |
| Level 1–9 | Starter form |
| Level 10+ | Evolved form |
| Level 10+ with high context-health score | Clean / calm evolution |
| Level 10+ with high usage but poor session hygiene | Tired variant (not death) |

**Out of scope**: 100 full evolution lines, trading evolutions, battle stats.

### 7.6 STT voice commands — P1 alpha

> As a user, when the agent needs a decision, I want to talk to the pet instead of switching windows.

- Push-to-talk button or hotkey, speech-to-text tuned for short commands
- Supported commands: `approve`, `reject`, `continue`, `open session`, `new session`, `mute`, `summarize`
- Destructive or permission-sensitive commands **must** show a confirmation first

**Privacy**: prefer local / on-device transcription; cloud STT requires explicit opt-in; **never** send code or prompt context to an STT provider.

**Acceptance**: voice commands can dismiss or open a decision notification; dangerous decisions require confirmation; users can turn STT off entirely.

### 7.7 Agent integration — P0 / P1

Build the unified local event bridge first. Per-tool adapters only normalize events into the standard shape and push them into the bridge.

**Standard event envelope**

```json
{
  "event": "decision_required",
  "agent": "claude_code",
  "session_id": "local-session-id",
  "project_id": "local-project-id",
  "severity": "high",
  "safe_summary": "Tool permission needed",
  "timestamp": "2026-08-18T10:00:00Z"
}
```

**Required events**

`session_started` · `agent_working` · `decision_required` · `permission_required` · `token_update` · `context_update` · `topic_drift_warning` · `session_finished` · `session_error`

**Integration priority**

| Priority | Integration | Mechanism |
| --- | --- | --- |
| P0 | Claude Code adapter | `.claude/settings.json` hooks + statusLine (live token channel) |
| P0 | Codex adapter | `.codex/hooks.json` (tokens extracted from the SessionEnd transcript) |
| P0 | pi-coding-agent adapter | pi extension plugin (hooks into pi lifecycle events) |
| P0 | Generic bridge | JSON / file / socket, for any other tool |
| P1 | DeepSeek Harness adapter | If reliable hooks/logs exist; otherwise the generic bridge |

**Degradation principle (never assume a perfect adapter)**: hooks drift across agent versions. A missing event degrades gracefully — skip the signal or approximate it — but never blocks the core loop. When Core is offline, adapters write events to local JSONL and the bridge backfills them later.

**Acceptance**: at least two real adapters work in the alpha, **or** one real adapter plus the generic bridge; the simulator can emit every core event for QA; events contain no raw code, prompt text, or secrets.

## 8. Privacy requirements (cross-cutting)

Privacy is not a feature; it's a hard constraint across every module.

| Layer | Constraint |
| --- | --- |
| Adapter capture | Allowlist fields; drop `tool_input`, prompts, `transcript_path` |
| Core, before persistence | Drop unknown fields again by schema; raw hook JSON is never stored |
| UI display | `safe_summary` uses fixed wording; agent text is never passed through |
| Network | No cloud sync by default; Core binds `127.0.0.1` only, with API token auth |
| Data ownership | Users can delete all local pet data at any time |

## 9. User experience flows

**First launch** → user opens Vibepaws → gets a random starter pet → connects Claude Code, Codex, pi, or the generic bridge → sets an optional token budget → pet goes `idle`.

**While coding** → agent starts working → pet switches to `working` → agent needs a decision → pet shows a bubble → user clicks the bubble or uses a voice command → agent continues → token/context usage updates pet EXP and health → session finishes → pet earns EXP and possibly a memory.

**Level-up** → user earns enough EXP → pet plays the level-up animation → user can view the EXP explanation → if evolution conditions are met, the pet evolves.

## 10. MVP metrics

| Category | Target |
| --- | --- |
| Activation | 60% of alpha users connect at least one agent |
| Activation | 50% of users receive at least one useful notification |
| Activation | 40% of users set or view a token/context budget |
| Utility | Decision notifications appear within 5 seconds |
| Utility | 70% of decision notifications are handled from the pet |
| Utility | False-positive warning rate below 20% |
| Retention | 25% D7 active usage |
| Retention | 40% of retained users viewed pet level or EXP history |
| Retention | 30% of retained users say the pet helped them notice agent state |

**Monetization signal**: don't charge during the two-week alpha unless onboarding is already stable. After the alpha, test a **$19 founder lifetime license** with users who came back for at least 3 sessions.

## 11. Non-goals

**Not** in the two-week MVP:

A full set of 100 high-quality pet assets · public pet marketplace · PVP · leaderboard · rare pet selling · trading · full LLM chat companion · mobile app · hardware pet · team dashboard · enterprise admin · cloud sync by default

## 12. Release criteria

The MVP can ship to alpha when:

- [ ] The desktop pet runs locally
- [ ] Random pet assignment works
- [ ] The EXP bar and level-up work
- [ ] Decision bubbles work
- [ ] Usage notifications work
- [ ] Context warnings work
- [ ] Basic topic drift / new-session recommendation works
- [ ] The Claude Code or Codex adapter works
- [ ] The generic bridge works for other agents
- [ ] No raw code or prompt text is stored by default
- [ ] Users can mute notifications
- [ ] Users can delete local pet data
- [ ] The app has a simple onboarding flow

## 13. Two-week roadmap

### Week 1: build the core loop

| Date | Focus | Deliverable |
| --- | --- | --- |
| Tue 8/18 | Lock scope and architecture: freeze MVP scope, finalize the normalized event schema, define local data models for pets / EXP / sessions / notifications / memories, pick the desktop framework and local storage, build an agent-events simulator | Technical spec, event simulator, initial app shell |
| Wed 8/19 | Pet surface: always-on pet window, draggable position and click-through toggle, seven states, first 6 high-quality pet sprites, pet registry format supporting 100 IDs | Pet renders on the desktop and can show simulated states |
| Thu 8/20 | Notification system: bubble UI, decision-needed bubble, dismiss / mute / click-to-session actions, local notification history | Pet can show and handle simulated decision notifications |
| Fri 8/21 | Usage, context, and EXP: token budget settings, usage thresholds, context thresholds, EXP formula with daily token cap, EXP explanation panel | Pet levels up from simulated usage and quality signals |
| Sat 8/22 | Agent bridge: implement the local event bridge, support JSON/file/socket ingestion, wire the simulator into the bridge, start the Claude Code or Codex adapter — whichever hook lands fastest and most reliably | Real or near-real agent events update pet state |
| Sun 8/23 | Recovery / buffer: fix issues from the first five days, finish the first 12 starter pets if the art pipeline holds, polish onboarding copy, add local delete/reset | Internal alpha build |

### Week 2: integrate, polish, ship alpha

| Date | Focus | Deliverable |
| --- | --- | --- |
| Mon 8/24 | First real adapter (Claude Code or Codex); confirm decision, working, token/context, and finish events; add a manual fallback event trigger where agent hooks are incomplete | One agent works end to end |
| Tue 8/25 | Second adapter or generic integration; write setup instructions for Codex/Claude and the generic bridge; prepare Pi Agent and DeepSeek Harness as generic-bridge configs if stable hooks are missing | Two-agent path, or one real agent plus the generic bridge |
| Wed 8/26 | Topic drift and new-session warnings: session-goal field, conservative drift rules, "open new session" recommendation, mute and "not useful" feedback | Pet can warn when context and session direction look unhealthy |
| Thu 8/27 | Evolution and self-growth: one complete evolution family, passive self-growth, tired/hibernation recovery, memory earned on session finish | Pet can level, recover, and evolve along one path |
| Fri 8/28 | STT alpha and safety: if the core loop is stable, add a push-to-talk prototype, support approve/reject/open/mute, add confirmation for sensitive commands; if STT is shaky, ship it behind a hidden experimental flag | Voice command alpha, or a documented deferral |
| Sat 8/29 | Alpha QA: test onboarding, notification latency, no-raw-prompt/code storage, mute / DND / click-through / reset / delete, two screen sizes, light and dark mode | Release candidate |
| Sun 8/30 | Private alpha: send the build to 5–10 target users; collect activation, notification usefulness, annoyance, and pet-attachment feedback; watch where adapter setup fails | Alpha feedback report |
| Mon 8/31 | Fix and cut: fix critical onboarding and adapter issues, tune notification thresholds, tune the EXP formula, remove or hide unstable STT paths | MVP alpha build |
| Tue 9/1 | Release decision: if release criteria pass, ship the alpha to a wider beta list; if not, extend by one week for adapter reliability and notification quality only | Ship / hold decision |

## 14. Biggest product risks

| Risk | Mitigation |
| --- | --- |
| **Token farming** — users burn tokens to level up the pet | Daily caps, quality multipliers, outcome bonuses |
| **Notification anxiety** — warnings make agent use stressful | Gentle copy, mute, DND, no permadeath |
| **Content scope** — 100 pets crushes v1 | Ship fewer, more finished pets; let the architecture support 100 |
| **Adapter fragility** — agent hooks may change or be incomplete | Generic bridge and simulator |
| **Privacy distrust** — users worry the pet reads their code or prompts | Local-first architecture and visible data boundaries |

## 15. Implementation status (as of 2026-08-21)

The release window is half over. The table below reconciles PRD requirements against the code — it is **not** a restatement of the targets.

| Requirement | Status | Notes |
| --- | --- | --- |
| 7.1 Desktop pet surface | ✅ Done | Electron transparent window, seven states, drag, click-through, tray, visible above fullscreen Spaces |
| 7.1 12 starter pets | ⚠️ Partial (5 / 12) | Embercub, Lunafang, Sporewick, Voltroc, Circuit Witch — 7 state portraits each |
| 7.1 100-pet-ID architecture | ✅ Done | `ui/pets/index.json` + `pet_types` table, with rarity and evolution metadata |
| 7.1 Random starter assignment | ✅ Done | Assigned on Core's first launch |
| 7.2 Notification bubbles | ✅ Done | Decision / permission / context / error / token milestone; 60s dedup; per-tier latch |
| 7.2 Mute (30m / 2h / project / session) | ✅ Done | Visible badge with remaining time, reversible |
| 7.2 Within 5 seconds | ✅ Decided in Core | Pending measured confirmation in alpha QA |
| 7.3 Context warnings 70/85/95 | ✅ Done | Default thresholds in `src/core/settings.ts`; adjustable (or off) in the settings window |
| 7.3 Token budget milestones 25/50/75/90 | ✅ Done | Engine, per-session budget field, and a settings window to set both the global default and per-session overrides |
| 7.3 Topic drift warnings | ⚠️ Partial | Event type, notification path, and the session-goal entry point (settings window) are wired; conservative heuristics still to be built (originally 8/26) |
| 7.4 EXP engine | ✅ Done | 1 EXP/1k tokens, daily cap 200 (adjustable in settings), context/topic multipliers, level curve 100+50(n−1) |
| 7.4 Tired state / no permadeath | ✅ Done | State machine includes `tired` |
| 7.4 EXP explanation | ✅ Done | EXP breakdown in the flyout |
| 7.5 Evolution | ⚠️ Partial | `evolution_meta` rule engine works (Lv5/Lv10 + health conditions); **evolved-form art not made** |
| 7.6 STT voice commands | ❌ Not started | P1, scheduled after the core loop (8/28) |
| 7.7 Claude Code adapter | ✅ Done | hooks + statusLine live token channel |
| 7.7 Codex adapter | ✅ Done | `.codex/hooks.json`; requires `/hooks` authorization once |
| 7.7 pi adapter | ✅ Done | Extension plugin (pulled from P1 to P0) plus a manual fallback emitter |
| 7.7 Generic bridge | ✅ Done | JSONL directory watcher, doubles as the Core-offline fallback |
| 7.7 Simulator | ✅ Done | 5 scenarios covering every core event |
| 8 Two-gate privacy | ✅ Done | Adapter allowlist + Core schema drop, verified by `src/core/privacy.test.ts` |
| 9 Onboarding flow | ⚠️ Partial | The installer self-checks and prints guidance; no graphical first-run wizard |
| 12 Delete local pet data | ⚠️ Partial | Delete `.vibepaws/`; no in-app button |

**Main gaps** (the three things that decide ship / hold on 9/1):

1. **Pet count** at 5 / 12 — the art pipeline works (per-state image-to-image generation), so this is throughput, not a technical blocker
2. **Budget and drift surfaces** — the engines exist but have no entry point, and two Activation metrics depend on them
3. **Evolved-form art** — the rule engine already fires, but there's no new form to switch to

## 16. Community and game economy roadmap (post-MVP)

Community matters, but it isn't the MVP core.

- **MVP** — local pet assignment, local pet profile, exportable pet card after milestones
- **Post-MVP** — community pet submission form, moderated pet gallery, skin packs, public profile pages
- **Later** — leaderboard, PVP, rare pet selling, trading, seasonal events

> ⚠️ Marketplaces, leaderboards, PVP, and rare pet sales bring anti-cheat, IP, moderation, and trust problems. **Don't add them before retention and daily usage are validated.**

## 17. Final recommendation

The two-week alpha should ship:

One well-finished desktop pet loop · 5–12 starter pets (not 100) · architecture that supports a 100-pet registry · decision bubbles · usage/context/topic warnings · EXP bar and level-up · healthy-session multipliers · no permadeath · one evolution family · Claude Code + Codex + pi adapters · a generic bridge for other agents · STT as P1 alpha only if the core loop is stable.

The next decision, two weeks out, should be based on **retention and notification usefulness** — not pet count.
