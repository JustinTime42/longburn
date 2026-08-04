# Longburn

Tier 0's authoritative simulation is deterministic and event-sourced from its first module.

## Local verification

```bash
npm run verify
```

`SimClock.production()` is always 1:1. The simulation receives elapsed time explicitly and does not read the wall clock. Code in `src/sim/` is linted against `Date.now()` and `Math.random()`; simulation randomness must use `SeededRng`.
