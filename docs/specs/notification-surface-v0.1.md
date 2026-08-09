# Notification Product Surface v0.1 — DRAFT (pending Overseer approval)

Status: DRAFT, written by the Mayor 2026-08-08 (din.7.4's design half; Forge
implements against it once approved). Parent: din.7 (GDD §6: for an async game
the notification layer *is* the retention mechanic — product, not plumbing).
Timing/derivation is din.7.1's contract (earliest-permissible instants from
the emission gate); delivery is din.7.2; transport is din.7.3. This document
decides only: what wakes a player, what it says, what the player controls,
and what din.10 measures.

## 1. Trigger classes and wake policy

| # | Trigger | Source | Lag class | Default channel |
|---|---|---|---|---|
| N1 | Transfer window opening | planner (local) | never lagged | **push** |
| N2 | Burn executed | ship report | c | **push** |
| N3 | Revision applied / refused | ship report | c | **push** |
| N4 | Last-revision-instant warning | HQ-local, about the future | never lagged | **push** |
| N5 | Arrival | ship report | c | **push** |
| N6 | Market event (surge/crash) | market (din.6, class 2.4) | c | **push**, digest-eligible |
| N7 | Quote cadence, routine telemetry | — | — | **in-app only, never push** |

Rationale for the wake line: N2/N3/N5 are the rare, stakes-bearing moments of
a weeks-long transit — each one is ejected mass or its verdict. N4 is the
agency mechanic: it wakes the player *while they can still act*. N1 starts
sessions. N6 is the only high-frequency-capable class, so it is the only one
with digest machinery; everything routine (N7) stays in-app — a notification
layer that cries hourly is deleted by the tester, and the retention mechanic
dies with it.

## 2. Copy principles and drafts

1. **The lag is the flavor — state it, never hide it.** Every c-lagged
   notification names both instants: when it happened at the ship/market and
   when the report arrived. The gap is the product.
2. **Facts, no urgency theater.** No "Act now!", no exclamation marks. The
   physics is dramatic enough (pillar 1/5).
3. **Executed is past tense and final** (pillar 2). Copy never implies a burn
   can be recalled.

Drafts (variables in braces):

- N1: `Transfer window to {body} opens {relative-time}. Departure band {date range}.`
- N2: `Report received: {ship} executed burn {n} of {total} at {event-time} ({lag} ago). {dv} committed.`
- N3 applied: `Report received: revision to burn {n} was applied at the ship at {event-time} ({lag} ago).`
- N3 refused: `Report received: revision refused at the ship — {reason}. Plan unchanged. ({lag} ago)`
- N4: `Last chance approaching: a revision to burn {n} must leave HQ by {instant} to arrive before execution. {countdown} remaining.`
- N5: `Report received: {ship} arrived at {body} at {event-time} ({lag} ago).`
- N6: `Market report from {body} ({lag} old): {commodity} {surged/crashed} to {price} cr/ton.`

## 3. Player preferences

Per trigger class (N1–N6): `push | email | in-app only | off`. Plus:

- **Digest mode** (N6 only at T0): immediate vs daily digest.
- **Quiet hours**: a player *choice*, never a mechanic (pillar 6). During
  quiet hours delivery is **deferred, not dropped** — the no-skip guarantee is
  about existence, and the earliest-permissible instant is still a floor:
  quiet hours can only delay beyond it, by the player's own election.
- N4 lead times: default warnings at 12 h and 1 h before the last-revision
  instant; player-tunable list. **(N4's deadline source is RULED — Overseer
  2026-08-09, longburn-kqop: computed from HQ's knowledge-consistent paper
  projection, never the authoritative worldline, so the zero-lag warning
  leaks nothing; expired deadlines filtered; "burn executed" = burnStarted.)**
- Defaults are the table in §1; a fresh tester gets the designed experience
  without touching settings.

## 4. Instrumentation (din.10's feed — why din.7 blocks din.10)

Two host-side (not sim) event records per notification:
`notificationDelivered` and `notificationOpened`, each carrying: trigger
class, channel, sim time of the underlying event, earliest-permissible
instant, wall-clock delivery/open time, and the notification's stable id
(opens join to deliveries). §7.5's measurables derived from them:
opens-per-class, open latency, and whether N4 warnings precede revision
commands (the "mid-flight decisions ignored?" fail signal, measured rather
than surveyed).

## 5. Open questions for the Overseer

- **Q1 — the wake line (§1):** ratify push defaults for N1–N6. Cheapest to
  change later; recorded so the 3-week run starts from a decided default.
- **Q2 — N4 cadence:** two warnings (12 h / 1 h) as default — enough agency
  without nagging?
- **Q3 — email copy = push copy** at T0 (one template surface, transport-
  agnostic). Any reason to want richer email?
