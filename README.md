# Longburn

Tier 0's authoritative simulation is deterministic and event-sourced from its first module.

## Local verification

```bash
npm run verify
```

`SimClock.production()` is always 1:1. The simulation receives elapsed time explicitly and does not read the wall clock. Code in `src/sim/` is linted against wall-clock APIs (`Date`, `performance`, and their `globalThis` forms) and unseeded randomness; simulation randomness must use `SeededRng`. Recorded seeds are unsigned 32-bit integers.

Every outbound state update must pass through `CausalEmissionGate`. It accepts the event position and the observer's authoritative position-at-time resolver, solves the arrival-time light cone, and permits only the first integral millisecond at or after that arrival. It validates runtime provenance, blocks and reports every failure, increments the causality alert counter, and supplies server-calculated staleness metadata. The gate has no transport-specific behavior; the event-store and visibility-filter work supplies its sole raw transport callback. The `causal-boundary/no-raw-outbound` ESLint rule mechanically rejects raw outbound calls outside that gate, with `test/causal-transport-fence.test.ts` as its deliberate-violation fixture.
