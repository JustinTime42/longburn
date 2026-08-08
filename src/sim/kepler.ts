import type { Vector3Km } from "./ephemerides.js";

/** A Cartesian state in kilometres and kilometres per second. */
export interface KeplerState {
  readonly positionKm: Vector3Km;
  readonly velocityKmPerSecond: Vector3Km;
}

/** Classical elements in the inertial frame used by the supplied state. */
export interface ConicElements {
  /** Infinity for a parabolic orbit. */
  readonly semiMajorAxisKm: number;
  readonly semiLatusRectumKm: number;
  readonly eccentricity: number;
  readonly inclinationRadians: number;
  readonly longitudeOfAscendingNodeRadians: number;
  readonly argumentOfPeriapsisRadians: number;
  readonly trueAnomalyRadians: number;
}

export interface StumpffFunctions {
  readonly c2: number;
  readonly c3: number;
}

/**
 * The refinement count is intentionally invariant. This module belongs to the
 * planner layer, but fixed work makes a malformed input's behavior independent
 * of tolerance and host load. Quantized committed burns, not these results,
 * enter authoritative simulation state.
 */
export const KEPLER_REFINEMENT_ITERATIONS = 200;
/** Relative residual allowed after the invariant Newton work has completed. */
export const KEPLER_RESIDUAL_RELATIVE_TOLERANCE = 1e-11;

/** Dimensionless relative tolerance for alpha, scaled by the current radius. */
const PARABOLIC_ALPHA_RELATIVE_EPSILON = 1e-12;
/** Dimensionless relative tolerance for element singularities. */
const ELEMENT_RELATIVE_EPSILON = 1e-10;
const NEAR_PARABOLIC_ECCENTRICITY_DISTANCE = 1e-3;

/** A typed refusal: fixed Newton work did not solve the universal Kepler equation. */
export class KeplerPropagationConvergenceError extends RangeError {
  public constructor() {
    super("Universal-variable propagation did not converge within the fixed iteration budget.");
    this.name = "KeplerPropagationConvergenceError";
  }
}

const add = (left: Vector3Km, right: Vector3Km): Vector3Km => ({ x: left.x + right.x, y: left.y + right.y, z: left.z + right.z });
const subtract = (left: Vector3Km, right: Vector3Km): Vector3Km => ({ x: left.x - right.x, y: left.y - right.y, z: left.z - right.z });
const scale = (vector: Vector3Km, scalar: number): Vector3Km => ({ x: vector.x * scalar, y: vector.y * scalar, z: vector.z * scalar });
const dot = (left: Vector3Km, right: Vector3Km): number => left.x * right.x + left.y * right.y + left.z * right.z;
const cross = (left: Vector3Km, right: Vector3Km): Vector3Km => ({
  x: left.y * right.z - left.z * right.y,
  y: left.z * right.x - left.x * right.z,
  z: left.x * right.y - left.y * right.x
});
const magnitude = (vector: Vector3Km): number => Math.sqrt(dot(vector, vector));
const clamp = (value: number, lower: number, upper: number): number => Math.max(lower, Math.min(upper, value));
const normalizeAngle = (angle: number): number => {
  const normalized = angle % (2 * Math.PI);
  return normalized < 0 ? normalized + 2 * Math.PI : normalized;
};

const assertFiniteVector = (name: string, vector: Vector3Km): void => {
  if (!Number.isFinite(vector.x) || !Number.isFinite(vector.y) || !Number.isFinite(vector.z)) {
    throw new RangeError(`${name} must contain finite components.`);
  }
};

const assertInputs = (mu: number, state: KeplerState): void => {
  if (!Number.isFinite(mu) || mu <= 0) throw new RangeError("Gravitational parameter must be positive and finite.");
  assertFiniteVector("Position", state.positionKm);
  assertFiniteVector("Velocity", state.velocityKmPerSecond);
  if (magnitude(state.positionKm) === 0) throw new RangeError("Position must be non-zero.");
};

/** Stumpff C2 and C3, using series terms around the removable singularity. */
export const stumpffC2C3 = (psi: number): StumpffFunctions => {
  if (!Number.isFinite(psi)) throw new RangeError("Universal anomaly parameter must be finite.");
  if (psi > 1e-6) {
    const root = Math.sqrt(psi);
    return { c2: (1 - Math.cos(root)) / psi, c3: (root - Math.sin(root)) / (psi * root) };
  }
  if (psi < -1e-6) {
    const root = Math.sqrt(-psi);
    return { c2: (1 - Math.cosh(root)) / psi, c3: (Math.sinh(root) - root) / (root * root * root) };
  }
  return { c2: 0.5 - psi / 24 + (psi * psi) / 720, c3: 1 / 6 - psi / 120 + (psi * psi) / 5040 };
};

/**
 * Propagates a two-body state with Vallado's universal-variable formulation.
 *
 * The solver always performs the fixed refinement count, then validates its
 * universal-Kepler residual. A failed residual is a typed refusal rather than
 * a numerically plausible but off-orbit state. `isNearParabolic` is only a UI
 * diagnostic: eccentricity alone neither predicts nor explains convergence.
 */
export const propagateKepler = (mu: number, initial: KeplerState, elapsedSeconds: number): KeplerState => {
  assertInputs(mu, initial);
  if (!Number.isFinite(elapsedSeconds)) throw new RangeError("Propagation interval must be finite.");
  if (elapsedSeconds === 0) return initial;

  const r0 = magnitude(initial.positionKm);
  const v0Squared = dot(initial.velocityKmPerSecond, initial.velocityKmPerSecond);
  const rDotV = dot(initial.positionKm, initial.velocityKmPerSecond);
  const sqrtMu = Math.sqrt(mu);
  const alpha = 2 / r0 - v0Squared / mu;
  const parabolicAlphaEpsilon = PARABOLIC_ALPHA_RELATIVE_EPSILON / r0;
  let chi: number;

  if (alpha > parabolicAlphaEpsilon) {
    chi = sqrtMu * elapsedSeconds * alpha;
  } else if (alpha < -parabolicAlphaEpsilon) {
    const a = 1 / alpha;
    const sign = elapsedSeconds < 0 ? -1 : 1;
    const denominator = rDotV + sign * Math.sqrt(-mu * a) * (1 - r0 * alpha);
    const logarithmArgument = (-2 * mu * alpha * elapsedSeconds) / denominator;
    if (!Number.isFinite(logarithmArgument) || logarithmArgument <= 0) {
      throw new RangeError("Hyperbolic universal-variable initial guess is undefined.");
    }
    chi = sign * Math.sqrt(-a) * Math.log(logarithmArgument);
  } else {
    const angularMomentum = cross(initial.positionKm, initial.velocityKmPerSecond);
    const semiLatusRectumKm = dot(angularMomentum, angularMomentum) / mu;
    const s = 0.5 * Math.atan2(1, 3 * Math.sqrt(mu / (semiLatusRectumKm ** 3)) * elapsedSeconds);
    const w = Math.atan(Math.tan(s) ** (1 / 3));
    chi = (2 * Math.sqrt(semiLatusRectumKm)) / Math.tan(2 * w);
  }

  for (let iteration = 0; iteration < KEPLER_REFINEMENT_ITERATIONS; iteration += 1) {
    const psi = alpha * chi * chi;
    const { c2, c3 } = stumpffC2C3(psi);
    const radius = chi * chi * c2 + (rDotV / sqrtMu) * chi * (1 - psi * c3) + r0 * (1 - psi * c2);
    if (!Number.isFinite(radius) || Math.abs(radius) <= Number.EPSILON) {
      throw new RangeError("Universal-variable propagation became singular.");
    }
    const correction = (sqrtMu * elapsedSeconds - chi * chi * chi * c3 - (rDotV / sqrtMu) * chi * chi * c2 - r0 * chi * (1 - psi * c3)) / radius;
    chi += correction;
    if (!Number.isFinite(chi)) throw new RangeError("Universal-variable propagation did not remain finite.");
  }

  const psi = alpha * chi * chi;
  const { c2, c3 } = stumpffC2C3(psi);
  const target = sqrtMu * elapsedSeconds;
  const chiCubedC3 = chi * chi * chi * c3;
  const rDotVTerm = (rDotV / sqrtMu) * chi * chi * c2;
  const r0Term = r0 * chi * (1 - psi * c3);
  const residual = target - chiCubedC3 - rDotVTerm - r0Term;
  const residualScale = Math.max(1, Math.abs(target), Math.abs(chiCubedC3), Math.abs(rDotVTerm), Math.abs(r0Term));
  if (!Number.isFinite(residual) || Math.abs(residual) > KEPLER_RESIDUAL_RELATIVE_TOLERANCE * residualScale) {
    throw new KeplerPropagationConvergenceError();
  }
  const radius = chi * chi * c2 + (rDotV / sqrtMu) * chi * (1 - psi * c3) + r0 * (1 - psi * c2);
  if (!Number.isFinite(radius) || radius <= 0) throw new RangeError("Universal-variable propagation produced an invalid radius.");
  const f = 1 - (chi * chi * c2) / r0;
  const g = elapsedSeconds - (chi * chi * chi * c3) / sqrtMu;
  const positionKm = add(scale(initial.positionKm, f), scale(initial.velocityKmPerSecond, g));
  const gDot = 1 - (chi * chi * c2) / radius;
  const fDot = (sqrtMu * chi * (psi * c3 - 1)) / (radius * r0);
  return { positionKm, velocityKmPerSecond: add(scale(initial.positionKm, fDot), scale(initial.velocityKmPerSecond, gDot)) };
};

/**
 * Returns osculating classical elements.
 *
 * Singular conventions: the ascending-node longitude is zero for equatorial
 * orbits; circular inclined orbits put the argument of periapsis at zero and
 * use true anomaly as argument of latitude; circular equatorial orbits put
 * both angles at zero and use true anomaly as true longitude. For retrograde
 * equatorial eccentric orbits, the periapsis/true-longitude measurements use
 * the retrograde orientation so reconstruction remains an inverse.
 */
export const conicElements = (mu: number, state: KeplerState): ConicElements => {
  assertInputs(mu, state);
  const r = magnitude(state.positionKm);
  const velocitySquared = dot(state.velocityKmPerSecond, state.velocityKmPerSecond);
  const angularMomentum = cross(state.positionKm, state.velocityKmPerSecond);
  const angularMomentumMagnitude = magnitude(angularMomentum);
  if (angularMomentumMagnitude === 0) throw new RangeError("Conic elements are undefined for zero angular momentum.");
  const elementEpsilon = ELEMENT_RELATIVE_EPSILON * angularMomentumMagnitude;
  const node = { x: -angularMomentum.y, y: angularMomentum.x, z: 0 };
  const nodeMagnitude = magnitude(node);
  const eccentricityVector = subtract(
    scale(subtract(scale(state.positionKm, velocitySquared), scale(state.velocityKmPerSecond, dot(state.positionKm, state.velocityKmPerSecond))), 1 / mu),
    scale(state.positionKm, 1 / r)
  );
  const eccentricity = magnitude(eccentricityVector);
  const alpha = 2 / r - velocitySquared / mu;
  const parabolicAlphaEpsilon = PARABOLIC_ALPHA_RELATIVE_EPSILON / r;
  const semiMajorAxisKm = Math.abs(alpha) <= parabolicAlphaEpsilon ? Number.POSITIVE_INFINITY : 1 / alpha;
  const semiLatusRectumKm = (angularMomentumMagnitude * angularMomentumMagnitude) / mu;
  const inclinationRadians = Math.acos(clamp(angularMomentum.z / angularMomentumMagnitude, -1, 1));
  const longitudeOfAscendingNodeRadians = nodeMagnitude <= elementEpsilon ? 0 : normalizeAngle(Math.atan2(node.y, node.x));

  let argumentOfPeriapsisRadians = 0;
  if (eccentricity > ELEMENT_RELATIVE_EPSILON && nodeMagnitude > elementEpsilon) {
    argumentOfPeriapsisRadians = Math.acos(clamp(dot(node, eccentricityVector) / (nodeMagnitude * eccentricity), -1, 1));
    if (eccentricityVector.z < 0) argumentOfPeriapsisRadians = 2 * Math.PI - argumentOfPeriapsisRadians;
  } else if (eccentricity > ELEMENT_RELATIVE_EPSILON) {
    argumentOfPeriapsisRadians = normalizeAngle(Math.atan2(inclinationRadians > Math.PI / 2 ? -eccentricityVector.y : eccentricityVector.y, eccentricityVector.x));
  }

  let trueAnomalyRadians: number;
  if (eccentricity > ELEMENT_RELATIVE_EPSILON) {
    trueAnomalyRadians = Math.acos(clamp(dot(eccentricityVector, state.positionKm) / (eccentricity * r), -1, 1));
    if (dot(state.positionKm, state.velocityKmPerSecond) < 0) trueAnomalyRadians = 2 * Math.PI - trueAnomalyRadians;
  } else if (nodeMagnitude > elementEpsilon) {
    trueAnomalyRadians = Math.acos(clamp(dot(node, state.positionKm) / (nodeMagnitude * r), -1, 1));
    if (state.positionKm.z < 0) trueAnomalyRadians = 2 * Math.PI - trueAnomalyRadians;
  } else {
    trueAnomalyRadians = normalizeAngle(Math.atan2(inclinationRadians > Math.PI / 2 ? -state.positionKm.y : state.positionKm.y, state.positionKm.x));
  }

  return { semiMajorAxisKm, semiLatusRectumKm, eccentricity, inclinationRadians, longitudeOfAscendingNodeRadians, argumentOfPeriapsisRadians, trueAnomalyRadians };
};

/** Reconstructs a state from conic elements. Parabolas use semiLatusRectumKm. */
export const stateFromConicElements = (mu: number, elements: ConicElements): KeplerState => {
  if (!Number.isFinite(mu) || mu <= 0) throw new RangeError("Gravitational parameter must be positive and finite.");
  const values = [elements.semiLatusRectumKm, elements.eccentricity, elements.inclinationRadians, elements.longitudeOfAscendingNodeRadians, elements.argumentOfPeriapsisRadians, elements.trueAnomalyRadians];
  if (values.some((value) => !Number.isFinite(value)) || elements.semiLatusRectumKm <= 0 || elements.eccentricity < 0) {
    throw new RangeError("Conic elements must be finite with positive semi-latus rectum and non-negative eccentricity.");
  }
  const denominator = 1 + elements.eccentricity * Math.cos(elements.trueAnomalyRadians);
  if (denominator <= Number.EPSILON) throw new RangeError("True anomaly is outside this conic's physical branch.");
  const radius = elements.semiLatusRectumKm / denominator;
  const positionPerifocal = { x: radius * Math.cos(elements.trueAnomalyRadians), y: radius * Math.sin(elements.trueAnomalyRadians), z: 0 };
  const velocityScale = Math.sqrt(mu / elements.semiLatusRectumKm);
  const velocityPerifocal = { x: -velocityScale * Math.sin(elements.trueAnomalyRadians), y: velocityScale * (elements.eccentricity + Math.cos(elements.trueAnomalyRadians)), z: 0 };
  const cosNode = Math.cos(elements.longitudeOfAscendingNodeRadians);
  const sinNode = Math.sin(elements.longitudeOfAscendingNodeRadians);
  const cosArgument = Math.cos(elements.argumentOfPeriapsisRadians);
  const sinArgument = Math.sin(elements.argumentOfPeriapsisRadians);
  const cosInclination = Math.cos(elements.inclinationRadians);
  const sinInclination = Math.sin(elements.inclinationRadians);
  const rotate = (vector: Vector3Km): Vector3Km => ({
    x: (cosNode * cosArgument - sinNode * sinArgument * cosInclination) * vector.x + (-cosNode * sinArgument - sinNode * cosArgument * cosInclination) * vector.y,
    y: (sinNode * cosArgument + cosNode * sinArgument * cosInclination) * vector.x + (-sinNode * sinArgument + cosNode * cosArgument * cosInclination) * vector.y,
    z: sinArgument * sinInclination * vector.x + cosArgument * sinInclination * vector.y
  });
  return { positionKm: rotate(positionPerifocal), velocityKmPerSecond: rotate(velocityPerifocal) };
};

/**
 * True for a UI diagnostic around e=1. This is not a convergence boundary and
 * must not be used to attribute a later Lambert or propagation failure.
 */
export const isNearParabolic = (elements: Pick<ConicElements, "eccentricity">): boolean =>
  Math.abs(elements.eccentricity - 1) <= NEAR_PARABOLIC_ECCENTRICITY_DISTANCE + Number.EPSILON;
