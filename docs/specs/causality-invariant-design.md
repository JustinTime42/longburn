# Design Note: Causality Invariant Test Harness

Bead: `longburn-6yu` (depends on `longburn-8b5`). Author: Mayor (Vardis), 2026-08-04. Amended 2026-08-04 per Overseer ruling on the r1 escalation (`fort/reviews/longburn-6yu-review-1.md`): the r1 draft permitted a relative tolerance that weakened the invariant; the charter wins. This note is subordinate to standing order 12 — where they conflict, the charter is correct and this note is the bug. GDD §4.5, §6 and standing order 12 are the governing texts. This note is interface-shape guidance, not implementation: the Forge owns the code, and actual type definitions live in code, not here.

## The invariant

For every message the server emits to a client:

```
emission_sim_time ≥ t_arrival, where t_arrival solves
dist(observer_pos(t_arrival), event_pos(event_sim_time)) = c · (t_arrival − event_sim_time)
```

No information about an event may reach an observer before light could have carried it — measured against where the observer actually *is* when the light gets there (see "Moving receivers" below). The inequality is absolute: no tolerance, no epsilon, no rounding down. This is asserted mechanically over **every** emitted message, from the first message ever emitted, in all environments (test, CI, production). It is server-side and absolute (GDD §6 security-critical paragraph): the client never receives data it could only hold by violating this, so nothing needs to be hidden client-side.

## Shape requirements this imposes on the emission layer

These are the requirements the event store and transport must satisfy so the invariant is *checkable*, and they should be designed together (review note 4):

1. **Every emitted message carries provenance**: the sim time of the underlying event (`event_time`), the sim time of emission (`emission_time`), the event's position (body or ship coordinates at `event_time`), and the observer's position at `emission_time`. If a message aggregates several events, the constraint applies to the *youngest* event in the aggregate.
2. **All times are sim times** from the SimClock (`longburn-8b5`): never wall clock (SO 10).
3. **Positions come from the same ephemerides/trajectory source the sim uses**: the check must not have its own physics that can drift from the sim's.
4. **Emission is a single choke point.** One gate function through which every outbound state update passes. The invariant is asserted *in* that gate, not sprinkled at call sites. If a message can leave the server without passing the gate, the harness is decorative.

## Moving receivers: arrival-time light propagation (Overseer ruling, 2026-08-04)

**No tolerance, ever.** The r1 draft's relative tolerance is struck: no constant may weaken the inequality. The physical condition is exact and, in this sim, exactly computable — trajectories are deterministic (commit-and-burn) and body positions come from the ephemerides, so the observer's position at any future sim time is known. Use it.

- **The exact condition:** light from an event at `event_pos(event_time)` reaches the observer when the observer's worldline first intersects the expanding light sphere — the arrival time `t_a ≥ event_time` satisfying `dist(observer_pos(t_a), event_pos(event_time)) = c · (t_a − event_time)`.
- **Solve by fixed-point iteration:** `t_0 = event_time + dist(observer_pos(event_time), event_pos)/c`, then `t_{n+1} = event_time + dist(observer_pos(t_n), event_pos)/c`. Convergence is geometric with ratio ≈ v/c; at Tier 0 speeds (even 100 km/s is v/c ≈ 3×10⁻⁴) two or three iterations reach sub-millisecond. Iterate to a fixed sub-millisecond step bound with a hard iteration cap.
- **Conservative direction only:** every uncertainty — iteration remainder, floating point, provenance the gate cannot verify, non-convergence — resolves toward *later* emission: over-estimate distance or delay the message. A millisecond late is lag; a millisecond early is time travel. Never early.
- **Rounding:** sim times are integral milliseconds. The earliest legal emission tick is `ceil` of the exact floating-point arrival time — `ceil` is permitted for *scheduling*. The *assertion* compares against the exact requirement and never floors or rounds it down.

## The harness itself

Two layers, both required:

1. **Runtime assertion (production and test):** the emission gate asserts the invariant on every message. Violation in test = test failure. Violation in production = the message is **not sent**, an `incident`-grade log event is recorded, and a counter/alert increments. Failing closed is mandatory: a delayed update is a bug; a leaked one is a design breach (the network tab is the attack surface).
   - **Provenance is validated at runtime, not just at the type level** (r1 finding 3): type branding does not protect against decoded network/database data or unsafe casts. Both times must be validated as non-negative safe-integer sim milliseconds *before* comparison; `NaN` or any malformed value fails closed. `NaN < required` being false must never become a send.
   - **Every failure mode is observable** (r1 finding 4): unexpected provenance/distance/computation errors also fail closed *and* record an incident + increment the counter/alert. A failure in the reporting path itself must still never reach transport.
2. **Property tests (CI):** drive the sim with the virtual clock through randomized (seeded) scenarios (ships in transit, events at each body, observers at each body and mid-transit) and assert over the *full stream* of emitted messages: (a) the invariant holds; (b) information *eventually* arrives (liveness: the filter can't cheat by sending nothing); (c) staleness metadata on each message equals `emission_time − event_time` (the client renders staleness; it must never compute it).
   - **Boundary sensitivity is required** (r1 finding 2): exact-boundary tests at the earliest legal tick and one millisecond before it (`ceil(exact) − 1` must block, `ceil(exact)` must pass), and a property that generates blocked and eligible cases *independently of the production helper* — a suite that derives its expectations from the code under test proves nothing about a one-millisecond leak.

## Non-goals at Tier 0 (tier fence, SO 13)

- No per-player subscription topology beyond the single player.
- No relativistic corrections: the light-cone solve above is Newtonian kinematics plus finite light speed, which is exact for our purposes at Tier 0 speeds. Time dilation, aberration, etc. stay out.
- No out-of-band channels (Discord-defusing analysis in §4.5): that is T2+ market design; here we only guarantee the transport can't leak.

## Acceptance (for the bead)

- Emission gate exists and is the only outbound path; the fence is **mechanical, not prose** (r1 finding 5): `CausalStateSubscription` structurally exposes only gate-backed `emit`, while an architecture test scans `src/host` and rejects its raw `writeText`/`writeJson` calls outside `CausalEmissionGate` callbacks. The test asserts its scan is non-empty and feeds the same visitor a deliberate violation. Until a structural fence covers the broader surface, the fort-wide `causal-boundary/no-raw-outbound` ESLint tripwire also remains in force for direct `.send`, `.publish`, `.broadcast`, and `.write` calls outside the gate, with its own deliberate-violation fixture. These checks do not prove aliases, computed members, arbitrary writer names, or that future transports use `CausalStateEgress`; README guidance alone is not enforcement.
- Runtime assertion fails closed with logging.
- Property suite runs in CI in seconds using the virtual clock (a 40-day transit's message stream checked in ms).
- One deliberately-violating test fixture proves the harness actually catches a leak (the /mcp-invariant lesson: a test that has never failed proves nothing).
