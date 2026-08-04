# Warden Review 3: longburn-6yu

Reviewer: Sereth Twicewalked (they/them), Warden of Farlantern
Model: Claude Opus 5 (frontier rung)
Date: 2026-08-04
Commit: `324ab7a` by Orin Slowfire (Forge, GPT-5.6 Terra)
Branch: `bead/6yu`, worktree `/home/justin/dev/longburn-worktrees/6yu`
Incremental diff reviewed: `b27bbe6..324ab7a`
Governing texts: charter SO 10-13, GDD §4.5/§6, and `docs/specs/causality-invariant-design.md` as amended per the Overseer ruling of 2026-08-04.

## VERDICT: approve — merge may proceed

All three required disposition items from round 2 are met, and I could not construct a case that emits early. The conservative return is real and I verified the reasoning rather than accepting it: the added margin is the final fixed-point step, which for a contraction of ratio v/c dominates the remaining error by roughly `(1-v/c)/(v/c)`, about three thousand times over at Tier 0 speeds. Both round-2 survivors are dead, killed by the new moving-receiver property, and that property's expectations come from a closed-form quadratic that hardcodes c and never touches the production solver. Across four independent exact-oracle batteries totalling about 324,000 cases, including two adversarial constructions aimed squarely at the float-ceil boundary, I measured zero under-estimates of arrival and zero early scheduling ticks. The README no longer overclaims the fence.

Ten mutations, ten kills. This harness can now see the dimension it was blind to in round 2.

## Disposition item 1: conservative return — CLOSED

`requiredArrivalTimeMs` now returns `nextArrivalTimeMs + precedingStepMs` where `precedingStepMs` is the final step that satisfied the convergence test, so the returned value can only err late.

**The reasoning holds, with a stated validity domain.** The iteration `t_{n+1} = f(t_n)` with `f(t) = t_e + |obs(t) − p_e|/c` has `|f'| = |radial velocity|/c ≤ v/c = L`. The standard contraction bound gives `|t_{n+1} − t*| ≤ L/(1−L) · |t_{n+1} − t_n|`, so adding the full step is conservative whenever `L/(1−L) ≤ 1`, that is for any receiver below half light speed. At the Tier 0 speeds the design note contemplates (100 km/s is `L ≈ 3.3e-4`) the margin exceeds the true remainder by about 3000x. I stressed the domain boundary deliberately (probe F): under-estimates first appear at exactly `v/c = 0.5` at float-noise magnitude (worst −4.7e-10 ms), reach −1.3e-3 ms at `v/c = 0.7` where three quarters of cases already fail closed on non-convergence, and vanish at 0.9c and above because every case fails closed. Tier 0 is four orders of magnitude away from that, and the design note's non-goals already fence relativistic regimes out, so this is a recorded limit rather than a finding. If anything in this sim ever exceeds 0.5c, the margin must become `step · L/(1−L)`.

**The zero-step case is sound, and it is the reason the exact static boundary survives.** Orin's reported nuance checks out. For a stationary receiver the first iterate is already the float fixed point, `precedingStepMs` is exactly 0, no margin is added, and the one-light-second case returns exactly 1000.0 (probe B), so 999 blocks and 1000 passes as it must. A zero step means `f(t_n)` rounded to `t_n`, which bounds the true residual at ulp scale (about 6e-11 ms at the largest arrival magnitudes in range), far below the 1 ms grid. I did not take that on argument. Probe C ran 300,000 adversarial stationary distances, each the smallest integer meter count strictly past an integer millisecond of light travel, and found zero ceil undershoots. Probe D built 20,000 adversarial *moving* cases, tuning the receiver's radial offset so the exact arrival lands one meter past an integer tick, and found zero under-estimates and zero early admissions. The unconditional-margin alternative Orin tried and rejected would indeed have pushed the exact static boundary to 1001; the final-step form is the better answer.

**Cost to liveness is negligible.** The margin is bounded by `CONVERGENCE_MS` = 0.001 ms; probe A measured the largest actual over-estimate at 0.000997 ms, and in 3000 randomized cases (probe E) the margin never pushed the scheduling tick a millisecond later.

## Disposition item 2 (was blocker): moving-receiver boundary property — CLOSED

The new property `independently generates both sides of moving-receiver light-cone boundaries` runs 800 seeded cases over linear worldlines with distances to 2e10 m and speeds to 172 km/s.

**The oracle is genuinely independent.** `independentLinearArrivalTimeMs` hardcodes `299_792_458` as a literal rather than importing `SPEED_OF_LIGHT_METERS_PER_SECOND`, forms the quadratic coefficients itself, and takes the smallest non-negative root by the numerically stable form `2|p₀|²/(√disc − 2p₀·v)`. It never calls the production solver. That is what makes the c+1 mutation a meaningful kill rather than a circular one.

**Both round-2 survivors are dead.**

- `CONVERGENCE_MS` 0.001 → 1000: **killed** by this property. Worth noting the kill direction changed. Before the margin, loosening convergence let the gate emit early and nothing noticed; now the step is added to the return, so the same mutation makes the gate over-block and the "admits at `ceil`" assertion fires. The convergence constant can no longer be weakened in the unsafe direction at all, which is a structural improvement over merely testing it.
- Returning stale `arrivalTimeMs` instead of `nextArrivalTimeMs`: **killed** by the oracle comparison, `expected 3.335640951981522 to be greater than or equal to 3.3356409519815227`.

**The property also guards the margin itself.** Removing the conservative margin entirely (returning the bare converged iterate, exactly the round-2 behavior) is now **killed** by the same assertion. The conservatism is tested, not merely asserted in a comment.

**Not vacuous.** I instrumented the predicate body: all 800 runs execute (fast-check replaces `fc.pre` discards with fresh samples), the minimum generated gap between the exact arrival and its tick was 0.0109 ms, and the maximum generated speed was 172 km/s. The `fc.pre(gap > 0.01)` guard sits 10x above the largest possible margin, and it is self-guarding: raising `CONVERGENCE_MS` past that headroom trips the property, as the M1 kill shows.

## Disposition item 3: README versus fence — CLOSED

The README now reads: the rule "is a name-based tripwire: it rejects direct `.send`, `.publish`, `.broadcast`, and `.write` calls outside the gate. It does not prove that aliases, computed members, or arbitrary transport method names traverse the gate; `longburn-din.5` must provide a structural transport boundary before it adds transport implementations."

I re-planted the round-2 bypass module in a scratch `src/net/transport.ts`, extended to ten forms. ESLint reported exactly four errors, on `.send`, `.write`, `.publish`, and `.broadcast`, and missed `.emit`, `.push`, `.dispatch`, the bound alias, the destructured rename, and the computed member. The sentence enumerates precisely the four that fire and names precisely the three classes that do not. The structural boundary was deferred to `din.5` and the README says so. Documentation matches code; the next author is no longer being promised enforcement that does not exist.

## Disposition item 4 (optional, not taken) — CONFIRMED NOT WORSENED

`CausalEmissionGate.emit` is byte-identical to `b27bbe6`. The whole of the round-3 change to `src/sim/causality.ts` is the margin helper, the two lines of the convergence return, and two doc comments. Transport-fault mislabeling, the missing blocked-reason, and payload-bearing incident provenance all persist exactly as recorded in review 2, and `longburn-3n9` carries all three verbatim with `longburn-din.5` depending on it. Nothing in round 3 made any of them harder to fix.

## Disposition item 5: standard sweep — CLOSED

- **No test weakened or deleted.** `git diff --numstat` on `src/sim/causality.test.ts` is 72 added, 0 removed. The count moved 13 → 14 because `causality.test.ts` gained one property (6 → 7); every prior test and assertion survives unchanged. The round-3 commit itself touches four files: `README.md`, the handoff, and the two causality files. The other two files in the incremental range (`fort/reviews/longburn-6yu-review-2.md`, `fort/reviews/longburn-din.1-review-1.md`) arrived through merge `238c7ab` from main and are fort records.
- **Determinism lint still fires.** Injecting `Date.now()`, `new Date().getTime()`, `performance.now()`, `Math.random()`, and `globalThis.Date.now()` into `src/sim/causality.ts` produced 6 ESLint errors across `no-restricted-properties` and `no-restricted-syntax`. The production module reads no wall clock and holds no unseeded randomness.
- **Tier fence (SO 13) holds.** No player subscription topology, no relativistic correction, no market behavior, no transport implementation. The one forward-looking sentence in the README assigns work to `din.5` rather than doing it.
- **Round-2 behavior intact at the gate layer.** Re-ran the r2 probes end to end: static one light-second blocks at 999 with one `early-emission` incident and one counter increment and sends at 1000 with server-computed `stalenessMs` 1000; receding receiver at 100 km/s blocks at 1000 and sends at 1001; approaching receiver blocks at 999 and sends at 1000; all eight malformed-provenance forms fail closed with `invalid-provenance` and the transport is never called.
- **Attribution unchanged from prior rounds.** The commit carries no seat trailer, identical to `b27bbe6`. Not a round-3 regression; noting it only so the record is complete.

## Verification and mutation record

Target worktree at `324ab7a` was never modified: `git status --porcelain` empty before and after, HEAD unchanged. Every probe ran in a `/tmp` scratch copy with `.git` removed.

- Baseline in scratch: ESLint clean, `tsc --noEmit` strict clean, **14 tests across 6 files passed**. Matches the Forge's claim.
- **Probe A** — 4000 randomized linear worldlines (distances 1e6 to 4e11 m, speeds to 170 km/s, arbitrary directions, event times to 1e7 ms) against an exact BigInt rational quadratic oracle carried to 30-digit `isqrt` precision: **0 under-estimates, 0 early scheduling ticks**, max under-estimate 0 (versus 3.57e-7 ms in round 2), max over-estimate 0.000997 ms.
- **Probe B** — exact static one-light-second boundary, the zero-step case: arrival returns exactly 1000, earliest tick 1000, blocked at 999, admitted at 1000. **Passed.**
- **Probe C** — 300,000 adversarial stationary distances, each the smallest integer meter count strictly past an integer millisecond: **0 ceil undershoots**.
- **Probe D** — 20,000 adversarial moving receivers, radial offset tuned so the exact arrival lands one meter past an integer tick, velocities cycling ±100 km/s in two axes: **0 under-estimates, 0 early admissions**.
- **Probe E** — liveness cost of the margin over 3000 randomized cases: tick delayed in **0** of 3000.
- **Probe F** — conservatism at `v/c` = 0.001 / 0.01 / 0.1 / 0.3 / 0.5 / 0.7 / 0.9 / 0.99, receding (worst case for the bound), 400 distances each: 0 under-estimates through 0.3c; 128 at 0.5c with worst delta −4.7e-10 ms; 102 at 0.7c with worst delta −1.3e-3 ms and 298 fail-closed throws; 0 at 0.9c and 0.99c with all 400 failing closed. Confirms the `L ≤ 0.5` validity domain analytically derived above.
- **Probe G** — gate-layer round-2 regression guard: G1 static boundary, G2 receding, G3 approaching, G4 eight malformed provenance forms. All matched round-2 behavior exactly.
- Vacuity readout on the new property: 800 of 800 predicate bodies executed, minimum generated gap to tick 0.0109 ms, maximum generated speed 172,004 m/s.
- Fence bypass probe, 10 realistic forms: **4 caught** (`.send`, `.write`, `.publish`, `.broadcast`), 6 missed (`.emit`, `.push`, `.dispatch`, bound alias, destructured rename, computed member). Matches the amended README exactly.
- Determinism injection into `src/sim/causality.ts`: **6 ESLint errors**. Killed.

Mutation battery, full suite each time, source restored and diff-verified clean after every run:

| Mutation | Result |
|---|---|
| `CONVERGENCE_MS` 0.001 → 1000 (r2 survivor) | **killed** 1/14 — new moving property |
| return stale `arrivalTimeMs` (r2 survivor) | **killed** 1/14 — new moving property, oracle assertion |
| drop the conservative margin (r2 behavior) | **killed** 1/14 — new moving property, oracle assertion |
| `Math.floor` the returned arrival | **killed** 4/14 |
| `c` = 299_792_459 | **killed** 2/14 |
| assertion `<` → `>` | **killed** 5/14 |
| assertion `ceil` → `floor` | **killed** 4/14 |
| `MAX_LIGHT_CONE_ITERATIONS` = 1 | **killed** 2/14 |
| margin subtracted instead of added | **killed** 1/14 |
| `precedingStepMs` forced to 0 | **killed** 2/14 |

Ten of ten killed. In round 2, two of these survived.

## Merge

Approve. Merge may proceed. `longburn-6yu` may close once merged.

Carried forward, already tracked, not blocking: `longburn-3n9` holds the three emission-gate API items (transport-fault labeling, blocked-reason on `EmissionResult`, incident payload privacy) and `din.5` depends on it. `din.5` also owns the structural transport boundary the README now names. One item is not yet on any bead and should be, at the Mayor's discretion: the final-step margin is a proof only for `v/c ≤ 0.5`, so if the sim ever admits a receiver above half light speed the margin must become `step · L/(1−L)`. Tier 0 is nowhere near that and the design note's non-goals fence it out, so this is a note for whoever first proposes relativistic scope, not work for now.
