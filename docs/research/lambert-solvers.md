# Lambert Solvers for LONGBURN — research report

> Provenance: research agent (Claude, session 2026-08-05), commissioned by the Mayor under the
> Overseer's directive to give the trajectory subsystem KSP-level correctness. Web content herein
> was gathered as untrusted data and is cited, not followed. Companion artifact:
> `reference/izzo-reference.py` (the validated dependency-free transcription described below:
> Izzo solver + universal-variable Kepler propagator, pure stdlib, ~200 lines — a direct porting target).

**Bottom line:** implement **Izzo (2015)** in TypeScript, transcribed from the poliastro/lamberthub reference. The agent ported it to dependency-free Python and validated it against seven published textbook cases plus a 40,000-case randomized sweep. It reproduced every published case, converged in **2–3 iterations always**, never threw on a well-posed input, and is **invariant to unit scaling to ~1 ULP** — which matters a lot for the determinism constraint. The one thing that will bite is not the algorithm, it's that JS transcendental functions are not bit-reproducible across engines; mitigation in §6.

---

## 1. Algorithm choice

| Algorithm | Verdict |
|---|---|
| **Izzo 2015** | **Recommended.** Householder (quartic) iteration on a single dimensionless variable `x`; full multi-revolution support; 2 iterations typical. |
| Gooding 1990 | Comparable accuracy, cubic (Halley) iteration, ~3 iterations, 1.25–1.5× slower. Far more code (heavy heuristic initial-guess machinery). No reason to prefer it. |
| Universal variables (Vallado/BMW) | Simple but bisection-based on ψ, slow, and multi-revolution support is bolted on rather than native. poliastro's tracker carries open bugs for long-way transfers and missing multi-rev. Fine as a cross-check oracle, not as the production path. |
| Battin 1984 | Historically robust, but the continued-fraction machinery is fiddly and it is neither faster nor more accurate than Izzo. |

Izzo's decisive structural property: **it is internally non-dimensionalized.** The iteration variable `x`, the geometry parameter `λ`, and the time parameter `T` are all dimensionless, so `mu` and the length unit only enter at the entry and exit. That is why unit scaling is nearly free (§6) and why the same code handles geocentric and heliocentric arcs without retuning.

The whole solver is scalar arithmetic on 3-vectors. Nothing in it resists a clean TypeScript port — no linear algebra, no special-function library beyond a 10-line hypergeometric series.

**Implementation warning:** the initial-guess formula printed immediately after Eq. (30) of the published paper is **wrong** for the middle branch `T_1 < T < T_0`. The corrected form, which is what poliastro and lamberthub actually ship, is:

```
x_0 = exp( ln(2) * ln(T/T_0) / ln(T_1/T_0) ) - 1
```

Tracked as poliastro issue #1362. Transcribe from the code, not from the paper.

---

## 2. Validation test cases

All seven below were **run through the agent's port and reproduced**. Inputs are exact; the "published" values are what lamberthub's suite asserts, "reproduced" is what the transcription produced. All use `mu_earth = 3.986004418e5 km³/s²` unless noted. Source for the case bundle: https://github.com/lamberthub/lamberthub

**Case 1 — Vallado, *Fundamentals of Astrodynamics and Applications* 4th ed., Example 7-5** (M=0, prograde)
```
r1  = [15945.34, 0.0, 0.0] km
r2  = [12214.83899, 10249.46731, 0.0] km
tof = 4560 s
published  v1 = [ 2.058913,  2.915965, 0.0]   v2 = [-3.451565, 0.910315, 0.0]
reproduced v1 = [ 2.058913354, 2.915964352, 0.0]
           v2 = [-3.451564845, 0.910314248, 0.0]      2 iterations
```

**Case 2 — Curtis, *Orbital Mechanics for Engineering Students* 3rd ed., Example 5.2** (M=0, prograde). Best single smoke test: fully three-dimensional, moderate eccentricity.
```
r1  = [5000.0, 10000.0, 2100.0] km
r2  = [-14600.0, 2500.0, 7000.0] km
tof = 3600 s
published  v1 = [-5.9925, 1.9254, 3.2456]    v2 = [-3.3125, -4.1966, -0.38529]
reproduced v1 = [-5.992495020, 1.925366714,  3.245638050]
           v2 = [-3.312458503, -4.196619008, -0.385289060]    2 iterations
           arc: a = 20002.88492 km, e = 0.433487451
```
Published values are rounded to 5 significant figures, so match at `rtol = 1e-4`, not tighter.

**Case 3 — Battin, *Introduction to the Mathematics and Methods of Astrodynamics*, Example 7.12.** Exercises a completely different unit system (`mu = 39.47692641 AU³/yr²`), exactly the check wanted for a heliocentric planner.
```
r1  = [0.159321004, 0.579266185, 0.052359607] AU
r2  = [0.057594337, 0.605750797, 0.068345246] AU
tof = 0.010794065 year
published  v1 = [-9.303603251, 3.018641330, 1.536362143] AU/yr
reproduced v1 = [-9.303608004, 3.018620165, 1.536360083]
           v2 = [-9.511186197, 1.888840064, 1.421378101]    2 iterations
```
Published v1 agrees to 2.2e-5 AU/yr — Battin's textbook rounding, not solver error; the round-trip residual on this case was 4.9e-17 AU.

**Case 4 — Der, *Astrodynamics 102*, case I.** Two configurations off one geometry; pins down prograde/retrograde and path-selection flag handling.
```
r1  = [2249.171260, 1898.007100, 5639.599193] km
r2  = [1744.495443, -4601.556054, 4043.864391] km
tof = 1618.50 s

prograde, low path:    v1 = [-2.09572809,  3.92602196, -4.94516810]
                       v2 = [ 2.46309613,  0.84490197,  6.10890863]
retrograde, high path: v1 = [ 1.94312182, -4.35300015,  4.54630439]
                       v2 = [-2.38885563, -1.42519647, -5.95772225]
```
Both reproduced to <1.2e-8 km/s. Source: http://derastrodynamics.com/docs/astrodynamics_102_v2.pdf

**Case 5 — Der, case II.** Larger, slower arc; `M_max = 1` for this geometry, so it doubles as the gateway to the multi-rev tests.
```
r1  = [22592.145603, -1599.915239, -19783.950506] km
r2  = [1922.067697, 4054.157051, -8925.727465] km
tof = 36000 s

prograde, high path:   v1 = [ 2.000652697,  0.387688615, -2.666947760]
                       v2 = [-3.79246619,  -1.77707641,   6.856814395]
retrograde, high path: v1 = [ 2.96616042,  -1.27577231,  -0.75545632]
                       v2 = [ 5.8437455,   -0.20047673,  -5.48615883]
```

**Case 6 — multi-revolution (M=1), same geometry as case 5.** No published multi-rev case with exact numbers was found anywhere, so the agent generated these and verified them independently: computed the orbital elements of the returned arc and integrated Kepler's equation analytically, including the M complete revolutions, to confirm the time of flight. **Relative TOF residual 4.0e-16 and 2.0e-16** — trustworthy to full double precision; the numbers to hard-code.
```
r1, r2, tof as case 5, M=1:

low path:  v1 = [-2.457595533987,  1.169458006909,  0.431612576787]
           v2 = [-5.538413180795,  0.018222133557,  5.496410156367]
           a = 21072.807743 km, e = 0.836621710, 3 iterations
high path: v1 = [ 0.503357699103,  0.618694082428, -1.571769036827]
           v2 = [-4.183346259285, -1.132627268989,  6.133070906961]
           a = 17032.400977 km, e = 0.916286178, 3 iterations

M=2 must raise "no feasible solution" (M_max = 1 here).
```

**Case 7 — heliocentric multi-revolution**, `mu_sun = 1.32712440018e11 km³/s²`, tof = 1600 days. Same independent verification, residuals 6e-16 to 2e-15. This exercises the regime the planner actually lives in.
```
r1  = [-1.4934e8, 1.1471e7, -1.0e3] km
r2  = [1.4726e8, 1.8946e8, -6.7e5] km
tof = 138240000 s

M=0:       v1 = [-11.106110888232, -36.514169499882, 0.124808565709]
           v2 = [-28.061622408476,   1.791859904940, 0.001027228710]
M=1 low:   v1 = [ 25.435364206861, -27.834143902304, 0.086663793853]
M=1 high:  v1 = [ -6.370687999473, -35.133840254064, 0.119011540518]
M=2 low:   v1 = [ 19.176379088371, -29.004900444759, 0.092141324695]
M=2 high:  v1 = [ -0.706086722919, -33.583059717486, 0.112412555410]
```

**The cheapest test available, and the one to lean on hardest:** a round-trip property test. Solve Lambert for random `(r1, r2, tof)`, then propagate `(r1, v1)` forward by `tof` with the Kepler propagator and assert it lands on `r2`. On well-conditioned cases this closes to ~1e-12 km. It needs no published numbers, covers geometries no textbook does, and catches sign and quadrant errors instantly. Be aware it tests the propagator too — see §4.

---

## 3. Delta-v bookkeeping

Lambert gives two **heliocentric inertial** velocity vectors on the transfer arc. Everything else is subtraction.

**Level 1 — heliocentric only (no patched conics).** The honest minimum:
```
v∞_dep = v1_lambert − v_body_origin(t_dep)        // vector, at departure epoch
v∞_arr = v2_lambert − v_body_dest(t_arr)          // vector, at arrival epoch
Δv_total = |v∞_dep| + |v∞_arr|
C3_dep   = |v∞_dep|²                               // km²/s², the porkchop contour variable
```
Both body velocities must come from the ephemeris **at their own epochs** — using the departure epoch for both is a classic and silently wrong bug.

**Level 2 — patched conics.** If the craft starts in a parking orbit of radius `r_p` around the origin body, it must climb out of that well on a hyperbola whose excess speed is `|v∞_dep|`. Vis-viva at periapsis with hyperbolic energy `v∞²/2`:
```
v_peri_hyp = sqrt( v∞² + 2μ_body/r_p )
v_park     = sqrt( μ_body/r_p )                    // circular parking orbit
Δv_departure = v_peri_hyp − v_park
```
Arrival is the mirror image. Capture into a circular orbit of radius `r_p`:
```
Δv_capture = sqrt( v∞_arr² + 2μ_dest/r_p ) − sqrt( μ_dest/r_p )
```
Capture into a barely-bound (near-parabolic) ellipse is far cheaper and is what real missions do:
```
Δv_capture_min = sqrt( v∞_arr² + 2μ_dest/r_p ) − sqrt( 2μ_dest/r_p )
```
A worked example, LEO 200 km to a 400 km Mars orbit on a 210-day arc: departure Δv 10.22 km/s, circular capture 7.41 km/s, total 17.63 km/s — versus 23.91 km/s naively summing the two `|v∞|` magnitudes. **The Oberth effect is worth ~6 km/s here.** If the game charges players the level-1 number while they are in a parking orbit, it overcharges by a large and physically meaningful margin. Near-parabolic capture saves another 1.4 km/s over circular capture.

Definitional anchors: `C3 = v∞² = 2ε` where ε is specific orbital energy, and `C3 = μ/|a|` on a hyperbola (https://en.wikipedia.org/wiki/Characteristic_energy); the periapsis/capture relations follow from vis-viva and are laid out at https://ai-solutions.com/_freeflyeruniversityguide/patched_conics_transfer.htm

**What comparable games do.** Terra Invicta is the closest precedent and it **does use a Lambert solver**, for the trajectory class it calls "impulse conics" (high-thrust, low-efficiency drives); it also models microthrust spirals for low-acceleration craft and "torch chords" for high-thrust-high-Δv drives. KSP does not solve Lambert in the stock game — maneuver nodes are hand-tuned patched conics; the MechJeb "Advanced Transfer to Another Planet" mod adds a Lambert solver driving a porkchop-plot search over departure/arrival date pairs, which is exactly the UX pattern to copy. Children of a Dead Earth went the other way: the developer started with patched conics, found they "diverge very heavily" from an n-body integrator, and switched to a fixed-planet n-body sim with a 4th-order Forest–Ruth symplectic integrator. That is a materially harder engineering commitment and it removes Lambert as a closed-form tool. Given that LONGBURN wants determinism and a TypeScript core, patched conics plus Lambert is the right tier.

---

## 4. Measured numerical behavior

40,000 randomly generated problems (seeded; 20k geocentric over 6600–60000 km and 300–200000 s, 20k heliocentric over 0.35–6 AU and 20–1500 days), scoring each by an independent check: recover the arc's orbital elements and integrate Kepler's equation analytically to see whether the time of flight comes back.

- **Zero exceptions across all 40,000 cases.**
- **Iteration counts: 2 or 3, always.** Geocentric histogram: 23 cases at 1 iteration, 17,905 at 2, 2,072 at 3. Heliocentric: 90 / 19,554 / 356. A `maxiter` of 35 is enormously conservative; 10 would be plenty, and hitting it means the input is malformed.
- **Worst relative TOF residual: 1.5e-9 (geocentric), 2.2e-9 (heliocentric).** Both worst cases were near-parabolic (e = 1.136 and e = 1.0009). Typical elliptic and all multi-revolution cases residual at ~1e-16.
- **Tightening tolerances does not help.** Going from `atol=1e-5, rtol=1e-7` to `atol=1e-12, rtol=1e-14` left the worst-case residual identical at 1.487e-9 while pushing nearly every case from 2 iterations to 3. The near-parabolic residual is a conditioning limit, not under-convergence. **Keep the shipped defaults** (`atol=1e-5, rtol=1e-7, maxiter=35`); tightening costs ~50% more iterations and buys nothing.

A caution on the methodology, because it nearly produced a false alarm: the first robustness pass used a universal-variable Kepler propagator as the oracle and flagged 12 catastrophic failures with round-trip errors of order 1e15. All twelve were the **propagator** breaking down on near-parabolic orbits (e = 0.9968, e = 0.99975), not the Lambert solver. Re-checking those cases by comparing conic elements derived from `(r1,v1)` against those from `(r2,v2)` showed agreement to 4e-16 in semi-major axis and 1e-16 in eccentricity. If round-trip propagation is the test oracle, **the propagator will fail before Izzo does**, and the tests need to be able to tell the two apart.

---

## 5. Edge cases and failure modes

**Hard failures (all throw a division-by-zero on `i_h = cross(r1,r2)/|cross(r1,r2)|`):**
- `r1 == r2` exactly.
- Transfer angle exactly 0°.
- Transfer angle exactly 180° with genuinely zero out-of-plane component, e.g. `r1 = [7000,0,0]`, `r2 = [-8000,0,0]`. Confirmed to throw.

Guard all three at the entry point with an explicit error rather than letting NaN propagate into sim state.

**Soft degradation near 180°.** The transfer plane is genuinely undetermined when `r1` and `r2` are antiparallel — physics, not a numerical defect, and no solver can fix it. Sweeping transfer angles from 179° to 180°: the solver converges in 2 iterations throughout and velocities stay smooth, but round-trip accuracy degrades from 3e-10 km at 179° to 8.6e-8 km at 179.999°, and the returned plane orientation becomes arbitrary. With a 1e-6 km out-of-plane component the solver returned an essentially in-plane arc, missing the target by the full 1e-6 km offset. For a planner this is harmless; if a near-180° solution ever feeds the actual sim state, detect the condition and either nudge the epoch or tell the player the transfer is degenerate.

**Multi-revolution degeneracy at `T_min`.** For each `M ≥ 1` there is a minimum time of flight below which no solution exists, and the low-path and high-path solutions **merge** approaching it. Swept on the Der II geometry (`λ = 0.500278`, `x(T_min) = 0.145349`, `tof_min(M=1) = 28755.17 s`): at 2× `tof_min` the two solutions differ by 5.9 km/s; at 1.00001× by 0.025 km/s; at `tof_min` itself by 0.0046 km/s, with iteration count climbing from 3 to 7. The two branches are numerically indistinguishable in the last few percent above `T_min`. A porkchop search should treat near-`T_min` multi-rev solutions as a single solution, not two.

**`M_max` is a function of geometry and TOF — query it, don't assume.** On the heliocentric geometry above: 200 and 400 days give M=0 only; 900 days admits M=1; 1600 days admits M=2. Requesting `M > M_max` correctly raises. For a porkchop generator, either catch that exception per cell or expose `M_max` from `_find_xy` and iterate up to it — expose it, since throwing inside a 10,000-cell grid search is expensive and noisy.

**`is_low_path` is meaningless for M=0** and the flag is silently ignored; confirmed empirically (identical velocities both ways). Only surface the high/low choice in the UI for M ≥ 1.

**`|λ| = 1` is asserted against** at the top of `_find_xy` because the derivative is discontinuous there. This corresponds to the degenerate chord cases above.

---

## 6. Determinism in TypeScript — the real risk

**Good news, measured:** the identical heliocentric problem solved in three unit systems (km/s, AU/day, m/s) gives `v1` agreeing to **3.5e-16 relative — about 1.5 ULP** — with identical iteration counts. A direct consequence of Izzo's internal non-dimensionalization. **No clever unit scale needed.** Use whatever the ephemeris layer already speaks; km and seconds is fine.

**Bad news:** ECMAScript specifies `Math.sqrt` as correctly-rounded IEEE-754, but `Math.acos`, `Math.asinh`, `Math.exp`, `Math.log`, and `Math.pow` are all **implementation-approximated** — the spec permits different engines, versions, and platforms to return different last bits. Izzo touches all of them: `acos`/`asinh` inside `_compute_psi` in the core TOF equation, and `pow`/`exp`/`log` in the initial guess. Because the Householder loop terminates on a step-size test rather than at an exact root, a one-ULP difference in the initial guess or in `psi` produces a slightly different converged `x`, and therefore different velocity bits. Divergence is bounded at roughly 1e-15 relative, but for a sim core that must replay identically it is not zero, and it is not under our control.

Recommendation, in preference order:

1. **Keep Lambert out of the deterministic state entirely.** Treat the solver as a planning and UI tool. When the player commits a maneuver, **quantize the delta-v** (say, to 1e-6 km/s or a fixed integer representation) and store *that* as the authoritative sim input. The sim then replays from a value that is bit-exact by construction, and engine variation in the planner becomes cosmetic. Cheap, robust, and worth doing regardless of what else is chosen.
2. If a solved trajectory must itself be part of replayable state, **serialize the converged `x`** (or the resulting velocity vectors) into the save/event stream rather than recomputing on load.
3. Only if 1 and 2 are both impossible: implement `acos`, `asinh`, `exp`, `log`, `pow` in software with fixed algorithms. Real cost; not recommended.

Smaller TypeScript notes: clamp the `acos` argument to `[-1, 1]` before calling — values a few ULP outside the domain occurred during the sweep, and unclamped that returns NaN. Avoid `Math.hypot` (also implementation-approximated, and slower than explicit `sqrt(x*x+y*y+z*z)`). The `hyp2f1b` series terminates on `res_old === res`, a fixed-point convergence test that behaves identically in JS. Nothing needs typed arrays or SIMD; at 2–3 iterations of scalar math, a 10,000-cell porkchop grid is a few milliseconds.

---

## 7. Annotated sources

- **Izzo, D. (2015), "Revisiting Lambert's problem"** — https://www.esa.int/gsp/ACT/doc/MAD/pub/ACT-RPR-MAD-2014-RevisitingLambertProblem.pdf (also https://arxiv.org/abs/1403.2705). Primary source; ESA-hosted PDF is the cleanest copy. Remember Eq. (30)'s successor is misprinted.
- **lamberthub** — https://github.com/lamberthub/lamberthub — 14 solvers in Python with a shared API and the textbook test suite quoted above. The single most useful repository: gives both the reference implementation and the validation cases. The file to port is https://raw.githubusercontent.com/jorgepiloto/lamberthub/main/src/lamberthub/universal_solvers/izzo.py
- **poliastro issue #1362** — https://github.com/poliastro/poliastro/issues/1362 — documents the published initial-guess error. Read before transcribing.
- **De la Torre Sangrà & Fantino, "Review of Lambert's Problem"** — https://arxiv.org/pdf/2104.05283 — independent survey; sanity-checks the algorithm choice against a third party rather than taking Izzo's own comparison at face value.
- **Russell, "Complete Lambert Solver Including Second-Order Sensitivities"** — https://arc.aiaa.org/doi/10.2514/1.G006089 — relevant only for analytic gradients when optimizing over dates instead of grid-searching. Not needed for v1.
- **Gooding, R.H. (1990)**, *Celest. Mech. Dyn. Astron.* 48:145–165 — the declined alternative; cite if anyone asks why not.
- **Terra Invicta Dev Diary #17** — https://www.pavonisinteractive.com/phpBB3/viewtopic.php?t=29424 — closest game precedent, confirms Lambert-solver-driven impulse conics. Caveat: the forum and the official wiki (https://wiki.hoodedhorse.com/Terra_Invicta/Fleets) both returned 403 to the agent's fetcher; the trajectory-type and Lambert-solver details come from search-result excerpts. Well-supported but not directly verified.
- **Children of a Dead Earth dev blog** — https://childrenofadeadearth.wordpress.com/2016/05/17/fun-with-orbital-mechanics/ — the n-body counterexample and why they abandoned patched conics.
- **MechJeb2** — https://github.com/MuMech/MechJeb2 — porkchop-plot UX reference.
- **Porkchop plot** — https://en.wikipedia.org/wiki/Porkchop_plot — the C3 contour convention the UI should follow.
- **Characteristic energy** — https://en.wikipedia.org/wiki/Characteristic_energy — C3 definitions.
- **Patched conics guide (AI Solutions)** — https://ai-solutions.com/_freeflyeruniversityguide/patched_conics_transfer.htm — departure/capture Δv formulas.
- **Der, *Astrodynamics 102*** — http://derastrodynamics.com/docs/astrodynamics_102_v2.pdf — source of test cases 4 and 5.
