# Trajectory Subsystem Spec v0.2 — the torch-to-Hohmann continuum, done right

Status: APPROVED by the Overseer, 2026-08-05 (all four §8 decisions resolved as recommended; see §8).
Amended: Amendment A, 2026-08-05 (Overseer-approved rulings on longburn-5cz and longburn-dr7; see §9).
Amendment B, 2026-08-06 (longburn-1at; see §10). Amendment C, 2026-08-07 (longburn-ddv; see §11).
Author: Vardis Slowfathom (Mayor). Supersedes the implicit design of bead longburn-din.3 rounds 1–2.
Foundations: `docs/research/lambert-solvers.md`, `docs/research/mars-windows-porkchop.md`,
`docs/research/torch-continuum-models.md` (each with validated reference scripts under
`docs/research/reference/`), plus Warden reviews din.3 r1/r2 (findings recorded on the bead).

## 0. Why a restructure

Two Forge rounds and two Warden reviews established that the single-module, single-model approach
fails at design level, not implementation level: the delta-v axis summed alternative trajectories,
no rendezvous constraint existed, and the flat-space torch model was silently extended into a regime
where it overprices a Hohmann freighter by 10x (research: the flat-space model has a ~55 km/s floor
where the true answer is 5.6 km/s). The Overseer directed a research-first restructure with
KSP-level correctness as the bar. Research delivered validated algorithms, published test vectors,
and quantitative regime boundaries. This spec turns those into buildable, independently verifiable
modules.

## 1. Architecture ruling: two solvers and a blend factor

There is no single closed form spanning impulsive-to-torch in real gravity (research §1, torch
report). The subsystem is therefore:

1. **Conic core** — universal-variable Kepler propagator + Izzo (2015) Lambert solver.
   Owns all gravity physics. Source of the porkchop and all long-transit costs.
2. **Flat-space rendezvous solver** — the 6-equation accelerate/coast/decelerate solution against a
   moving target (torch report §3.2), damped fixed-point with FIXED iteration count.
   Owns feasibility (coast ≥ 0), burn durations, duty cycle. Valid where eta < 0.2.
3. **The blend** — `Dv_helio(T, a) = Dv_Lambert(T) × kappa(T, a)` where
   `kappa = Dv_flat(T, a) / Dv_flat(T, a→∞)`. Gravity is counted exactly once (in Lambert);
   finite thrust exactly once (in kappa). The naive min() of the two models is FORBIDDEN
   (Lambert is a strict lower bound; min() deletes the thrust constraint).
   **[Amendment A] This formula applies to EVERY leg, at every eta. There is no regime in which
   a different delta-v expression is quoted.** Selecting between delta-v models by a regime
   parameter has no counterpart in real mission-design practice and manufactures a ~9%
   discontinuity at the switch (Warden din.3.4 r1 finding 1); the multiplicative correction
   factor applied continuously IS the established practice (Willis, NASA TN D-3606, 1966;
   research: `finite-thrust-correction-practice.md`). kappa ≥ 1 by construction preserves the
   Lambert lower bound — the same invariant the min() ban protects.

Regime parameter: `eta = g_sun(r)·T²/(2·D_chord)`. Torch threshold for ships: **0.01 g**
(the flat-space validity boundary; also Atomic Rockets' torchship definition — physics backs
fiction). **[Amendment A] eta is a DIAGNOSTIC ANNOTATION carried on results (model-fidelity
note for records and future tiers), never a selector of the delta-v expression.** Computed
per-leg, never per-ship. Known, documented limitation: at high eta kappa → 1, so the quote
degrades into the pure impulsive figure — which is exactly the behaviour of the reference
NASA/JPL porkchop handbooks (no finite-burn correction at all), honest at this fidelity
provided the duty cycle is reported (see §2 duty ruling).

Out of Tier-0 scope, fenced (SO 13): microthrust spirals / Edelbaum (needed only when a < local g;
future well-operations tier), multi-revolution *planning* (Type III/IV transfers offered to the
player; the porkchop stays one prograde zero-rev solve per cell per §4), interception exposure and
return windows, aerocapture, launch azimuth/RAAN. NOTE (Warden din.3.2 finding 9): solver-level
multi-rev CAPABILITY is in scope — §6 tier 1 and §7.B require multi-rev validation fixtures — and
must not be stripped citing this fence; the fence is on what the planner offers, not what the
solver can compute.

## 2. Delta-v bookkeeping rulings

- **[Amendment B]** The budget assembles as
  `Dv_total = Dv_depart_well(v∞_dep) + Dv_arrive_well(v∞_arr) + (kappa − 1)·Dv_Lambert(T)`.
  The well burns already impart the hyperbolic excess: for a patched-conic transfer, the impulsive
  heliocentric cost `Dv_Lambert = |v∞_dep| + |v∞_arr|` is paid entirely inside the two well terms,
  so a decomposition that adds a full `Dv_helio` on top counts the heliocentric leg twice
  (incident record: din.3.7 r1 transcribed the previous version of this sentence faithfully and
  quoted ~12.3 km/s where the true figure is ~6.0; Warden r1 blocker, longburn-1at). The only
  heliocentric term in the sum is the finite-burn residue
  `(kappa − 1)·Dv_Lambert = Dv_helio − Dv_Lambert`, which vanishes in the impulsive limit
  (kappa → 1) and preserves §1.3's invariant: gravity counted exactly once, finite thrust
  exactly once.
- Well terms are patched-conic point-model FUNCTIONS of that cell's v∞, evaluated per porkchop
  cell: `Dv_well(v∞) = sqrt(v∞² + 2μ/r_p) − v_orbit` (Oberth included). They are not constants
  per (origin, destination, parking orbit), and no term of the sum is T-invariant: the v∞ pair
  varies across the porkchop grid and the wells vary with it. Tier 0 ships START in a parking
  orbit; the player-facing cost is the burn from that orbit, NOT raw v∞ (Oberth is worth
  ~6 km/s on an Earth→Mars run and C3 is a badly miscalibrated proxy — porkchop report §4.3).
  Reference pin: the §6 2028 fixture assembles to ~6.03 km/s (hand-derived 6.0256 km/s, Warden
  din.3.7 r2).
- v∞ vectors are computed against ephemeris body velocities **at their own epochs** (departure body
  at t_dep, arrival body at t_arr). Using one epoch for both is a named classic bug.
- Rendezvous is position AND velocity matching. The rendezvous invariant is a property test:
  propagate the committed plan and assert terminal position/velocity error against stated tolerances,
  with a genuinely moving destination from the real ephemerides module.
- Infeasibility is a typed refusal, never a clamp and never a sentinel zero. The f=1 torch case is
  computed analytically (t_b = T/2, coast = 0), never through the quadratic discriminant — the
  discriminant is exactly zero there and its float sign is noise (Warden din.3 r2 finding 1;
  measured firing rate 22.5%).
- **[Amendment A] Thrust-feasibility gating is graded, and it gates on the QUOTED delta-v.**
  Every planner result carries `quotedDutyCycle = Dv_helio/(a·T)` as a first-class output
  (consumed by G's Pareto assembly and displayed by H2; named `quotedDutyCycle` — Overseer-approved
  rename 2026-08-05, longburn-606 — to be unmistakable next to `flatspacePlan.burnDutyCycle`, the
  flat-space plan's own firing fraction, which can differ by 11x). Typed physics refusal ONLY at
  quotedDutyCycle > 1 — the ship cannot accumulate the quoted delta-v inside the window
  (pykep-precedent typed feasibility predicate). A soft `finiteBurnCaution` flag is set at
  quotedDutyCycle > 0.83 (the published 1.2x
  screening margin, Xie & Dempster 2021) — displayed, never refused: hard pruning of
  near-feasible candidates is a named failure mode (Englander et al. 2016 false negatives).
  The gate runs on `Dv_helio = Dv_Lambert × kappa`, never on the flat-space plan's own delta-v,
  which diverges from Lambert at long transits (11x at 259 d — torch report §1) and would
  over-refuse. The flat-space solver's own wall (negative discriminant at actual `a`) continues
  to produce typed refusals through kappa's computation wherever it binds. Per-endpoint impulse
  bounds (departure/arrival burns against allocated sub-windows) are a future refinement, filed
  not built (SO 13).

## 3. Fuel and cargo rulings

- **Constant-acceleration (throttled) burn model.** `Dv = a·t_burn` exact, `MR = exp(Dv/v_e)` exact;
  propellant is proportional to burn seconds. Constant-thrust is a documented non-goal (2.3x
  divergence if mixed; torch report §6).
- `cargo_fraction = exp(−Dv/v_e) − f_struct`, with `f_struct` the structural fraction of wet mass.
  Cargo ≤ 0 is a typed "nonviable" result distinct from infeasible-trajectory. The viability wall
  `Dv_max = v_e·ln(1/f_struct)` is a design constant, not an emergent accident.
- The Tier 0 ship configuration fixes its departure wet mass at 1,000 t for authoritative
  propellant accounting. A plan revision is accepted or refused at arrival by the **exact
  integer wall comparison** (sufficient iff total quantized delta-v < the viability wall,
  strict; at-the-wall refuses — longburn-hvx, amended here by longburn-7n6); sequential
  per-node projection from remaining mass survives as a readout, not the decision mechanism.
  Callers never name fuel costs.
  (Overseer-ratified 2026-08-07, longburn-40j.3; Warden note: the constant is behaviorally inert
  today — the accept/refuse decision is scale-invariant in wet mass, so it sets readout units only,
  becoming load-bearing when cargo mass exists. Ship system v2 is filed: longburn-hev.)
- For a fixed ship the Pareto front is the 2-D curve `(T, Dv*(T))`; cargo is a derived readout.
  The surface is 3-D only across ships (v_e as decision variable). The planner API returns the
  per-window curve with feasibility walls; it does not fabricate a third independent axis.

## 4. Window search / porkchop rulings

- Grid: compute on (departure × time-of-flight), render on (departure × arrival). Spans per NASA
  handbook defaults: 160-day departure span, TOF 100–450 d, C3 display cap 50 km²/s².
- One prograde zero-rev Lambert per cell; Type I/II emerge from geometry, never special-cased.
  Guard |Δθ − 180°| < 0.05° as invalid-cell (the ridge is real and rendered; the singular line is
  not). Rank cells by total Δv; C3 and arrival v∞ are overlays (both required — the 2028 Type I
  trap: near-identical C3, catastrophic v∞ difference).
- Windows are 3–4 week soft regions, not instants (JPL/ISRO precedent + off-window sweep: <0.1 km/s
  penalty within ±30 days; the real cost of slipping is arrival v∞ and trip time — which is the
  correct feel for LONGBURN's irreversibility pillar).

## 5. Determinism rulings (extends standing orders 10–11)

- All iterative numerics run FIXED iteration counts (Lambert: capped Householder, non-convergence =
  invalid cell; flat-space solver: fixed 200 iterations, damping 0.5). No tolerance-terminated or
  time-budgeted loops in anything that can touch sim state.
- JS transcendentals (`acos`, `exp`, `log`, `pow`, `asinh`, `Math.hypot`) are
  implementation-approximated per ECMAScript — NOT bit-reproducible across engines. Therefore:
  **the planner is a planning-layer tool outside the deterministic sim core. A committed maneuver
  stores QUANTIZED burn parameters (fixed-point delta-v / burn seconds) as the authoritative sim
  input.** The sim replays from quantized values, bit-exact by construction. (Adopted as standing
  order 16, Overseer 2026-08-05.)
- Quantization resolution (pinned 2026-08-05, Warden din.3.6 finding 5, Mayor ruling on finding 3):
  **burn duration in integer milliseconds is the SINGLE authoritative committed field**; delta-v is
  derived exactly as a×t_burn from the fixed ship config and is never stored as an independent
  second field (two independently-rounded fields = a dispute-replay divergence class). Changing the
  resolution is a spec amendment, not a code edit.
- `acos` arguments clamped to [−1, 1]; no `Math.hypot` in the conic core; parallel grid reduction
  in index order if ever parallelized.

## 6. Validation contract (what "super duper right" means, mechanically)

Fixture tiers, all committed as test vectors with sources:
1. **Solver-level**: the seven published Lambert cases (Vallado 7-5, Curtis 5.2, Battin 7.12,
   Der I/II, generated multi-rev M=1 and heliocentric M=0/1/2 — exact vectors in
   `docs/research/lambert-solvers.md` §2) at stated tolerances; the Lambert round-trip property
   (solve → propagate → land on r2, ~1e-12 km well-conditioned); flat-space solver limits
   (brachistochrone endpoint exact, 2D/T impulsive limit, stationary closed form to machine
   precision).
2. **Physics-level**: circular-coplanar Hohmann degenerate case (C3 8.671, v∞ 2.649, TOF 258.87 d,
   phase 44.34°); kappa → 1 in both limits; continuum continuity across regime switches (no cliffs
   in the returned curve — Warden r2 finding 3).
3. **World-level** (against NASA/TM—2010-216764, band ±2 weeks / ±1.5 km²/s²):
   2026 Type II (2026-10-31 → 2027-08-19, C3 9.144, v∞ 2.729); 2028 Type II (C3 8.928, v∞ 3.261);
   2033 Type II (C3 7.781, the 20-year minimum); **2035 must prefer Type I** (the Mars-eccentricity
   check); synodic closure at +779.94 d.

A world-level failure outside the band is a defect, full stop. The band itself is committed in the
fixtures with its derivation cited.

## 7. Module decomposition (the bead tree)

Each module is a bead with its own verifiers; dependencies as listed. All pure functions of
(sim time, ephemerides, ship parameters) — SO 10/11 apply throughout.

- **A. kepler-core** — universal-variable propagator + conic utilities. Verifies: propagation
  round-trips elements; known-orbit fixtures; near-parabolic conditioning documented (the oracle
  caution from research §4).
- **B. lambert-izzo** — port of `reference/izzo-reference.py` with lamberthub as the transcription
  source (the paper's Eq. 30 successor is misprinted). Verifies: fixture tier 1. Depends on A
  (round-trip property uses the propagator).
- **C. flatspace-rendezvous** — §3.2 solver + analytic f=1 path + min-T bisection + duty cycle.
  Verifies: tier-1 flat-space cases; typed infeasibility; t=0-and-nonzero initial-time property
  ranges (min: 0 — Warden r2 finding on excluded fresh-world case). No dependencies.
- **D. continuum-blend** — eta (diagnostic), kappa, `Dv_helio = Dv_Lambert × kappa` on every leg,
  quotedDutyCycle + finiteBurnCaution + typed duty>1 refusal [Amendment A — no regime selection].
  Verifies: tier-2; kappa→1 limits; boundary continuity asserted with an INDEPENDENT Lambert cost
  (no step anywhere on the curve — the near-impulsive self-consistent test is tautological at the
  boundary and does not discharge this verifier). Depends on B, C.
- **E. window-search** — porkchop grid over the real ephemerides, ranking, well-term adders.
  Verifies: tier-3 (the NASA handbook fixtures). Depends on B (D optional overlay: torch feasibility
  wall per cell). **[Amendment C]** Performance budget, measured (longburn-e0y, corrected figures
  of record): generation ~2.9–3.7 µs/cell (186–235 ms at 64k), universal-kappa assembly
  58.945 µs/cell (3772.5 ms at 64k, all-feasible grid — not an upper bound; walled cells cost more
  via `refineGeneral`). A full planning sweep of ~3.3–3.8 s is ACCEPTED for Tier 0 (Overseer,
  2026-08-07, longburn-ddv): async play, low query rate. The original "64k cells in tens of ms"
  estimate predates Amendment A and described only the Lambert generation leg. torchTime-class
  work stays hoisted out of inner loops (Warden r2 finding 9); optimization work is filed
  (longburn-5x0, longburn-s3t), not scheduled, and is revisited only on observed T0 latency
  complaints.
- **F. mass-cargo** — rocket equation, viability wall, quantization helpers for commitment.
  Verifies: MR/cargo tables from research §6; quantization round-trip. No dependencies.
- **G. planner-api** — the Pareto curve assembly consumed by din.4 (commit-and-burn) and H2 (picker
  UI): per-window curve, feasibility walls, duty-cycle readout, typed infeasible/nonviable reasons,
  authoritative-arrivalTime convention documented (Warden r2 finding 12). Depends on D, E, F.

Salvage from `bead/din.3` (at 6049213): the Lambert core Sereth verified faithful to Curtis Alg 5.2
by inspection feeds B's starting point; the ephemerides-wired test harness feeds E. The branch is
otherwise superseded; its handoffs stand (SO 7) with the r2-mandated superseding handoff.

## 8. Decisions (resolved by the Overseer, 2026-08-05)

1. **Quantized-commitment determinism rule** (§5): ADOPTED as a charter standing order.
   Amendment applied same day with this approval as its record.
2. **Well terms at Tier 0**: patched-conic adders per (body, parking orbit), Oberth-correct.
3. **Ship parameterization at Tier 0**: fixed (v_e, a, f_struct) tuple in config; 2-D Pareto curve;
   ship design deferred to a later tier.
4. **Bead tree**: approved as specified in §7; filed as children of longburn-din.3 with the branch
   at 6049213 superseded and its Lambert core salvaged into module B.

## 9. Amendment A (approved by the Overseer, 2026-08-05)

Raised by Warden review of din.3.4 (findings 1 and 2 — the code was faithful to the spec as then
written; the spec had the cliff and the gap). Grounded in commissioned research:
`docs/research/finite-thrust-correction-practice.md` (Willis 1966 multiplicative correction
precedent; Sims-Flanagan thrust-as-constraint; no surveyed tool selects between delta-v models by
regime; Englander false-negative warning; pykep typed-predicate precedent; Xie & Dempster 1.2x
margin). Beads: longburn-5cz (ruling A), longburn-dr7 (ruling B).

**Ruling A (5cz):** the §1.3 blend formula applies to every leg at every eta; the three-regime
delta-v selection (eta < 0.2 flat-space / 0.2–0.5 Lambert×kappa / > 0.5 Lambert-only) that din.3.4
round 1 implemented from the research regime map is retired. eta is demoted to a diagnostic
annotation. The eta = 0.2 quoted-delta-v cliff (~9%) is thereby removed by construction.

**Ruling B (dr7):** graded thrust-feasibility: `quotedDutyCycle` first-class on every result
(field renamed from `dutyCycle` with Overseer approval 2026-08-05, longburn-606), typed
refusal only at quotedDutyCycle > 1, `finiteBurnCaution` at > 0.83, gate computed on the quoted
`Dv_helio`, never the flat-space plan. The ~10% silent transition-band understatement is dissolved
(kappa is now applied there and duty is reported).

Amended text carries `[Amendment A]` markers in §1, §2, and §7.D. Implementation bead filed under
din.3 as the successor to din.3.4's regime logic.

## 10. Amendment B (approved by the Overseer, 2026-08-06)

Raised by Warden review of din.3.7 (the r1 code was a faithful transcription of §2's then-written
decomposition; the sentence itself instructed the double-count). Bead: longburn-1at.

**Ruling:** §2's first bullet is replaced. The assembled budget is
`Dv_total = Dv_depart_well + Dv_arrive_well + (kappa − 1)·Dv_Lambert`. The well burns impart the
v∞ pair, so the impulsive heliocentric cost lives entirely inside the well terms and only the
finite-burn residue is added on top. Well terms are per-cell functions of v∞, not constants, and
every term varies with transit time. Matches the merged planner (`src/planner/pareto.ts`) and the
§6 2028 fixture pin (6.0256 km/s hand-derived). Authoritative anchors unchanged: §0 (true answer
~5.6 km/s for the Hohmann freighter case) and §1.3 (gravity counted exactly once).

Amended text carries the `[Amendment B]` marker in §2.

## 11. Amendment C (approved by the Overseer, 2026-08-07)

Raised by the longburn-e0y measurement (Warden-reviewed r1/r2; corrected figures on the bead)
and ruled on longburn-ddv. §7.E's "64k cells in tens of ms" was a pre-Amendment-A estimate of
the Lambert generation leg alone; measured reality is 186–235 ms generation plus ~3.77 s
universal-kappa assembly at 64k cells. The Overseer accepts seconds-scale planning sweeps for
Tier 0 and re-bases §7.E's budget on the measured numbers. din.4/H2 size against these figures.
Optimization beads (5x0, s3t) remain filed, unscheduled.

Amended text carries the `[Amendment C]` marker in §7.E.
