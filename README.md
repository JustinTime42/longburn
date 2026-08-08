# Longburn

Tier 0's authoritative simulation is deterministic and event-sourced from its first module.

## Local verification

```bash
npm run verify
```

`SimClock.production()` is always 1:1. The simulation receives elapsed time explicitly and does not read the wall clock. Code in `src/sim/` is linted against wall-clock APIs (`Date`, `performance`, and their `globalThis` forms) and unseeded randomness; simulation randomness must use `SeededRng`. Recorded seeds are unsigned 32-bit integers.

`HostTickDriver` is the live host boundary: it samples wall-clock milliseconds on a configured interval and passes only elapsed milliseconds into `AuthoritativeSimLoop`. It intentionally uses `Date.now()` because the 1:1 world is anchored to wall time, rejects backward steps, skips zero-elapsed ticks, and logs unhandled timer failures. A typed `AuthoritativeSimLoopConflictError` stops the driver rather than silently retrying a stale loop. Its clock and timer are injectable for deterministic host tests; neither enters `src/sim/`.

Every outbound state update passes through `CausalEmissionGate`. It accepts the event position and the observer's authoritative position-at-time resolver, solves the arrival-time light cone conservatively, and permits only the first integral millisecond at or after that arrival. It validates runtime provenance, blocks and reports every failure, increments the causality alert counter only for causality failures, and supplies server-calculated staleness metadata. A blocked `EmissionResult` carries its typed reason: `early-emission` is retryable at the legal tick, while malformed provenance and position failures are not. A throwing transport callback produces `transport-failure`, may have delivered the message, and is recorded without incrementing the causality alert. Incident provenance deliberately contains only event/emission times and an event-position snapshot, never the event payload or observer worldline. `CausalStateEgress` is the structural server boundary: its WebSocket subscription and REST snapshot operations accept only gate candidates, and its only raw socket/response writes are callbacks supplied to a `CausalEmissionGate`. `test/causal-transport-fence.test.ts` pins that host-boundary shape, asserts it scanned host sources, and proves its visitor rejects a deliberate raw writer. Separately, the `causal-boundary/no-raw-outbound` ESLint tripwire remains in force throughout `src/`: it rejects direct `.send`, `.publish`, `.broadcast`, and `.write` calls except in the gate implementation, and its deliberate fixture proves it goes red. The capability-facing subscription is structural; the broad outbound guard remains name-based. Neither proves aliases, computed members, arbitrary transport method names, or that a future transport binds itself only through `CausalStateEgress`; those residual limits remain until a fence that covers them exists.

`FlightPlan` is the Tier-0 maneuver aggregate. It stores only ordered, quantized pending `BurnNode`s. `AuthoritativeSimLoop` appends plan revisions and exact-time `burnStarted`/`burnEnded` events; a started burn leaves the editable plan and becomes append-only history. Replay never invokes a planner. `docked`, `accel`, `coast`, `flip`, `decel`, and `arrived` are views derived from burn history, the pending plan, and virtual time. A PlanRevision is durably recorded as `commandIssued` at its fixed T0 HQ, then applies or refuses only at its solved light-speed arrival boundary. The command record retains the issue and arrival facts needed to reconstruct in-flight commands after a restart; equal-time burns win by log order. Arrival validation refuses in this order: a replaced burn already started, an invalid plan, reintroduction of executed history, a past burn, then active-burn overlap. Fuel validation remains the next bead.

The authoritative loop persists each event before applying it locally. Writers sharing one loop instance are serialized by that instance; conflicts between loop instances remain terminal wherever the instances live, including two instances in one process. `SimulationEventStore` is the narrow durability boundary: `InMemorySimulationEventStore` is the deterministic reference used by property tests, while `PostgresSimulationEventStore` uses the [base append-only migration](db/migrations/0001_simulation_event_store.sql) and [per-stream sequence migration](db/migrations/0002_simulation_event_stream_sequence.sql). Each stream stores its RNG seed, ordered events, sim event time, and event position, preserving causality provenance for the future emission gate. Every stored event has two keys: `streamSequence` is contiguous and one-based within a stream for replay and stream resume; `globalPosition` is the globally monotone physical subscription order and can have gaps. `append` optionally accepts the current `streamSequence` and reports a typed conflict rather than appending when it is stale. PostgreSQL's unique `(stream_id, stream_sequence)` constraint arbitrates concurrent assignments; the adapter retries a constraint race from a fresh statement snapshot.

`EmissionScheduler` takes an explicit sim-time tick, constructs each envelope from its stored event position, and delays light-lagged reports until the causal solver's earliest legal tick. `DeliveryCursorStore` persists only post-acknowledgement, per-observer watermarks for those light-lagged classes. A crash after transport acknowledgement and before the cursor write produces an idempotent redelivery; a failed transport never advances the cursor. Observer-local command echoes and clock messages are live-only and are reconstructed from durable command history by the reconnect snapshot path, never resent stale. The production cursor adapter uses [migration 0003](db/migrations/0003_delivery_cursors.sql).

Apply migrations in order with stop-on-error enabled. Migration 0002 contains its own transaction so a failed backfill cannot leave the append-only update trigger disabled:

```bash
psql -v ON_ERROR_STOP=1 --dbname 'postgresql://user:password@host:5432/database' --file db/migrations/0001_simulation_event_store.sql
psql -v ON_ERROR_STOP=1 --dbname 'postgresql://user:password@host:5432/database' --file db/migrations/0002_simulation_event_stream_sequence.sql
psql -v ON_ERROR_STOP=1 --dbname 'postgresql://user:password@host:5432/database' --file db/migrations/0003_delivery_cursors.sql
```

The real PostgreSQL adapter suite is gated by `LONGBURN_TEST_DATABASE_URL`, so the Forge sandbox skips it with an explicit reason. A CI/host job with a migrated database runs it through the host `psql` executable:

```bash
LONGBURN_TEST_DATABASE_URL='postgresql://user:password@host:5432/database' npm test -- test/event-store.postgres.integration.test.mjs
```

It asserts the schema, adapter append/read ordering, database append-only triggers, and 25 replay-identical persisted runs. It does not use a mock or embedded database.
