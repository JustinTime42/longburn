# Longburn

Tier 0's authoritative simulation is deterministic and event-sourced from its first module.

## Local verification

```bash
npm run verify
```

`SimClock.production()` is always 1:1. The simulation receives elapsed time explicitly and does not read the wall clock. Code in `src/sim/` is linted against wall-clock APIs (`Date`, `performance`, and their `globalThis` forms) and unseeded randomness; simulation randomness must use `SeededRng`. Recorded seeds are unsigned 32-bit integers.

Every outbound state update must pass through `CausalEmissionGate`. It accepts the event position and the observer's authoritative position-at-time resolver, solves the arrival-time light cone conservatively, and permits only the first integral millisecond at or after that arrival. It validates runtime provenance, blocks and reports every failure, increments the causality alert counter, and supplies server-calculated staleness metadata. The gate has no transport-specific behavior; the event-store and visibility-filter work supplies its sole raw transport callback. The `causal-boundary/no-raw-outbound` ESLint rule is a name-based tripwire: it rejects direct `.send`, `.publish`, `.broadcast`, and `.write` calls outside the gate. It does not prove that aliases, computed members, or arbitrary transport method names traverse the gate; `longburn-din.5` must provide a structural transport boundary before it adds transport implementations. `test/causal-transport-fence.test.ts` is the tripwire's deliberate-violation fixture.

The authoritative loop persists each event before applying it locally. `SimulationEventStore` is the narrow durability boundary: `InMemorySimulationEventStore` is the deterministic reference used by property tests, while `PostgresSimulationEventStore` uses [the append-only migration](db/migrations/0001_simulation_event_store.sql). Each stream stores its RNG seed, ordered events, sim event time, and event position, preserving causality provenance for the future emission gate. PostgreSQL integration tests are intentionally skipped in this sandbox because no live server is available; CI or a host must run them against a real database.
