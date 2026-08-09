# [Working Title: SOL] — Game Design Document

**Version 0.1 — Design Vision & Tier 0 Prototype Spec**
*Status: pre-prototype. Everything below is a bet on the Tier 0 test resolving positively.*

---

## 1. One-Paragraph Pitch

A persistent, single-world, asynchronous strategy MMO set in a near-future solar system running on a 1:1 real-time clock. Players operate shipping, mining, construction, and brokerage businesses across a fully player-driven physical economy. Transits take hours to weeks. Information propagates at light speed. There is no fast-forward, no instancing, and no developer-tuned economic dials. Civilization expands outward only as the player base builds the capacity to make expansion affordable — so the game world's history is literally the record of what its players did.

The target feeling is the thing *The Expanse* nails and no game has captured: space is enormous, help is weeks away, a burn cannot be un-burned, and the news you're acting on is already old.

---

## 2. Design Pillars

1. **No gamey nonsense.** Every constraint in the game is a physical or economic consequence, not a rule. If something limits the player, it should be because of delta-v, mass, distance, light-lag, or another person's decision.
2. **Commitment is irreversible.** A burn cannot be un-burned. Every dispatch is a bet placed under uncertainty into a world that will change before you arrive.
3. **Depth over content faucets.** Mastery should change *which* action is correct, not just how fast you take it. Optimal play must resist compression into a wiki page.
4. **Players are the economy.** NPCs exist only where players are absent, and they exit on their own as players arrive.
5. **Simulation over presentation.** Low-fidelity visuals are acceptable and expected. The product is the sim.
6. **Async-native.** No mechanic may require the player to be online at a specific moment. Sessions are check-ins, not sittings.

---

## 3. Competitive Landscape & The Gap

| Game | Has | Lacks |
|---|---|---|
| **Influence (Adalia)** | Real Keplerian orbits, 250k asteroids, deep production chains, real transit times | Crypto/NFT entry wrapper, fictional system, capped audience |
| **EVE Online** | Player economy at scale, real politics | Minutes-scale travel, online-presence-required combat |
| **OGame / Astro Empires / Planetarion** | The right async check-in loop | Arcade physics, 2003-era design, shallow economy |
| **Hades' Star** | Async-friendly, corporations, long timers | Abstract map, no real orbits, mobile F2P economy |
| **Terra Invicta** | Real Sol system, real transfer windows | Single-player |
| **Delta V: Rings of Saturn** | Hardest physics in the genre | Single-player, belt mining only |
| **Falling Frontier** | Expanse-adjacent aesthetic and tone | Conventional RTS |

**The gap:** no non-crypto, 1:1 real-time, real-Sol-system, asynchronous strategy MMO with a genuinely player-driven economy exists. Influence proved the simulation is tractable and that players will engage on multi-day timescales; it just proved it inside a niche that repelled the strategy audience it was built for.

---

## 4. Core Systems

### 4.1 Physics & Travel

- Real solar system, real ephemerides, 1:1 real time. No time acceleration, ever.
- **Delta-v is the ladder, not distance.** Earth surface → LEO is ~9.4 km/s, the most expensive hop in the system. LEO → anywhere is comparatively cheap. Climbing out of the well is the tutorial arc and the setting's founding myth simultaneously.
- Transit options span a real Pareto frontier with no dominant choice:
  - transit time
  - delta-v cost
  - cargo mass fraction
  - interception exposure
  - return window timing
- **Propulsion tech compresses time, and this is the second progression axis.** Mars is first reachable as an ~8-month Hohmann gamble; later, a continuous-burn torch makes it a routine multi-day run. Every destination is effectively unlocked twice.

### 4.2 Time Structure — Nested Fast Layers

The naive model ("early game fast, late game slow") is wrong. The correct model:

> **The fast layer is not a phase you graduate from. It is local, and it replicates at every node you reach.**

Cislunar is a fast layer (hours). So is Mars–Phobos–Deimos once established. So is the Jovian moon system. So is intra-Belt hopping between nearby rocks. Slow interplanetary transits become *connective tissue between fast neighborhoods*.

Reaching Mars does not slow your game down — it opens a **second board** running at the tempo you already enjoy. A mature player has several local theaters humming at hour-scale plus several hulls crossing the dark between them.

**The layers must interlock, not merely coexist.** Near work determines far outcomes:
- the cislunar depot you finish this week refuels the Mars ship's return leg
- the relay you skipped is why you lose telemetry at closest approach
- the Ceres price you're betting on is being moved by other players while your cargo is committed

A ship under burn is not idle. It is a committed vector with shrinking options.

### 4.3 Economy — Organic Expansion, Zero Dials

**The cold-start problem is solved by premise, not by tuning.**

The world begins approximately where we are now. There is no interplanetary civilization on day one — not because the devs disabled it, but because nobody has built the capability yet. Earth is the entire economy: infinitely deep, price-inelastic, already there. Early players serve:

- government and commercial launch contracts to LEO
- long-duration research payloads further out

**Expansion is demand-gated, never schedule-gated.** A lunar base becomes viable when player-driven launch capacity pushes cislunar cost below the threshold that makes it economic. Then it must be built — and then supplied forever. Then someone mines an asteroid. Then Mars. Each frontier converts into **permanent, compounding standing demand** for water, food, propellant, spares, and structure.

This is the renewability engine, and it has no faucet:
- **Contracts are emitted by scarcity in the physical simulation.** Ceres is short on water because a mining ship broke down; the contract's existence and price are true statements about world state.
- **NPC demand is permanent and large.** A million people on Ceres eat, drink, and breathe whether or not anyone is logged in. This is not a game concession; it is the premise of the setting.
- **The demand ratchet means past achievements stay economically alive** rather than becoming checkboxes.

**Ratchets need failure states.** A colony whose supply lapses must decline: population falls, output falls, lanes go dark. Maintaining civilization is content. Without decay, expansion is a monotone graph and all tension drains out.

**Anti-solved-lane pressure:** popular routes must not stay optimal. Orbital geometry shifts, depots deplete, and competitors saturating a lane crush its own margin.

### 4.4 Starting Locations — The Frontier Is Temporary

Locations become available as **player origins** when their local economy can actually onboard a newcomer: sufficient population, fuel availability, food production, a functioning market. This is a self-scaling criterion with no manual gate.

Consequences:
- **Onboarding infrastructure becomes a player-built good.** Whoever builds the first real depot and habitat on Ganymede is literally opening a starting zone. This is a status prize no other game can offer and a natural sink for late-game ambition.
- **The frontier is only briefly the frontier.** Ceres opens as thin, hard, and lucrative; five years later it is a settled hub with cheap fuel and boring margins while Ganymede is the edge. "I started on Ceres in '31" carries real meaning because that Ceres no longer exists.

**Origin must be identity, not a difficulty slider.** Earth start must be genuinely superior at some things — deep capital markets, mature supply chains, political access, ability to bid on large contracts. Frontier start gets scarcity pricing, first-mover claims, and low competition, at the cost of thin infrastructure and long resupply. If frontier is strictly better for experts, everyone rerolls to the edge, which fails both design and lore. Earth should be where the money and power are.

### 4.5 Information — Light Speed, Everywhere

**All in-game information propagates at c.** Prices, contracts, mayday calls, telemetry, market orders.

Key properties:

- **Actions propagate at c too.** This is what defuses out-of-band coordination. A friend can tell you over Discord that Ceres prices spiked, but your buy order still takes 20 minutes to arrive, by which point locals have already traded on it. Metagaming is made structurally weak rather than policed.
- **Light lag is trivial next to transit times** (Earth–Mars: 3–22 min vs. weeks). So comm delay never gates logistics — it gates *markets, coordination, and emergencies*, which is exactly where the friction belongs.
- **Every market you observe is a market as it was**, and you know precisely how stale. You place orders into a future state you cannot observe.
- **The economy decentralizes for free.** Locals hold an unbeatable latency edge in their own market, so no single system-wide exchange can dominate. Real regional price divergence emerges, and *presence* becomes a competitive asset.

**Starting origin grants literal information asymmetry, not stat bonuses.** A Belter-origin player sees live, accurate Ceres prices, stockpiles, hazard conditions, and depot control. An Earth-origin player sees the same data stale, aggregated, or wrong. This makes information a tradeable good — the deepest and least gamey commodity available — and gives async downtime something worth spending hours on.

**Emergent world events from the same physics:**
- **Solar conjunction.** Mars passes behind the Sun roughly every 26 months; comms black out for ~2 weeks. A recurring, predictable, dread-inducing event. Player-built L4/L5 relays are the mitigation, so blackout resilience becomes real infrastructure that someone owns and profits from.
- **The mayday gap.** Distress travels at c; rescue travels at rocket speed. You learn of the disaster in 20 minutes and arrive in five weeks. This is the emotional core of the setting, delivered as a direct consequence of the sim rather than scripted drama.

**Open risk:** slow verification makes lying viable — false distress calls, phantom cargo, misreported stockpiles. This is either the richest social layer in the game or a griefing nightmare, depending entirely on reputation design.

### 4.6 Reputation — Dual Layer

- **Both individuals and organizations hold reputation**, and organizations hold reputation *with each other*. Nuance is the goal; this system is the least resolved in the design.
- **Contacts gate access to counterparties, not discounts.** A Ceres native can bid on work that never appears in Earth's public listings because it's arranged through people who don't post to open markets. This creates the **broker** role natively — the player with standing in two places who moves opportunity between them.
- **Reputation must be slow, costly, and rivalrous.** Gaining Martian favor should cost Belter standing. If rep can be maxed everywhere, it collapses into a checklist. If it's a real commitment with opportunity cost, it's a strategic position — and political alignment matters without any formal faction-war mechanic.
- **Partnership becomes structurally necessary.** An Earth player with capital and a Ceres player with local access can each do things the other cannot. Cooperation falls out of the geography rather than being bolted on.

**Unresolved:** person-bound vs. org-bound rep. Person-bound makes a corporation a coalition of individuals with differing access — richer, messier, and gives veteran players something irreplaceable to contribute. Org-bound is cleaner but eventually lets a large alliance own every door in the system.

### 4.7 Market-Maker Firms (the NPC question)

**Not a lever. Not scaffolding. Algorithmic traders.**

Dynamically generated NPC firms step in at inflection points where margins become absurd and no player is serving the need. They are subject to **every constraint players face**: real ships, real delta-v, real transit times, real capital limits, real light-lag on their information.

Design rules:

- **They must be beatable, and easily.** Their weakness is *information and reaction time*, never bad math. A firm that misprices is farmable in a boring way; a firm that prices correctly but acts on three-week-old data is beaten through **presence and speed** — exactly the advantage local players should have.
- **They self-scale.** As players saturate a lane, margins compress below the firm's threshold and it exits. No dial, no patch note, no visible dev intervention.
- **Crashes remain possible.** A price floor would kill real failure. A responder that needs six weeks to arrive does not — the shortage persists for the full transit, prices spike, people starve, and relief lands late and wrong. This is the correct texture.
- **They have identity.** Named firms with home ports, known lanes, interceptable hulls, ownable depots, and standing in the same reputation graph. They can be outcompeted, undercut, raided, and driven off a route — and driving one into visible bankruptcy (assets liquidated, lane abandoned, name gone from the market) is a genuine player achievement.
- **Thresholds must not be constants.** Derive entry from capital availability, opportunity cost against other lanes, and route risk premium, so players can't farm a fixed boundary.

**Health metric to monitor:** what fraction of transactions have a player on at least one side? Individual firms being weak does not prevent twelve of them from collectively owning bulk water. If that fraction drops, the economy is drifting toward decorative.

---

## 5. Session Shapes

| Player stage | Check-in rhythm | What they're doing |
|---|---|---|
| New / cislunar | Multiple times daily | Launch scheduling, LEO contracts, depot construction, local market |
| Established | 1–3× daily | Managing several local theaters; one or two interplanetary bets in flight |
| Mature | Daily-ish, higher stakes | Standing orders, contracts with other players, political positioning, intelligence work |

**Unit of play must escalate with scale**, or volume becomes chores: ship → route → standing order → policy → subordinate. Late game should not be dispatching hulls; it should be contracting a hauling co-op and finding out three weeks later they defected to Mars. **Delegation is endgame content.**

---

## 6. Technical Architecture

The genre is anti-realtime, which makes this far easier than a conventional MMO. No twitch input, no client-side prediction, no netcode nightmare. A ship under burn is a deterministic function of state and time.

**Server**
- Node / TypeScript, authoritative, single continuous sim loop
- Postgres for durable state
- **Event-sourced and deterministic.** Seeded RNG. Makes debugging tractable, allows rewinding to investigate disputes, and guarantees "what actually happened to my ship" is always answerable — critical when players commit weeks to a decision.
- All truth lives here: positions, orders, markets, comm arrival times, visibility

**Client**
- One codebase, thin. Renders from server state; propagates orbits locally between updates so the map animates without polling.
- **Browser + mobile parity via a single web client wrapped with Capacitor.** Parity is guaranteed because there is one implementation. Yields App Store / Play presence and, critically, **push notifications** — "transfer window opens in 6 hours," "distress signal received," "your order filled." For an async game the notification layer *is* the retention mechanic.

**Transport**
- WebSocket for live subscriptions, REST for commands
- Full state-since-timestamp resync on reconnect. Mobile backgrounds aggressively; reconnect-and-catch-up is a first-class path, not an afterthought.

**Security-critical:** visibility filtering is server-side and absolute. The server must send each player only what has causally reached them at light speed. If this leaks, the entire information-asymmetry design is visible in the network tab. The client must never compute anything it could be wrong about — not fuel, not arrival time, not what is visible.

**Concurrency profile** resembles a trading venue far more than an action MMO. Single world, no instances, is the easy half.

---

## 7. Tier 0 Prototype

### 7.1 The Question Being Tested

> **Is a multi-week, irreversible transit compelling to a single player with fake numbers and nobody else in the world?**

If 40 days of waiting is boring here, no amount of economic depth downstream rescues it. This is the cheapest possible way to settle the central bet, and it must be settled before any other system is built.

### 7.2 Why This First

The full design specifies four hard systems — trajectory sim, player-driven economy, light-speed information, dual-layer reputation — and **each is only interesting in the presence of the others.** Economy without players is a spreadsheet. Comm lag without a market is an annoyance. Reputation without stakes is a number. That mutual dependency is the specific way ambitious sim projects die. Tier 0 deliberately isolates the one thing that can be validated alone.

### 7.3 Scope — In

- One player, one ship, single-player, local server
- Real ephemerides for Earth, Moon, Mars (and Sun for conjunction geometry)
- 1:1 real time, no acceleration
- Trajectory planning with a real tradeoff: transit time vs. delta-v vs. cargo mass
- **Plan-and-burn: executed burns are forever; planned burns are paper.** No undo, no recall, no cancel of any burn that has fired. Any planned burn may be edited or aborted until it executes (command light-lag applies). *(Amended 2026-08-07, Overseer ruling, longburn-v3t; originally "Commit-and-burn: no undo, no recall, no cancel" with a 6-hour re-target window below.)*
- Full plan agency at light-lag: any planned burn (re-target, correction, capture, arrival profile) may be edited or aborted until it executes; commands travel at c from the player's HQ, so agency thins with distance
- Light-lag applied to all displayed information, with visible staleness indicators
- A single fake market at the destination whose prices move on a scripted/noisy basis while you're in flight, so the cargo decision is a real bet
- **The cargo-composition bet:** a single NPC forward desk at the destination offers a hauling contract before departure — contracted forward tonnage at a rate fixed and persisted at composition (two-sided risk: the rate binds in both directions) versus spot tonnage sold at arrival prices, both physically loaded; optionality costs delta-v. Three sell dispositions: manual sell order at c, sell-on-arrival, contractual auto-settle. Physical delivery only. *(Amended 2026-08-08, Overseer ruling, longburn-gfg4; governing spec market-model-v0.1.md §4.)*
- Push/desktop notification on window opening, arrival, and events
- Deliberately minimal visuals: 2D orbital plot, vector lines, data panels

### 7.4 Scope — Out

Everything else. Specifically: multiplayer, real economy simulation, player-to-player contracts, reputation, NPC trading fleets and firms, colony demand, construction, combat, propulsion tech tree, additional bodies, mobile wrapper, art. *(Amended 2026-08-08, Overseer ruling, longburn-gfg4: the single NPC forward desk and its hauling contract, market-model-v0.1.md §4, are IN Tier 0 scope — see §7.3; the exclusions originally read "contracts" and "NPC firms" unqualified.)*

### 7.5 Success Criteria

Tested against ~5–10 target-audience players (Expanse readers, Aurora 4X / KSP / EVE veterans) over a **minimum 3-week live run** — the test cannot be compressed, since the thing under test is duration.

**Pass:**
1. Testers voluntarily check in more than once daily during a long transit without being prompted
2. Testers report thinking about the ship when not playing
3. At least one tester independently expresses regret or satisfaction about an *executed burn* — evidence that irreversibility is landing emotionally. (A docked ship has zero stakes beyond opportunity cost; regret anchors to ejected mass, not the commit click. Amended 2026-08-07, longburn-v3t.)
4. Testers describe the market bet as tense rather than as waiting
5. Nobody asks for a fast-forward button more than once

**Fail signals:**
- "I set it and forgot it, then came back when it arrived" — the transit is dead time
- Mid-flight decisions ignored or perceived as busywork
- Testers want to skip ahead

### 7.6 Build Notes

- Server-authoritative from day one even though it's single-player. The Tier 0 client should already be a thin window onto a sim loop. This avoids a rewrite and validates the architecture cheaply.
- Event-sourced from day one. Cheap now, near-impossible to retrofit.
- Light-lag filtering implemented server-side from day one for the same reason.
- Real ephemerides via a standard kernel source; patched-conic transfers are sufficient at Tier 0 (full n-body is not the thing being tested).

---

## 8. Tier Roadmap (post-validation, provisional)

| Tier | Adds | Validates |
|---|---|---|
| **T1** | The cislunar bootstrap, solo: the contract loop (authored seed contracts + recurring-demand generators), multi-ship, physical stockpiles, hours-to-days cadence in the Earth-Moon zone (stations, lunar surface and orbital bases, mining, science, agriculture) | Does the contract loop carry the early game, solo? (H2) |
| **T2** | Multiplayer, single world, cislunar only: the same contract loop with player-to-player trade and contracts | Does a small population produce a breathing market in tight geography — and does the contract loop still carry it with real counterparties? |
| **T3** | Reputation (v1), brokerage, information as a tradeable good | Does asymmetry create roles rather than frustration? |
| **T4** | Demand-gated lunar expansion, colony supply and decay, market-maker firms | Does the organic expansion premise actually fire? |
| **T5** | Mars, conjunction blackouts, relay infrastructure, dynamic starting locations | Does the frontier-becomes-hub cycle land? |
| **T6+** | Belt, outer system, propulsion tech compression, interception/conflict | — |

*(T1/T2 rows amended 2026-08-08 by Overseer gate-2 ratification, longburn-52lr, per world-progression-v0.1.md §4: redefined around the cislunar contract loop — T1 absorbs the solo half of H2, T2 keeps its breathing-market question and adds the multiplayer half. Playtest cohorts at elevated timescale k are permitted at these tiers at Overseer discretion; production k=1 is pinned at world birth. Original rows: T1 "Multi-ship, cislunar fast layer, real local economy with physical stockpiles, scarcity-emitted contracts / Does the near loop stay interesting alongside the far bet?"; T2 "Multiplayer, single world, cislunar only. Player-to-player trade and contracts. / Does a small population produce a breathing market in tight geography?")*

---

## 9. Open Questions & Known Risks

**Highest risk — population floor.** A player-driven economy with thin population is a lonely spreadsheet. Influence had significant funding and still struggled to hold a crowd. **Mitigation: open cislunar only.** Tight geography is the single strongest lever for making a small population feel dense, and it is more effective than any amount of NPC tuning.

**Unresolved design questions:**
1. Person-bound vs. org-bound reputation (§4.6)
2. How to handle unverifiable claims — false distress, phantom cargo — without inviting griefing (§4.5)
3. Whether new players entering years into the world's history slog through solved territory, and how much dynamic starting locations actually fix that (§4.4)
4. Whether combat can be made async-safe with days of warning, and whether it should exist at all in early tiers
5. What the colony decay curve looks like such that neglect has teeth without producing spiteful griefing
6. Monetization — must not compromise the player-driven economy. Subscription is the obvious fit; anything that sells economic advantage destroys pillar 4.

**Structural risks:**
- **Safety valves drain stakes.** Every anti-frustration mechanism (NPC backstop, insurance, guaranteed contracts) removes commitment pressure, which is where the depth lives. Add these late and grudgingly.
- **Chore creep.** Twenty ships is not twenty times the fun if the unit of play doesn't escalate (§5).
- **Depth cannot be patched in later.** Renewability is cheap and boltable at any time; depth is structural. Teams that ship the faucet first discover they've built a treadmill they can't refactor out.

---

## 10. Audience & Positioning

Aurora 4X and Dwarf Fortress both have essentially no visuals and command deeply loyal audiences, because simulation depth is the product. The target player is the person who read all nine Expanse books twice and will happily take orbital plots and data tables over shaders. The audience repelled by a 2D vector map is not the audience.

Positioning: **"The Expanse as a simulation, not as a shooter."** Not a game about being on a ship. A game about the solar system being enormous, help being weeks away, and the news always being old.
