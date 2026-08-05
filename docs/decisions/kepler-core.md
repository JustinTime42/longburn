# Kepler core conditioning boundary

`src/sim/kepler.ts` implements the universal-variable propagator used as the
conic utility for trajectory planning. It performs exactly 35 Newton updates:
the count does not vary with a tolerance, elapsed wall-clock time, or the host.

The universal-variable formulation is poorly conditioned close to eccentricity
one. Research in `docs/research/lambert-solvers.md` §4 found that this
propagator can lose accuracy before the Izzo Lambert solver does. Therefore a
Lambert round-trip failure in that regime is not, by itself, evidence that the
Lambert solution is wrong. `isNearParabolic` exposes the boundary
`abs(e - 1) <= 0.001` for diagnostics and tests; it does not reject a valid
conic or label the later Lambert module as failed.

This is a planning-layer calculation. A committed maneuver stores quantized
burn parameters as the authoritative simulation input, per the trajectory
subsystem spec §5.
