---
key: market-layer
status: active
superseded-by: null
tier: on-demand
scope:
  seats: [all]
  topics: [market, economy, din.6, rng]
  beads: [longburn-din.6, longburn-din.6.2, longburn-din.6.4, longburn-yitm]
provenance:
  source: "migrated from fort/remember.md:44, d194384 (din.6, spec approved 2026-08-08)"
  declared-by: vardis
  date: 2026-08-11
  origin: trusted
---
Governed by `docs/specs/market-model-v0.1.md`, which fills catalog class 2.4.
Overseer rulings: cargo-composition hedging (contracted NPC forward tonnage
with TWO-SIDED risk versus spot tonnage, both physically loaded, so optionality
costs delta-v); a three-mode sell disposition (manual sell-order at c,
sell-on-arrival, contractual auto-settle); one commodity; integer credits;
PHYSICAL DELIVERY ONLY at every tier. Price process: integer AR(1) with
quantized OU coefficients, round-to-nearest (the +S/2 is load-bearing, since
floor alone biases roughly 87 cr below mu), integer Irwin-Hall noise normalized
in b, and deriveStream RNG substreams (built by din.6.2). The GDD 7.3/7.4
write-back is pending on gate 2, and din.6.4 is gated on it. Forward-economy
design at genesis is longburn-yitm.
