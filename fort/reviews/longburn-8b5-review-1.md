# Warden Review 1: longburn-8b5

Reviewer: Sereth Twicewalked (Warden), Claude Opus, fresh context, read-only. 2026-08-04.
Subject: branch `bead/8b5`, commits `d2ec784`, `2b7cd42` (author: Orin Slowfire, GPT-5.6 Terra via Codex).
Method: read charter + all five source files; probed both guards empirically (eslint --stdin; mutation-tested a scratchpad copy with four injected regressions; worktree never modified).

## VERDICT: request_changes

The work is honest. All three deliverables are genuinely present, the lint ban really fires, and the property test caught two of four injected regressions. No reward-hacking. But a wall-clock read in sim core was demonstrated that passes BOTH the lint gate and the full test suite, and a silent RNG-algorithm change passes all three tests. For the maiden bead whose purpose is making standing orders 10-11 mechanical, those are the thing itself. Both fixes are ~10 lines; nothing needs rework.

## Findings

1. **eslint.config.mjs:10-22 — blocker.** Ban covers only `Date.now` and `Math.random` as member/destructured access; `new Date().getTime()`, `performance.now()`, and `globalThis.Date.now()` all pass clean (confirmed by probe). SO 10's fence is broader than SO 11's named calls. Fix: `no-restricted-syntax` for `NewExpression[callee.name="Date"]` plus `performance.now` / `Date.parse` entries.
2. **src/sim/event-log.test.ts:24-27 — blocker.** Property compares `replaySegment(seed, events)` against itself in-process: proves purity, not stability. Changing the mulberry32 constant at rng.ts:14 (0x6d2b79f5 → 0x6d2b79f6) passed all 3 tests, so a change that rewrites every historical replay goes undetected. Fix: golden-vector test pinning a known (seed, events) pair to a literal SimState.
3. **Findings 1+2 compose — blocker.** `const BOOT_SKEW = new Date().getSeconds();` at module scope, applied inside replaySegment: lint passed, all tests passed. A wall-clock read constant within one process is invisible to intra-process self-comparison. This is the exact bypass the bead exists to close.
4. **src/sim/clock.ts:48 — should-fix.** `multiplier` scales caller-supplied elapsedMs, so the same event log replays to different SimTimeMs depending on constructor; replaySegment masks it by hardcoding `SimClock.production`. Drop it or record it in the log.
5. **src/sim/clock.ts:49-51 — should-fix.** Fractional multiplier makes `next` non-integral and throws the overflow error, misreporting the cause.
6. **eslint.config.mjs / package.json:10 — should-fix.** Nothing in `npm run verify` proves the lint rule exists; deleting the rule keeps the suite green. Add a fixture asserting the rule fires.
7. **src/sim/rng.ts — nit.** SeededRng has no direct tests.
8. **src/sim/rng.ts:10 — nit.** `#state = seed >>> 0` silently aliases seeds ≥ 2^32 after the constructor accepted them; undocumented aliasing in a determinism-critical component.
9. **fort/events/ — nit (process).** No events emitted by the Forge session; cold start (the sandbox blocked emission until forge.sh was fixed), not a lapse unique to this seat.
10. **fort/handoffs/forge-2026-08-03-completion.md:12 — nit, NOT falsification.** "replays ... identically from the recorded seed and append-only log" is literally true but reads stronger than what is proven (finding 2). Append a clarification per SO 7; never edit. All other verified-fact claims in both handoffs checked out, including the Date.now() probe rejection, reproduced independently.

## Coverage gaps

Determinism is proven within a process, not across processes or versions: no golden vector pins RNG output or replay results, so "replayable in a dispute two months from now" is held by no test. No producer exists — nothing in src/sim/ records an event log from a running sim; replaySegment is only exercised against logs synthesized by fc.array, so the record-then-replay round-trip is unproven. Serialization and cross-process replay untested. Lint rule's own existence unverified by the suite. SO 12 untouched, correctly (out of scope; tier fence holds).

What the suite genuinely proves (confirmed by mutation): a module-level shared RNG leaking state across replays fails the property; a varying wall-clock read in `advance` fails both test files. `npm run verify` is honest: eslint really lints all five files, tsc runs strict with noUncheckedIndexedAccess, vitest is non-watch with no --passWithNoTests.
