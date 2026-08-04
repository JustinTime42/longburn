# Handoff: Forge 2026-08-04T13:06:00-08:00
Model: GPT-5.6 Codex

## State of work

- `longburn-6yu` remains in progress, ready for the required fresh Warden review. Round 2 replaces the rejected tolerance-based causal gate with an absolute arrival-time light-cone gate.

## Verified facts

- `src/sim/causality.ts` removes `CAUSALITY_RELATIVE_TOLERANCE`, validates both simulation times at runtime, solves the receiver worldline by bounded fixed-point iteration, and schedules/asserts only at `ceil(arrival)`.
- The gate fails closed for malformed provenance, malformed position data, thrown worldline evaluation, and non-convergence. Each blocked emission attempts incident recording and the causality counter/alert independently, so reporting failure cannot release transport.
- `src/sim/causality.test.ts` independently tests `ceil(exact)-1` blocked and `ceil(exact)` admitted, runs a seeded 400-case independent boundary property, proves delayed messages eventually pass with server staleness, and includes a non-convergent worldline fixture.
- `eslint.config.mjs` supplies a production lint fence against raw outbound calls everywhere under `src/`; `test/causal-transport-fence.test.ts` proves it with a deliberate raw-send fixture.
- `npm run verify` passed: ESLint, strict TypeScript build, and Vitest (13 tests across 6 files). `git diff --check` passed.

## Next actions

1. Request a fresh Warden review of this commit, including the previous `Math.floor` and `c+1` mutation probes.
2. If approved, close `longburn-6yu` and unblock `longburn-din.5` when its remaining dependency is complete.

## Open risks / questions

- The light-cone solver depends on the future trajectory evaluator supplied by the event-store/visibility implementation. That evaluator must be deterministic and return the same ephemeris worldline used by the simulation.

## Failed attempts

- A filesystem-scanning transport-fence test required unavailable Node type declarations. The fence is now an ESLint rule scoped to all production `src/**/*.ts`, with a deliberate-violation test, which is stronger and type-checks in the current dependency set.
