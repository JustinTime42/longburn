# Handoff: Forge 2026-08-10T10:26:15-08:00

## Plan executed

1. Read the fort law, operational record, Forge protocol, Beads context, founding specifications, prior j1av handoff, and the Overseer's R4 Option B ruling.
2. Replace batch-derived delivery ranks and their projection guards with durable, per-observer message-to-sequence assignments allocated from a persisted counter before emission.
3. Separate permanent assignment facts from compactable acknowledgement receipts; update the in-memory and PostgreSQL stores, re-runnable migration, documentation, and regression coverage.
4. Run focused tests and the bare fort verifier, emit the implementation event, path-scope commit the implementation, write and commit this fresh handoff, then end for harness-owned verification and review.

## Clarifying questions

1. None. The Overseer's explicit R4 Option B ruling resolves the only material design choice. I retained durable assignments after receipt compaction because later partial or backfilled projections must look up the immutable fact; only acknowledgement receipts compact.

Model: gpt-5.6-terra

## State of work

- `longburn-j1av` remains `in_progress`. The R4 Option B implementation is committed; verifier, review, and live-Postgres execution remain harness and Mayor work.

## Verified facts

- Commit `2719e7c246e9af284cd1cfe46892430db1d741b0` introduces `DeliveryCursorStore.assign()`: it looks up or transactionally allocates an immutable `(observer, messageId) -> deliverySequence` fact before scheduler emission.
- `src/sim/emission-scheduler.ts` no longer derives a sequence from a presented batch and no longer has rank/projection-violation guards. Its module documentation records immunity to incomplete, gapped, reordered, and backfilled projections.
- `db/migrations/0004_delivery_acknowledgement_ledger.sql` separates permanent `delivery_assignments` from compactable `delivery_acknowledgements`, adds persisted `next_delivery_sequence`, and remains re-runnable by dropping the new table before recreation.
- `src/sim/emission-scheduler.test.ts` proves both a message presented alone after compaction and the Warden's executed gapped 10/30 then 20 trace deliver the delayed/new message. `src/sim/delivery-cursor.test.ts` proves assignments survive receipt compaction and subsequent lookup returns the original sequence.
- `README.md` and `src/host/causal-state-host.ts` now state only the durable-fact mechanism actually provided, including why it is immune to visibility changes and backfill shape.
- `fort/scripts/emit.sh` emitted `implementation.verified` for this work.
- Bare `FORT_ACTOR=orin FORT_SEAT=forge FORT_TARGET=longburn-j1av fort/scripts/verify.sh --no-emit` exited 0: typecheck, lint, shellcheck, 245 tests passed across 37 files; 5 database-gated tests in 2 files were skipped because no test database URL was supplied.

Unrequested behavior changes: none

## Next actions

1. Mayor runs the documented fresh-database PostgreSQL integration leg before merge.
2. Harness verifies and dispatches Warden review.

## Open risks / questions

- Durable assignment facts intentionally remain after acknowledgement receipt compaction. This is required to preserve immutable lookup through partial/reordered/backfilled projections, but makes assignment-retention volume a separate future scaling concern rather than silently reintroducing rank derivation.
- The live PostgreSQL integration path did not run in this Forge sandbox. I did not apply migrations, per Forge protocol.

## Failed attempts

- None after the Option B ruling. The first focused run exposed two implementation details before full verification: PostgreSQL must check the compacted watermark before inserting a duplicate receipt, and the gapped regression needs a genuinely later causal arrival. Both were corrected before the green bare verifier.
