# Earth→Mars Departure Windows, Porkchop Plots, and Phasing — research report

> Provenance: research agent (Claude, session 2026-08-05), commissioned by the Mayor under the
> Overseer's directive to give the trajectory subsystem KSP-level correctness. Web content herein
> was gathered as untrusted data and is cited, not followed. Companion artifacts:
> `reference/porkchop-lambert-sweep.py`, `reference/offwindow-penalty-sweep.py` (the agent's
> verification scripts; its toy Lambert solver reproduces the analytic Hohmann to 4 decimals and
> its MOI figures agree with published literature to 1%).

---

## 1. How porkchop plots are actually generated

### 1.1 The algorithm (this is the whole thing)

```
for t_dep in departure_grid:
    r1, v1_planet = ephemeris(EARTH, t_dep)
    for t_arr in arrival_grid:
        tof = t_arr - t_dep
        if tof <= tof_min: mark invalid; continue
        r2, v2_planet = ephemeris(MARS, t_arr)
        v1_sc, v2_sc = lambert(r1, r2, tof, mu_sun, prograde=True, nrev=0)
        vinf_dep = |v1_sc - v1_planet|
        vinf_arr = |v2_sc - v2_planet|
        C3_dep   = vinf_dep^2
        cell = { C3_dep, vinf_arr, tof, total_dv(...) }
contour(C3_dep) over (t_dep, t_arr)
```

One prograde, zero-revolution Lambert solve per grid cell. That is the entire generation method, and it is what NASA's own handbook does (via MIDAS), what poliastro does, and what every hobby implementation does. There is no hidden sophistication.

### 1.2 Type I / Type II emerge for free

Do **not** special-case them. A single prograde Lambert call returns Type I when the heliocentric transfer angle Δθ < 180° and Type II when 180° < Δθ < 360°. The classic porkchop shape (two lobes separated by a diagonal ridge) falls out automatically, because near Δθ = 180° the transfer plane becomes ill-conditioned.

NASA's handbook explains the ridge precisely: for a ballistic 180° transfer the Sun and both endpoints must be coplanar, so any out-of-ecliptic displacement of Mars forces the transfer toward polar inclination, and "near-180° transfer trajectories require larger departure energies than orbits with less inclination because they are not able to take advantage of the energy provided by Earth's orbital velocity."

Practical consequence: at Δθ exactly 180° the transfer plane is undefined and any Lambert implementation will produce garbage or NaN. Detect |Δθ − 180°| < ~0.05° and mark the cell invalid rather than letting a wild number poison the contouring. The surrounding high-C3 ridge is physically real and should be rendered.

The exception the handbook documents is the **nodal transfer**: when departure happens at the node where Mars' orbit crosses Earth's orbital plane and arrival at the opposite node, the 180° transfer can lie in Earth's orbital plane and the C3 spike collapses into a single low-energy point connecting the two lobes. It does not occur in every window. It is a real feature worth reproducing with a 3D ephemeris, and it produces a visually distinctive "pinched waist" porkchop.

### 1.3 Grid choice: recommendation

**Compute on (departure date × time-of-flight); render on (departure date × arrival date).**

Rationale: on a departure×arrival grid, roughly half the cells are wasted (invalid negative TOF, or TOF so long nobody cares), and the useful region is a diagonal band. On a departure×TOF grid the useful region is rectangular, giving uniform sample density where it matters at the same cell count. Rendering is a shear transform, so the canonical chart with diagonal TOF lines is preserved.

**Resolution.** NASA's handbook uses a 160-day departure span and a 400-day arrival span, covering TOF from 100 to 450 days, with C3 contours drawn up to 50 km²/s² (above that "considered to be generally not of interest because of the large propulsive maneuvers they require"). Copy those bounds; they are a well-tested default.

At 1-day resolution that is 160 × 400 = 64,000 Lambert solves. Izzo converges in ~2-3 iterations per solve, so this is a few tens of milliseconds in optimized TypeScript. Full-resolution recompute on every UI interaction is affordable. Do the coarse pass at 1 day and, for a crisp displayed optimum, run a local refinement (golden-section or Nelder-Mead on the two dates) seeded from the best coarse cell.

### 1.4 Quantities to compute per cell

| Quantity | Formula | Why |
|---|---|---|
| `C3_dep` | `\|v1_sc − v1_earth\|²` (km²/s²) | The industry-standard axis. Launch vehicle capability is published as mass-vs-C3 curves. |
| `vinf_arr` | `\|v2_sc − v2_mars\|` (km/s) | Drives capture cost and entry heating. NASA plots this as a separate overlay on the same axes. |
| `tof` | `t_arr − t_dep` | Drawn as diagonal lines, 50-day increments in the NASA plots. |
| `dv_TMI` | `sqrt(C3 + 2μ_E/r_park) − sqrt(μ_E/r_park)` | The number the *player* actually pays. See §4.3. |
| `dv_MOI` | `sqrt(vinf_arr² + 2μ_M/r_p) − v_target_orbit` | Ditto at the far end. |
| `dv_total` | `dv_TMI + dv_MOI` | The single scalar to optimize if the game has one ship budget. |
| `Δθ` | heliocentric transfer angle | Classifies Type I/II; drives the ridge guard. |

A real trap in poliastro's API: it returns `dv_dpt` and `dv_arr`, but these are **v-infinity magnitudes**, not burns from a parking orbit. It then sets `c3_launch = dv_dpt**2`, which is correct as C3 but the variable naming has misled a lot of people into treating v∞ as a Δv. Keep naming honest.

### 1.5 Determinism (LONGBURN standing orders)

- Use a **fixed iteration count with a fixed convergence tolerance**, never adaptive or time-budgeted termination. Cap Izzo's Householder iterations (e.g. 15) and treat non-convergence as an invalid cell rather than "keep going."
- No wall clock anywhere. Grid dates are virtual-clock JD offsets.
- If the grid is parallelized (workers), reduce results in **index order**, not completion order. Floating-point summation order matters for any aggregate.
- Pin the ephemeris interpolation scheme. Two different Chebyshev evaluation orders give different last-bit results and therefore different "optimal cell" picks near ties.

---

## 2. Validation data: real Earth→Mars windows

### 2.1 Primary source

**NASA/TM—2010-216764**, Burke, Falck & McGuire (NASA Glenn Research Center, October 2010), *Interplanetary Mission Design Handbook: Earth-to-Mars Mission Opportunities 2026 to 2045*. Generated with MIDAS, a patched-conic interplanetary trajectory optimizer. This covers exactly our window range and is the single best validation target available.
https://ntrs.nasa.gov/api/citations/20100037210/downloads/20100037210.pdf

The per-opportunity tables give four rows: two optimizing minimum C3 (Type I and Type II), two optimizing minimum Mars arrival V∞. Times of flight below are the agent's arithmetic from the published date pairs.

### 2.2 The 2026 opportunity (Table 2 of the handbook)

| Case | Earth departure | Mars arrival | TOF (d) | C3 (km²/s²) | V∞ arrival (km/s) | RA / Dec of asymptote |
|---|---|---|---|---|---|---|
| Type I, min C3 | **2026-11-14** | 2027-08-09 | 268 | **11.11** | 2.915 | 120° / 28.28° |
| Type II, min C3 | **2026-10-31** | 2027-08-19 | 292 | **9.144** | 2.729 | 130.7° / 23.16° |
| Type I, min V∞ | 2026-11-14 | 2027-08-09 | 268 | 11.11 | **2.915** | 120° / 28.28° |
| Type II, min V∞ | 2026-11-06 | 2027-09-08 | 306 | 9.646 | **2.565** | 130° / 32.8° |

**Headline number for 2026: minimum C3 = 9.144 km²/s², Type II, departing 31 Oct 2026, arriving 19 Aug 2027, 292 days.**

Independent cross-check: a 2025 paper in the *Journal of the Korean Society for Aviation and Aeronautics* (Vol 33 No 2), using Lambert plus patched conics on JPL DE405, gives an optimal 2026 departure of **15 Oct 2026 → 10 Aug 2027, ~299 days, C3 = 10.4297 km²/s², V∞ = 2.7932 km/s**. That is 2 weeks and ~1.3 km²/s² from the NASA figure. Treat **±2 weeks in date and ±1.5 km²/s² in C3 as the acceptable agreement band** between independent tools; anything tighter is over-claiming, anything looser means a bug.
https://www.jksaa.org/archive/view_article?pid=jksaa-33-2-19

### 2.3 The 2028/2029 opportunity (Table 3)

| Case | Earth departure | Mars arrival | TOF (d) | C3 (km²/s²) | V∞ arrival (km/s) | RA / Dec |
|---|---|---|---|---|---|---|
| Type I, min C3 | 2028-12-10 | 2029-07-20 | 222 | **9.048** | 4.892 | 158.9° / 1.581° |
| Type II, min C3 | **2028-12-02** | 2029-10-16 | 318 | **8.928** | 3.261 | 185.1° / 29.34° |
| Type I, min V∞ | 2029-01-17 | 2029-09-02 | 228 | 24.12 | **3.593** | 140.9° / 1.581° |
| Type II, min V∞ | 2028-11-20 | 2029-09-18 | 302 | 9.315 | **2.966** | 182.8° / 25.51° |

**Headline for 2028: minimum C3 = 8.928 km²/s², Type II, departing 2 Dec 2028, arriving 16 Oct 2029, 318 days.**

Two deliberate test cases:

1. The Type I min-V∞ row costs **24.12 km²/s²**, nearly triple the min-C3 solution, to buy 1.6 km/s of arrival V∞. If the planner reproduces that trade, the two objectives are genuinely decoupled and it is not accidentally optimizing one proxy.
2. 2028's Type I min-C3 (9.048) is nearly identical to its Type II (8.928), yet arrival V∞ differs enormously (4.892 vs 3.261). A planner that ranks by C3 alone picks a trajectory that is catastrophically expensive to capture into.

### 2.4 Further windows (Table 1, and per-opportunity tables)

Optimal (lowest-energy across both types) per opportunity:

| Year | C3 (km²/s²) | Type |
|---|---|---|
| 2026 | 9.144 | II |
| 2028 | 8.928 | II |
| 2031 | 8.237 | II |
| 2033 | **7.781** | II |
| 2035 | 10.19 | **I** |
| 2037 | 14.84 | II |
| 2039 | 12.17 | II |
| 2041 | 9.818 | II |
| 2043 | 8.969 | II |
| 2045 | 8.587 | II |

Additional date pairs worth having as test vectors:

- **2031**, Type II min-C3: depart 2031-02-23, arrive 2032-01-09, 320 d, C3 8.237, V∞ **5.530** (cheap to leave, brutal to arrive).
- **2033**, Type II min-C3: depart 2033-04-28, arrive 2034-01-27, 274 d, C3 **7.781**, V∞ 4.377. Best departure energy in the whole 20-year set.
- **2033**, Type I min-C3: depart 2033-04-06, arrive 2033-10-01, **178 d**, C3 8.412, V∞ 3.956. Notably fast.
- **2035**, Type I min-C3: depart 2035-04-21, arrive 2035-11-03, 196 d, C3 10.19, V∞ 2.692. **The one year where Type I beats Type II.**

The 2035 anomaly is a genuine physics check, not noise. The handbook: "the arrival date for the Type II transfer approaches the aphelion date of Mars, and larger departure energies are necessary to reach Mars at its furthest point." If the planner reproduces 2035 preferring Type I, its Mars eccentricity handling is correct. If it always prefers Type II, Mars' orbit has probably been circularized somewhere.

The handbook also notes the 15-17 year meta-cycle: "Earth and Mars nearly return to their original relative heliocentric positions every 7 to 8 synodic periods." That is why 2037 (14.84) is expensive, mirroring 2020's expensive window, and why 2033 (7.781) is cheap. Nice to surface in-game.

### 2.5 Handbook caveats

- It is a 2010 study, labeled on its own cover "a formal draft or working paper, intended to solicit comments and ideas from a technical peer group."
- Arrival is modeled as a **flyby**, not a propulsive capture, deliberately: the C3 column is a pure departure-energy optimum and the V∞ column is unweighted by capture cost.
- The methodology section contains what is almost certainly a typo: "The trajectories calculated with MIDAS were specified to be Venus flyby trajectories" in a document entirely about Mars. Read as Mars flyby.
- Verification: MIDAS was validated against the earlier George & Kos handbook (NASA/TM-1998-208533) for the 2005 opportunity: 15.89 vs 15.883 km²/s² on C3, 3.219 vs 3.2602 on V∞, dates "within one or two days." That is the accuracy floor of the published data itself.

### 2.6 Flown missions as end-to-end sanity checks

| Mission | Departure | Arrival | TOF (d) | Type | C3 (km²/s²) |
|---|---|---|---|---|---|
| MSL / Curiosity | 2011-11-26 | 2012-08-06 | 254 | I | 11.68 |
| MAVEN | 2013-11-18 | 2014-09-22 | 308 | — | — |
| MOM | 2013-12-01 (TMI) | 2014-09-24 (MOI) | 297 | — | — |
| ExoMars TGO | 2016-03-14 | 2016-10-19 | 219 | — | — |
| InSight | 2018-05-05 | 2018-11-26 | 205 | — | — |
| Mars 2020 / Perseverance | 2020-07-30 | 2021-02-18 | 203 | — | 14.40 |

C3 figures are from the JKSAA paper (§2.2), which independently recomputed them.

**Launch period width** is the most useful number for game design. JPL's Mars 2020 press kit: "Targeted Launch Period: no earlier than July 20 to Aug. 11, 2020" — **23 days**, with a **2-hour daily window**. ISRO's MOM: 15 Oct to 15 Nov 2013, **31 days**, **5-minute daily window** (tighter because PSLV's low margin made parking-orbit RAAN alignment critical).
https://www.jpl.nasa.gov/news/press_kits/mars_2020/launch/quick_facts/
https://issfd.org/2015/files/downloads/abstracts/017_B-S.pdf

**A realistic Mars launch period is 3 to 4 weeks wide.** That is the number to expose to players, not the single optimal instant.

---

## 3. Synodic period and phasing

### 3.1 Core constants

```
T_Earth = 365.256 d          n_Earth = 0.98561 °/d
T_Mars  = 686.97  d          n_Mars  = 0.52404 °/d
relative drift = n_E - n_M   = 0.46157 °/d
T_synodic = 360 / 0.46157    = 779.95 d  (2.135 yr)
```

NASA's handbook gives 779.935 d. The agent's independent computation from semi-major axes gives 779.95 d. Use 779.94 d.

### 3.2 Departure phase angle

General relation, where Δθ is the heliocentric transfer angle the spacecraft sweeps:

```
γ_departure = Δθ − n_Mars · TOF
```

γ is how far Mars leads Earth in heliocentric longitude at departure. For a Hohmann transfer, Δθ = 180°.

Idealized circular-coplanar Earth→Mars Hohmann (agent computation, r_E = 1.0 AU, r_M = 1.523679 AU):

```
TOF                   = 258.87 d
Δv1 (heliocentric)    = 2.9447 km/s   →  C3 = 8.671 km²/s²
Δv2 (heliocentric)    = 2.6489 km/s   →  = v∞ at Mars
total heliocentric Δv = 5.5936 km/s
departure phase angle = 44.34°   (Mars leading Earth)
arrival phase angle   = −75.14°  (Earth relative to spacecraft at Mars; sets return wait)
```

Note how close the idealized C3 of 8.671 is to the real 2026 value of 9.144 and the real 2033 value of 7.781. The circular-coplanar model is a genuinely good first-order predictor of *energy*; where it fails is *dates*, because real windows are shifted and reshaped by Mars' e = 0.0934 eccentricity and 1.85° inclination.

### 3.3 How bad off-window transfers get

The agent built a small universal-variable Lambert solver and swept departure phase angle over a full synodic cycle in the circular-coplanar model, taking the best TOF at each phase. It reproduces the analytic Hohmann exactly (C3 = 8.6712, v∞_arr = 2.6489, total 5.5936). `dV_TMI` is the burn from a 200 km circular LEO parking orbit.

| Days off optimum | Phase (°) | min C3 (km²/s²) | TOF (d) | v∞ arrival (km/s) | dV_TMI (km/s) | penalty |
|---|---|---|---|---|---|---|
| 0 | 44.5 | 8.67 | 259 | 2.65 | 3.611 | — |
| 10 | 39.9 | 9.05 | 283 | 2.89 | 3.628 | +0.016 |
| 20 | 35.3 | 9.80 | 313 | 3.51 | 3.661 | +0.049 |
| 30 | 30.7 | 10.62 | 337 | 4.08 | 3.697 | +0.085 |
| 45 | 23.7 | 11.86 | 367 | 4.81 | 3.750 | +0.139 |
| 60 | 16.8 | 13.08 | 394 | 5.43 | 3.803 | +0.192 |
| 90 | 3.0 | 15.47 | 436 | 6.37 | 3.906 | +0.295 |
| 120 | 349.1 | 17.79 | 475 | 7.14 | 4.005 | +0.393 |
| 180 | 321.4 | 22.21 | 544 | 8.33 | 4.191 | +0.579 |
| 260 | 284.5 | 27.67 | 631 | 9.51 | 4.416 | +0.805 |
| 390 | 224.5 | **102.62** | 649 | 11.83 | 7.176 | **+3.565** |
| 520 | 164.5 | **222.59** | 238 | 6.93 | **10.757** | **+7.146** |
| 650 | 104.5 | 70.28 | 277 | 4.00 | 6.053 | +2.441 |
| 720 | 72.2 | 24.89 | 271 | 3.11 | 4.302 | +0.691 |
| 780 | 44.5 | 8.67 | 259 | 2.65 | 3.611 | 0.000 |

Reading this for game design:

- **The window is soft, not sharp.** Within ±30 days the C3 penalty is 20%, but the actual departure burn penalty is under 0.1 km/s. This is why real launch periods are 3-4 weeks wide.
- **The real cost of slipping is arrival V∞ and trip time, not departure energy.** At 30 days off, C3 rises 22% but v∞ at Mars rises 54% and TOF grows by 78 days. Capture cost and consumables punish a late departure. Communicating the window through C3 alone makes slipping feel free.
- **The cliff is around 90-120 days out.** Beyond that it is "wait for the next window" territory.
- **Worst case is ~520 days off, not 390.** The maximum lands where the required transfer is a near-180° chase: C3 ~223 km²/s², a 26× increase; even after Oberth the LEO departure burn triples to 10.8 km/s.
- **Row 780 returning exactly to row 0 is the synodic-period regression test.** If it does not close, phase bookkeeping is wrong.

Caveat: the "min C3" column at large offsets selects pathologically long transfers (600+ days). Ranking by total Δv gives a smoother and more honest curve. Rank by total, display both.

Published human-mission analysis agrees on magnitude: NTRS 20150001240 reports a 2033 conjunction-class mission needing 3.3 km/s while the lowest-energy opposition-class mission needs >50% more, and "to skip no more than one mission opportunity at a time would require at least 9 km/s."

---

## 4. Patched conics, SOI, and KSP-level fidelity

### 4.1 What KSP actually models

- **Two-body patched conics with hard spherical SOI boundaries.** Exactly one body's gravity at any instant; SOI crossing instantaneously re-references to the new primary; no blending.
- **Planets on rails**, never perturbed (load-bearing: Jool's moon Val would be ejected within a few orbits under true n-body).
- **No Lagrange points, no n-body.** The Principia mod exists specifically to replace this.
- Stock Kerbin is exactly circular in the reference plane; Duna has e = 0.051, i = 0.06°. Real Mars is e = 0.0934, i = 1.85°, which produces the Type I/II asymmetry, the 2035 anomaly, and the nodal transfer. **Real ephemerides put LONGBURN strictly above KSP fidelity already.**

### 4.2 SOI radii

`r_SOI = a · (m_planet / m_Sun)^(2/5)` (agent-computed):

| Body | r_SOI (km) | in body radii | **as fraction of orbital radius** |
|---|---|---|---|
| Earth | **924,647** | 145 | **0.62%** |
| Mars | **577,228** | 170 | **0.25%** |
| Venus | 616,278 | 102 | 0.57% |
| Moon (about Earth) | 66,183 | 38 | 17.2% |
| Jupiter | 48,219,777 | 674 | 6.2% |

The right-hand column justifies a heliocentric-only Tier 0: point-patching Earth's SOI introduces ~0.62% position error on the heliocentric arc, Mars ~0.25%. **Tier-0 C3 and v∞ computed with a point-patch are good to roughly 1%, well inside the ±1.5 km²/s² tool-agreement band from §2.2.**

The one real approximation cost is time: escaping Earth's SOI at v∞ ≈ 3 km/s takes 4-6 days, Mars approach a couple more — a point-patch loses ~2-3% of the ~260-day TOF. Matters only for arrival dates accurate to better than a week.

The Moon's 17.2% and Jupiter's 6.2% are where point-patching genuinely breaks. A future lunar leg needs actual SOI geometry, not a point.

### 4.3 Delta-v adders (agent computations, μ_E = 398600.4418, μ_M = 42828.375, R_M = 3396.19)

**Earth departure (TMI) from a 200 km circular parking orbit.** v_circ = 7.7843 km/s, v_esc = 11.0086 km/s.

| C3 (km²/s²) | v∞ (km/s) | Δv_TMI (km/s) |
|---|---|---|
| 8.93 (2028 optimum) | 2.99 | 3.622 |
| 9.14 (2026 optimum) | 3.02 | 3.632 |
| 11.11 (2026 Type I) | 3.33 | 3.718 |
| 14.00 | 3.74 | 3.843 |
| 20.00 | 4.47 | 4.098 |

**The single most important design insight in the report.** Because of the Oberth effect, more than doubling C3 from 9.1 to 20 costs only **0.47 km/s** of actual burn. A player looking at a C3 porkchop sees a 120% penalty; a player looking at their fuel gauge sees 13%. Show Δv from the parking orbit as the primary player-facing number; keep C3 as the expert overlay.

**Mars orbit insertion**, from the arrival hyperbola at 400 km periapsis:

| v∞ arrival (km/s) | → 400 km circular | → 1-sol ellipse (a = 20,448 km) | → barely captured |
|---|---|---|---|
| 2.565 (2026 min-V∞) | 2.040 | 0.874 | 0.648 |
| 2.729 (2026 optimum) | 2.119 | 0.954 | 0.728 |
| 2.915 (2026 Type I) | 2.207 | 1.041 | 0.815 |
| 3.261 (2028 Type II) | 2.403 | 1.238 | 1.012 |
| 3.593 | 2.601 | 1.436 | 1.210 |
| 4.892 (2028 Type I) | 3.466 | 2.300 | 2.074 |

Cross-check: published aerocapture literature quotes 2079 m/s for insertion to a 400 km circular Mars orbit from v∞ = 2.6 km/s; the formula gives 2056 m/s at the same v∞ — 1% agreement.

Note the asymmetry: at the far end, **v∞ is not forgiving.** Going from v∞ 2.7 to 4.9 more than doubles the capture burn — the opposite of departure behavior, and exactly why the 2028 Type I solution (cheap C3, v∞ 4.892) is a trap.

**Representative full budget, 2026 Type II optimum:** LEO ≈ 9.4 km/s, TMI 3.63, MOI to 1-sol ellipse 0.95. Post-LEO total ≈ **4.59 km/s**.

### 4.4 What Tier 0 legitimately omits, and what it must not claim

Safe to omit at heliocentric-only Tier 0:

- Planetocentric hyperbolic legs at both ends (point-patch, ~1%).
- The daily launch window and parking-orbit RAAN alignment (a launch-vehicle problem, not a transfer problem).
- Declination of launch asymptote and launch azimuth constraints (real — Cape Canaveral range safety restricts azimuth to 40°-115° — but future gameplay, not Tier 0).
- Finite-burn and gravity losses (a few percent on TMI).
- Deep-space / broken-plane maneuvers (flatten the Type I/II ridge; later tier).
- Aerobraking and aerocapture (large: can cut Mars-arrival budget from ~3.2 to ~1.2 km/s).
- Trajectory correction maneuvers (tens of m/s).

Must **not** claim at Tier 0:

- No n-body accuracy or Lagrange points — cannot get them from Lambert.
- No arrival-date precision better than a few days, given the point-patch time error.
- Never present the C3 optimum as "the best trajectory" without the arrival-V∞ overlay (§2.3 shows why that is actively wrong).

---

## 5. Existing open-source tools

- **poliastro `PorkchopPlotter`** — reference design. https://github.com/poliastro/poliastro/blob/main/src/poliastro/plotting/porkchop.py — broadcasts launch×arrival grids, `None` for non-positive TOF, three contour layers (filled C3, dashed red TOF, navy arrival velocity), defaults `max_c3=45 km²/s²`, `max_vhp=5 km/s`. **Archived Oct 2023, unmaintained**; maintained fork is **hapsira** (https://github.com/pleiszenburg/hapsira).
- **Degenerate Conic** (https://degenerateconic.com/porkchop-plots.html) — contours departure C3, arrival C3, and their **sum**; separates short-way/long-way as distinct overlaid families instead of one chart with a ridge scar. Arguably the better UI pattern for a game; recommended.
- **lamberthub** — solver benchmarking + cross-validation vectors.
- **PyKEP** (ESA) — maintained, proper multi-rev `lambert_problem`.
- **GMAT** (NASA, open source) — court of last resort if our numbers and the handbook disagree.
- **MATLAB File Exchange #39248** (David Eagle) — compact readable reference implementation.
- **NASA Trajectory Browser** (https://trajbrowser.arc.nasa.gov/traj_browser.php) — searchable; **its Δv budgets are quoted from a 200 km LEO**, same reference as §4.3, so directly comparable. Best independent cross-check for specific date pairs.
- **Multi-revolution / Type III & IV**: skip at Tier 0 (multiple roots per cell, branch selection; not what any real Mars mission flies).

---

## 6. Recommendations for LONGBURN, in priority order

1. **Single prograde zero-rev Lambert per cell.** Let Type I/II emerge from geometry. Guard |Δθ − 180°| < 0.05°.
2. **Compute on departure × TOF, render on departure × arrival.** NASA's spans: 160-day departure, TOF 100-450 d, C3 contours capped at 50 km²/s².
3. **Use Izzo's algorithm** with a hard iteration cap and fixed tolerance, for determinism. Validate against lamberthub vectors.
4. **Rank cells by total Δv (TMI + MOI), not by C3.** Display C3 as an expert overlay. Oberth makes C3 a badly miscalibrated proxy for what the player pays, and C3-only ranking picks actively bad trajectories.
5. **Always overlay arrival v∞.** It punishes a slipped departure and is what the 2028 Type I trap turns on.
6. **Regression tests, in order of value:**
   - 2026 Type II: 2026-10-31 → 2027-08-19, C3 9.144, v∞ 2.729 (±1.5 km²/s², ±2 weeks)
   - 2028 Type II: 2028-12-02 → 2029-10-16, C3 8.928, v∞ 3.261
   - 2033 Type II: 2033-04-28 → 2034-01-27, C3 7.781 (global minimum of the set)
   - 2035 prefers **Type I** (10.19) over Type II (17.52) — the Mars-aphelion eccentricity check
   - Synodic closure: phase at t and t + 779.94 d must give identical C3 to solver tolerance
   - Circular-coplanar degenerate case must reproduce C3 = 8.671, v∞ = 2.649, TOF = 258.87 d, phase = 44.34°
7. **Expose a 3-4 week launch period, not a single instant.** Justified by JPL's 23-day Mars 2020 period, ISRO's 31-day MOM period, and the §3.3 sweep (sub-0.1 km/s penalty within ±30 days).
8. **State the Tier-0 error bar honestly as ~1% on energies**, citing the SOI-to-orbital-radius ratios (0.62% Earth, 0.25% Mars). Defensible; "KSP-level" undersells what real ephemerides already buy.

---

## Sources

- NASA/TM—2010-216764, *Interplanetary Mission Design Handbook: Earth-to-Mars Mission Opportunities 2026 to 2045* — https://ntrs.nasa.gov/api/citations/20100037210/downloads/20100037210.pdf — **primary validation source.** Caveats: 2010 working draft, flyby-arrival assumption, one apparent "Venus flyby" typo.
- NTRS citation page — https://ntrs.nasa.gov/citations/20100037210
- J. Korean Soc. Aviat. Aeronaut. 33(2) — https://www.jksaa.org/archive/view_article?pid=jksaa-33-2-19 — independent Lambert+patched-conic study on DE405; cross-validation tolerance source.
- Wikipedia, *Porkchop plot* — https://en.wikipedia.org/wiki/Porkchop_plot
- Degenerate Conic, *Porkchop Plots* — https://degenerateconic.com/porkchop-plots.html
- poliastro porkchop source — https://github.com/poliastro/poliastro/blob/main/src/poliastro/plotting/porkchop.py (archived); maintained fork https://github.com/pleiszenburg/hapsira
- NASA Trajectory Browser — https://trajbrowser.arc.nasa.gov/traj_browser.php (Δv referenced to 200 km LEO)
- JPL Mars 2020 Launch Press Kit — https://www.jpl.nasa.gov/news/press_kits/mars_2020/launch/quick_facts/
- ISSFD 2015, *Launch Window Analysis for Mars Orbiter Mission* — https://issfd.org/2015/files/downloads/abstracts/017_B-S.pdf
- Orbital Mechanics & Astrodynamics: transfer phasing — https://orbital-mechanics.space/interplanetary-maneuvers/interplanetary-transfer-phasing.html ; SOI — https://orbital-mechanics.space/interplanetary-maneuvers/sphere-of-influence.html
- Wikipedia, *Patched conic approximation* — https://en.wikipedia.org/wiki/Patched_conic_approximation ; KSP Forums — https://forum.kerbalspaceprogram.com/topic/124639-what-are-patched-conics/
- NTRS 20150001240, *Trades Between Opposition and Conjunction Class Missions* — https://ntrs.nasa.gov/api/citations/20150001240/downloads/20150001240.pdf
- arXiv 2310.00891 — https://arxiv.org/pdf/2310.00891 — MOI cross-check to 1%.
- Wikipedia, *Mars Science Laboratory* — https://en.wikipedia.org/wiki/Mars_Science_Laboratory

**Computed by the agent, not sourced** (scripts at `reference/porkchop-lambert-sweep.py` and `reference/offwindow-penalty-sweep.py`): the SOI radius table; the idealized Hohmann figures (C3 8.671, v∞ 2.649, TOF 258.87 d, phase 44.34°); all Δv_TMI and Δv_MOI tables; the off-window penalty sweep in §3.3; times of flight derived from published date pairs.
