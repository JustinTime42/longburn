/**
 * Per-leg torch-to-conic continuum assembly.  This is planner-layer work: it
 * consumes explicit states and a Lambert cost, and must be quantized before a
 * maneuver enters authoritative simulation state.
 */
import {
  solveFlatspaceRendezvous,
  type FlatspaceRendezvousInfeasible,
  type FlatspaceRendezvousIndeterminate,
  type FlatspaceRendezvousPlan,
  type FlatspaceRendezvousRequest,
  type FlatspaceVector
} from "./flatspace-rendezvous.js";

/** Sun GM, in m^3/s^2. */
export const SUN_GRAVITATIONAL_PARAMETER_M3_PER_SECOND2 = 132_712_440_018_000_000_000_000;
export const FINITE_BURN_CAUTION_DUTY_CYCLE = 0.83;

export interface ContinuumLegRequest {
  /** The conic rendezvous cost: |v_transfer - v_departure| + |v_arrival - v_transfer|, in m/s. */
  readonly lambertDeltaVMetersPerSecond: number;
  /**
   * The actual-thrust flat-space rendezvous request.  Its duration supplies
   * T, its endpoints supply the chord, and its departure radius supplies r.
   */
  readonly flatspaceRequest: FlatspaceRendezvousRequest;
  /**
   * Optional local solar radius for eta.  A caller with a better leg reference
   * radius (for example a midpoint) may provide it; departure radius is the
   * deterministic default.
   */
  readonly solarRadiusMeters?: number;
}

export interface ContinuumPlan {
  readonly kind: "feasible";
  /** A model-fidelity diagnostic; it never selects the quoted delta-v model. */
  readonly eta: number;
  /** Finite-burn correction from the actual and impulsive flat-space solves. */
  readonly kappa: number;
  readonly heliocentricDeltaVMetersPerSecond: number;
  /**
   * Amendment A gate: fraction of the flight window needed to execute the
   * quoted heliocentric delta-v. This is intentionally distinct from
   * flatspacePlan.burnDutyCycle, the flat-space solver's firing fraction.
   */
  readonly quotedDutyCycle: number;
  /** A screening warning, not a refusal. */
  readonly finiteBurnCaution: boolean;
  /** The correction's actual-thrust solve, retained as planner diagnostics. */
  readonly flatspacePlan: FlatspaceRendezvousPlan;
}

export interface ContinuumInfeasible extends FlatspaceRendezvousInfeasible {
  readonly eta: number;
}

export interface ContinuumIndeterminate extends FlatspaceRendezvousIndeterminate {
  readonly eta: number;
}

/** The quoted heliocentric burn cannot fit in the requested flight window. */
export interface ContinuumDutyCycleInfeasible {
  readonly kind: "infeasible";
  readonly reason: "duty-cycle-exceeded";
  readonly eta: number;
  readonly kappa: number;
  readonly heliocentricDeltaVMetersPerSecond: number;
  /** Amendment A gate; not the flat-space plan's firing fraction. */
  readonly quotedDutyCycle: number;
  /** The actual-thrust solve, retained so refusals preserve planner diagnostics. */
  readonly flatspacePlan: FlatspaceRendezvousPlan;
}

export type ContinuumResult =
  | ContinuumPlan
  | ContinuumInfeasible
  | ContinuumIndeterminate
  | ContinuumDutyCycleInfeasible;

const magnitude = (vector: FlatspaceVector): number => Math.hypot(vector.x, vector.y, vector.z);

const finitePositive = (value: number, name: string): void => {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be finite and positive.`);
};

/** Solar acceleration at radius r, in m/s². */
export const solarGravityAt = (radiusMeters: number): number => {
  finitePositive(radiusMeters, "Solar radius");
  return SUN_GRAVITATIONAL_PARAMETER_M3_PER_SECOND2 / radiusMeters ** 2;
};

/** eta = g_sun(r) * T² / (2 * D_chord). */
export const gravityLoadingParameter = (solarRadiusMeters: number, durationSeconds: number, chordDistanceMeters: number): number => {
  finitePositive(durationSeconds, "Duration");
  finitePositive(chordDistanceMeters, "Chord distance");
  return solarGravityAt(solarRadiusMeters) * durationSeconds ** 2 / (2 * chordDistanceMeters);
};

const chordDistance = (request: FlatspaceRendezvousRequest): number => magnitude({
  x: request.arrivalPositionMeters.x - request.departurePositionMeters.x,
  y: request.arrivalPositionMeters.y - request.departurePositionMeters.y,
  z: request.arrivalPositionMeters.z - request.departurePositionMeters.z
});

const departureRadius = (request: FlatspaceRendezvousRequest): number => magnitude(request.departurePositionMeters);

/**
 * Calculates the finite-burn correction using the flat-space solver twice.
 * Number.MAX_VALUE is the representable a -> infinity limit: the solver's
 * burn durations underflow toward zero while sharing precisely the same path
 * and kinematics as the actual-acceleration solve.
 */
export const flatspaceKappa = (request: FlatspaceRendezvousRequest):
  | { readonly kind: "feasible"; readonly kappa: number; readonly actual: FlatspaceRendezvousPlan; readonly impulsive: FlatspaceRendezvousPlan }
  | FlatspaceRendezvousInfeasible
  | FlatspaceRendezvousIndeterminate => {
  const actual = solveFlatspaceRendezvous(request);
  if (actual.kind !== "feasible") return actual;
  const impulsive = solveFlatspaceRendezvous({ ...request, accelerationMetersPerSecondSquared: Number.MAX_VALUE });
  // The limiting solve is necessarily feasible if the actual solve was. Keep
  // a typed planner refusal if a future solver changes that contract.
  if (impulsive.kind !== "feasible") return impulsive;
  const kappa = actual.totalDeltaVMetersPerSecond / impulsive.totalDeltaVMetersPerSecond;
  if (!Number.isFinite(kappa) || kappa < 1) throw new RangeError("Flat-space kappa must be finite and at least one.");
  return { kind: "feasible", kappa, actual, impulsive };
};

/**
 * Assembles a heliocentric leg without taking a min() or adding gravity loss.
 * Gravity occurs only in Lambert and finite thrust only in kappa, so neither
 * effect is counted twice. The correction is applied at every eta.
 */
export const solveContinuumLeg = (request: ContinuumLegRequest): ContinuumResult => {
  finitePositive(request.lambertDeltaVMetersPerSecond, "Lambert delta-v");
  // This invokes flat-space request validation on every path. The public input
  // contract must not vary with eta or with the resulting feasibility answer.
  const correction = flatspaceKappa(request.flatspaceRequest);
  const chord = chordDistance(request.flatspaceRequest);
  const radius = request.solarRadiusMeters ?? departureRadius(request.flatspaceRequest);
  const eta = gravityLoadingParameter(radius, request.flatspaceRequest.durationSeconds, chord);
  if (correction.kind !== "feasible") return { ...correction, eta };
  const heliocentricDeltaVMetersPerSecond = request.lambertDeltaVMetersPerSecond * correction.kappa;
  const quotedDutyCycle = heliocentricDeltaVMetersPerSecond /
    (request.flatspaceRequest.accelerationMetersPerSecondSquared * request.flatspaceRequest.durationSeconds);
  if (quotedDutyCycle > 1) {
    return {
      kind: "infeasible",
      reason: "duty-cycle-exceeded",
      eta,
      kappa: correction.kappa,
      heliocentricDeltaVMetersPerSecond,
      quotedDutyCycle,
      flatspacePlan: correction.actual
    };
  }
  return {
    kind: "feasible",
    eta,
    kappa: correction.kappa,
    heliocentricDeltaVMetersPerSecond,
    quotedDutyCycle,
    finiteBurnCaution: quotedDutyCycle > FINITE_BURN_CAUTION_DUTY_CYCLE,
    flatspacePlan: correction.actual
  };
};
