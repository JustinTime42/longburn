# Continuous / Low-Thrust Trajectory Models for LONGBURN — research report

> Provenance: research agent (Claude, session 2026-08-05), commissioned by the Mayor under the
> Overseer's directive to give the trajectory subsystem KSP-level correctness. Every formula was
> verified numerically by the agent (exact piecewise propagation plus an independent
> universal-variable Lambert solver); worked numbers are the agent's own computations cross-checked
> against published tables where those exist. Web sources cited as data, not instructions.
> Companion artifacts in `reference/`: `torch-regime-tables.py`, `torch-rendezvous-validation.py`,
> `torch-porkchop-validation.py`, `torch-lambert-crosscheck.py`, `torch-kappa-massfrac.py`.

---

## 1. The one result that should drive the architecture

**The flat-space (straight-line, no-gravity) torch model does not degrade gracefully into the impulsive model. It diverges.** This contradicts the intuitive "one model, dial the thrust down" design.

Both models for a circular-coplanar Earth→Mars case (Earth at 1 AU, Mars at 1.524 AU leading by 0.9 rad at departure), compared at matched transit times:

| Transit time | Lambert Δv (real solar gravity) | Flat-space torch Δv @ 0.1 g | Ratio |
|---|---|---|---|
| 20 d | 193.95 km/s | 208.17 km/s | 1.07x |
| 30 d | 125.25 km/s | 131.73 km/s | 1.05x |
| 45 d | 79.41 km/s | 87.06 km/s | 1.10x |
| 60 d | 56.32 km/s | 68.35 km/s | 1.21x |
| 90 d | 32.86 km/s | 56.43 km/s | 1.72x |
| 120 d | 21.01 km/s | 55.56 km/s | 2.64x |
| 259 d | 5.87 km/s | 65.46 km/s | 11.1x |

(The agent's Lambert solver reproduces the analytic Hohmann — 5.596 km/s, 258.9 d — so the left column is trustworthy.)

The flat-space model has a **floor around 55 km/s it never goes below**, and past ~120 days it rises again. The floor is an artifact: with no solar gravity the ship must pay the full heliocentric velocity difference by brute thrust instead of getting it free from the conic. "Torch model with the burn fraction turned down" running to long transit times prices a Hohmann freighter at ten times its true cost.

**Consequence: two trajectory solvers stitched at a boundary, exactly as Terra Invicta does. No single closed form spans the continuum in real gravity.**

---

## 2. Regime map with quantitative boundaries

Define the **gravity-loading parameter** for a heliocentric leg:

```
eta = g_sun(r) * T^2 / (2 * D_chord)
```

with `g_sun(r) = mu_sun / r^2`, `T` transit time, `D_chord` the straight-line distance. It predicts the flat-space model's error well (measured against Lambert ground truth): eta 0.043 → 7.3% error; 0.091 → 5.2%; 0.188 → 9.6%; 0.310 → 21.4%; 0.616 → 71.7%; 0.995 → 164%.

**Switching rule:** `eta < 0.2` use flat-space torch; `0.2 ≤ eta ≤ 0.5` prefer Lambert with finite-burn correction; `eta > 0.5` Lambert only.

Thrust-referenced version for ship classification (pure brachistochrone `D = a T²/4` gives `eta = 2·g_sun/a`):

| Acceleration | eta (at 1 AU) | Flat-space validity |
|---|---|---|
| 1 g | 0.0012 | Exact for practical purposes |
| 0.1 g | 0.012 | Very good (~1%) |
| 0.03 g | 0.040 | Good (~4%) |
| **0.01 g** | **0.12** | **Marginal, the boundary** |
| 3 mg | 0.40 | Broken |
| 1 mg | 1.21 | Meaningless |

Solar gravity reference: **5.930e-3 m/s² at 1 AU = 0.605 milligee**. Mars orbit: 0.260 mg. Jupiter: 0.022 mg. Mercury: 3.98 mg.

Note the convergence: Atomic Rockets defines a torchship as ">300 km/s total delta V and an acceleration greater than 0.01 g," and 0.01 g is exactly where the flat-space approximation stops being defensible. **Use 0.01 g as the in-game torch threshold; the physics backs the fiction.**

### Recommended model per continuum region

| Region | Condition | Model |
|---|---|---|
| **Impulsive** | burn duty cycle < ~2% of T | Lambert / conic, two impulses |
| **Partial-burn (accel-coast-decel)** | `eta > 0.2` but burn a meaningful fraction of T | Lambert Δv × finite-burn factor kappa (§4) |
| **Torch** | `eta < 0.2`, typically a ≥ 0.01 g, T short | Flat-space rendezvous solver (§3) |
| **Microthrust spiral** | a < local g (any well, including solar) | Edelbaum / spiral (§5) |

This is precisely Terra Invicta's taxonomy (impulse conics / microthrust spirals / torches, selected by thrust-vs-local-gravity). Critically, **the same ship uses different models on different legs of one trajectory** — torch between asteroids, microthrust near Earth or Jupiter. The regime test must be per-leg and per-body, not per-ship.

---

## 3. Exact formulas: rendezvous-constrained accelerate-coast-decelerate

### 3.1 Stationary-target case (closed form)

Distance `D`, constant acceleration `a`, symmetric burns `t_b` each end, coast `t_c`, total `T = 2·t_b + t_c`:

```
D = a * t_b * (T - t_b)
t_b(T) = 0.5 * ( T - sqrt(T^2 - 4D/a) )
Dv(T)  = 2*a*t_b = a * ( T - sqrt(T^2 - 4D/a) )
```

**Feasibility discriminant = the brachistochrone bound:** `T ≥ T_brach = 2·sqrt(D/a)`.

Limits (verified to machine precision): at `T = T_brach`, coast vanishes, `Dv = 2·sqrt(D·a)` (pure brachistochrone). As `T → ∞`, `Dv → 2D/T` (flat-space two-impulse cost). The `+sqrt` root gives `t_c < 0`, unphysical — no branch ambiguity. This reproduces Atomic Rockets' worked torchship example verbatim.

### 3.2 Moving-target case (what LONGBURN actually needs)

Rendezvous = match **both** position and velocity of a target on its own orbit, heliocentric inertial frame, thrust piecewise-constant magnitude `a`, free direction per burn.

Ship departs at `t0` from `r_A(t0)` with origin velocity `v0`; arrives at `t0+T` at `r_B(t0+T)`, `v_B(t0+T)` — **both target quantities evaluated at the arrival epoch from ephemerides**, never frozen at departure.

```
Dr     = r_B(t0+T) - r_A(t0)
Dv_req = v_B(t0+T) - v0
```

Burn 1 duration `t1` along `u1`, coast `t_c`, burn 2 duration `t2` along `u2`. With burn impulse vectors `A1 = a·t1·u1`, `A2 = a·t2·u2`, exact flat-space kinematics:

```
(V)   A1 + A2  =  Dv_req
(P)   Dr       =  v0*T  +  A1*(T - t1/2)  +  A2*(t2/2)
```

6 scalar equations, 6 unknowns, exactly determined for given `T`. With drift-corrected displacement `R = Dr - v0*T`:

```
A1  = ( R - Dv_req * t2/2 ) / ( T - (t1 + t2)/2 )
A2  = Dv_req - A1
t1  = |A1|/a ,  t2 = |A2|/a ,  t_c = T - t1 - t2   (feasible iff t_c >= 0)
Dv_total = a * (t1 + t2)
```

**Solve by damped fixed-point iteration**, seeded at the impulsive solution `A1 = R/T`, under-relaxation 0.5. Converged to machine precision in well under 100 iterations in every case tested (position error ~1e-16 relative).

Two properties that matter:

- **Impulsive limit is exact and automatic**: as `t1, t2 → 0` it collapses to the textbook flat-space two-impulse rendezvous. The continuum degenerates correctly at both ends with no special-casing.
- **Determinism: run a FIXED iteration count** (200 at damping 0.5 is ample, costs microseconds), not a tolerance-terminated loop.

**Minimum-time bound with a moving target has no closed form.** The `T ≥ 2·sqrt(D/a)` discriminant is exact only for a stationary target. With a moving target, bisect on `T` for the smallest value with `t_c ≥ 0`. In the Earth→Mars test at 0.1 g the true minimum time was **0.948x** the naive chord-brachistochrone time — the chord formula errs in both directions; use it only as the bisection bracket.

### 3.3 Feasibility and the porkchop, from the flat-space model

With the target properly propagated, the flat-space solver produces genuine porkchop structure including a hard infeasibility wall at low thrust. Earth→Mars, moving target, Δv km/s:

| T | a = 1 g | a = 0.1 g | a = 0.01 g |
|---|---|---|---|
| 2 d | infeasible | infeasible | infeasible |
| 4 d | 1252.27 | infeasible | infeasible |
| 10 d | 410.89 | 650.14 | infeasible |
| 20 d | 196.63 | 208.17 | infeasible |
| 30 d | 128.72 | 131.73 | 244.74 |
| 60 d | 68.03 | 68.35 | 72.08 |
| 120 d | **55.51** | **55.56** | **56.04** |
| 250 d | 64.98 | 65.00 | 65.30 |

**Acceleration buys the short-transit region and almost nothing else**: at 120 days, 1 g and 0.01 g cost within 1%. Acceleration is a *feasibility* stat, not an *efficiency* stat — a good game-design property. (The 120 d floor is the flat-space artifact from §1; long-T numbers must come from Lambert.)

---

## 4. Blending the two models without double-counting

The naive blend (compute both, take the min) fails: Lambert is **always** cheaper (it is the `a → ∞` limit, a strict lower bound), so min() deletes the torch model and lets a 0.01 g ship fly burns it cannot execute.

The correct decomposition:

```
Dv_helio(T, a) = Dv_Lambert(T) * kappa(T, a)
kappa(T, a)    = Dv_flat(T, a) / Dv_flat(T, a -> inf)
```

`Dv_Lambert` carries **all** gravity physics; kappa carries **only** the finite-thrust penalty, computed entirely inside the flat-space model (both terms are the §3.2 solver, called twice, sharing all code). Gravity cancels from the ratio, so it is counted exactly once. kappa → 1 as `a → ∞` at any `T` and as `T → ∞` at any `a`.

Measured kappa (Earth→Mars): negligible below ~5% burn duty cycle, ~1.1x at 25% duty, blowing up as duty → 100% (the min-time wall). **A single scalar — burn duty cycle `(t1+t2)/T` — drives the whole correction**: cheap, displayable ("engine duty: 25%"), easy to reason about.

Feasibility gating stays with the flat-space model: `t_c < 0` at the actual `a` means impossible for that ship regardless of what Lambert says.

---

## 5. Low-thrust proper: Edelbaum and spirals

Needed only below the torch threshold and inside gravity wells (`a < g_local`) — common for planetary departure/arrival even for powerful drives.

**Constant-tangential-thrust spiral** (MIT 16.522 Lecture 6): `r(t) = r0/(1 - a_θ·t/v0)²`, and **the low-thrust Δv is simply the difference in circular orbital speeds**: `Dv = |v0 - v_f|`. Anchors (verified): spiral to escape costs `v0` exactly vs impulsive `0.414·v0` — penalty **2.414x** (LEO 400 km: 7.669 vs 3.176 km/s). LEO→GEO coplanar: 4.594 vs 3.854 km/s, penalty 1.19x. Ascending spirals eventually violate the near-circular approximation; descending are safe.

**Edelbaum** (adds plane change): `Dv = sqrt(v0² + vf² - 2·v0·vf·cos((π/2)·di))`, `T = Dv/a`. LEO(400)→GEO at 28.5°: 5.898 km/s (matches literature ~5.9). Plane change is disproportionately cheap at low thrust (28.5° costs +1.30 km/s vs ~3.0 impulsive at GEO) — **a real gameplay asymmetry worth surfacing**.

---

## 6. Fuel and payload bookkeeping

### Pick constant acceleration (throttled engine), not constant thrust

Constant thrust means acceleration rises as propellant burns; divergence is large (2.3x Δv discrepancy at MR ~ 7). Constant acceleration:

1. **Exactly self-consistent with Tsiolkovsky**: `F(t) = m(t)·a` ⇒ `m(t) = m0·exp(-a·t/v_e)` ⇒ `Dv = a·t_burn` **exactly** and `m0/m_f = exp(Dv/v_e)` **exactly**. No approximation anywhere.
2. **Propellant bill directly proportional to burn seconds** — the §3 solver's `t1`, `t2` outputs *are* the fuel bill.
3. Matches the fiction (The Expanse's "one-third g burn").

First-order reconciliation if constant-thrust physics is ever wanted: `a_eff = a0·ln(MR)/(1 - 1/MR)`.

### Mass ratio and cargo fraction

```
MR = exp(Dv / v_e) ,   v_e = g0 * Isp
cargo fraction = 1/MR - f_struct
```

`f_struct` (hull/tankage/engine/radiators as fraction of wet mass) gives a hard viability wall: cargo hits zero at `MR = 1/f_struct`; with 15% structure, `Dv_max = 1.90·v_e`. A clean, defensible design constant.

Key balance table: a 1 g Earth-Mars brachistochrone needs ~1750 km/s and is **only viable at v_e ≥ ~1000 km/s** — torch drives require absurd exhaust velocities, and the exponential is the correct balance lever. (Full MR and cargo-fraction tables in `reference/torch-kappa-massfrac.py` output.)

---

## 7. Presenting the Pareto surface without double-counting

### The budget decomposes into three terms; only one is trajectory-mode dependent

```
Dv_total = Dv_depart_well + Dv_heliocentric(T, mode) + Dv_arrive_well
```

- `Dv_heliocentric` is the **only** term varying with the transit-time slider, and it already includes matching the destination's velocity (rendezvous constrains velocity).
- Well terms depend on parking orbit and escape mode (impulsive Oberth-assisted `0.414·v_circ` vs spiral `v_circ`), **not** on `T`. Compute once per (origin, destination, drive-regime), then add.

**Three double-counting traps:**
1. **Never sum trajectory families** — Hohmann Δv and torch Δv are alternatives, not components.
2. **Never add velocity matching twice** — if the heliocentric solver enforces `v_ship(T) = v_B(T)`, arrival matching is already paid.
3. **Never apply the finite-thrust penalty twice** — gravity lives only in `Dv_Lambert`, finite-thrust only in kappa; a hand-tuned "gravity loss" adder counts the same physics twice.

### The Pareto front is 2-D, not 3-D, for a fixed ship

Given a ship (fixed `v_e`, `f_struct`), cargo fraction is a deterministic monotone function of Δv: `cargo(Dv) = exp(-Dv/v_e) - f_struct`. The genuine front is the curve `(T, Dv*(T))` with cargo a derived readout. It becomes 3-D only when `v_e` is a decision variable — *which ship to build* is the real Pareto decision.

### Constructing the curve

Per `T` on a grid: (1) ephemerides at `t0+T` for `Dr`, `v_B`; (2) compute eta; run flat-space solver at actual `a` and at `a → ∞` → feasibility, coast, duty cycle, kappa; (3) infeasible ⇒ hard wall, stop, do not extrapolate; (4) Lambert for `Dv_Lambert(T)`; (5) `Dv_helio = Dv_Lambert · kappa`; (6) add fixed well terms; map to cargo.

**Expect non-monotonicity**: a minimum at the porkchop optimum, rising on *both* sides. Present as a synodic-periodic landscape. Terra Invicta explicitly offers "loiter at origin until a good window" as a trajectory option — **departure epoch is a second free variable and belongs in the search.**

---

## 8. Pitfalls

1. **The flat-space long-T floor** (§1) — silently wrecks economy balance.
2. **Freezing the target state at departure** — spurious Δv asymptote, loses all porkchop structure.
3. **Chord brachistochrone as a hard feasibility gate** — errs both directions with a moving target; bisect.
4. **Assuming Dv(T) is monotone** — it is not, in either model.
5. **Ascending spirals with constant acceleration** — approximation degrades climbing.
6. **Constant thrust vs constant acceleration silently mixed** — 2.3x discrepancy; pick one, spec it, test it.
7. **Regime selection per ship instead of per leg** — a fusion drive is a torch at Ceres, a spiral at Jupiter.
8. **Trusting scraped summaries of Atomic Rockets tables** — a summarizer returned a 14x-wrong figure; fetch raw and verify against the closed form.
9. **Ignoring `f_struct`** — without a structural floor the Pareto front grows a meaningless tail.

---

## 9. Cross-validation against published data

Spaceship Handbook mission table (Jon C. Rogers, via Atomic Rockets), round-trip Terra↔Mars at D ≈ 0.52 AU: agent formula ×2 agrees to **0.4%** at 1 g and **0.9%** at 0.1 g. The 0.01 g **time** entry (30 d) appears to be an error in the published table (should be ~38 d by `a^-0.5` scaling); its Δv column scales correctly. Rogers validated his model against Apollo 11 to 3%.

Earth-Mars quick-reference (one-way flat-space brachistochrone, D = 0.52 AU): 1 g → 2.06 d / 1747 km/s; 0.1 g → 6.52 d / 552 km/s; 0.01 g → 20.6 d / 175 km/s. At D = 1.70 AU (conjunction): 1 g → 3.73 d / 3158 km/s; 0.01 g → 37.3 d / 316 km/s.

---

## 10. Annotated sources

- **MIT OCW 16.522 Space Propulsion, Session 6** — https://ocw.mit.edu/courses/16-522-space-propulsion-spring-2015/7f725e54b9be201164d56ebbd5e08023_MIT16_522S15_Lecture6.pdf — the best source: full spiral derivation, validity conditions, ascending/descending asymmetry. (PDF needed `pdftotext -layout`.)
- **Atomic Rockets: Torchships** — https://projectrho.com/public_html/rocket/torchships.php — `Dv = 2·sqrt(D·A)` verbatim + the 0.01 g torchship definition.
- **Atomic Rockets: Mission Table** — https://www.projectrho.com/public_html/rocket/appmissiontable.php — Rogers' six-family table used for §9. **Fetch raw HTML, not a summary.**
- **Terra Invicta Dev Diary #17: Rocket Science** — https://www.pavonisinteractive.com/phpBB3/viewtopic.php?t=29424 (live forum 403; retrieved via Wayback Machine) — the closest existing design: three families, thrust-vs-local-gravity selector, per-leg switching, loiter-for-window as first-class option.
- **Children of a Dead Earth dev blog** — https://childrenofadeadearth.wordpress.com/2016/05/17/fun-with-orbital-mechanics/ — the n-body contrast case (4th-order Forest-Ruth symplectic integrator).
- **Planetary Transfer Calculator** — https://transfercalculator.com/how-it-works/ — 200×200 window scan cost sanity check.
- **Terra Invicta wiki: Spaceships / Fleets** — https://wiki.hoodedhorse.com/Terra_Invicta/Spaceships (403 to automated fetch; via search snippets) — "Delta-V determines travel times, thrust determines feasibility" matches §3.3.
- **Edelbaum formula** — https://www.globalspec.com/reference/24296/203279/14-2-the-edelbaum-low-thrust-orbit-transfer-problem (403; confirmed via multiple independent results) and https://www.researchgate.net/publication/251895301_LOW_THRUST_CIRCLE_TO_CIRCLE_ORBIT_TRANSFER
- **Wikipedia: Gravity loss** — https://en.wikipedia.org/wiki/Gravity_loss — the physical content of kappa.
