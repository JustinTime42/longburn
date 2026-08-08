# Handoff: Forge 2026-08-08, longburn-l4cw, round 2

## Plan executed

1. Read the charter, operating record, Forge seat protocol, founding specifications, Beads context, prior Forge handoff, and the E4 egress composition tests.
2. Machine-check the moving-observer oracle, then correct only Warden blockers b1-b4: per-event ordering, moving worldline geometry, independent oracle sign, and egress hook coverage.
3. Run focused and fort-wide verification, emit the verifier record, and commit this append-only handoff.

## Clarifying questions

1. None. The remediation instructions identify the exact test fixtures and assertions to restore.

Model: gpt-5.6-terra

## State of work

- `longburn-l4cw` remains `in_progress` for harness-owned review and completion processing.

## Changes

- Swapped the per-event dispute fixture's global positions: the farther report is now position 1 and the near report position 2. At the shared tick, position 2 must emit even while position 1 defers, detecting head-of-line blocking.
- Corrected the independent constant-velocity retarded-time quadratic to use `+2vY`, with explicitly named coefficients.
- Made the moving observer scenario recede along the line of sight and asserted its arrival tick differs from the stationary oracle. The requested Node calculation observed stationary `748184` versus receding `748254`.
- Restored egress-boundary coverage that a causality refusal reports `early-emission` and increments the causality-failure counter exactly once.

## Verification

- Focused `npm test -- --run src/host/causal-state-egress.e2e.test.ts src/host/causal-state-egress.test.ts`: 2 files, 9 tests passed.
- Bare `FORT_ACTOR=orin FORT_SEAT=forge FORT_TARGET=longburn-l4cw fort/scripts/verify.sh`: passed and emitted its normal verification record.
  - 29 test files passed, 1 skipped (30).
  - 176 tests passed, 4 skipped (180).
- `git diff --check`: passed.

## Surprises

- The first along-axis trial placed both source and observer on positive y, which was an approaching rather than receding geometry. The pre-change calculation made that visible, so the fixture is now source `-y`, observer velocity `+y`; it produces a 70 ms distinct boundary.
