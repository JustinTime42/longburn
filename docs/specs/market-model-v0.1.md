# Market Model v0.1

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
simulation — no order book, no depth, no NPC trading fleets (out of T0 scope,
GDD §7.4). One NPC entity exists by Overseer ruling (Q4, 2026-08-08): the
forward desk that quotes the hauling contract in §4. GDD §7.4's literal text
still lists "contracts" and "NPC firms" as scope-out; the write-back amending
§7.3/§7.4 to record this ruling is a pending gate-2 action, **longburn-gfg4**
(Warden din.6.1 r1 f7; the v3t plan-and-burn precedent is the model). din.6.4
does not build until that write-back or an Overseer reversal lands.

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
  constants**. The sim core's per-step update is integer
  multiply/add/divide-by-power-of-two
  only. This is SO 16's planner/commitment split applied to the market: the
  math that derives the coefficients advises; the quantized constants commit.
- The noise term is an **integer Irwin-Hall sum** (AMENDED per Warden din.6.1
  r1 f2, which caught the unpinned normalisation): draw twelve uniform
  integers on `[0, M)` with `M = 2^16`, sum them, and subtract `6·(M − 1)`.
  `Z_n` is then an exact integer with mean 0 and standard deviation
  `sqrt(M² − 1) ≈ M`, approximately normal in shape. **The normalisation is
  folded into the coefficient**: `b = round(2^s · σ_step / sqrt(M² − 1))`.
  No Box-Muller anywhere. **`M = 2^16` is load-bearing** (Warden r2): with a
  uint32 source, drawing on `[0, 2^16)` is an exact high-bits truncation with
  zero modulo bias; a different `M` requires re-deriving the unbiasedness
  argument, not just retuning.

**Per-step update (integer domain, AMENDED per Warden din.6.1 r1 f3+f4):**

```
P_{n+1} = clamp(P_min, P_max,
          floor( ( a·P_n + (S − a)·μ + b·Z_n + S/2 ) / S ) )
```

where `a = round(2^s · e^{-θΔt})`, `S = 2^s` (scale shift `s = 32`), and `b`
as above are pinned config integers; `μ`, `P_min`, `P_max` are integer
prices. `σ_step` is the exact discrete-step deviation
`σ_diff·sqrt((1 − e^{−2θΔt}) / 2θ) = σ_stat·sqrt(1 − e^{−2θΔt})`, computed at
config time only (see §7 for which σ the config carries).

- **The `+ S/2` is load-bearing**: plain floor division truncates toward −∞
  every step, and the constant ~0.5-credit bias equilibrates against the
  mean-reversion pull at `μ − P* ≈ 0.5/(1 − a/S)` — about **87 credits below
  μ** at the §7 defaults, a defect the fixed-seed pins would have recorded as
  normal (Warden f3's arithmetic). Round-to-nearest removes the systematic
  term; the residual per-step rounding is bounded by ±0.5 credits and carries
  no constant sign. Any implementation change to this rounding is a
  price-history-breaking change.
- **Numeric domain (f4):** no `>>` anywhere — JS shift coerces to int32 and
  silently corrupts at `s = 32`. All arithmetic in plain `Number` with
  `Math.floor(x / 2**s)`: the worst-case numerator at the §7 defaults is
  `a·P_max + (S−a)·μ + b·|Z_max| + S/2 ≈ 2.2e13`, comfortably inside the
  2^53 exact-integer range (headroom verified in the r1 review). A test must
  pin this bound against the config so a retune cannot silently overflow.

- **Prices are integers** (credits, no subunits at T0). Negative prices are
  impossible by the clamp; a floor hit is an ordinary market state, not an
  error.
- **Cadence:** one market step per hour of sim time (config
  `marketStepMs`, default 3 600 000). Three weeks ≈ 500 steps — trivial for
  the event log; well inside j1av's known T0 headroom.
- **Sim time is the input** — the process advances only when the loop advances
  it; nothing here reads a wall clock.
- **Seed (AMENDED per Warden din.6.1 r1 f5 — the substream facility does not
  yet exist and must be built by din.6.2):** `src/sim/rng.ts` today is a
  single mulberry32 stream with no derivation facility. din.6.2 adds
  `deriveStream(worldSeed, streamId)`: fold the stream name (`"market:" +
  commodityId`) to a uint32 via FNV-1a, mix with the world seed through
  splitmix32, and seed an independent mulberry32 — deterministic, documented,
  pinned by fixture tests. Stream independence is determinism-critical: it is
  what stops any future RNG consumer from silently reshaping every historical
  price series. (Also f5's minor: the existing `nextInt` routes through an
  IEEE-754 float multiply — exactly specified operations, not SO 16
  transcendentals, but "pure integer arithmetic" claims are scoped to the
  price update itself, not the RNG internals.)
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
  expectation at the arrival planned **at composition time**, minus a config
  spread), payable on delivery. **Quote mechanism (AMENDED per Warden r2 f2 —
  the r1 text said "authoring-side", which is impossible: the expectation
  `μ + (P_t − μ)·aᴺ/Sᴺ` depends on runtime spot and horizon):** the quote is
  computed **planner-side at composition time** from the current spot and the
  planned horizon, transcendental-free — `aᴺ` by integer
  exponentiation-by-squaring on the already-pinned `a` — then **quantized
  into the contract as a persisted fact** (SO 16's planner/commitment shape,
  exactly like a burn parameter). The contracted rate is **never recomputed**:
  replay and settlement read the persisted rate (the kg2 doctrine, §6 test 5,
  applies to it explicitly — it is the number a dispute turns on).
  Certain, lower margin. **Two-sided risk by construction**: the holder is
  protected when spot crashes and locked out when spot spikes past the agreed
  rate (lock-in regret) — the forward converts price risk into opportunity
  cost plus a delivery obligation, it does not eliminate risk.
  - **Re-planning vs the quote (Warden f8; REOPENED by Warden din.6.4 r2 f1
    with worked numbers; RULED by the Overseer 2026-08-10, longburn-gll3 —
    the T0 fence below is in force):** the plan is paper (pillar 2) and
    arrival may be re-planned after composition. At T0 **the quoted rate
    stands regardless of actual arrival time** — the desk honors it whenever
    delivery occurs. The earlier justification ("at a 5-day half-life the
    arrival distribution is essentially stationary, so quotes carry almost no
    timing information") was FALSE for a degenerate paper plan: at shipped
    constants a throwaway 1-hour plan quoted ≈ spot − spread (a¹ ≈ 0.994),
    and re-planning to the real transit afterwards converted the forward into
    a guaranteed sale at today's spot — ≈ 1,880 cr/ton risk-free at spot
    3,000, 7.5× §7's ~250 cr/ton safety bar. The T0 fence makes the
    justification true by construction instead of by assumption:
    1. **Destination check (typed refusal):** `composeCargo` refuses
       contracted tonnage unless the flight plan's destination is the
       forward's market body. A contract for delivery at a body requires a
       plan that goes there.
    2. **Quote-horizon floor (an information clamp, never a refusal):** the
       quote exponent uses `N_q = max(N_planned, N_min)`, `N_min` config
       (§7). Below the floor the quote is the near-stationary quote, so a
       short-horizon plan carries no timing information worth re-planning
       around. Default derivation: worst-case extractable timing information
       is `(P_max − μ)·a^N_min`; setting it equal to the §7 bar gives
       `4000·2^(−N_min/120) = 250 → N_min = 480` sim-hours (20 days). An
       honest 3-week transit (504 h) sits above the floor and quotes
       unchanged. A refusal-shaped floor was considered and rejected: it
       would refuse honest fast transits outright, where the clamp only
       denies them timing information.
    Delivery windows, quote-repricing on revision, and non-delivery penalties
    remain market-genesis design (longburn-yitm) — deferred there because the
    solo world has **no counterparty to harm** (f8's correction stands: not
    because arrival is "deterministic"; a player can re-plan or never arrive,
    which at T0 is self-cheating).
- **Spot tonnage**: owned outright, sold at the destination's then-current
  price (§ sell side below). Full exposure, full upside.

This is not a financial slider: both lots are loaded mass, so carrying a spare
speculative ton costs real delta-v and transit time — **optionality has a fuel
price** (pillar 1). **Mass accounting (su0j, Mayor decision 2026-08-10 under
Overseer delegation; governing memo
`docs/design/cargo-capital-tuning-v0.1.md`):** composed tonnage is mass inside
the fixed 1,000 t departure wet mass and displaces propellant (propellant
budget = wet − structure − cargo); the delta-v ceiling is derived
planner-side at composition, quantized, and persisted as the authoritative
commitment input (SO 16). Total composed tonnage above the hold capacity (§7)
is a typed refusal. Settlement is physical delivery only; no cash-settled
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
3. **Statistics (property assertions, not harvested fixtures):** mean-reversion
   pull toward μ; clamp floor/ceiling branches; Irwin-Hall endpoint centering;
   a fixed-seed 500-draw window must satisfy `|sum| ≤ 5σ`, where
   `σ = sqrt(500 · (M² − 1)) ≈ 1.47e6`. This is a stated plausibility bound,
   not a price-history fixture (and with a fixed seed it is a deterministic
   plausibility band, not a distribution test with statistical power — do not
   credit it with more). One harvested fixed-seed price pin is deliberately
   RETAINED as a determinism canary; the prohibition above is on harvested
   fixtures standing in for property assertions, not on canaries. *(This item
   reworded by the Forge under longburn-aq3n, faithful to the bead text;
   ratified and clarified by the Mayor 2026-08-08 per Warden aq3n f3+f4+f6 —
   spec wording stays the Mayor's lane.)*
4. **Trade:** sell-at-arrival validation against the arrival-instant price
   (not issue-instant); typed refusals for each case in §4; integer proceeds
   exactness; duplicate-sale refusal.
5. **Replay:** market state is reducer-replayable from the log like all sim
   state; quotes are facts once persisted (kg2's live-only ruling applies —
   replay never re-runs the process to second-guess a persisted quote). The
   **contracted forward rate is likewise a persisted fact, never recomputed**
   (Warden r2 f2).
6. **Overflow headroom pin (Warden r2 f4, promoted from §2 prose):** a test
   pins the worst-case update numerator against the 2^53 exact-integer bound
   **computed from the live config**, so a din.11 retune cannot silently
   overflow.
7. **`deriveStream` fixtures (Warden r2 f4):** the RNG substream derivation is
   pinned by fixture tests (fixed worldSeed + streamId → pinned first draws),
   so stream assignment can never silently change across refactors.
8. **Forward fence (longburn-gll3):** typed refusal when the plan's
   destination is not the forward's market body; the floor clamp pinned
   (quote at any `N < N_min` equals the quote at `N_min`); and the
   extractable-information bound `(P_max − μ)·a^N_min ≤ 250` asserted **from
   the live config**, so a din.11 retune of walls, half-life, or floor cannot
   silently reopen the exploit.

## 7. Initial parameters (all retunable config; product-tuning pass before din.11)

| Param | Default | Note |
|---|---|---|
| Commodity | 1 (`refined-volatiles`, name cosmetic) | schema carries commodityId for N later (Q2) |
| μ (mean price) | 1 000 cr/ton | |
| P_min / P_max | 200 / 5 000 | clamp walls |
| θ (reversion) | half-life ≈ 5 days | slow enough that mid-transit news matters |
| σ_stat (stationary std) | 250 cr | the config-facing σ (Warden f9: §2's σ_diff derives from it, `σ_diff = σ_stat·sqrt(2θ)`; per-step `σ_step = σ_stat·sqrt(1 − e^{−2θΔt})` ≈ 27 cr/hour-step at these defaults). din.11 tuning note: at a 5-day half-life a 3-week transit is ≈ 4.2 half-lives, so arrival is essentially stationary and forward quotes ≈ μ − spread on nearly every run — the hedge is a pure risk-appetite dial, not a market read. **Lengthening the half-life requires quote-repricing-on-revision to land FIRST** (Warden r2 f3: at a 30-day half-life, quote-then-replan-to-a-far-arrival extracts ≈250 cr/ton risk-free under the rate-stands ruling — the T0 ruling is safe only at near-stationary tuning). |
| Step | 1 sim-hour | |
| N_min (quote-horizon floor) | 480 sim-hours (20 days) | gll3 fence: chosen so `(P_max−μ)·a^N_min` equals the ~250 cr/ton bar exactly at these walls and half-life; retune together with the walls and θ, and §6 test 8 asserts the bound from live config |
| Origin cost | 600 cr/ton | buys must be beatable but lose-able (P_min=200 caps the worst sale; origin must sit well above it — do not retune below ~500 without revisiting the loss floor) |
| Starting capital | 200 000 cr | su0j (was 10 000, which priced the mass coupling out of play): an all-in load is 333 t ≈ 1.0× capital, the games-research tension band; derivation in `docs/design/cargo-capital-tuning-v0.1.md` |
| Cargo hold capacity | 600 t | su0j: 1.8× starting capital to fill; binding constraint flips with geometry (hold binds close, propellant binds far) |
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
- **Q4 — hedging: RESOLVED 2026-08-08 (with the Overseer's refinement).** The
  hedge decision is cargo composition, not a financial ratio: contracted
  tonnage (NPC forward, two-sided risk) vs spot tonnage, both physically
  loaded (§4). Physical delivery only at every tier. Contract non-delivery
  penalties are out of T0 scope (solo world, **no counterparty to harm**);
  designed at market genesis (longburn-yitm).
