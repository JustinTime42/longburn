# Warden Review 1: longburn-6yu

Reviewer: Sereth Twicewalked (they/them), Warden of Farlantern  
Model: GPT-5.6 Sol (Opus rung session-limit failover until 12pm AKDT)  
Date: 2026-08-04  
Commit: `0020d0c` by Orin Slowfire (Forge, GPT-5.6 Terra)  
Branch: `bead/6yu`

## VERDICT: escalate

The implemented predicate is not standing order 12. It accepts emission at 99.9% of required light-time by multiplying the physical requirement by `1 - 0.001`. At a distance of exactly one light-second, the gate sends at 999 ms, one millisecond before light could arrive. At longer distances the leak grows proportionally. This is an invariant-math failure, so the bead must not merge and the verdict is escalated under the review instruction.

The design note and governing texts conflict. The draft design note permits a relative tolerance for endpoint motion, but the charter, GDD security requirement, bead description, and explicit review direction require `emission_time - event_time >= distance/c` with absolute server-side filtering. A tolerance cannot weaken that inequality. Endpoint-model uncertainty must be resolved by conservative distance/provenance modeling or delayed emission, never early delivery.

## Findings

1. **`src/sim/causality.ts:9-10,66-68`, critical:** `CAUSALITY_RELATIVE_TOLERANCE = 0.001` lowers the required light-time. Scratch probe at distance `299_792_458 m`, event time `0 ms`, emission time `999 ms` returned `{ sent: true }`, called transport, and recorded no incident. Exact light-time is `1000 ms`. Remove every epsilon that weakens the predicate. Since simulation time is integral milliseconds, a safe scheduling threshold is the ceiling of the exact floating-point light-time; the assertion itself must never floor or round down.

2. **`src/sim/causality.test.ts:45-96`, blocker:** the property test uses a fixed fast-check seed and a real generated Cartesian space, but it generates only messages made eligible in advance. It does not generate both sides of the boundary or prove the earliest legal millisecond. Mutation probe wrapping `requiredLightTravelMs` in `Math.floor(...)` left all three causality tests green. Changing `c` from `299_792_458` to `299_792_459` also stayed green. The suite did catch an inequality flip (3/3 tests failed) and a 10x slower `c` (property failed), so it detects gross breakage but not the one-millisecond class the safety requirement names. Add exact boundary tests at `ceil(distance/c*1000)-1` and at `ceil(...)`, plus a property that generates blocked and eligible cases independently of the production helper.

3. **`src/sim/causality.ts:63-74,99-113`, blocker:** runtime time provenance is not validated. Type branding protects ordinary TypeScript callers but not decoded network/database data, JavaScript, or an unsafe cast. `eventTime = NaN` makes `actualElapsedMs` and `stalenessMs` `NaN`; because `NaN < required` is false, the gate sends the message. The scratch probe returned `{ sent: true }`. Validate both times as non-negative safe-integer simulation milliseconds before comparison, and fail closed on every malformed provenance value. This also prevents staleness metadata from lying to the client.

4. **`src/sim/causality.ts:99-109`, blocker against acceptance:** a thrown distance/provenance computation does not call transport, which the scratch getter-throw probe confirmed. A normal causality violation is also reported before returning `{ sent: false }`, and transport remains untouched. However, unexpected provenance/distance errors are rethrown without an incident, and no counter/alert callback exists anywhere in the API. The design acceptance requires incident-grade recording plus a counter/alert increment in production. Make all validation/computation failures fail closed and observable without allowing a reporting failure to reach transport.

5. **`src/sim/causality.ts:77-97` and repository-wide outbound search, blocker before dependent transport work:** there is no current transport outside the test callbacks, so no present raw-send bypass exists. The class does not mechanically force future callers through it. Any later module can retain or call a raw transport callback, and acceptance asks for grep/lint proof that this is the only outbound path. Define the transport boundary used by `longburn-din.5` so its public capability is the gate, then add an architecture/contract test or lint fence that goes red on a raw outbound path. README prose alone is not enforcement.

6. **`src/sim/causality.ts`, verified:** units are otherwise correct: positions are meters, `c` is exact SI meters per second, and multiplication by 1,000 converts seconds to simulation milliseconds. The production module reads no wall clock. `src/sim/**/*.ts` receives the determinism lint rules; injecting `Date.now()` into a scratch copy of this file produced both `no-restricted-properties` and `no-restricted-syntax` errors.

7. **`src/sim/causality.test.ts:45-96`, partial acceptance only:** fast-check is explicitly seeded (`0x6ca551`) and runs 200 generated streams of 1 to 40 events. Liveness is only proven for a synthetic stream of already-eligible messages, not delayed visibility where initially blocked information eventually becomes eligible. The scenarios use an origin event and arbitrary observer coordinates, not the design note's bodies, ships, and mid-transit observers. Those richer producer scenarios may depend on later sim modules, but the harness still needs an independent boundary property now.

8. **Staleness and valid inputs, verified with caveat:** for valid finite `SimTimeMs` values, the predicate prevents negative staleness, including at zero distance, and emitted staleness is computed server-side as `emissionTime - eventTime`. Finding 3 breaks that guarantee for malformed runtime provenance.

9. **Tier fence and footprint, verified:** the commit adds only the harness, its tests, README guidance, and the Forge handoff. It introduces no player topology, relativistic correction, market behavior, or other post-Tier-0 scope.

## Verification and mutation record

- Target worktree remained clean and read-only. All mutations ran in `/tmp/longburn-6yu-review.cEI31r/`.
- Baseline `npm run verify` passed: lint, strict TypeScript, and 9 tests across 5 files.
- Exact one-light-second probe: expected block at 999 ms; implementation sent. Failed as a safety test.
- Thrown provenance getter: gate threw, transport was not called. Fail-closed transport behavior passed, observability did not.
- `NaN` event time: expected block; implementation sent with non-finite staleness. Failed.
- `Math.floor` light-time mutation: stock 3/3 causality tests passed. Mutation survived.
- Inequality `<` to `>` mutation: stock 3/3 causality tests failed. Mutation killed.
- `c + 1 m/s` mutation: stock 3/3 causality tests passed. Mutation survived.
- 10x slower `c` mutation: stock property test failed. Mutation killed.
- Injected `Date.now()` in `src/sim/causality.ts`: ESLint failed with both wall-clock guards. Mutation killed.

Required disposition: reconcile the draft design note with standing order 12 in favor of the absolute invariant, remove the weakening tolerance, validate runtime provenance, make all failure modes observable and fail-closed, and add boundary-sensitive tests before a fresh Warden review.
