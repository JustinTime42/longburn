# Decision record: flatspace-rendezvous solver-failure policies

> Mayor (Vardis Slowfathom), 2026-08-05. Raised by Warden wz6 r1 finding 4: two deliberate,
> asymmetric refusal policies are player-visible planner behavior and should be discoverable
> outside source comments. Beads: longburn-tll, longburn-wz6 (doubling), longburn-2mw (bisection).

`findMinimumFlatspaceRendezvousTime` runs two phases, and they treat an indeterminate probe
(a solver failure: not feasible, not proven infeasible) differently — on purpose.

## Doubling phase (bracket search): refuse on any indeterminate

If any probe during bracket doubling is indeterminate, the whole search returns a typed
`indeterminate`, even when a later probe finds a feasible upper bound. Rationale: the bracket's
placement would rest partly on an unvalidated solver result, and this planner feeds an
irreversible commitment (design pillar 2) — refusing conservatively is the correct side to err
on. Pinned by a test in which an early indeterminate probe is followed by a feasible doubled
upper and the search still refuses (wz6).

## Bisection phase (minimum refinement): tolerate, count, report

An indeterminate midpoint never aborts the bisection; it is pushed below the bracket (the
validated upper plan is retained) and counted. The result carries `indeterminateProbeCount` so
consumers can distinguish a converged physical wall from a minimum partly inflated by solver
artifact (2mw). Rationale: by this phase a validated feasible plan already exists; discarding it
over a refinement failure would convert a usable answer into a refusal — the false-negative
pruning failure the practice literature warns against (see
`docs/research/finite-thrust-correction-practice.md`, Englander et al. 2016).

## The asymmetry in one line

Before a validated plan exists, solver failure taints everything and the search refuses; after
one exists, solver failure is reported as uncertainty on the answer, never as loss of the answer.

Consumers: din.3.7 (planner-api) surfaces `indeterminateProbeCount` (and should prefer interval
width if added later — see the note on that bead); UI displays uncertainty, never silently drops
it. A third solver-failure policy variant should extend this record before it exists in code.
