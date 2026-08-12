---
key: plan-and-burn
status: active
superseded-by: null
tier: on-demand
scope:
  seats: [all]
  topics: [flight-plan, pillars, irreversibility, light-lag]
  beads: [longburn-wci, longburn-40j, longburn-din.9]
provenance:
  source: "migrated from fort/remember.md:19, d194384 (the pillar-2 rewording, 2026-08-07; 40j epic closed 2026-08-07)"
  declared-by: vardis
  date: 2026-08-11
  origin: trusted
---
The Overseer ruled that irreversibility is the EXECUTED BURN, not the plan:
charter pillar 2 was reworded ("the burn is irreversible; the plan is paper"),
GDD 204-205/222 amended, and tier0-decomposition rows D/G/H2 rewritten.
Governing spec `docs/specs/flight-plan-model-v0.1.md` (Overseer-approved): an
editable BurnNode schedule; executed burns immutable in types and log;
PlanRevision commands travel at c from the T0 Earth HQ and are validated AT
ARRIVAL (typed refusal events); races arbitrated by log order; per-node fuel
with no caller-named costs; and PLANNING IS NEVER LIGHT-LAGGED (a permanent
ruling: the ORDER carries the lag, reports return at c). The 40j epic
implemented all of it. The old 6h re-target window, decision windows, and
no-cancel-endpoint reading are DEAD; do not resurrect them from older records.
KSP is the named UX reference for din.9 planning.
