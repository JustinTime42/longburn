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
export const FLATSPACE_ETA_UPPER_BOUND = 0.2;
export const LAMBERT_ETA_LOWER_BOUND = 0.5;

export type ContinuumRegime = "flatspace" | "lambert-kappa" | "lambert";

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
  readonly regime: ContinuumRegime;
  readonly eta: number;
  /** One in pure conic mode; otherwise the same flat-space solver's ratio. */
  readonly kappa: number;
  readonly heliocentricDeltaVMetersPerSecond: number;
  /** Present whenever flat-space was evaluated, including the transition regime. */
  readonly flatspacePlan?: FlatspaceRendezvousPlan;
}

export interface ContinuumInfeasible extends FlatspaceRendezvousInfeasible {
  readonly regime: "flatspace" | "lambert-kappa";
  readonly eta: number;
}

export interface ContinuumIndeterminate extends FlatspaceRendezvousIndeterminate {
  readonly regime: "flatspace" | "lambert-kappa";
  readonly eta: number;
}

export type ContinuumResult = ContinuumPlan | ContinuumInfeasible | ContinuumIndeterminate;

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

export const continuumRegimeForEta = (eta: number): ContinuumRegime => {
  if (!Number.isFinite(eta) || eta < 0) throw new RangeError("Eta must be finite and non-negative.");
  if (eta < FLATSPACE_ETA_UPPER_BOUND) return "flatspace";
  if (eta <= LAMBERT_ETA_LOWER_BOUND) return "lambert-kappa";
  return "lambert";
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
 * In the transition regime gravity occurs only in Lambert and finite thrust
 * only in kappa, so neither effect is counted twice.
 */
export const solveContinuumLeg = (request: ContinuumLegRequest): ContinuumResult => {
  finitePositive(request.lambertDeltaVMetersPerSecond, "Lambert delta-v");
  const chord = chordDistance(request.flatspaceRequest);
  const radius = request.solarRadiusMeters ?? departureRadius(request.flatspaceRequest);
  const eta = gravityLoadingParameter(radius, request.flatspaceRequest.durationSeconds, chord);
  const regime = continuumRegimeForEta(eta);

  if (regime === "lambert") {
    return { kind: "feasible", regime, eta, kappa: 1, heliocentricDeltaVMetersPerSecond: request.lambertDeltaVMetersPerSecond };
  }

  const correction = flatspaceKappa(request.flatspaceRequest);
  if (correction.kind !== "feasible") return { ...correction, regime, eta };
  if (regime === "flatspace") {
    return {
      kind: "feasible", regime, eta, kappa: correction.kappa,
      heliocentricDeltaVMetersPerSecond: correction.actual.totalDeltaVMetersPerSecond,
      flatspacePlan: correction.actual
    };
  }
  return {
    kind: "feasible", regime, eta, kappa: correction.kappa,
    heliocentricDeltaVMetersPerSecond: request.lambertDeltaVMetersPerSecond * correction.kappa,
    flatspacePlan: correction.actual
  };
};
