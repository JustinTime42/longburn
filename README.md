# Longburn

Tier 0's authoritative simulation is deterministic and event-sourced from its first module.

## Local verification

```bash
npm run verify
```

`SimClock.production()` is always 1:1. The simulation receives elapsed time explicitly and does not read the wall clock. Code in `src/sim/` is linted against wall-clock APIs (`Date`, `performance`, and their `globalThis` forms) and unseeded randomness; simulation randomness must use `SeededRng`. Recorded seeds are unsigned 32-bit integers.

Every outbound state update must pass through `CausalEmissionGate`. It accepts the event position and the observer's authoritative position-at-time resolver, solves the arrival-time light cone conservatively, and permits only the first integral millisecond at or after that arrival. It validates runtime provenance, blocks and reports every failure, increments the causality alert counter, and supplies server-calculated staleness metadata. The gate has no transport-specific behavior; the event-store and visibility-filter work supplies its sole raw transport callback. The `causal-boundary/no-raw-outbound` ESLint rule is a name-based tripwire: it rejects direct `.send`, `.publish`, `.broadcast`, and `.write` calls outside the gate. It does not prove that aliases, computed members, or arbitrary transport method names traverse the gate; `longburn-din.5` must provide a structural transport boundary before it adds transport implementations. `test/causal-transport-fence.test.ts` is the tripwire's deliberate-violation fixture.

The authoritative loop persists each event before applying it locally. `SimulationEventStore` is the narrow durability boundary: `InMemorySimulationEventStore` is the deterministic reference used by property tests, while `PostgresSimulationEventStore` uses the [base append-only migration](db/migrations/0001_simulation_event_store.sql) and [per-stream sequence migration](db/migrations/0002_simulation_event_stream_sequence.sql). Each stream stores its RNG seed, ordered events, sim event time, and event position, preserving causality provenance for the future emission gate. Every stored event has two keys: `streamSequence` is contiguous and one-based within a stream for replay and stream resume; `globalPosition` is the globally monotone physical subscription order and can have gaps. `append` optionally accepts the current `streamSequence` and reports a typed conflict rather than appending when it is stale. PostgreSQL's unique `(stream_id, stream_sequence)` constraint arbitrates concurrent assignments; the adapter retries a constraint race from a fresh statement snapshot.

Apply migrations in order with stop-on-error enabled. Migration 0002 contains its own transaction so a failed backfill cannot leave the append-only update trigger disabled:

```bash
psql -v ON_ERROR_STOP=1 --dbname 'postgresql://user:password@host:5432/database' --file db/migrations/0001_simulation_event_store.sql
psql -v ON_ERROR_STOP=1 --dbname 'postgresql://user:password@host:5432/database' --file db/migrations/0002_simulation_event_stream_sequence.sql
```

The real PostgreSQL adapter suite is gated by `LONGBURN_TEST_DATABASE_URL`, so the Forge sandbox skips it with an explicit reason. A CI/host job with a migrated database runs it through the host `psql` executable:

```bash
LONGBURN_TEST_DATABASE_URL='postgresql://user:password@host:5432/database' npm test -- test/event-store.postgres.integration.test.mjs
```

It asserts the schema, adapter append/read ordering, database append-only triggers, and 25 replay-identical persisted runs. It does not use a mock or embedded database.
