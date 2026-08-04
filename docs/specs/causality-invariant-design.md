# Design Note: Causality Invariant Test Harness

Bead: `longburn-6yu` (depends on `longburn-8b5`). Author: Mayor (Vardis), 2026-08-04. Status: draft for Warden/Forge consumption; GDD §4.5, §6 and standing order 12 are the governing texts. This note is interface-shape guidance, not implementation: the Forge owns the code, and actual type definitions live in code, not here.

## The invariant

For every message the server emits to a client:

```
emission_sim_time − event_sim_time ≥ distance(event_position, observer_position, at event→emission interval) / c
```

No information about an event may reach an observer before light could have carried it. This is asserted mechanically over **every** emitted message, from the first message ever emitted, in all environments (test, CI, production). It is server-side and absolute (GDD §6 security-critical paragraph): the client never receives data it could only hold by violating this, so nothing needs to be hidden client-side.

## Shape requirements this imposes on the emission layer

These are the requirements the event store and transport must satisfy so the invariant is *checkable*, and they should be designed together (review note 4):

1. **Every emitted message carries provenance**: the sim time of the underlying event (`event_time`), the sim time of emission (`emission_time`), the event's position (body or ship coordinates at `event_time`), and the observer's position at `emission_time`. If a message aggregates several events, the constraint applies to the *youngest* event in the aggregate.
2. **All times are sim times** from the SimClock (`longburn-8b5`): never wall clock (SO 10).
3. **Positions come from the same ephemerides/trajectory source the sim uses**: the check must not have its own physics that can drift from the sim's.
4. **Emission is a single choke point.** One gate function through which every outbound state update passes. The invariant is asserted *in* that gate, not sprinkled at call sites. If a message can leave the server without passing the gate, the harness is decorative.

## Distance subtlety (decided now so it isn't re-litigated)

Bodies move between `event_time` and `emission_time`. The exact condition is retarded-time light propagation. At Tier 0 scale (Earth/Moon/Mars, light-minutes, transits of weeks) the acceptable simplification is:

- **Check condition:** `emission_time − event_time ≥ dist(event_pos@event_time, observer_pos@emission_time) / c` with a small relative tolerance (motion of both endpoints during light transit is second-order at Sol scales; tolerance covers it).
- The tolerance is a named constant with a comment deriving its bound, not a magic number. If the Forge finds the bound uncomfortable, escalate rather than widen it.

## The harness itself

Two layers, both required:

1. **Runtime assertion (production and test):** the emission gate asserts the invariant on every message. Violation in test = test failure. Violation in production = the message is **not sent**, an `incident`-grade log event is recorded, and a counter/alert increments. Failing closed is mandatory: a delayed update is a bug; a leaked one is a design breach (the network tab is the attack surface).
2. **Property tests (CI):** drive the sim with the virtual clock through randomized (seeded) scenarios (ships in transit, events at each body, observers at each body and mid-transit) and assert over the *full stream* of emitted messages: (a) the invariant holds; (b) information *eventually* arrives (liveness: the filter can't cheat by sending nothing); (c) staleness metadata on each message equals `emission_time − event_time` (the client renders staleness; it must never compute it).

## Non-goals at Tier 0 (tier fence, SO 13)

- No per-player subscription topology beyond the single player.
- No relativistic corrections beyond the tolerance analysis above.
- No out-of-band channels (Discord-defusing analysis in §4.5): that is T2+ market design; here we only guarantee the transport can't leak.

## Acceptance (for the bead)

- Emission gate exists and is the only outbound path; grep/lint proof that no other code path calls the transport send.
- Runtime assertion fails closed with logging.
- Property suite runs in CI in seconds using the virtual clock (a 40-day transit's message stream checked in ms).
- One deliberately-violating test fixture proves the harness actually catches a leak (the /mcp-invariant lesson: a test that has never failed proves nothing).
