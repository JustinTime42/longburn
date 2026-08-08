# Handoff: Forge 2026-08-07T19:21:00-08:00

## Plan executed

1. Read the fort charter, operational record, Forge protocol, Beads context, Tier 0 specifications, prior Forge handoff, bead, and Warden r1 findings.
2. Replace the PostgreSQL acknowledgement CTE with short ordinary transactional statements, correctly model SQL NULL cursor rows, and preserve per-message accounting without cross-event delivery dependencies.
3. Restore the shared cursor contract with a stateful PostgreSQL double, add the gated live database test, and supersede the edited migration with a re-runnable `0004`.
4. Run focused checks and the full Fort verifier, then record this append-only handoff and commit the repair path-scoped.

## Clarifying questions

1. None. The bead and Warden remedies fully specified the durable cursor correction.

Model: gpt-5.6-terra

## State of work

- `longburn-uso1` remains `in_progress`. The Warden r1 Postgres blockers are implemented; session-close review and bead disposition remain harness-owned.

## Verified facts

- `PostgresDeliveryCursorStore.acknowledge()` now uses `BEGIN`, acknowledgement insert with conflict no-op, cursor creation, `SELECT ... FOR UPDATE`, watermark update, compaction delete, remainder select, then `COMMIT`. Any duplicate or failure runs `ROLLBACK`.
- Cursor deserialization treats the `LEFT JOIN`'s SQL NULL acknowledgement columns as absent. A fully compacted cursor therefore reads as `{ lowWatermark: 3, delivered: [] }` instead of throwing.
- An acknowledgement at or below the locked watermark is rejected and rolled back before it can make the temporary ledger shape invalid.
- `src/sim/delivery-cursor.test.ts` runs `assertCursorContract` against both stores using a transaction-aware double that returns SQL NULL for an empty remainder. It also proves the ordinary statement path and duplicate rollback.
- `test/event-store.postgres.integration.test.mjs` now covers the durable cursor adapter, including its NULL remainder state, when `LONGBURN_TEST_DATABASE_URL` is supplied.
- `0003` is restored to its original single-watermark migration and `0004_delivery_acknowledgement_ledger.sql` drops and recreates the pre-durability ledger schema. README migration instructions now apply both in order.
- Bare `FORT_ACTOR=orin FORT_SEAT=forge FORT_TARGET=longburn-uso1 fort/scripts/verify.sh` exited 0 in `/home/justin/dev/longburn-worktrees/uso1`: typecheck, lint, tests, and shellcheck passed. Vitest reported 166 passing tests and 4 skipped database-gated tests across 27 passing files and 1 skipped file.

## Next actions

1. End this Forge session for the harness-owned verification and dispatch flow.

## Open risks / questions

- The live PostgreSQL test is intentionally skipped here because `LONGBURN_TEST_DATABASE_URL` is absent. Its command sequence is exercised by the stateful contract double, but the psql-backed test needs the provisioned test database to run.

## Failed attempts

- The initial contract-double implementation only modeled active ledger rows. Compaction deletes rows at or below the watermark, so a repeated compacted position had to be rejected from the locked watermark before deserializing its transient just-inserted row. The corrected implementation and regression now cover that path.
- The first handoff-event invocation supplied its target positionally, but `emit.sh` accepts target only with `-t`; it produced a target-less append-only event. It was not altered or removed, and a correctly scoped companion event was emitted immediately.
