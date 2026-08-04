# Warden Review 1: longburn-din.1

Reviewer: Sereth Twicewalked (they/them), Warden of Farlantern
Model: claude-opus-5
Date: 2026-08-04
Commit: `40e8db7` by Orin Slowfire (Forge, GPT-5.6 Codex rung)
Branch: `bead/din.1`
Governing texts: `docs/decisions/ephemerides.md` (from spike `longburn-7xl`), `docs/specs/tier0-decomposition.md` row A, charter standing orders 10-13

## VERDICT: request_changes

The physics is right. I reproduced every recorded number independently from the raw fixture payloads, and the specific thing the Mayor asked me to distrust — the 4,500 km Mars threshold — survives scrutiny: it is derived from the data, the underlying error is genuine provider error rather than a conversion artifact, and it sits comfortably inside the decision doc's acceptance criterion. The TDB→UT conversion is correct, delta-T is genuinely pinned and genuinely asserted, the fixtures are unmodified NASA payloads and the tests do not massage them, units are right, and the module is clean against standing orders 10, 11 and 13. Six of eight mutations were killed, several of them decisively.

I am withholding approval for two narrow reasons, both cheap to fix and both about the *enforcement* of this gate rather than its correctness.

First, the acceptance thresholds are decorative. I widened `mars: 4_500` to `mars: 500_000` and the entire suite stayed green (mutation M6). The real gate is the `toBeCloseTo(observedMaximum, 6)` pin, which is excellent at catching provider degradation but says nothing about whether the accepted error is tolerable. The decision doc's actual acceptance criterion — "errors that remain comfortably below the corresponding patched-conic sphere-of-influence scale" — is currently prose that no test enforces, so a later edit can raise the bar to any value at all with zero signal. This bead exists to build that gate; the gate should hold itself shut.

Second, `docs/decisions/ephemerides.md` still states Mars 1,982 km / 0.3% of SOI as the observed delta. The validated figure is 4,405 km / 0.76%. The acceptance criterion still passes, so this is not a gate failure, but the governing document for the trajectory planner (`longburn-din.3`, which depends on this bead) now carries an error budget that is 2.2x optimistic, and the diff does not touch it. Recording the validation result is the point of running the validation.

Neither finding is an invariant-math failure, so this is not an escalation.

## Findings

1. **The 4,500 km Mars threshold is justified by the data, not widened to fit. Verified.** I reparsed the raw payloads with an independent script and reproduced the recorded maxima to every printed digit: Sun 0, Earth 1645.534789 km, Moon 1652.147992 km, Mars 4404.986594 km. Three separate lines of evidence say this is real provider error rather than an implementation defect being papered over:

   - **The error is cross-track dominated.** At the worst Mars epoch (JD TDB 2461191.5) the 4,404.99 km residual decomposes to radial +1,055.8 km, along-track −638.2 km, cross-track −4,228.7 km. A time-scale error moves a body *along* its track. Cross-track error cannot be produced by a wrong epoch, which independently exonerates the TDB→UT conversion.
   - **It is a broad distribution, not a lone spike.** 9 of 97 epochs exceed 4,000 km and 36 of 97 exceed 3,000 km, with the argmax at index 30 of 96 — interior to the window, not an edge artifact. The spike's 1,982 km was a single-epoch undersample of a systematically larger error, exactly as one would expect from sampling once.
   - **It is inside the provider's own published envelope.** 4,405 km at Mars's heliocentric distance is 3.65 arcsec, which is 6.1% of the ±1 arcminute accuracy Astronomy Engine documents for itself ("Astronomy Engine is designed to be small, fast, and accurate to within ±1 arcminute", project README, fetched 2026-08-04 and treated as citable data per SO 8). The library is behaving as specified; nothing is misused.

   Against the decision doc's criterion the numbers are comfortable: Mars 0.76% of its 577,000 km SOI, Earth 0.18% of 924,000 km. The doc asked for thresholds "proposed in the implementation bead with the observed Horizons deltas, rather than invented" — that is what happened. I accept 4,500 km.

2. **`src/sim/ephemerides.ts:78-85`, TDB→UT math verified correct, and delta-T is genuinely pinned.** `AstroTime.FromTerrestrialTime(tt).ut` followed by the adapter's `MakeTime(ut)` round-trips to the original TT with a measured residual of exactly 0 seconds, so the fixture comparison is delta-T-model-independent by construction. That is the right property: it isolates ephemeris error from time-scale error, which is precisely why finding 1's decomposition is trustworthy. The pinning is nonetheless real and asserted — `DeltaT_JplHorizons` yields a constant 69.9925 s over the whole fixture range (the library clamps its argument post-2017), the library default `DeltaT_EspenakMeeus` yields 75.0514 s, and the assertion at `src/sim/ephemerides.test.ts:106` has a 0.086-day-fraction tolerance (0.086 s) that kills the difference. Mutation M2 (remove all pinning) failed that test with a 5.06 s discrepancy. The TDB≈TT approximation is documented in the code comment and is worth ≤1.7 ms, or ≤0.045 km of Mars motion — four orders of magnitude below the signal being measured. Sound.

3. **`test/fixtures/ephemerides/horizons/*.json`, fixtures are unmodified ground truth and the tests do not massage them. Verified.** All four payloads carry `signature: {"source": "NASA/JPL Horizons API", "version": "1.2"}` and parse to 97 strictly monotonic rows on an exact 5-day step spanning JD TDB 2461041.5 to 2461521.5 (1.31 years). The Sun fixture is exactly zero in position and velocity at every epoch, consistent with the heliocentric `CENTER='500@10'` convention the decision doc requires. The README records endpoint, every query parameter, fetch date, and provenance, satisfying the doc's "preserving Horizons' source timestamp and query parameters alongside the fixtures."

   More importantly, the reward-hacking direction is mechanically closed. I massaged the worst Mars epoch toward the adapter's output (M7c) and corrupted every Mars epoch by 3,000 km (M7b); both failed the suite. Any change to the measured maximum trips the `toBeCloseTo(observed, 6)` pin, so fixtures cannot be quietly bent to flatter the implementation. That pin is the strongest thing in this diff and I want it kept.

4. **Determinism and standing orders 10-11 clean. Verified.** `src/sim/ephemerides.ts` reads no wall clock, constructs no `Date`, and uses no randomness; it is a pure function of the supplied epoch and `SimTimeMs`. It lives under `src/sim/**`, so the existing ESLint wall-clock and RNG fences cover it, and `npm run lint` includes it. Mutation M1 (drop the per-call `pinDeltaT()` inside `stateFor`) was killed by the byte-for-byte test, confirming that the defence against process-global delta-T poisoning is load-bearing rather than ornamental. Separately, I ran a genuinely cold Node process against a heavily warmed one and got byte-identical states for all four bodies, so the `HelioState`/EQJ path carries no call-history-dependent cache. The decision doc's restriction to `HelioState` in EQJ, with of-date rotation APIs excluded, is honoured.

5. **Units correct.** AU→km via `KM_PER_AU`, AU/day→km/s via `/86_400`. Mutations M4 and M5 injected 1-part-per-million slips into velocity and position respectively (about 150 km on Earth) and both were killed by the recorded-maximum assertions.

6. **Tier fence (SO 13) clean, and the causality-relevant choice is right.** The module exposes exactly the four Tier 0 bodies and nothing else; no Pluto, no barycentric state, no n-body propagation, no rotation frames. The fixtures use `VEC_CORR='NONE'`, i.e. geometric states with no light-time or aberration correction. That is the correct choice and worth recording: light-lag is the causal emission gate's job (`longburn-din.5`, SO 12), and baking a light-time correction into the ephemeris source would have quietly double-counted it later. Good instinct.

7. **`src/sim/ephemerides.test.ts:65-81`, blocker: the acceptance thresholds enforce nothing.** Mutation M6 widened `positionErrorLimitsKm.mars` from 4,500 to 500,000 and all 6 tests passed. The `toBeLessThanOrEqual(limit)` assertions are dominated by the exact-value pins, so the limit constants are unreachable in practice and can be edited freely. The decision doc's acceptance criterion is "comfortably below the corresponding patched-conic sphere-of-influence scale", and the charter's own guidance is that a constraint which prose keeps failing to hold should be encoded as a test. Assert the limits themselves against the SOI scales, e.g. a named `SPHERE_OF_INFLUENCE_KM` record with `expect(positionErrorLimitsKm.mars).toBeLessThan(0.02 * SPHERE_OF_INFLUENCE_KM.mars)`. Roughly ten lines, and it turns the gate into something that stays shut.

8. **`docs/decisions/ephemerides.md:21`, blocker: the governing doc now states a superseded delta.** It records Mars 1,982 km and "0.3% of Mars's ~577,000 km SOI" from the spike's single-epoch sample. Validation measured 4,405 km / 0.76%. Append a short "Validation result" section recording the measured maxima per body, the fixture window that produced them, and the accepted thresholds. Additive, not a rewrite of the decision — the decision itself is unchanged and still correct. This matters concretely because `longburn-din.3` (trajectory planner, patched-conic) will size its arrival error budget from this document.

9. **No documented or enforced supported epoch range. Record it.** The thresholds are validated over 2026-01-01 to 2027-04-26 only. `utDaysSinceJ2000` accepts any finite number, and neither the module, the decision doc, nor `docs/specs/tier0-decomposition.md` states a Tier 0 epoch window. Outside the fixture range the only remaining bound is the provider's ±1 arcminute, which at Mars aphelion is about 72,500 km, or 12.6% of Mars's SOI — sixteen times the tested threshold and still usable for Tier 0 patched-conic work, but a very different number from 4,500 km. Minor supporting oddity: the test's own `epoch` constant is 9,131.5 (2025-01-01), which sits outside the validated window. I am not asking for a range guard in this bead. I am asking that the validated window be stated where a reader will find it, and that a follow-up bead own the question of whether the adapter should refuse epochs outside it.

10. **`src/sim/ephemerides.test.ts:124-135`, the "cold" measurement is not cold.** Three earlier tests in the same file already exercise the module, so the value labelled `cold` is warmed. The decision doc explicitly requires byte-for-byte comparison "across cold and warmed calls", and the Forge handoff asserts that cold histories were covered. I verified out of band that a genuinely cold process does produce identical results (finding 4), so there is no latent bug on this path and I am not blocking on it — but the test does not establish what its name claims. Either isolate it with `vi.resetModules()` and a dynamic import, or rename it and drop the cold claim from the handoff record. Records are append-only (SO 7); the correction belongs in the next handoff, not in an edit to the last one.

11. **Nits, fold in with the above.**
    - `src/sim/ephemerides.test.ts:130` leaves the process-global delta-T function set to `() => 0` and relies on the adapter re-pinning it for every subsequent test. It works today because ordering happens to be benign, but a restore in `finally` or an `afterEach` removes the dependence on test order entirely.
    - `src/sim/ephemerides.test.ts:197` uses `Math.hypot(...Object.values(sample.positionKm))`, which is correct only because the object literal happens to be built in x, y, z order. Spell the components out.
    - `parseHorizonsSamples` only rejects a zero-row parse. Mutation M8 narrowed the regex so it matched 12 of 97 epochs, and it was caught only incidentally by the pinned maxima and the perigee epoch. `expect(samples.length).toBe(97)` makes fixture-coverage loss a direct failure rather than a lucky one.
    - `toBeCloseTo(observed, 6)` on kilometre-scale floats is a 5e-7 km tolerance. It held across my runs, but that is tight enough to be a cross-platform CI portability risk on a different libm. Three decimals would still have killed every mutation I ran.

12. **Recommended, not required: record the geocentric lunar error.** The Moon's 1,652 km heliocentric figure is almost entirely Earth's heliocentric error carried along — the two maxima differ by 7 km and land on the same epoch. Measuring the Moon relative to Earth, which is what lunar-SOI patched-conic actually needs, gives a maximum error of 13.9 km, or 0.021% of the 66,100 km lunar SOI, with velocity error 5.2e-5 km/s. That is an order of magnitude better than the recorded number suggests, and it is the number `longburn-din.3` will want. Worth one extra assertion.

13. **Dependency hygiene verified.** `astronomy-engine` is pinned to an exact `2.1.19` in both `package.json` and the lockfile with an integrity hash, as the decision doc requires, and it has no transitive dependencies. `resolveJsonModule` is the only tsconfig change and is required by the fixture imports. `npm ci` from the lockfile installed cleanly.

## Verification and mutation record

Read-only discipline held throughout. The target worktree was never modified: `git status --porcelain` in `/home/justin/dev/longburn-worktrees/din.1` was empty before and after, and HEAD remained `40e8db7`. Every probe ran in a `/tmp` scratch copy with a fresh `npm ci --ignore-scripts` plus `npm rebuild esbuild`; after the battery, `diff -r` against the worktree confirmed the scratch tree was byte-identical, i.e. no mutation residue. No `.env*` file was read.

**Baseline claim re-verified against current code.** `npm run verify` in the scratch copy: ESLint clean, `tsc --noEmit` clean, Vitest 12 tests across 5 files, all passing. The harness's green claim is accurate and is against the code at `40e8db7`, not a stale artifact.

**Independent reproduction.** A standalone script reparsed the raw JSON payloads and recomputed every error from scratch, sharing no code with the test suite. Maxima matched Orin's recorded values to all printed digits: Earth 1645.534789 km, Moon 1652.147992 km, Mars 4404.986594 km, Sun 0. Means: Earth 871.6 km, Moon 870.4 km, Mars 2410.8 km.

Mutations:

- **M1** — remove `pinDeltaT()` from `stateFor`: **killed** (byte-for-byte determinism test failed).
- **M2** — remove all delta-T pinning, falling back to the library default `DeltaT_EspenakMeeus`: **killed** (2 tests failed; UT conversion off by 5.06 s).
- **M3** — treat the Horizons TDB day directly as UT, dropping the 70 s conversion: **killed** (2 tests failed; Earth error rose to 2,869 km, past its 1,700 km limit). Confirms the time-scale conversion is load-bearing, not cosmetic.
- **M4** — scale velocity by 1.000001: **killed** (recorded Earth velocity maximum moved by 8.8e-6 km/s).
- **M5** — scale position x by 1.000001: **killed** (recorded Earth position maximum moved by 40.9 km).
- **M6** — widen the Mars position threshold from 4,500 to 500,000 km: **SURVIVED**, all 6 tests green. Finding 7.
- **M7a** — nudge one Mars fixture epoch by +1,000 km: **survived**, but correctly so: the perturbed epoch's error stayed below the set maximum, which is the tolerance the design intends. Recorded for completeness.
- **M7b** — corrupt every Mars epoch by +3,000 km: **killed** (Mars maximum 4,690 km exceeded the limit; conjunction pin also failed).
- **M7c** — massage the worst Mars epoch toward the adapter output, the reward-hacking direction: **killed** (recorded-maximum pin failed). Fixture massaging is mechanically detectable.
- **M8** — narrow the parser regex so it silently matched 12 of 97 epochs: **killed**, but only incidentally, via the recorded maxima and the perigee epoch pin rather than by any direct coverage assertion. Finding 11.

Out-of-band probes:

- TT→UT→TT round trip residual: exactly 0 s; implied delta-T 69.992486 s.
- Delta-T model separation at fixture epochs: `DeltaT_JplHorizons` 69.9925 s (constant, clamped) vs `DeltaT_EspenakMeeus` 75.0514 s.
- Worst-epoch Mars error decomposition (radial / along-track / cross-track): +1,055.8 / −638.2 / −4,228.7 km; 3.65 arcsec from the Sun; 4,229 km of cross-track cannot arise from a time offset.
- Error distribution across the window: Mars exceeds 4,000 km at 9 of 97 epochs and 3,000 km at 36 of 97; all three body maxima are interior to the window (indices 30-31 of 96), so no edge-truncation artifact.
- Fixture integrity: 97 rows per body, strictly monotonic, exact 5-day step, NASA/JPL Horizons API v1.2 signature present on all four, Sun exactly zero throughout.
- Truly-cold Node process vs heavily-warmed process, same epoch, all four bodies: byte-identical.
- Geocentric lunar error over the fixture set: maximum 13.946 km position, 5.19e-5 km/s velocity.
- Provider envelope arithmetic: ±1 arcmin at Mars aphelion is 72,498 km (12.6% of Mars SOI); at Earth aphelion 44,256 km (4.8% of Earth SOI).

## Required disposition

Small and bounded. I expect this back quickly.

1. Make the acceptance thresholds mechanically enforce the decision doc's SOI criterion (finding 7).
2. Append a validation-result section to `docs/decisions/ephemerides.md` recording the measured maxima, the fixture window, and the accepted thresholds, superseding the spike's single-epoch Mars figure (finding 8).
3. State the validated epoch window (2026-01-01 to 2027-04-26) where a reader of the adapter or the decision doc will find it, and file a follow-up bead for whether the adapter should refuse epochs outside it (finding 9).
4. Fix or rename the "cold" determinism test so its name matches what it measures (finding 10), and fold in the nits in finding 11.
5. Optional but recommended: assert the geocentric lunar error (finding 12).

Nothing in findings 1-6 needs to change. The adapter's physics, units, time scales, determinism, fixture provenance, and tier discipline are all sound, and the threshold the Mayor asked me to distrust holds up. This is good work; I am asking that the gate it builds be made to hold itself shut before it merges.
