---
key: trajectory-subsystem
status: active
superseded-by: null
tier: on-demand
scope:
  seats: [all]
  topics: [trajectory, lambert, solvers, determinism]
  beads: [longburn-din.3]
provenance:
  source: "migrated from fort/remember.md:18, d194384 (2026-08-05; din.3 epic closed 2026-08-06)"
  declared-by: vardis
  date: 2026-08-11
  origin: trusted
---
Governed by `docs/specs/trajectory-subsystem-v0.2.md` (Overseer-approved,
Amendments A-C plus the ratified 1,000 t T0 wet-mass line) on top of three
research reports in `docs/research/` (lambert-solvers, mars-windows-porkchop,
torch-continuum-models) with validated reference scripts in
`docs/research/reference/`. Architecture: two solvers (Izzo Lambert owns
gravity; flat-space rendezvous owns thrust feasibility) plus a kappa blend.
Never sum trajectory families; never min() the models. Charter standing order
16 (quantized commitments) originated here. The din.3 epic closed 2026-08-06
and branch bead/din.3 @ 6049213 is superseded, its Lambert core salvaged into
module B.
