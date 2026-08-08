# Authoritative Worldline Spec v0.1 — where the ship actually is

Status: APPROVED by the Overseer, 2026-08-07 (all three §6 questions ruled in-session:
two-body heliocentric authority confirmed after his review overturned the flat-space
draft; arrival snap approved; m / mm/s grain approved).
Author: Vardis Slowfathom (Mayor).
Origin: longburn-1ls escalation (Forge handoff forge-2026-08-07-1ls.md): the committed
BurnNode schema carries no direction and no initial state, so no authoritative
`shipPositionAt(t)` exists; the planner's ProjectedShipState is advisory by law (SO 16,
flight-plan-model-v0.1.md §1) and must not become causality provenance.
Direction approved by the Overseer in-session 2026-08-07; this draft is the review artifact.
Related: flight-plan-model-v0.1.md, trajectory-subsystem-v0.2.md, longburn-ksj (folded into
1ls), longburn-8lz (departureStateAt provider), longburn-4qs (schema versioning — this spec
must land inside the pre-durability window), longburn-din.5 (first consumer beyond 1ls).

## 0. The problem

Four consumers need the ship's position as a function of sim time, from authoritative data:

1. Event provenance (1ls): `commandIssued.arrivalPosition`, applied/refused records.
2. Burn-event stamping at the event's own time (ksj).
3. The emission gate's light cones at arbitrary emission times (din.5).
4. Report-arrival instants for notifications (din.7.1, via din.5's machinery).

Executed events today cannot answer this: a burn is (time, kind, duration) with no direction,
and nothing records where the ship started. The only object that knows the trajectory is a
planner projection, which SO 16 forbids from crossing into the sim.

## 1. Decision: the worldline is derived from quantized committed data by a sim-core propagator

Two quantized schema extensions (both inside the 4qs pre-durability window):

- **DepartureState** (new, stamped once per ship stream at plan commitment): quantized
  position (integer meters per axis, heliocentric J2000 frame — the solar system fits
  comfortably in int53) and velocity (integer mm/s per axis) at a departure epoch (integer
  sim ms). For T0 the ship starts docked at Earth: the live command boundary consults the
  ephemerides adapter for Earth's state at the departure epoch, quantizes it, and stamps it
  as the authoritative fact. The adapter is consulted at the boundary only — never during
  replay (kg2 doctrine: stamped facts are history).
- **BurnNode gains a quantized delta-v vector**: integer mm/s per axis, alongside the
  existing `burnDurationMs`. Direction and magnitude in one vector. Consistency between
  |Δv| and duration (via the ship's acceleration) is validated at the live command boundary
  only, with exact integer arithmetic; replay applies stored nodes as history.
- **FlightPlan gains a `destination`** (T0 body id: earth | moon | mars). ADDENDUM
  2026-08-07, Mayor gap-fill after the Forge's round-2 escalation; RATIFIED by the Overseer
  2026-08-07 as a REQUIRED field (Warden 1ls r1 finding 2 sharpened the ratification: no
  default anywhere — a silent `?? "earth"` on the replay path synthesizes a durable fact the
  stored event never carried and is forbidden; the pre-durability window exists precisely so
  the field can be required and existing fixtures updated). The destination is part of the
  paper plan: replaceable by any PlanRevision (retargeting is editing paper — pillar 2),
  validated at the live boundary (known body), durable for free because `commandIssued` and
  `planRevisionApplied` already persist the plan. `arrivalRecorded` stamps the FINAL applied
  plan's destination body. Inferring a target from burn geometry is forbidden (stored-facts
  doctrine).

A new sim-core module (`src/sim/worldline.ts`) derives position deterministically:

- **Coast segments**: two-body heliocentric Kepler propagation of the segment's initial
  state (conic arcs around the Sun), reusing `src/sim/kepler.ts`. Kepler solves run fixed
  iteration counts per SO 16. Prerequisite: longburn-0yy (scale-relative epsilons before
  heliocentric consumers) sequences before or with 1ls.
- **Burn segments**: constant acceleration along the node's fixed quantized direction for
  the node's duration (gravity during a burn is neglected — the standard, bounded
  approximation for burns short against the orbital period). Position is quadratic in t.
- The propagator never consults the planner. It satisfies the existing `ObserverPositionAt`
  contract in causality.ts and adds `velocityAt`.

## 2. Fidelity precommitment (the headline decision)

**The T0 authoritative worldline is two-body heliocentric: Kepler coasts, constant-
acceleration burns. Solar gravity acts on the ship; planetary gravity does not (yet).**

History of this decision: the first draft proposed flat-space coasts. The Overseer's review
(2026-08-07) surfaced the counterexample that killed it: fuel is the economy, the
fuel-efficient plan is a Hohmann-class transfer — two burns and a long ballistic coast —
and a flat-space authority would fly the tangent line instead of the ellipse, punishing the
physically correct strategy with a wrong worldline (pillar 1 violation). Flat-space
authority was only sound if every plan is thrust-dominated, which the economy actively
works against. Recorded so the reasoning survives.

Why the transcendental/iteration cost of Kepler in the authoritative path is acceptable:

- §3's stamping doctrine (extending kg2): positions are computed live and stored as facts;
  replay reads stamps and never recomputes. Cross-engine transcendental divergence therefore
  cannot make history unresumable — the same argument that admits astronomy-engine at the
  ephemerides boundary. Kepler solves are fixed-iteration (SO 16). Exact integer arithmetic
  remains mandatory where it is today: accept/refuse decisions.
- Light-time solves tolerate position error of many thousands of km; conic coasts are far
  inside that everywhere.

**Planetary gravity (slingshots, capture, orbital play) is the named v2 upgrade — filed,
not built (SO 13).** It requires patched conics: sphere-of-influence boundaries, frame
handoffs, hyperbolic planetary legs. No T0 consumer exists. The commitment made NOW is
structural: the durable schema (state vectors + per-node delta-v vectors) is model-agnostic,
so v2 is a new propagator version behind the same `positionAt(t)` interface under the 4qs
versioning policy — no schema change, no migration. Heliocentric conics are the same conic
propagator patched conics reuse later; this spec is an installment on slingshots, not a
detour from them.

**Arrival is a physical predicate, not a paperwork one** (AMENDED 2026-08-07, Overseer-
approved, after Warden 1ls r1 finding 3: the original trigger — "final planned burn
completes and the plan is empty" — is indistinguishable from the normal mid-transit state
in which the player's next revision is still in flight, and fired arrival spuriously).
When a burn ends and the plan is empty, the loop appends `arrivalRecorded` ONLY if the
ship is physically there: terminal position within the capture radius of the plan's
destination body AND relative velocity within the docking tolerance, both compared as
quantized integers against the body's ephemerides state at that instant. T0 constants
(Overseer may retune pre-durability): capture radius 1,000,000 km (1e9 m — inside both
Earth's and Mars's spheres of influence), docking speed 100 m/s (1e5 mm/s — absorbs
quantization and burn-model error; the planner nulls relative velocity by design).
Otherwise the ship coasts on, plan empty, awaiting orders — the physically honest state.

`arrivalRecorded` stamps the quantized arrival state (live-computed: ship worldline
terminal state, plus target-body state from the ephemerides adapter at that instant) and
the measured position/velocity gaps. From `arrivedAtMs` ON — and only from then —
the ship's worldline is the target body's worldline (docked = co-moving with the body, as
at departure); `shipPositionAt(t)` for t < arrivedAtMs remains the transit worldline (the
resolver is a function of time alone). A plan applied after arrival whose nodes fire
appends a NEW `departureRecorded` stamped from the body's state at the first burn — the
worldline is piecewise: docked segments on body worldlines, transit segments from
departure stamps. If the recorded arrival gap is embarrassing in practice, that is planner
feedback (or v2-propagator feedback), not a reason to hand-wave the arrival.

## 3. Stamping doctrine (extends kg2's ruling to positions)

- Every position persisted in an event is computed by the live resolver evaluated at the
  event's own sim time (this fixes ksj: the inbound sweep must pass each due event's own
  time, never the command's arrival instant).
- Replay reads stored positions and never recomputes them. The propagator is deterministic
  anyway; the doctrine removes even the temptation.
- eventPosition is not part of SimState, so no state-equality oracle can catch a stamping
  bug: 1ls must add targeted stored-envelope assertions (ksj's test requirement).

## 4. HQ resolver

`T0_EARTH_HQ_POSITION_METERS` (a constant valued at the frame origin) is replaced by
`hqPositionAt(t)`: Earth's ephemerides position at t, quantized at the call boundary. HQ is
product-fixed at Earth for T0 (flight-plan-model §3); the resolver signature is
body-agnostic so future HQ relocation is a data change. The ephemerides adapter's
transcendentals are acceptable here for the same reason they are at the departure stamp:
consulted live at boundaries, outputs stamped or asserted, never replay-recomputed.

## 5. Scope of longburn-1ls against this spec

1. Schema: DepartureState stamp + BurnNode delta-v vector (quantization helpers alongside
   the existing ones in mass-cargo.ts; boundary validation live-only).
2. `src/sim/worldline.ts` propagator satisfying ObserverPositionAt, with velocityAt.
3. `hqPositionAt` replacing the placeholder constant.
4. Event stamping via the live resolver at each event's own time (ksj), including the
   arrival-position provenance in commandIssued and applied/refused records.
5. `arrivalRecorded` event and docked-at-body worldline handoff.
6. Tests: stored-envelope assertions (ksj); propagator determinism and closed-form pins;
   causality suite green over the real worldline; quantization round-trips.

Out of scope, filed elsewhere: planetary gravity / patched conics (the named v2 propagator,
future tier), emission gate itself (din.5), notification instants (din.7.1), schema
versioning policy (4qs — but this spec's events land before 4qs declares the schema real,
per flight-plan-model §5). Sequencing note: longburn-0yy becomes a prerequisite of 1ls.

## 6. Open questions for the Overseer

1. §2 fidelity precommitment — approve two-body heliocentric authority for T0 (Kepler
   coasts + constant-acceleration burns; planetary gravity as the filed v2)?
2. §2 arrival snap via `arrivalRecorded` with the measured gap on the record — approve?
3. Quantization grain (m, mm/s) — any objection to meter/mm-s grain? (Chosen so int53
   holds the full solar system with headroom; finer grain buys nothing causal.)
