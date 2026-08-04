# Tier 0 Decomposition: Draft for Overseer Approval

Bead: `longburn-2fz`. Author: Mayor (Vardis), 2026-08-04. Status: **APPROVED by the Overseer 2026-08-04**, with one amendment (thrust-profile continuum, below). Child beads filed same day; IDs recorded in the table.
Governing text: GDD §7.3 (scope-in), §7.4 (scope-out), §7.6 (build notes), standing orders 10–14.

## Shape of the tree

One epic, eleven tasks, plus the three foundation beads already filed (`longburn-8b5` sim clock, `longburn-c38` CI, `longburn-6yu` causality harness) and the ephemerides spike (`longburn-7xl`, proposed promotion P2→P1: it is on the critical path). The tier fence (SO 13) was applied throughout; every temptation past §7.3 is named in the bead that resists it.

**Epic: T0: "the lonely transit"** (is a multi-week irreversible transit compelling alone?)

Filed 2026-08-04: epic `longburn-din`; children A=`din.1`, B=`din.2`, C=`din.3`, D=`din.4`, E=`din.5`, F=`din.6`, G=`din.7`, H1=`din.8`, H2=`din.9`, I=`din.10`, J=`din.11`, K=`din.12`. All dependencies below wired in beads; `7xl` promoted to P1.

| # | Bead (proposed) | Depends on | P | One-line scope |
|---|---|---|---|---|
| A | Ephemerides module | `7xl` (spike) | 1 | Positions of Earth/Moon/Mars/Sun as pure functions of sim time, from the kernel source the spike selects; deterministic, sim-core clean |
| B | Event store + authoritative sim loop | `8b5` | 1 | Postgres-backed append-only event store; single continuous loop driven by SimClock; replay-identical property test extended from 8b5's in-memory seed |
| C | Trajectory planner | A | 1 | Transfer planning over departure windows spanning the full thrust-profile continuum (Overseer amendment, below): minimum-delta-v Hohmann/patched-conic at one end, continuous-thrust brachistochrone (accelerate, flip, decelerate) at the other, partial-burn-plus-coast profiles between; output is the real Pareto surface (transit time × fuel/delta-v × cargo mass fraction); pure functions, property-tested. Interception exposure and return-window axes (§4.1) are full-design scope and are **not built** |
| D | Ship + commit-and-burn order flow | B, C | 1 | Ship state machine (docked→accel burn→coast→flip→decel burn→arrival; coast may be zero for full torch, burns may be impulsive for Hohmann) as events; REST commit command; **no cancel endpoint exists in the API at all** (pillar 2 as an absence, not a check); mid-flight windows (re-target ≤6h, arrival-profile-at-fuel-cost) as first-class scheduled decisions |
| E | Causal emission gate + visibility filter | `6yu`, B | 1 | The single outbound choke point per `docs/specs/causality-invariant-design.md`; light-lag + staleness metadata on every emitted message; fails closed. Harness (`6yu`) lands first: test before the code that could regress it |
| F | Fake market process | B, E | 2 | One destination market; seeded noise process (e.g. Ornstein-Uhlenbeck) advanced by the sim loop; quotes reach the player only through the gate, so the market is light-lagged for free |
| G | Notification layer | D | 2 | Desktop/web push on: transfer window opening, mid-flight decision window opening, arrival, market events worth waking for. §6 calls the notification layer the retention mechanic, so it is treated as product, not plumbing |
| H1 | Client shell: plot + sync | B | 2 | Thin web client; 2D orbital plot + vector lines + data panels; WebSocket subscribe / REST commands; server-timestamp clockOffset; reconnect = snapshot-then-buffered-deltas (both patterns validated by the oldlight study); renders staleness, **never computes it** |
| H2 | Client: planning + commitment UI | H1, D, F | 2 | Tradeoff-surface picker (porkchop-style) exposing the full torch-to-Hohmann continuum as the economic/tactical/fuel decision, the commit ritual, in-flight decision UI, market panel with staleness indicators |
| I | Telemetry for success criteria | H2, G | 2 | §7.5's pass/fail is measurable: log check-ins, session lengths, notification opens, decision-window responses. Without this the 3-week run yields anecdotes |
| J | Live-run readiness | I | 2 | Hosted instance (web push needs HTTPS), tester onboarding doc, reset/reseed procedure |
| K | **HUMAN: 3-week live run** | J | 1 | Recruit 5–10 target-audience testers; run ≥3 weeks; Overseer reads results against §7.5. Permanently human (gate 1). A fail is read per SO 14: re-test at T2 before any kill decision |

`longburn-c38` (CI) stays independent and should land immediately after `8b5` merges, before B starts.

## Sequencing logic

Two parallel tracks after the foundation: **physics** (7xl → A → C) and **world** (B → E/F), converging at D. The client (H1) can start as soon as B emits anything. Longest path: 8b5 → B → E → F → H2 → I → J → K.

## Decisions embedded (flag if you disagree)

1. **6yu before E** (harness before gate): the /mcp-invariant lesson, encoded in the dep direction.
2. **No cancel endpoint** rather than a rejected cancel command: irreversibility as API absence.
3. **Market quotes route through the causal gate** rather than having their own lag logic: one mechanism, one test surface.
4. **Telemetry bead exists**: §7.5's criteria ("check in more than once daily, unprompted") are quantitative; we instrument rather than survey.
5. **7xl promoted to P1**: the spike now blocks the physics track.

## Overseer amendment (2026-08-04)

**Thrust-profile continuum.** Players must be able to make the economic/tactical/fuel decision across the full range of burn strategies: full torch (continuous burn, flip at midpoint, maximum fuel, minimum time), partial burn plus coast, down to a minimum-delta-v Hohmann transfer, and everything in between. This supersedes the draft's patched-conic-only wording for bead C and is encoded in beads C (planner), D (ship phase model), and H2 (picker UI).

## Open questions — resolution (2026-08-04)

The Overseer approved the decomposition as a whole; the three open questions were not individually ruled on. The Mayor's proposals stand as working defaults, recorded on the relevant beads, overridable any time before those beads start:

1. **Hosting for the live run (bead J):** cheapest VPS, one instance per tester (T0 tests solo compulsion; shared sightings would contaminate it). Recorded on bead J.
2. **Notification transport (bead G):** web push primary, email fallback for testers who block it. Recorded on bead G.
3. **`7xl` promotion:** promoted to P1 — it blocks the physics track (embedded decision 5, unflagged at approval).
