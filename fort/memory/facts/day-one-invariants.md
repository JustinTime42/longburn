---
key: day-one-invariants
status: active
superseded-by: null
tier: on-demand
scope:
  seats: [all]
  topics: [determinism, causality, virtual-clock, invariants]
  beads: []
provenance:
  source: "migrated from fort/remember.md:13, d194384 (charter standing orders 10-12)"
  declared-by: vardis
  date: 2026-08-11
  origin: trusted
---
Three day-one invariants, carried as charter standing orders 10-12: sim time is
an INPUT and nothing in sim code reads the wall clock; determinism means seeded
RNG only; causality means no information travels faster than c, asserted by a
mechanical test rather than a comment.
