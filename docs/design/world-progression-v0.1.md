# World Progression v0.1 — the world as a caused thing

Status: design document, drafted by the Mayor 2026-08-08 from three Overseer design
sessions. **Sections marked RULING record decisions the Overseer made on 2026-08-08 and
are in force. The §4 T1/T2 proposal was RATIFIED by the Overseer 2026-08-08 (gate 2,
longburn-52lr) and the GDD tier table is amended accordingly** (the GDD and tier ladder
are Overseer-only; this doc proposed, the Overseer amended). This is a design doc, not a
governing spec: nothing here authorizes implementation beyond the current tier (SO 13).

## 1. The core principle

**Nothing exists in the world until player action causes it to exist.** The world begins
at (approximately) the real present: no space program, no stations, no markets. Contracts
pull players outward; settlements follow players; markets follow settlements. The world
is never a large empty simulation, because the only things simulated are things somebody
caused. This is GDD §5's self-scaling origin criterion generalized from player origins to
the entire world, and it is simultaneously a performance strategy, an anti-dead-world
guarantee, and the fiction's explanation for why the world feels alive.

The authority split: **servers run settlements, players run ships.** NPC ships backfill
only where player supply fails a settlement's survival needs, and withdraw when players
return (pillar 4's self-exiting clause; reuse §4.7's market-maker firm design — identity,
home ports, outcompetable — for haulers).

## 2. Contracts: the world's own tech tree

Two regimes, and the boundary between them is the load-bearing design decision
(pillar 3 defense):

- **Authored bootstrap (finite):** the pre-settlement era's hand-crafted seed. Spy
  satellites, weather satellites, comm constellations, rovers, flag-and-footprints
  science missions. KSP-progression-shaped. These are content, they are few, and they
  are allowed to be special.
- **Derived steady state (forever):** every other contract is generated from a demand
  model, never authored. Recurring demand makes the early rungs inexhaustible:
  satellites wear out and need replacement forever; stations eat forever; equipment
  breaks forever. Once settlements exist, their populations and equipment generate
  buy/sell demand mechanically. Contracts are simulation output, not quest lists.

Ladder shape: satellite contracts → longer/complex missions (sponsored by governments
and corporations for science and prestige, not trade profit) → hauling contracts to
early habitation (single-mission, NASA/SpaceX-CRS-shaped) → **market genesis**: when a
habitation crosses a population/permanence threshold, it opens a real order book where
players and NPCs place and fill orders. Markets are an unlock, never a given. The
reason there is no Ceres market is that nobody lives on Ceres: a fact, not a rule
(pillar 1).

**Unique firsts (RULING: adopted).** Some dynamically generated contracts are
one-per-world-history: exactly one player, ever, is first to land a person on the Moon,
first to each body. On a single persistent world these are world-historical facts.
The event-sourced log is the authoritative history book; the annals surface (who did
what, first, verified) renders straight from it. No claims, just the log.

**Player-founded settlements (RULING: PARKED indefinitely).** Settlements are
server-run until the Overseer reopens this. Rationale recorded: ownership, upkeep,
succession, and abandonment semantics are unsolved; it is the largest griefing surface
in the design; and decay/siege dynamics should be proven on NPC-held settlements first.
Deferred bead filed so the thinking is not lost.

## 3. Timescale (RULING)

- **Production runs at k = 1 (1:1 real time), chosen at world birth, never changed
  mid-world.** The sim-time mapping is a config value (standing order 10), so test
  harnesses and playtest cohorts may run any k — long missions are testable without
  real-world months. The config exists for testing; production is pinned.
- **Uniform or nothing:** any k applies to the entire physical fabric. Travel time and
  light-lag are the same physics; selective compression would let ships outrun their own
  light and break the causality invariant. There is no per-domain or per-player scaling,
  ever.
- Epoch anchors to the real date: a player on a real date sees the solar system as it
  truly is. Consequence accepted knowingly: launch windows are real calendar facts
  (Mars windows ~26 months apart on dates we don't choose); the tech tree, not the
  clock, is the mitigation.
- Why 1:1 survived the pacing challenge: **slowness is load-bearing for the async
  design, and the async design is load-bearing for the niche** (pillar 6; the player
  who thinks about their ship at work). The late game is compressed by technology, not
  the clock — brachistochrone one-way times: 0.01 g gives Mars ~1 month / Pluto
  ~6 months; 0.1 g gives ~9 days / ~2 months; 1 g gives ~3 days / ~17 days. The early
  game is compressed by content shape, not the clock (§4).
- Early-game pacing levers inside 1:1: **LEO-first onboarding** (90-minute orbital
  periods give minutes-to-hour event cadence in the first session with zero clock
  trickery); **fast portfolio growth** (two or three concurrent small contracts by day
  one — check-in-and-manage requires a portfolio to manage); **notifications as the
  heartbeat** (din.7); **tech-progression pacing** (how long the Hohmann era lasts in
  real months is a tunable, without touching the clock).

## 4. Tier mapping

- **T0 (RULING: unchanged).** The lonely transit keeps its question: is a multi-week,
  irreversible transit compelling alone? Rationale recorded: of the two existential
  hypotheses — H1 "the long transit is compelling" and H2 "a cislunar contract loop can
  carry the early game" — H1 is the radical, distinctive, longest-feedback claim
  (3 weeks by construction, since duration is the thing under test), and the tier
  discipline tests the scariest load-bearing claim first. H2 is the safer, faster-to-
  test claim. T0's fake market is the H1 test instrument; under the delivery-contract
  skin (payout floats with destination price) even its fiction survives into the settled
  world, and its price process is a candidate reference model for §4.7 market makers
  and newborn settlement markets. Nothing in T0 is discarded by this vision.
- **T1/T2 (RATIFIED 2026-08-08, gate 2, longburn-52lr): the cislunar bootstrap.** Redefine around the
  contract loop: authored seed contracts plus recurring-demand generators, solo then
  multiplayer, hours-to-days cadence, the vibrant earth-moon zone (stations, lunar
  surface and orbital bases, mining, science, agriculture). Absorbs T2's existing
  question ("does a small population produce a breathing market") and adds H2 ("does
  the contract loop carry the early game"). Playtest cohorts at elevated k are
  permitted here at Overseer discretion (the config exists); production remains 1:1.
- **T3+ (mapping, not new scope):** market genesis at habitation thresholds, then
  demand-gated expansion outward — the existing T4 premise ("does the organic expansion
  premise actually fire") with this document's mechanism attached.

## 5. Risk register

1. **Content-faucet trap (pillar 3):** resolved by the two-regime contract split (§2).
   The tripwire to watch: any steady-state contract that had to be hand-written is a
   design failure to investigate, not a content task to repeat.
2. **Pacing at 1:1:** resolved by §3's levers; measured, not assumed, at the cislunar
   tier.
3. **Irreversibility at world scale (RULING: it is a feature).** One persistent world;
   world-progression outcomes are permanent. The stance, in the Overseer's framing: this
   game serves the Dwarf-Fortress definition of fun, and that is only honest if losses
   are always attributable to real simulated causes the players can understand and route
   around — which is why the simulation must be spotless (this fort's verification
   culture is the implementation of that sentence). Correction levers, when the world
   stalls, must themselves be physical/economic (new sponsor capital, distress premiums),
   never admin edits (pillar 1).
4. **Player-founded settlements:** parked (§2).
5. **Late joiners on a historied world:** unique firsts sharpen GDD §4.4's concern
   (early players own history). Mitigations live in §4.4 (dynamic origins) plus the
   inexhaustible steady-state contract regime; revisit at the multiplayer tier.

## 6. Beads filed from this document

Contract generation model (design), settlement lifecycle + market genesis (design),
NPC backfill rules (design), player-founded settlements (parked/deferred), T1/T2
ladder amendment (HUMAN, gate 2), wall-clock anchor rate field (folded into
longburn-9j0).
