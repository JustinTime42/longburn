# Handoff: Forge 2026-08-07T16:31:00-08:00

## Plan executed

1. Load the fort, Beads, approved flight-plan, and authoritative-worldline context; inspect the prior 1ls tranche.
2. Compose the real Tier 0 Earth departure, ship worldline, and Earth HQ resolver in the authoritative loop and inbound transport.
3. Stamp departure and arrival facts, preserve the durable destination through burn execution, and resolve all live event positions at their own timestamps.
4. Add a production-composition regression, run the full verifier, emit the result, then commit this handoff and implementation.

## Clarifying questions

None. The approved authoritative-worldline specification and the bead's resolved destination note supplied the needed decisions.

Model: gpt-5.6-terra

## State of work

- `longburn-1ls` remains in progress pending the harness-owned verification and review flow.
- `longburn-ksj` is covered by the loop's per-event-time resolver path.

## Verified facts

- `src/sim/tier0-worldline.ts` is the live-only composition boundary: it reads Earth/body ephemerides only to stamp new authoritative records.
- `src/sim/loop.ts` owns `shipPositionAt`, records `departureRecorded` once, records `arrivalRecorded` after the final burn, and uses the target-body resolver after arrival.
- `src/host/plan-revision-transport.ts` supplies the real Earth HQ resolver and defaults to the loop-owned ship resolver in Tier 0 composition.
- `src/sim/tier0-worldline.test.ts` proves the stored departure is heliocentric Earth, arrival preserves Mars provenance, and post-arrival resolution uses the target state.
- `fort/scripts/verify.sh` exited 0: typecheck and lint passed; 136 tests passed, with 3 configured PostgreSQL integration skips.

## Next actions

1. Harness-owned verification and Warden dispatch.
2. If approved, merge through the harness; do not close the bead before review.

## Open risks / questions

- `FlightPlan.destination` remains optional at the TypeScript construction boundary for pre-durability test compatibility, but reducer normalization persists an explicit Earth default. A schema-versioning pass (`longburn-4qs`) should make the wire requirement explicit before durable production streams.

## Failed attempts

- Requiring `FlightPlan.destination` immediately broke the existing pre-durability fixtures and persisted-event compatibility. The reducer now normalizes the explicit T0 Earth default, preserving a durable owner without rewriting the prior stream shape before 4qs.
