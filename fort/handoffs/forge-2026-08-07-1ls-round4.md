# Handoff: Forge 2026-08-07 longburn-1ls round 4

## Plan executed

1. Restore the approved durable-destination contract: make `FlightPlan.destination` required and reject missing destinations during both live validation and replay.
2. Make arrival a measured physical predicate using quantized target position and velocity, capture radius, and docking-speed limits; leave an empty in-flight plan coasting.
3. Make the loop-owned worldline time-indexed across arrival and subsequent departures, then verify the full fort suite and commit the result.

## Clarifying questions

None. The approved authoritative-worldline amendment resolves the required destination, physical arrival, and piecewise-worldline decisions.

## Changes

- `FlightPlan.destination` is required at the TypeScript and reducer boundaries. Missing durable destinations now refuse; replay no longer manufactures Earth.
- Arrival records include quantized position and velocity gaps and are appended only inside the approved 1e9 m / 1e5 mm/s physical bounds.
- The reducer retains ordered departure and arrival boundaries. `shipPositionAt(t)` uses transit before `arrivedAtMs`, the target-body worldline from arrival, and a fresh departure stamp when a docked ship fires again.
- The propagator now exposes its quantized velocity state for the docking comparison.
- Regressions cover missing destinations, dry mid-transit plans, pre-arrival time queries after an arrival record exists, and repeat departures.

## Verification

- `CI=1 fort/scripts/verify.sh` — pass: typecheck, lint, shellcheck, 22 test files passed, 1 skipped; 138 tests passed, 3 skipped.
- `git diff --check` — pass.

## Surprises

- The post-arrival departure path needed an explicit boundary record before `burnStarted`; preserving the boundary history is what keeps position provenance a function of queried time rather than current reducer state.

## Bead status

- `longburn-1ls` remains in progress pending harness review. `longburn-ksj` is referenced because its own-time event-provenance fix remains folded into this pass.

Model: gpt-5.6-terra
