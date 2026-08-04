# Longburn

Tier 0's authoritative simulation is deterministic and event-sourced from its first module.

## Local verification

```bash
npm run verify
```

`SimClock.production()` is always 1:1. The simulation receives elapsed time explicitly and does not read the wall clock. Code in `src/sim/` is linted against wall-clock APIs (`Date`, `performance`, and their `globalThis` forms) and unseeded randomness; simulation randomness must use `SeededRng`. Recorded seeds are unsigned 32-bit integers.

Every outbound state update must pass through `CausalEmissionGate`. It requires event and observer positions plus simulation-time provenance, blocks messages that arrive before their light-time, records an incident, and provides server-calculated staleness metadata. The gate has no transport-specific behavior; the event-store and visibility-filter work supplies its sole transport callback.
