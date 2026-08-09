# Market Model v0.1 — DRAFT (pending Overseer approval)

Status: **APPROVED by the Overseer 2026-08-08** (din.6.1; all §8 questions
resolved in design session, including the Q4 cargo-composition refinement in
his words). Governing for the din.6 tree. Fills the reserved class 2.4 of
`emitted-state-catalog-v0.1.md`. Parent design rows: `tier0-decomposition.md`
row F; GDD §7.3 ("A single fake market at the destination whose prices move on a
scripted/noisy basis while you're in flight, so the cargo decision is a real
bet") and success criterion 4 ("testers describe the market bet as tense rather
than as waiting"); forward-economy context in
`docs/design/world-progression-v0.1.md`.

## 1. Purpose and scope

T0 has exactly one market, at the transit destination (Mars for the canonical
Earth→Mars run). It exists to make the cargo decision a bet: the player loads
cargo before departure at a known cost, prices move stochastically during the
weeks-long transit, and the sale settles at a price the player could not have
observed when they committed. The market is a *process*, not a counterparty
simulation — no order book, no depth, no NPC traders (all out of T0 scope,
GDD §7.4).

Non-goals, recorded so they are not accreted: multiple markets, arbitrage
loops, price impact from the player's own trade, commodity interactions,
shorting, any instrument beyond spot sale of carried cargo.

## 2. The price process

A discrete-time mean-reverting AR(1) process — the exact discretization of
Ornstein-Uhlenbeck — advanced by the sim loop on a fixed cadence.

**Determinism constraints (SO 10/11/16), and how the textbook form is bent to
satisfy them:**

- The continuous OU update needs `exp(-θΔt)`; Gaussian noise needs
  Box-Muller (`log`, `cos`). Both are JS transcendentals, which ECMAScript
  leaves implementation-approximated — banned from authoritative sim state
  (SO 16; incident record in `docs/research/lambert-solvers.md` §6, and the
  hvx/d0c scars).
- Therefore: the discretization coefficients are computed **once, outside the
  sim core** (config-build time) and pinned as **quantized fixed-point config
  constants**. The sim core's per-step update is integer multiply/add/shift
  only. This is SO 16's planner/commitment split applied to the market: the
  math that derives the coefficients advises; the quantized constants commit.
- The noise term is an **Irwin-Hall sum of 12 uniform draws** from the seeded
  sim RNG, shifted to mean 0 — approximately N(0,1), pure integer arithmetic,
  bit-exact across engines. No Box-Muller anywhere.

**Per-step update (integer domain):**

```
P_{n+1} = clamp(P_min, P_max,
          ( a·P_n + (S - a)·μ + b·Z_n ) >> s )
```

where `a = round(2^s · e^{-θΔt})`, `b = round(2^s · σ_step)`, `S = 2^s`
are pinned config integers (scale shift `s`, e.g. 32); `μ`, `P_min`, `P_max`
are integer prices; `Z_n` is the centered Irwin-Hall draw. `σ_step` is the
exact discrete-step deviation `σ·sqrt((1 − e^{−2θΔt}) / 2θ)`, again computed at
config time only.

- **Prices are integers** (credits, no subunits at T0). Negative prices are
  impossible by the clamp; a floor hit is an ordinary market state, not an
  error.
- **Cadence:** one market step per hour of sim time (config
  `marketStepMs`, default 3 600 000). Three weeks ≈ 500 steps — trivial for
  the event log; well inside j1av's known T0 headroom.
- **Sim time is the input** — the process advances only when the loop advances
  it; nothing here reads a wall clock.
- **Seed:** dedicated named stream from the sim's seeded RNG (whatever
  substream convention `src/sim/rng` uses), so market noise is independent of
  any other consumer and replays identically.
- Tuning target (product, not physics): parameters chosen so a 3-week transit
  sees swings large enough to flip a typical cargo bet's sign — the bet must
  be *tense* (GDD §7.5 crit. 4). Initial values proposed in §7; retunable
  config like the arrival predicate's constants.

## 3. Events and emission (fills catalog class 2.4)

Two event types, both persisted in the event log, both emitted through the
causal gate — the market has **no lag logic of its own** (decomposition
decision 3: one mechanism, one test surface).

| Event | When | Payload (sketch) |
|---|---|---|
| `marketQuoteUpdated` | every market step | commodityId, price, stepIndex, marketBodyId |
| `marketEventOccurred` | threshold crossing (§5) | commodityId, price, kind (`surge`/`crash`), referencePrice |

- **Event position** = the market's host body's ephemeris position at event
  time (client-side public math for rendering, but the *emission* stamps the
  authoritative position exactly as ship events do). Light-lag to the observer
  follows from the gate; Earth↔Mars staleness of 3–22 min is the product
  experience.
- Class 2.4 is **light-lagged** and therefore inside the durable no-skip
  ledger (catalog delivery-guarantee split, ratified 2026-08-08): a missed
  quote has no other path to the player. Per-event arrival delivery per the
  Overseer's watermark veto — a quote never waits on any other message.
- The sale-outcome report (§4) is a class 2.2-shaped outcome: it happens at
  the market, travels back at c.

## 4. Trade mechanics — the bet

**Buy side (local, before departure):** the player buys cargo at HQ at a
**known, fixed origin cost schedule** (config: credits per ton). There is one
market in T0 (row F); the origin side is a price tag, not a market. Purchase
is a local HQ action — no light-lag. Cargo mass feeds the existing flight-plan
mass/fuel tradeoff (`mass-cargo` machinery): more cargo means a slower or
thirstier transit. That coupling **is** the bet's stake.

**The hedge decision is cargo composition (RATIFIED with refinement by the
Overseer, 2026-08-08).** At loading, tonnage divides into two physically loaded
lots:

- **Contracted tonnage**: committed to an NPC hauling contract — a forward:
  fixed rate per ton (quoted from the price process's closed-form conditional
  expectation at planned arrival, minus a config spread; computed
  authoring-side, quantized, SO 16), payable on delivery. Certain, lower
  margin. **Two-sided risk by construction**: the holder is protected when
  spot crashes and locked out when spot spikes past the agreed rate
  (lock-in regret) — the forward converts price risk into opportunity cost
  plus a delivery obligation, it does not eliminate risk.
- **Spot tonnage**: owned outright, sold at the destination's then-current
  price (§ sell side below). Full exposure, full upside.

This is not a financial slider: both lots are loaded mass, so carrying a spare
speculative ton costs real delta-v and transit time — **optionality has a fuel
price** (pillar 1). Settlement is physical delivery only; no cash-settled
instruments exist at any tier (anti-degenerate-finance guardrail, recorded for
market genesis as well). din.10 records the chosen composition per transit —
revealed risk appetite is a first-class measurement of the live run, and the
tester guide (din.11) should nudge every tester to carry some spot tonnage on
at least one transit so §7.5 criterion 4 has a subject (protocol note, not a
mechanic — pillar 6).

**Sell side (Q1 RESOLVED by the Overseer 2026-08-08: player-configured
disposition per lot).** Spot tonnage carries a disposition, chosen at loading
and revisable en route through the standard command pattern (the change
travels at c and is validated at arrival — flight-plan-model §7's machinery,
nothing new):

- **`manual`** (default): the ship arrives and holds. The player inspects
  light-lagged price reports and, when ready, issues a `sellOrder` from HQ
  travelling at c, executed against the price current when it **arrives** —
  an order placed into a future market state they cannot observe (GDD §4.1).
  Refusal cases: ship not arrived/docked at the market body; no cargo;
  duplicate sale.
- **`sell-on-arrival`**: a standing instruction; the lot sells at the
  arrival-instant spot price with no presence required (pillar 6).
- **Contracted tonnage always auto-settles at delivery** at the forward rate —
  contractually required, not configurable.

An unsold manual hold is a position, not an error (pillar 1: consequences,
not rules).

- Settlement: `cargoSold` event at the market (proceeds = price × tons,
  integer arithmetic; forward settlements at the contracted rate), report back
  at c. Credits balance lives in ship/player state; starting capital is
  config.

## 5. Notification hook (din.7.1 wiring)

`marketEventOccurred` is the notification-worthy trigger ("market events worth
waking for", row G). Threshold: price crossing ±X% (config, default 15%) from
the **last notified reference**, with re-arm on each firing so a slow drift
notifies once, not hourly. din.7.1 consumes the arrival instants the gate
already computes for 2.4; no second light-time surface.

## 6. Test obligations

1. **Determinism:** two runs, same seed → identical price series; determinism
   lint covers `src/sim/market*` like the rest of the core (no transcendental
   enters the step function — extend d0c's guard surface when it lands).
2. **Causality:** market emissions asserted by the same causality suite as
   ship events (SO 12) — a quote reaches the observer no earlier than
   distance/c; the moving-Earth observer case included.
3. **Statistics (fixed-seed pins, not distribution tests):** mean-reversion
   pull toward μ; clamp floor/ceiling branches; Irwin-Hall centering (sum over
   a pinned window ≈ 0).
4. **Trade:** sell-at-arrival validation against the arrival-instant price
   (not issue-instant); typed refusals for each case in §4; integer proceeds
   exactness; duplicate-sale refusal.
5. **Replay:** market state is reducer-replayable from the log like all sim
   state; quotes are facts once persisted (kg2's live-only ruling applies —
   replay never re-runs the process to second-guess a persisted quote).

## 7. Initial parameters (all retunable config; product-tuning pass before din.11)

| Param | Default | Note |
|---|---|---|
| Commodity | 1 (`refined-volatiles`, name cosmetic) | schema carries commodityId for N later (Q2) |
| μ (mean price) | 1 000 cr/ton | |
| P_min / P_max | 200 / 5 000 | clamp walls |
| θ (reversion) | half-life ≈ 5 days | slow enough that mid-transit news matters |
| σ | ≈ 25% of μ over a 3-week horizon | tuned for sign-flipping swings |
| Step | 1 sim-hour | |
| Origin cost | 600 cr/ton | buys must be beatable but lose-able |
| Starting capital | 10 000 cr | |
| Notify threshold | ±15% from last notified | |

## 8. Questions — all resolved by the Overseer, 2026-08-08

- **Q1 — sale mechanics: RESOLVED.** Player-configured disposition per lot
  (§4): `manual` (inspect, then sell-order at c), `sell-on-arrival` (standing
  instruction, no presence required), and contractual auto-settle for forward
  tonnage.
- **Q2 — commodity count: RESOLVED.** One commodity at T0; schema carries
  `commodityId` for N later.
- **Q3 — money: RESOLVED.** Integer credits, starting capital, fixed origin
  cost — every transit ends in a signed profit/loss number, for T0.
- **Q4 — hedging: RESOLVED (with the Overseer's refinement).** The hedge
  decision is cargo composition, not a financial ratio: contracted tonnage
  (NPC forward, two-sided risk) vs spot tonnage, both physically loaded (§4).
  Physical delivery only at every tier. Contract non-delivery penalties are
  out of T0 scope (solo world, deterministic arrival); designed at market
  genesis (longburn-yitm).
- **Q4 — hedging: RATIFIED 2026-08-08 (with the Overseer's refinement).** The
  hedge decision is cargo composition, not a financial ratio: contracted
  tonnage (NPC forward, two-sided risk) vs spot tonnage, both physically
  loaded (§4). Physical delivery only at every tier. Contract non-delivery
  penalties are out of T0 scope (solo world, deterministic arrival); designed
  at market genesis.
