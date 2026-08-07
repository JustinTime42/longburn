# Flight-Plan Model Spec v0.1 — plan-and-burn

Status: DRAFT, pending Overseer approval (longburn-wyu).
Author: Vardis Slowfathom (Mayor).
Authority: Overseer ruling 2026-08-07 (recorded on longburn-wci and longburn-v3t; amended
design pillar 2 and GDD lines 204-205/222). Supersedes the single-order commit-and-burn model
of longburn-din.4 at design level; din.4's event-sourcing, shared-reducer, serialization, and
quantization machinery all survive and are the substrate here.
Related: trajectory-subsystem-v0.2.md (planner), tier0-decomposition row D (rewrite bead
longburn-wbu), implementation epic longburn-40j.

## 0. The ruling this spec implements

The burn is irreversible; the plan is paper. An executed burn — ejected mass and everything it
did to trajectory and tanks — is history: no undo, no recall, no cancel. Any planned burn
(launch, correction, capture, de-orbit) may be edited or aborted until the moment it executes,
gated only by command light-lag. Stakes begin when the engine fires. A docked ship has zero
stakes beyond opportunity cost.

UX reference named by the Overseer: Kerbal Space Program's maneuver-node planning — get on a
trajectory now, add the capture burn later along the route, see the projected path update.

## 1. The model

A **FlightPlan** is an ordered sequence of **BurnNodes** laid on the ship's projected
trajectory.

- **BurnNode** (authoritative, quantized per SO 16): node id, `executeAtMs` (integer sim ms),
  and quantized fixed-point burn parameters (the same representation class din.4 established:
  integer-quantized durations/magnitudes the sim replays bit-exact, never planner floats).
  Exact field layout is an implementation decision inside SO 16's constraints.
- **Executed burns are events; planned burns are state.** When the sim clock reaches a node's
  `executeAtMs`, the loop appends `burnStarted`/`burnEnded` (impulsive burns may collapse to a
  single event — implementation choice) stamped at exact sim times, the way phase boundaries
  are stamped today. Those events are append-only history. The un-executed remainder of the
  plan is aggregate state, replaced wholesale by revision commands (§3).
- **Phases are derived, not authoritative.** accel/coast/flip/decel/docked become views
  computed from executed burn events plus elapsed time. `docked` = at rest at a body with no
  burn yet executed. No event may move a ship backward through history (the type-level
  guarantee din.4 established for docked-return generalizes: nothing un-executes a burn).
- **Trajectory projection** (client + planner): deterministic propagation of executed state
  through the planned nodes. Projection is advisory display; only executed events are truth.

## 2. The immutability boundary

Enforced in three layers, strongest first:

1. **Types**: no event type exists that deletes, edits, or re-times an executed burn event.
2. **Log invariants**: the shared reducer (`SimEventReducer`) rejects any stream where a
   revision's node set conflicts with already-executed burns (assertOrder-class checks, on
   BOTH replay paths — the din.4 r2 lesson).
3. **Command boundary**: typed refusals before anything appends (§3).

## 3. Commands and light-lag

Player commands are physical signals. They originate at the player's **HQ**, travel at c, and
take effect at the ship when they arrive.

- **PlanRevision command**: carries the complete replacement set of un-executed BurnNodes
  (possibly empty = abort everything; possibly a superset = KSP-style adding a later burn).
  Atomic wholesale replacement subsumes add/edit/abort in one primitive and keeps replay
  simple. Issued at `t_issue` from HQ position; **arrives** at
  `t_arrive = t_issue + lightTime(HQ, ship)` — a light-time solve against the ship's
  propagated position, the same solve class as the emission gate, fixed-iteration per SO 16.
- **Validity is judged at arrival, not issue.** At `t_arrive`, if any burn the revision would
  replace has already started executing, the revision is refused — as an appended, typed
  refusal EVENT (the dispute record must show the command arrived and why it bounced), and the
  refusal notice travels back to the player at c. A revision that arrives in time atomically
  replaces the un-executed remainder.
- **Race rule, deterministically**: a burn executes at its `executeAtMs` unless a valid
  superseding revision ARRIVED before that instant. Event order in the log is the single
  arbiter; the loop's writer serialization (longburn-brp) plus in-critical-section evaluation
  (longburn-153) make the ordering exact.
- **Causality symmetry**: the outbound gate already guarantees no information reaches a player
  faster than light; this section is the inbound mirror — no player intent reaches a ship
  faster than light. Both directions asserted mechanically (SO 12 extended).

**T0 HQ**: fixed at world-join, default Earth. HQ relocation and multi-planet command offices
are future-tier product (deliberately enabled by this design; filed, not built — SO 13).
Consequence to embrace, not hide: agency thins with distance. The UI must show, for every
planned burn, the last instant a revision issued NOW could still arrive before it fires.

## 4. Planner integration

- The planner plans **from a propagated state at any chosen time** (current state, or the
  projected state at an existing node), not only from "now" — this is what enables adding a
  capture burn mid-route.
- Planner output remains advisory (SO 16): the revision command carries only quantized nodes;
  the sim never re-runs a planner to reproduce state.
- Fuel: a revision is validated at arrival against remaining propellant at the projected
  execution states (rocket equation per node, mass-cargo module). Over-budget revisions get a
  typed refusal (subsumes longburn-guc's finding: no caller-named fuel costs anywhere).

## 5. What dissolves, what survives

Dissolved: the single fixed-order machine, the ≤6h re-target window, the arrival-profile
window, the departure-anchor question (all window mechanics — a plan is paper until it burns).
`shipDecisionWindowScheduled` precedent: retired event types cost nothing pre-durability, but
this rework must land before 4qs declares the schema real.

Survives unchanged: event sourcing from commit one, the shared reducer with both-path
validation, loop-owned writer serialization, exact-boundary timestamps, integer quantization,
the causal transport fence, no-cancel-of-history as a type-level absence.

## 6. Verifier obligations (mechanical, from day one of 40j)

- Replay equivalence over streams containing revisions racing burns (property tests; both
  replay paths).
- Inbound causality: no revision applies before light could carry it (mirror of the existing
  causality suite).
- Immutability: property test that no reachable command sequence mutates an executed burn.
- Quantization round-trip per node; fuel-refusal boundary cases.

## 7. Open questions for the Overseer (approve-with-answers)

1. **HQ default**: fixed at Earth at world-join for T0 — confirm.
2. **Burn-execution report**: the ship reports each executed burn back to HQ at light-lag
   (din.7 notification trigger: "burn executed as planned" arriving minutes later) — confirm.
3. **In-flight planner access**: T0 keeps the planner server-side and instant (the ~3.3-3.8 s
   sweep, ddv). Planning latency as a light-lagged in-fiction service is future-tier flavor —
   defer? (Recommend: defer; c9q territory.)
