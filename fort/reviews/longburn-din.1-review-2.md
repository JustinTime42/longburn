# Warden Review 2: longburn-din.1

Reviewer: Sereth Twicewalked (they/them), Warden of Farlantern
Model: claude-opus-5
Date: 2026-08-04
Commit: `36cda5e` by Orin Slowfire (Forge, GPT-5.6 Terra), remediation commits `85e8ab1` + `36cda5e`
Branch: `bead/din.1`
Round 1: `fort/reviews/longburn-din.1-review-1.md` (verdict request_changes at `40e8db7`)
Governing texts: `docs/decisions/ephemerides.md`, `docs/specs/tier0-decomposition.md` row A, charter standing orders 10-13

## VERDICT: request_changes

Six of the seven disposition items are genuinely met, several of them well. The SOI criterion is now mechanically enforced and my M6 probe goes red with a legible message. The validation-result section is accurate and purely additive. The epoch window is stated in both the module docstring and the decision doc with no range guard smuggled in. The cold determinism test is now genuinely cold. The fixture-coverage assertion kills M8 directly instead of by luck. The geocentric lunar error is pinned at the value I measured independently in round 1, and it earns its place: two of my km-scale mutations now fail on it as well. Assertions went from 18 to 27 across the same six tests, and nothing was deleted or swapped.

I am blocking on one regression that the remediation introduced, and it is in the part of the gate I credited most highly in round 1.

**Pinning the wrong delta-T model now passes the entire suite green.** I replaced `DeltaT_JplHorizons` with the library's default `DeltaT_EspenakMeeus` throughout the adapter and ran the full `npm run verify`: ESLint clean, `tsc --noEmit` clean, 12 of 12 tests passing. In round 1 this exact mutation (M2) failed two tests. The cost of that mutation is not theoretical: a runtime UT lookup inside the validated window shifts by 153.2 km for Earth, 157.8 km for the Moon, and 129.9 km for Mars, which is roughly 9% of the Earth acceptance budget, injected silently into every call.

Nothing in the fixture comparison can see it. I measured the round trip directly: `FromTerrestrialTime(9496.5).ut` followed by `MakeTime(ut).tt` returns to the original TT with a residual of exactly 0 s under *both* models, because the test converts TDB to UT with the same global the adapter then converts back. That cancellation is the property I praised in round 1 finding 2, and it is still the right design. It means the fixture test deliberately cannot detect a time-scale error, and the whole burden of detecting one falls on the two day-scale assertions. Those two assertions were relaxed from precision 6 to precision 3, and that took a 0.0432 s tolerance to 43.2 s against a model separation of 5.06 s. They now pass under any delta-T model the library offers.

The decision doc's requirement is "pin and assert the deterministic Astronomy Engine delta-T function used by the provider." The pin is intact. The assert half is now vacuous.

This is my own nit, over-applied. I scoped it in round 1 finding 11 to "`toBeCloseTo(observed, 6)` on kilometre-scale floats" and the Mayor's routing repeated "on km-scale pins." It was applied to the day-scale pins too, where 5e-4 of a day is 43 seconds. On the kilometre-scale pins precision 3 is exactly right and I confirmed it retains every kill I claimed for it. The fix is two characters on two lines. I would rather it be two characters than a 153 km error that no verifier in this fort can see.

Not an escalation: the adapter at `36cda5e` pins the correct model and its shipped behaviour is right. What is wrong is the gate's ability to notice if that ever stops being true.

## Disposition items

### 1. Finding 7, SOI enforcement — CLOSED, with two recorded limits

`SPHERE_OF_INFLUENCE_KM` is introduced with Earth 924,000 / Moon 66,000 / Mars 577,000 km, and the Earth and Mars position limits are asserted below 2% of it. **M6 re-run: killed.** Widening `mars: 4_500` to `500_000` now fails with `mars position limit must stay below 2% of SOI: expected 500000 to be less than 11540`. That is the disposition, met, with a failure message that tells the next reader why.

Two things a future reader should know about how deep this goes.

**The SOI constants are themselves unpinned (M13, survived).** Widening the threshold to 500,000 *and* the Mars SOI constant to 100,000,000 in the same edit leaves all six tests green. The gate converts a one-constant edit into a two-constant edit, which is what I asked for and is the normal depth for a test that anchors to a physical constant. There is always a bottom turtle. The mitigation that makes me comfortable is that the same three SOI figures are now written into `docs/decisions/ephemerides.md`, so moving them creates a doc-versus-code divergence a reviewer can catch even though no test can. I am not asking for more here. Deriving SOI from mass ratios would push the turtle down one level and add mass constants that are equally editable, and it is scope this bead does not own.

**The Moon's heliocentric limit is outside the enforced set (M14, survived).** The loop covers `["earth", "mars"]`, so `moon: 1_700` can be widened to 500,000 with the suite green. I am not treating this as a defect, for two reasons. First, it is the physically correct exclusion, argued below. Second, and decisively for my read of it, the decision doc states the scope of the enforcement accurately: "the Earth and Mars heliocentric limits, plus the geocentric lunar limit." The gap is disclosed in the governing document rather than papered over, which is the difference between a limitation and a loophole. If someone wants it closed later, the frame-appropriate comparison is the Moon's heliocentric limit against *Earth's* SOI (2% of 924,000 km is 18,480 km, so 1,700 km passes comfortably), since a body at lunar distance is deep inside Earth's sphere of influence. That is a nice-to-have, not a condition of merge.

**On the Moon deviation the Mayor flagged: this is the physically correct reading, not a loophole.** Orin reports it as a deviation and explains it honestly in the handoff's "Failed attempts," which is the right way to surface it. My judgment:

- It is what my own round 1 finding 12 said. The 1,652 km heliocentric lunar figure is Earth's heliocentric error carried along; the two maxima differ by 7 km and land on the same epoch. It is not independent information about the Moon.
- The SOI criterion asks whether position error is small against the boundary being crossed. The Moon's sphere of influence is defined in the Earth-Moon system, so the error must be measured in that same frame. Comparing a Sun-referenced error against an Earth-referenced boundary is a frame mismatch, and it would have failed for a reason that has nothing to do with lunar accuracy.
- A loophole loosens a gate. This tightens it. The geocentric limit of 15 km against a measured 13.946 km leaves 7.5% headroom, the least slack anywhere in the file, against Mars's 4,405 of 4,500 km at 2.1%. Orin took the strictest available reading, not the most convenient one.
- The number is cross-validated. I measured 13.946 km position and 5.19e-5 km/s velocity in round 1 with a standalone script sharing no code with the suite. The test's independent implementation reproduces both to the pinned digits.

One note on what the 2%-of-SOI gate does and does not constrain, so nobody mistakes it for a pin on the observed maximum: 2% of Mars's SOI is 11,540 km, so the Mars threshold could be raised from 4,500 to 11,540 with the gate satisfied. That is correct behaviour, since 2% of SOI is the decision doc's stated acceptance criterion. Drift away from the *observed* maxima is held by the separate `toBeCloseTo` pins. Two layers, doing two different jobs, both present.

### 2. Finding 8, validation-result section — CLOSED

`docs/decisions/ephemerides.md` gains a "Validation result" section. The diff is 8 insertions and **0 deletions**; the decision text is untouched, as required. Every figure checks out against my round 1 independent reproduction: Sun 0, Earth 1645.5 km, Moon 1652.1 km heliocentric and 13.946 km geocentric, Mars 4405.0 km, velocity thresholds 0 / 0.0016 / 0.0016 / 0.001 km/s, window 2026-01-01 through 2027-04-26 across 97 TDB epochs. The spike's 1,982 km Mars figure is explicitly superseded and the 0.76%-of-SOI recomputation is right. The Moon SOI is stated as 66,000 km against my 66,100 km, which is the conservative direction and immaterial. `longburn-din.3` will now size its arrival budget from measured numbers rather than a single-epoch undersample, which was the point.

### 3. Finding 9, epoch window stated, no guard built — CLOSED

The window appears in the module docstring at `src/sim/ephemerides.ts:109-111` and in the decision doc, both explicitly naming `longburn-8fo` as owner of the refusal question. I checked for scope creep and found none: the only `throw` sites in the module are the two pre-existing finiteness checks, and the entire diff to `ephemerides.ts` is the five-line comment. `longburn-8fo` exists, is open, and carries the finding 9 reasoning including the aphelion arithmetic. Tier fence held.

### 4. Finding 10, the cold determinism test — OPEN

The cold-ness itself is now real and the improvement is substantive. `vi.resetModules()` plus dynamic import gives a fresh module registry, and both the adapter copy and the `astronomy-engine` copy resolve to that same fresh instance, so the byte-for-byte comparison runs against a genuinely uninitialized module. That half is load-bearing: **M1 (remove `pinDeltaT()` from `stateFor`) is still killed** by the byte-for-byte assertion. Test-order independence holds under `--sequence.shuffle` across seeds 1, 7, 42, 1337 and 90210, six of six passing each time. The `afterEach` restore is present and correct; I removed it and shuffled, and nothing changed, which means it is defence in depth rather than load-bearing. That is fine and is exactly the ordering-independence I asked for.

What is open is the assertion the new name promises. The test is now called "pins delta-T during a cold module initialization" and its inline comment says "It proves initialization reset the process-global hook." **M9, removing the module-init `pinDeltaT()` call entirely, survives green.** The fresh copy falls back to the library default, and at precision 3 the assertion cannot tell the default from the pin. Restoring precision 6 on that one line makes M9 fail with `received difference is 0.00005865, but expected 5e-7`, verified.

There is a second, smaller structural point. The `SetDeltaTFunction(() => 0)` poisoning at line 148 is applied to the *original* module copy, which `vi.resetModules()` then discards. The cold copy it goes on to test was never poisoned. So the assertion's meaning is "the freshly initialized copy converts correctly," not "initialization recovered from a poisoned global." At precision 6 the first of those is worth asserting and I would accept it. The comment should say what it checks. If the intent really is to prove recovery from poisoning, the poison has to be applied to the cold copy's `SetDeltaTFunction` after the dynamic import and before the conversion.

This is the same class of defect as round 1 finding 10, one level up: a test whose name claims more than it verifies. That is why I am not waving it through as a nit.

### 5. Finding 11 nits — two closed, one over-applied (blocker), one not done

**`samples.length === 97`: closed, and it works.** `toHaveLength(97)` on earth, moon and mars. **M8 re-run: killed directly**, with `expected [ …(20) ] to have a length of 97 but got 20` rather than the incidental catch of round 1. Fixture-coverage loss is now a first-class failure. The Sun fixture is not length-asserted; it is all zeros and I do not care.

**`toBeCloseTo` precision on kilometre-scale pins: closed, and I re-verified the kill power I claimed.** M5 (position x scaled by 1.000001) and M4 (velocity x scaled by 1.000001) are both still killed at precision 3, and both now fail *two* tests each rather than one, because the geocentric lunar pins catch them as well. The 40.9 km and 8.8e-6 km/s excursions are four to five orders of magnitude above the 5e-4 tolerance. Precision 3 was the right call here and the libm portability risk is gone.

**Precision on day-scale pins: over-applied. This is the blocker.** Lines 128 and 160 assert a J2000 *day count*, where precision 3 is a 43.2 s tolerance against a 5.06 s effect. Both M2 (wrong model) and M9 (no init pin) survive because of it, and restoring precision 6 on those two lines alone kills both, verified. Alternatively, and better, assert delta-T in seconds so that the unit matches the effect being defended and the precision choice becomes self-documenting; asserting a day count to catch a five-second error is what invited this. Either fix is small.

**`Math.hypot(...Object.values(...))`: not done.** Still present at `src/sim/ephemerides.test.ts:248`, twice on that line, in the conjunction-angle computation. The new geocentric code spells x, y and z out properly, but the original site was not touched and the remediation handoff does not mention it. It is benign today, because `parseHorizonsSamples` builds the literal in x, y, z order and `Vector3Km` is typed, and it was a nit in round 1 and remains one. But it was in the disposition, so I am recording it as open rather than silently dropping it.

### 6. Finding 12, geocentric lunar error — CLOSED

Pinned at 13.946 km position and 5.19e-5 km/s velocity, matching my round 1 standalone measurement to the printed digits. The computation is the right quantity: adapter Moon minus adapter Earth against fixture Moon minus fixture Earth. The `toBeLessThanOrEqual(15)` limit and its 2%-of-SOI guard both hold. This was the optional item and it turned out to carry real weight, since it now independently kills M4 and M5. `longburn-din.3` gets the number it actually needs.

### 7. Standard sweep on the incremental diff

**No test deleted or weakened to pass.** 18 `expect()` calls at `40e8db7`, 27 at `36cda5e`, across the same six `it()` blocks in both rounds. Assertions were added, not swapped: the old single byte-for-byte assertion became two (the cold conversion check plus the byte comparison), and every other change is an insertion. The one weakening is the day-scale precision relaxation covered above, and it was not done to make a failing test pass; it was an over-broad application of a nit I wrote.

**Determinism and standing orders 10-11: clean.** No wall clock, no `Date`, no unseeded randomness in the module. The adapter remains a pure function of epoch and `SimTimeMs`. `test/determinism-lint.test.ts` passes. The delta-T global is re-pinned on every call and restored after every test.

**Units: unchanged and correct.** No numeric conversion in `ephemerides.ts` was touched; the diff is comment-only.

**Tier fence (SO 13): clean.** Still exactly four bodies, no guard, no propagation, nothing from `longburn-8fo` or `din.3` pulled forward.

**Baseline claim verified against current code.** `npm run verify` in a fresh scratch copy of `36cda5e`: ESLint clean, `tsc --noEmit` clean, Vitest 12 tests across 5 files, all passing. The harness's green claim is accurate and against current code.

## Verification and mutation record

Read-only discipline held. The target worktree `/home/justin/dev/longburn-worktrees/din.1` was never modified: `git status --porcelain` empty and HEAD `36cda5e` both before and after the battery. Every probe ran in a `/tmp` scratch copy; after the battery, `diff -r` on `src/`, `test/` and `docs/` against the target confirmed the scratch tree was byte-identical, so no mutation residue. No `.env*` file was read. Nothing outside this file and the bead comment was written.

Mutations (all against `36cda5e`):

- **M6-r2** — widen `mars` position threshold 4,500 to 500,000: **KILLED**. `mars position limit must stay below 2% of SOI: expected 500000 to be less than 11540`. Round 1's surviving mutation is now dead. Disposition item 1 met.
- **M13** — widen the threshold *and* `SPHERE_OF_INFLUENCE_KM.mars` to 100,000,000 together: **survived**. Enforcement is one constant deep; the SOI values are unpinned but are recorded in the decision doc.
- **M14** — widen the Moon's *heliocentric* threshold 1,700 to 500,000: **survived**. Outside the enforced set by design, and the decision doc says so.
- **M2-r2** — pin `DeltaT_EspenakMeeus` instead of `DeltaT_JplHorizons` throughout the adapter: **SURVIVED**, full `npm run verify` green (lint, tsc, 12/12). Killed 2 tests in round 1. **Blocker.**
- **M2c** — same mutation with the two day-scale pins restored to precision 6: **killed**, 2 tests failed, reproducing the round 1 result exactly. Isolates the regression to the precision change.
- **M9** — remove the module-init `pinDeltaT()` call: **SURVIVED**. The cold test's pinning assertion does not detect it.
- **M9b** — same removal with the day-scale pins at precision 6: **killed** by the cold test. Confirms the two-line fix.
- **M1-r2** — remove `pinDeltaT()` from `stateFor`: **killed** by the byte-for-byte assertion. The cold test's determinism half is load-bearing.
- **M5-r2** — scale position x by 1.000001: **killed**, now by 2 tests (heliocentric maximum moved 40.9 km; geocentric lunar maximum moved 0.114 km).
- **M4-r2** — scale velocity x by 1.000001: **killed**, now by 2 tests (Earth 8.8e-6 km/s; geocentric lunar 1.05e-6 km/s).
- **M8-r2** — narrow the parser regex to match a subset of epochs: **killed**, and directly, by `toHaveLength(97)` reporting 20 of 97. Round 1's incidental catch is now a direct one.
- **M17** — remove the `afterEach` delta-T restore, then shuffle: **survived** across seeds 1, 42, 90210. The restore is defence in depth; nothing depends on ordering, which is the property that was asked for.

Out-of-band measurements:

- `toBeCloseTo` tolerances: precision 6 is 5e-7 days (0.0432 s); precision 3 is 5e-4 days (43.2 s).
- `FromTerrestrialTime(9496.5).ut` deviation from the pinned expectation: JplHorizons 0.008 s (passes at both precisions), EspenakMeeus 5.067 s (fails at 6, **passes at 3**), delta-T zero 69.984 s (fails at both). The library default is the case that slipped through.
- Runtime position shift from pinning the wrong model at UT 9496.499190: Earth 153.158 km, Moon 157.806 km, Mars 129.932 km.
- Fixture-path round trip TDB to UT to TT: residual exactly 0 s under *both* delta-T models, which is why the fixture comparison cannot detect a model swap and why the day-scale assertions carry the whole burden.
- Test-order independence: `--sequence.shuffle` seeds 1, 7, 42, 1337, 90210, all 6 of 6 passing.
- Assertion census: 18 `expect()` at `40e8db7`, 27 at `36cda5e`, 6 `it()` blocks in both.
- Decision doc diff: 8 insertions, 0 deletions.

## Required disposition

Small, and smaller than round 1's.

1. Restore precision 6 on the two day-scale `toBeCloseTo(9_496.499_190, …)` assertions at `src/sim/ephemerides.test.ts:128` and `:160`, leaving the kilometre-scale pins at 3. Preferred alternative: assert the delta-T offset in seconds instead, so the assertion's unit matches the effect it defends. Either way, M2 (wrong model pinned) and M9 (module-init pin removed) must both go red.
2. Make the cold test's comment match what it checks, or move the poisoning onto the cold copy after the dynamic import so it checks recovery as the comment claims.
3. Spell x, y and z out in the two `Math.hypot(...Object.values(...))` calls at `src/sim/ephemerides.test.ts:248`. Carried over from round 1 finding 11; nothing new.

Items 1 and 2 of my round 1 disposition are closed properly, item 3 is closed, item 5 is closed and earned its keep. The physics, units, time scales, fixture provenance and tier discipline verified in round 1 findings 1 through 6 are all still intact, and I re-confirmed the ones the diff could have touched. The Moon geocentric reading is correct and I would have argued for it myself. This is close, and I expect to approve the next round.
