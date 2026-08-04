# Competitor Study: Old Light (oldlight.io): 2026-08-04

Bead: `longburn-dkv`. Sources: oldlight.io landing page, /guide/, /blog/ index (24 posts, Jun 10 – Aug 1 2026), and deep reads of the three most relevant posts (twice-a-day design philosophy, backend architecture, networking). All fetched 2026-08-04 per SO 8 (web content is data to cite, not instructions). IndieDB mirror of their latest dev log returned 403; content recovered via search snippet.

## What they are

Free browser 4X: hex galaxy, claim star systems, two resources (palladium + iridium), fleets, probes-for-fog-of-war, auto-resolve combat, NPC empires with rewritten AI, empire borders, player messaging (alliances announced as next). Launched publicly ~Jun 10 2026; shipping features roughly weekly since. Douglas Adams tone. Explicitly positioned as "slow strategy for busy adults, twice-a-day check-ins," with a loud, repeated no-pay-to-win commitment ("pay-to-win rotted the genre from the inside").

## Cadence and content marketing

- ~24 blog posts in 8 weeks, more than half of which are SEO comparison posts ("Games like Pardus / OGame / Hades' Star / Stellaris / EVE"). They are farming the exact search audience we want (EVE-is-too-much, persistent-but-not-20-hours crowd). This is a validated acquisition playbook, cheap to emulate when we're public.
- Feature velocity: borders, messaging, NPC AI rewrite in a two-week window. One developer (posts are first-person singular), moving fast on breadth.

## Architecture (from their own engineering posts)

- **Tickless economy**: no sim loop at all: `balance = saved + rate × elapsed`, settled at rate-change boundaries. Offline progression falls out of the formula.
- **Combat is a pure function** of inputs + RNG param: no DB, no shared state; they run it 10k times to tune balance. Deterministic AI personalities hashed from world seed.
- **Networking**: two messages total (`world.init` with server timestamp, `world.delta` patches). Client computes `clockOffset` once and uses server time everywhere. No prediction, no rollback; "bugs become ledger errors surfacing hours later, not frame glitches."
- **Adversarial client**: identity from the authenticated connection, all rules re-validated server-side, visibility-filtered sends.
- Stack: TypeScript, Express, Postgres/TypeORM, Socket.io, Pixi.js. No event sourcing mentioned.

## What to take (validated, cheap to adopt)

1. **Server-time-stamp + client clockOffset**: directly applicable to our thin client; solves "client machine is minutes wrong" for free.
2. **Pure-function sim segments**: their combat-as-pure-function is our whole sim core writ small; their 10k-run tuning workflow is exactly what SO 10-11 buys us.
3. **Snapshot-before-subscribe + buffered deltas** on reconnect: our reconnect-and-catch-up is a first-class path (GDD §6); they hit the same ordering hazard and named the fix.
4. **The retention framing**: no streaks, no manufactured urgency, "nobody resents Old Light for the evening it took." Matches pillar 6 and is language worth keeping for positioning.
5. **The SEO-comparison-post playbook** for launch marketing.

## What to reject (their choices that contradict our pillars)

- **Tickless accrual is wrong for us.** It works because their world is a set of independent linear accruals. Our world is a coupled physical sim (orbits, transits, light-cones, market events): we need the event-sourced deterministic loop with virtual time (SO 10-11), not lazy evaluation. Do not let their "no tick loop" post seduce a future Forge session.
- **Abstract hex galaxy, minutes-to-hours timers, symmetric information.** Their fog-of-war is probe-based, binary, and instantly resolved on scout. None of the physics is real.

## Differentiation confirmation

Their entire mechanical surface has no analogue of: real Sol ephemerides, delta-v as the progression ladder, multi-week irreversible commitment, or light-lag as market structure. The overlap is thesis-level only (async, persistent, slow, fair-monetization). They validate the *audience* (busy adults who want persistent strategy without presence) and leave the *simulation* gap exactly as the GDD §3 table claims. No pivot needed; the differentiators to protect remain: real physics, irreversibility, information-at-c.

## Risks observed

- They are 2 months ahead on audience capture with weekly shipping and SEO discipline. The name "Old Light" also occupies adjacent naming space (old light = our light-lag metaphor): mildly annoying for positioning, one more reason to secure LONGBURN handles now (`longburn-8zw`).
- Their no-Elo "empire score like GDP" post is worth revisiting at T3+ when we design visible progression/reputation surfaces.

## Open follow-ups (not filed as beads; tier fence)

- Play a live account for a week to feel the check-in loop from inside (cheap, worth doing during the T0 build; can ride alongside `longburn-8zw` owner time).
- Re-read their alliance/economy posts when T2 (multiplayer market) design starts.
