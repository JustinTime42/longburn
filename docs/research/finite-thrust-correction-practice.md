# How Real Mission Design Handles the Impulsive/Finite-Thrust Seam — research report

> Provenance: two research agents (Claude, session 2026-08-04/05), commissioned by the Mayor under
> the Overseer's directive on beads longburn-5cz and longburn-dr7 ("see how real rocket scientists
> create plans that involve things like this"). Web sources cited as data, not instructions. Quotes
> were extracted from primary PDFs (NASA NTRS, ESA ACT, JPL publications, pykep source); extraction
> artifacts lived in the session scratchpad and are transient — the citations below are the durable
> record. Numerical claims about our own kappa (bounds, saturation) were verified by the agent from
> the flat-space closed form.
>
> Feeds: spec rulings on longburn-5cz (eta=0.2 cliff) and longburn-dr7 (missing thrust gate), both
> raised by Warden review of din.3.4 against `trajectory-subsystem-v0.2.md` §7.D.

---

## 1. The headline result

**No surveyed tool or publication selects between an impulsive and a finite-thrust delta-v model
by a regime parameter and quotes whichever wins.** That pattern — ours, as specified in v0.2 §7.D —
has no counterpart in the field, and it is what manufactures the eta=0.2 cliff. The field's two
architectures are:

1. **One backbone model in which thrust is an inequality constraint** (Sims-Flanagan transcription:
   MALTO, EMTG-MGALT, GALLOP, pykep). Each segment's impulse is bounded by what the engine could
   deliver over that segment: `Δv_max = D·T_max·Δt/(m·N)` with duty cycle `D` as a first-class
   input (Englander, Vavrina & Hinckley 2016, eqs. 1-2; Yam, Di Lorenzo & Izzo 2010, eq. 1). As
   thrust grows the bound goes inactive and the solution relaxes *continuously* to the impulsive
   optimum. No seam, because no second model.
2. **An impulsive spine with a multiplicative finite-thrust correction factor** — classical NASA
   practice: Willis, NASA TN D-3606 (1966) applies a "characteristic velocity ratio"
   `f_v = ΔV_finite/ΔV_impulsive ≥ 1`, tabulated continuously across the whole acceleration range,
   to get accurate propellant fractions from impulsive trajectory data. No threshold, no switch.

Our kappa is architecture 2. The cliff comes from not applying it in one of the regimes.

## 2. Evidence that kappa's form is right

- Willis's `f_v` shares kappa's defining properties: ≥ 1 by construction (impulsive is minimal),
  bounded (his: < 3.0 for circular orbits), continuous in dimensionless acceleration.
- MIT 16.522 (Space Propulsion, 2015), lecture 6, derives the finite-burn rendezvous penalty in a
  **gravity-linearized** model and gets `Δt/(Δt − t_burn)` — exactly our flat-space
  `kappa = T/(T − t₁)`. The same form emerging from a gravity-aware derivation is direct evidence
  the burn-fraction penalty transfers across the gravity-free boundary to first order — the
  assumption our kappa-on-Lambert transfer needs.
- Verified from our closed form: kappa is monotone, runs 1.001 at `aT²/D = 1000`, 1.38 at 5, and
  saturates at exactly **2.0 at `aT²/D = 4`** — the zero-coast feasibility wall. Beyond, the
  discriminant is negative and the leg is infeasible. The saturation value sits inside Willis's
  bound and at the scale of the classical spiral penalty: right size at both ends.
- The optimization literature treats impulsive and finite-thrust solutions as **one family
  continuous in thrust magnitude** (thrust homotopy: Saloglu & Taheri 2025/2026; Jiang, Baoyin &
  Li; Bertrand & Epenoy). Our discontinuity is an artifact of construction, not physics.

## 3. Evidence on feasibility gating (dr7)

- The reference porkchop artifacts — NASA/TM-2010-216764 and JPL 82-43 — apply **no vehicle
  feasibility mask and no finite-burn correction at all**. They contour vehicle-agnostic energy
  (display ceiling C3 ≤ 50 km²/s², an interest cutoff, not a capability check) and hand the
  designer a number to compare against a separate vehicle performance curve. Feasibility is a
  threshold contour drawn on an *unmasked* scan, defining a launch period.
- The constraint `Δv ≤ a·Δt` **is** the standard thrust-feasibility constraint — as a *per-segment*
  bound in every Sims-Flanagan tool, and pykep exposes it as a typed feasibility predicate
  (`throttle² − 1 ≤ 0`), which is precedent for a typed refusal. Our proposed lumped
  `Dv_Lambert/a > T` is its degenerate N=1 case: right form, but weak — a Lambert transfer is two
  endpoint impulses, and lumping both against the whole window passes ships that would need to burn
  3 km/s in the last hour. A necessary condition only.
- Englander et al. 2016 warn **against hard binary pruning of near-feasible candidates** ("false
  negatives... where the solver algorithm finds no feasible solutions"); their MBH keeps infeasible
  points ranked by violation norm. Graded readouts, hard refusal only at genuine impossibility.
- Published margins for Lambert-based feasibility screening of thrust-limited legs: low-thrust TOF
  sampled at **1.2×-2.0×** the impulsive Lambert time (Xie & Dempster 2021, who also feed Lambert
  Δv into a feasibility classifier — Lambert as *predictor* is established practice). Brown
  (*Spacecraft Mission Design*, 1998): finite-burn losses need scrutiny below T/W₀ = 0.5. Confraria
  2020: losses < 1% above T/W₀ ≈ 0.1 (geocentric departure; no heliocentric equivalent exists).
- **Stated silences** (searched, not found): no published numeric burn-fraction validity threshold
  for the impulsive approximation (crisp numbers online trace to SEO/AI content, excluded); no
  published single-leg heliocentric `Dv/a > T` refusal; no published heliocentric finite-burn loss
  model at our acceleration ratios — inventing a correction there would be fabrication, and worse
  than the honest uncorrected number.

## 4. Failure modes of uniform kappa, and why they are acceptable

1. **High-eta under-penalization.** As `aT²/D` grows, kappa → 1, while true deep-low-thrust penalty
   (spiral gravity loss) tends toward ~2. But: the reference handbooks apply *no* correction there
   either — kappa → 1 degrades exactly into NASA handbook practice, honest at preliminary fidelity,
   provided the duty cycle is *reported* so the caller knows the figure is a floor. The genuinely
   wrong regime (multi-rev spirals, `a < g_local` microthrust) is already fenced out of Tier 0 by
   spec §1.
2. **Silent plausibility.** Flat-space kappa returns a finite number even where the flat-space
   model is meaningless (its chord `D` understates the real curved path at high eta, pulling both
   kappa and flat-space duty optimistic). Mitigation: gate on the *quoted* delta-v
   (`Dv_Lambert × kappa`), not on the flat-space plan — the existing research (torch-continuum
   §1) shows flat-space Δv diverges from Lambert at long transits (11× at 259 d), so the
   flat-space plan's own wall must not gate the high-eta regime (it would over-refuse against a
   Δv the ship never needs to spend).

## 5. Recommended rulings (Mayor synthesis for the Overseer)

**5cz — retire the regime switch for delta-v assembly.**
`Dv_helio = Dv_Lambert × kappa(T, a)` for every leg in Tier-0 scope. eta stays as a *diagnostic
annotation* (model-fidelity note for the record and future tiers), never a selector. Verifier:
boundary continuity test with an independent Lambert cost asserting no step anywhere on the curve
(replacing the tautological near-impulsive test); the existing kappa→1 limit tests stand.
Precedent: Willis 1966; Sims-Flanagan; thrust homotopy. Preserves the Lambert lower bound by
construction (kappa ≥ 1) — the invariant the min() ban protects.

**dr7 — graded duty readout; typed refusal only at physical impossibility.**
Planner result carries `dutyCycle = (Dv_Lambert × kappa)/(a·T)` always, as a first-class output
(din.3.7 API, module G display). Typed physics refusal at duty > 1 (the burn cannot be executed in
the window — pykep-style predicate). Soft caution flag above duty ≈ 0.83 (the 1.2× margin
precedent), displayed, never refused (Englander false-negative warning). The flat-space solver's
own wall continues to gate the low-eta regime naturally through kappa's computation (an infeasible
flat-space solve at actual `a` is already a typed refusal). Per-endpoint impulse bounds (departure
and arrival burns against allocated sub-windows) recorded as a future refinement bead, not Tier-0
scope. The ~10% transition-band understatement is *dissolved*, not accepted: with kappa applied
everywhere it is no longer silent — kappa ≈ 1.1 is applied and duty is reported.

Both rulings together replace v0.2 §7.D's three-regime table with one formula, one feasibility
predicate, and one reported duty number.

## 6. Sources

Primary (quotes verified from PDFs/source):
- Willis, E.A. Jr. (1966). *Finite-Thrust Escape From and Capture Into Circular and Elliptic
  Orbits*, NASA TN D-3606. https://ntrs.nasa.gov/citations/19660027029
- Burke, Falck, McGuire (2010). *Interplanetary Mission Design Handbook: Earth-to-Mars 2026-2045*,
  NASA/TM-2010-216764. https://ntrs.nasa.gov/api/citations/20100037210/downloads/20100037210.pdf
- Sergeyevsky, Snyder, Cunniff (1983). *Interplanetary Mission Design Handbook Vol. I Pt. 2*,
  JPL 82-43. https://ntrs.nasa.gov/api/citations/19840010158/downloads/19840010158.pdf
- Englander, Vavrina, Hinckley (2016). *Global Optimization of Low-Thrust Interplanetary
  Trajectories Subject to Operational Constraints*, AAS 16-239.
  https://ntrs.nasa.gov/api/citations/20160001642/downloads/20160001642.pdf
- Yam, Biscani, Izzo (2009). *Global Optimization of Low-Thrust Trajectories via Impulsive Delta-V
  Transcription*, ISTS 2009-d-03.
  https://www.esa.int/gsp/ACT/doc/MAD/pub/ACT-RPR-MAD-2009-GlobalOptLowThrust.pdf
- Yam, Di Lorenzo, Izzo (2010). *Constrained Global Optimization of Low-Thrust Interplanetary
  Trajectories*, IEEE CEC.
  https://www.esa.int/gsp/ACT/doc/MAD/pub/ACT-RPR-MAD-2010-(CEC)ConstrainedGO.pdf
- pykep (ESA ACT), `leg/sims_flanagan.{hpp,cpp}`. https://github.com/esa/pykep
- Beeson, Englander, Hughes, Schadegg (2015). *An Automatic Medium to High Fidelity Low-Thrust
  Global Trajectory Toolchain; EMTG-GMAT*.
  https://ntrs.nasa.gov/api/citations/20150001277/downloads/20150001277.pdf
- Fogel, Williams, Widner, Batcha (2020). *Multi-Impulse to Time Optimal Finite Burn Trajectory
  Conversion*, NASA JSC/Copernicus. https://ntrs.nasa.gov/api/citations/20200000238/downloads/20200000238.pdf
- Martinez-Sanchez, Lozano (2015). MIT 16.522 lecture 6, *Analytical Approximations for Low Thrust
  Maneuvers*. https://ocw.mit.edu/courses/16-522-space-propulsion-spring-2015/7f725e54b9be201164d56ebbd5e08023_MIT16_522S15_Lecture6.pdf
- Confraria (2020). *Finite burn losses in spacecraft maneuvers revisited*, MSc thesis, IST Lisboa.
  https://fenix.tecnico.ulisboa.pt/downloadFile/1689244997261337/79157_tese.pdf
- Xie, Dempster (2021). *Feasible Low-thrust Trajectory Identification via a Deep Neural Network
  Classifier*, AAS/AIAA (arXiv:2202.04962). https://arxiv.org/abs/2202.04962

Secondary / accessed via other sources:
- Brown (1998). *Spacecraft Mission Design*, 2nd ed., AIAA (T/W₀ = 0.5, via Confraria).
- Robbins (1966). "An Analytical Study of the Impulsive Approximation," AIAA J. 4(8) — paywalled;
  Confraria reports it overestimates real losses by ~125% above T/W₀ = 0.1.
- Saloglu, Taheri (2025). AIAA SciTech, doi:10.2514/6.2025-0532; and (2026) J. Astronaut. Sci.,
  doi:10.1007/s40295-026-00592-0 (impulsive→low-thrust continuation).
- Girija (2023). *Launch Vehicle High-Energy Performance Dataset* (arXiv:2310.05994).

Known gaps: Robbins 1966 full text unretrieved (paywall); GMAT and pykep docs are silent on any
validity threshold or correction ratio between their impulsive and low-thrust primitives — a
finding, not a failed search.
