# Cargo & Capital Tuning v0.1 (longburn-su0j)

Status: **DECIDED by the Mayor 2026-08-10 (session 15), under Overseer
delegation** ("do research, make a decision on ratios; we'll tweak during
testing"). These are pre-playtest defaults for the din.11 tuning pass to
adjust, chosen from three research sweeps (spacecraft mass fractions,
terrestrial freight, physics-game and trading-game tuning) plus the T0
physics already ratified in trajectory-subsystem-v0.2 §3. Warden finding of
origin: din.6.4 f6 (the coupling was numerically vacuous as configured).

## 1. The decision

| Param | Old | New |
|---|---|---|
| Starting capital | 10,000 cr | **200,000 cr** |
| Origin cost | 600 cr/ton | unchanged |
| Cargo hold capacity | (absent) | **600 t** |
| Wet mass / structure / v_e | 1,000 t / 15% / 1,000 km/s | unchanged (ratified) |

**Model statement (the wiring's contract):** composed tonnage (contracted +
spot, both physically loaded) is mass inside the fixed 1,000 t departure wet
mass and **displaces propellant**: propellant budget = wet − structure −
cargo. The delta-v ceiling with cargo C tons is `v_e · ln(1000 / (150 + C))`,
derived planner-side at composition, quantized, and persisted as the
authoritative commitment input (SO 16, the same shape as a burn parameter).
Total composed tonnage is refused above the hold capacity (typed refusal).

## 2. Why the physics needed no new mechanism, only money

The coupling is already implemented and ratified (`cargo_fraction =
exp(−Δv/v_e) − f_struct`). Computed over the brachistochrone envelope at the
fixed 1 g ceiling, max cargo vs transit time:

| Transit | 0.52 AU (close) | 1.0 AU | 1.5 AU | 2.5 AU (far) |
|---|---|---|---|---|
| 10 days | 548 t | 350 t | 204 t | 27 t |
| 21 days | 692 t | 569 t | 460 t | 288 t |
| 40 days | 764 t | 691 t | 621 t | 499 t |

Cargo starts binding the trajectory at roughly **200–500 t**. The shipped
economy (10,000 cr affording 16 t) never touches that curve, which is the
whole of Warden f6: the felt tradeoff was priced out, not unbuilt.

## 3. Why these numbers

1. **Tension band (games research).** Early economies praised as tense
   cluster at one cargo load costing **0.8×–3× liquid capital** (Elite 1984:
   0.85×; Taipan: 0.75–3.6×; Drug Wars: ~0.5× for the one affordable good).
   Below ~0.3× there is no decision; above ~4× the player is locked out and
   the early game turns into capital grind (Elite Dangerous, EVE collateral).
   At 200,000 cr and 600 cr/t: an all-in load is 333 t (**1.0× capital,
   exactly in-band**) and a full 600 t hold costs 360,000 cr (**1.8×
   capital**, an aspiration, not a lockout).
2. **The all-in load sits in the physics bite region.** 333 t leaves a
   728 km/s delta-v ceiling: comfortable for a 3-week transit at most
   geometries, prohibitive for sprints, and genuinely constraining at far
   conjunction (2.5 AU: 288 t is the 21-day limit — a fully loaded ship
   *cannot* fly the fast schedule). The games research is blunt that the
   rocket equation alone is too gentle to be legible; the titles where mass
   bites all add a hard ceiling on top (COADE's tank mass ratio, High
   Frontier's weight class, ΔV: Rings of Saturn's Transit Reserve). Our
   displacement model IS that ceiling: load too much and the fast plan is
   refused by propellant sufficiency, not discouraged by a slider.
3. **Two binding regimes, like real freight.** Terrestrial research: every
   mode has a crossover where the binding constraint flips (container ships
   cube out, bulkers weigh out, aircraft are engineered to the crossover).
   With hold 600 t: at close geometry the hold binds (692 t physics room >
   600 t hold), at far geometry propellant binds (288 t < hold). The binding
   constraint flips with orbital geometry across the synodic cycle — a
   depth-over-content mechanic (pillar 3) that costs zero new code beyond
   the wiring.
4. **The real-vehicle envelope.** Sourced payload fractions run 7–48% of wet
   mass; the high end belongs to moderate-Isp electric tugs and
   barely-maneuvering resupply craft, and mature aircraft converge on ~30% of
   MTOW. Our trajectory-dependent 20–60% (200–600 t of 1,000 t) sits at and
   above the top of the historical envelope, defensible for a far-future
   torch, with one honest caveat recorded: at v_e = 1,000 km/s (Isp
   ~102,000 s), the physics-plausible structure fraction is closer to
   Discovery II's 38% (powerplant scales with jet power) than our ratified
   15%. Accepted: the 15% is the ratified T0 ship, and the game's fiction is
   a drive lineage that solved the radiator problem. hev (ship system v2)
   owns any future revisit.
5. **Downside severity (worked).** All-in: 200,000 cr → 333 t. Sold at μ:
   333,000 cr (+67% net worth). At the P_min=200 floor: 66,600 cr (−67%).
   Contracted instead at ≈ μ − spread: 316,350 cr guaranteed, with lock-in
   regret if spot spikes. Two-sided, serious, and the composition dial reads
   as a real risk-appetite instrument for din.10.
6. **Rejected knobs.** Lowering origin cost much below ~500 cr/t breaks §7's
   "beatable but lose-able" (P_min=200 caps the worst sale; origin must sit
   well above it for losses to exist). Shrinking the ship contradicts the
   ratified 1,000 t line. A refusal-shaped hold-plus-capital lockout above
   4× capital is the documented anti-pattern.

## 4. Consequences and follow-ups

- **Wiring bead** (filed with this memo): composeCargo hold-cap refusal;
  displacement accounting into the propellant projection; the
  composition-time quantized delta-v ceiling as a persisted fact; config
  deltas. Must coordinate with **gll3** (same composeCargo surface — the
  destination check and quote-horizon floor land first or together).
- **j2k9**: the frozen-ceiling spec amendment now also covers the ceiling
  becoming composition-dependent (it was authored ship-constant).
- **hev**: cargo density / hold volume (weight-out vs cube-out with real
  commodity densities) parked there for the multi-commodity tier; T0 is
  mass-only, one commodity, hold cap in tons.
- **din.10**: instruments unchanged; composition per transit remains the
  revealed-risk-appetite measurement, now against stakes that are felt.
- Research reports live in the session transcript; key sourced anchors are
  quoted inline above.
