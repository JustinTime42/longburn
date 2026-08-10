# Handoff: Forge 2026-08-09T21:14:08-08:00

## Plan executed

1. Read the fort law, operational record, Forge protocol, Beads context, founding specifications, prior j1av handoff, and the Warden's R2 blocker recorded on `longburn-j1av`.
2. Preserve the sound observer-local delivery-sequence compaction and strengthen its caller contract: complete durable light-lagged projection, acknowledged entries included, append-only in global-position order.
3. Refuse incomplete or renumbered projections before duplicate suppression, add the Warden's regression shape, update the host boundary test to meet the contract, and run the bare fort verifier.
4. Commit the implementation, emit the append-only handoff event, commit this handoff, and end for harness-owned verification and review.

## Clarifying questions

1. None. I chose the Warden's cheaper accepted path: retain per-pass delivery ranking, make its complete-projection precondition explicit, and fail closed when the observable cursor state proves the projection is incomplete or renumbered.

Model: gpt-5.6-terra

## State of work

- `longburn-j1av` remains `in_progress`. R2 remediation is committed; bead disposition and review are harness-owned.

## Verified facts

- Commit `446337d5dbfefd36ecb12025be90d1a779b3dc50` adds the named `DeliveryProjectionViolation` refusal before ledger duplicate suppression, rather than changing the delivery-sequence compaction.
- `EmissionSchedulerOptions`, `EmissionScheduler.run()`, and `CausalStateHost.run()` now require the observer's complete durable light-lagged projection, acknowledged messages included, append-only in global-position order.
- This strengthens the precondition ratified under `longburn-uso1` item (3), which said every pass presents all unacknowledged messages. The stronger complete-projection contract is necessary because delivery sequence is a per-pass rank; callers that use an above-watermark-only query now receive a typed refusal rather than silently losing a report.
- The scheduler rejects a pass whose light-lagged candidate count cannot cover the compacted watermark, and rejects a delivered-entry sequence/message-ID mismatch above the watermark.
- `src/sim/emission-scheduler.test.ts` covers the review trace: a first pass presents three candidates, acknowledges two, and defers the third; the later pass that presents only that unacknowledged remainder raises `DeliveryProjectionViolation` and sends nothing.
- The host quarantine test now re-presents the complete durable projection on its later pass, preserving its malformed-record behavior without violating the strengthened scheduler contract.
- Bare `FORT_ACTOR=orin FORT_SEAT=forge FORT_TARGET=longburn-j1av fort/scripts/verify.sh --no-emit` exited 0: typecheck, lint, 243 tests across 37 files, and shellcheck passed; 5 database-gated tests in 2 files were skipped because no test database URL was supplied.

## Next actions

1. End this Forge session for the harness-owned verification and dispatch flow.

## Open risks / questions

- The live PostgreSQL integration path remains database-gated in this Forge sandbox. I did not apply migrations, per Forge protocol.

## Failed attempts

- The first full verifier run failed because an existing host test passed only its malformed record on a later call. That is an invalid partial durable projection under the new contract; the test now supplies the complete projection and the bare rerun exits 0.

Unrequested behavior changes: none

## R3 correction (2026-08-10)

The R2 claim that every above-watermark-only query receives a typed refusal was false. Its count-only guard missed the minimal one-acknowledged, one-new projection and the alternating-loss trace. R3 replaces that claim with a persisted acknowledged-source-position horizon and a guard that refuses a candidate assigned inside the compacted delivery prefix when its immutable source global position is newer than that horizon.
