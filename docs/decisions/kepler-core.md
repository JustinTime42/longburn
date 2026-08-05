# Kepler core convergence safeguards

`src/sim/kepler.ts` implements the universal-variable propagator used as the
conic utility for trajectory planning. It performs exactly 200 Newton updates:
the count does not vary with a tolerance, elapsed wall-clock time, or the host.
After that invariant work, it evaluates the universal-Kepler residual and
throws `KeplerPropagationConvergenceError` when its relative magnitude exceeds
`1e-11`; it never returns an unvalidated state.

The pre-remediation 35-step implementation could fail to enter Newton's basin
for high-eccentricity, long-duration elliptic cases (including e=0.995 and the
research fixture e=0.9968). That was under-convergence, not an inherent
near-parabolic conditioning boundary: the reference's 200 iterations preserve
the orbit invariants for the exercised cases. Research in
`docs/research/lambert-solvers.md` §4 still establishes the operational rule:
when a Lambert round trip and this propagator disagree, first check this
propagator's own invariant/convergence result before attributing the failure to
Lambert.

`isNearParabolic` is an inclusive UI diagnostic near e=1, with a one-ULP guard
at its nominal `0.001` edge. It neither predicts convergence nor labels any
later Lambert result as failed. The test suite exercises the formerly failing
band directly by conserving semi-major axis, eccentricity, and semi-latus
rectum across propagation.

`conicElements` uses zero-angle singular conventions: Ω=0 for equatorial
orbits; ω=0 for circular inclined orbits; and Ω=ω=0 with true longitude stored
as ν for circular equatorial orbits. Equatorial retrograde longitudes use the
retrograde orientation so state reconstruction remains an inverse.

This is a planning-layer calculation. A committed maneuver stores quantized
burn parameters as the authoritative simulation input, per the trajectory
subsystem spec §5.
