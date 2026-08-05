import type { Vector3Km } from "./ephemerides.js";

/** Izzo's published/default Householder budget. Reaching it is an invalid plan. */
export const IZZO_HOUSEHOLDER_MAX_ITERATIONS = 35;
export const IZZO_ABSOLUTE_TOLERANCE = 1e-5;
export const IZZO_RELATIVE_TOLERANCE = 1e-7;

export interface IzzoLambertOptions {
  readonly revolutions?: number;
  readonly isPrograde?: boolean;
  /** Selects the low branch for multi-revolution solutions. Ignored for M=0. */
  readonly isLowPath?: boolean;
  readonly maxIterations?: number;
  readonly absoluteTolerance?: number;
  readonly relativeTolerance?: number;
}

export interface IzzoLambertSolution {
  readonly departureVelocityKmPerSecond: Vector3Km;
  readonly arrivalVelocityKmPerSecond: Vector3Km;
  readonly iterations: number;
  /** Largest revolution count feasible for this geometry and time of flight. */
  readonly maxRevolutions: number;
}

/** The transfer plane is undefined for a zero or collinear transfer chord. */
export class LambertGeometryError extends RangeError {
  public constructor(message: string) {
    super(message);
    this.name = "LambertGeometryError";
  }
}

/** The requested revolution count has no solution at the supplied time of flight. */
export class LambertNoFeasibleSolutionError extends RangeError {
  public constructor(readonly maxRevolutions: number) {
    super(`No feasible Lambert solution for the requested revolution count (M_max=${maxRevolutions}).`);
    this.name = "LambertNoFeasibleSolutionError";
  }
}

/** The bounded Householder solve did not settle within its fixed cap. */
export class LambertConvergenceError extends RangeError {
  public constructor(readonly maxIterations: number) {
    super(`Izzo Householder iteration did not converge within ${maxIterations} iterations.`);
    this.name = "LambertConvergenceError";
  }
}

const add = (left: Vector3Km, right: Vector3Km): Vector3Km => ({ x: left.x + right.x, y: left.y + right.y, z: left.z + right.z });
const subtract = (left: Vector3Km, right: Vector3Km): Vector3Km => ({ x: left.x - right.x, y: left.y - right.y, z: left.z - right.z });
const scale = (vector: Vector3Km, factor: number): Vector3Km => ({ x: vector.x * factor, y: vector.y * factor, z: vector.z * factor });
const dot = (left: Vector3Km, right: Vector3Km): number => left.x * right.x + left.y * right.y + left.z * right.z;
const cross = (left: Vector3Km, right: Vector3Km): Vector3Km => ({
  x: left.y * right.z - left.z * right.y,
  y: left.z * right.x - left.x * right.z,
  z: left.x * right.y - left.y * right.x
});
const magnitude = (vector: Vector3Km): number => Math.sqrt(dot(vector, vector));
const unit = (vector: Vector3Km): Vector3Km => scale(vector, 1 / magnitude(vector));
const clamp = (value: number, lower: number, upper: number): number => Math.max(lower, Math.min(upper, value));

// This is scipy's hyp2f1(3, 1, 5/2, x), transcribed from lamberthub.
const hyp2f1b = (x: number): number => {
  if (x >= 1) return Number.POSITIVE_INFINITY;
  let result = 1;
  let term = 1;
  for (let index = 0; ; index += 1) {
    term = (term * (3 + index) * (1 + index) * x) / ((2.5 + index) * (index + 1));
    const previous = result;
    result += term;
    if (previous === result) return result;
  }
};

const computeY = (x: number, lambda: number): number => Math.sqrt(1 - lambda * lambda * (1 - x * x));

const computePsi = (x: number, y: number, lambda: number): number => {
  if (x >= -1 && x < 1) return Math.acos(clamp(x * y + lambda * (1 - x * x), -1, 1));
  if (x > 1) return Math.asinh((y - x * lambda) * Math.sqrt(x * x - 1));
  return 0;
};

const timeOfFlightAt = (x: number, y: number, targetTime: number, lambda: number, revolutions: number): number => {
  let time: number;
  if (revolutions === 0 && Math.sqrt(0.6) < x && x < Math.sqrt(1.4)) {
    const eta = y - lambda * x;
    const s1 = (1 - lambda - x * eta) / 2;
    time = (eta * eta * eta * ((4 / 3) * hyp2f1b(s1)) + 4 * lambda * eta) / 2;
  } else {
    const oneMinusXSquared = 1 - x * x;
    time = ((computePsi(x, y, lambda) + revolutions * Math.PI) / Math.sqrt(Math.abs(oneMinusXSquared)) - x + lambda * y) / oneMinusXSquared;
  }
  return time - targetTime;
};

const timeOfFlight = (x: number, targetTime: number, lambda: number, revolutions: number): number =>
  timeOfFlightAt(x, computeY(x, lambda), targetTime, lambda, revolutions);

const firstDerivative = (x: number, y: number, time: number, lambda: number): number =>
  (3 * time * x - 2 + (2 * lambda ** 3 * x) / y) / (1 - x * x);
const secondDerivative = (x: number, y: number, time: number, first: number, lambda: number): number =>
  (3 * time + 5 * x * first + (2 * (1 - lambda * lambda) * lambda ** 3) / y ** 3) / (1 - x * x);
const thirdDerivative = (x: number, y: number, first: number, second: number, lambda: number): number =>
  (7 * x * second + 8 * first - (6 * (1 - lambda * lambda) * lambda ** 5 * x) / y ** 5) / (1 - x * x);

const halley = (initial: number, targetTime: number, lambda: number, absoluteTolerance: number, relativeTolerance: number, maxIterations: number): number => {
  let previous = initial;
  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const y = computeY(previous, lambda);
    const first = firstDerivative(previous, y, targetTime, lambda);
    const second = secondDerivative(previous, y, targetTime, first, lambda);
    if (second === 0) throw new LambertConvergenceError(maxIterations);
    const third = thirdDerivative(previous, y, first, second, lambda);
    const next = previous - (2 * first * second) / (2 * second * second - first * third);
    if (Math.abs(next - previous) < relativeTolerance * Math.abs(previous) + absoluteTolerance) return next;
    previous = next;
  }
  throw new LambertConvergenceError(maxIterations);
};

const minimumTime = (lambda: number, revolutions: number, maxIterations: number, absoluteTolerance: number, relativeTolerance: number): number => {
  if (revolutions === 0) return 0;
  const initial = 0.1;
  const atInitial = timeOfFlight(initial, 0, lambda, revolutions);
  const x = halley(initial, atInitial, lambda, absoluteTolerance, relativeTolerance, maxIterations);
  return timeOfFlight(x, 0, lambda, revolutions);
};

const initialGuess = (time: number, lambda: number, revolutions: number, isLowPath: boolean): number => {
  if (revolutions === 0) {
    const t0 = Math.acos(lambda) + lambda * Math.sqrt(1 - lambda * lambda);
    const t1 = (2 * (1 - lambda ** 3)) / 3;
    if (time >= t0) return (t0 / time) ** (2 / 3) - 1;
    if (time < t1) return (2.5 * t1 * (t1 - time)) / (time * (1 - lambda ** 5)) + 1;
    // Correct successor to Izzo Eq. 30; the printed paper has this branch wrong.
    return Math.exp(Math.log(2) * Math.log(time / t0) / Math.log(t1 / t0)) - 1;
  }
  const leftPower = (((revolutions + 1) * Math.PI) / (8 * time)) ** (2 / 3);
  const rightPower = ((8 * time) / (revolutions * Math.PI)) ** (2 / 3);
  const left = (leftPower - 1) / (leftPower + 1);
  const right = (rightPower - 1) / (rightPower + 1);
  return isLowPath ? Math.max(left, right) : Math.min(left, right);
};

const householder = (initial: number, targetTime: number, lambda: number, revolutions: number, absoluteTolerance: number, relativeTolerance: number, maxIterations: number): { readonly x: number; readonly iterations: number } => {
  let previous = initial;
  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const y = computeY(previous, lambda);
    const residual = timeOfFlightAt(previous, y, targetTime, lambda, revolutions);
    const time = residual + targetTime;
    const first = firstDerivative(previous, y, time, lambda);
    const second = secondDerivative(previous, y, time, first, lambda);
    const third = thirdDerivative(previous, y, first, second, lambda);
    const next = previous - residual * ((first * first - residual * second / 2) / (first * (first * first - residual * second) + third * residual * residual / 6));
    if (!Number.isFinite(next)) throw new LambertConvergenceError(maxIterations);
    if (Math.abs(next - previous) < relativeTolerance * Math.abs(previous) + absoluteTolerance) return { x: next, iterations: iteration };
    previous = next;
  }
  throw new LambertConvergenceError(maxIterations);
};

const findXY = (lambda: number, time: number, revolutions: number, isLowPath: boolean, maxIterations: number, absoluteTolerance: number, relativeTolerance: number): { readonly x: number; readonly y: number; readonly iterations: number; readonly maxRevolutions: number } => {
  let maxRevolutions = Math.floor(time / Math.PI);
  const t00 = Math.acos(lambda) + lambda * Math.sqrt(1 - lambda * lambda);
  if (maxRevolutions > 0 && time < t00 + maxRevolutions * Math.PI && time < minimumTime(lambda, maxRevolutions, maxIterations, absoluteTolerance, relativeTolerance)) maxRevolutions -= 1;
  if (revolutions > maxRevolutions) throw new LambertNoFeasibleSolutionError(maxRevolutions);
  const result = householder(initialGuess(time, lambda, revolutions, isLowPath), time, lambda, revolutions, absoluteTolerance, relativeTolerance, maxIterations);
  return { ...result, y: computeY(result.x, lambda), maxRevolutions };
};

/**
 * Solves Lambert's problem using Izzo (2015), faithfully transcribed from the
 * lamberthub/poliastro implementation rather than the Eq. 30 paper typo.
 * This is planner-layer numerical work; its result must be quantized before a
 * maneuver becomes authoritative simulation state.
 */
export const solveLambertIzzo = (mu: number, departurePositionKm: Vector3Km, arrivalPositionKm: Vector3Km, timeOfFlightSeconds: number, options: IzzoLambertOptions = {}): IzzoLambertSolution => {
  if (!Number.isFinite(mu) || mu <= 0) throw new RangeError("Gravitational parameter must be positive and finite.");
  if (!Number.isFinite(timeOfFlightSeconds) || timeOfFlightSeconds <= 0) throw new RangeError("Time of flight must be positive and finite.");
  const values = [departurePositionKm.x, departurePositionKm.y, departurePositionKm.z, arrivalPositionKm.x, arrivalPositionKm.y, arrivalPositionKm.z];
  if (values.some((value) => !Number.isFinite(value))) throw new RangeError("Lambert positions must have finite components.");
  const revolutions = options.revolutions ?? 0;
  const maxIterations = options.maxIterations ?? IZZO_HOUSEHOLDER_MAX_ITERATIONS;
  const absoluteTolerance = options.absoluteTolerance ?? IZZO_ABSOLUTE_TOLERANCE;
  const relativeTolerance = options.relativeTolerance ?? IZZO_RELATIVE_TOLERANCE;
  if (!Number.isInteger(revolutions) || revolutions < 0) throw new RangeError("Revolution count must be a non-negative integer.");
  if (!Number.isInteger(maxIterations) || maxIterations < 0) throw new RangeError("Householder iteration cap must be a non-negative integer.");
  if (!Number.isFinite(absoluteTolerance) || absoluteTolerance < 0 || !Number.isFinite(relativeTolerance) || relativeTolerance < 0) throw new RangeError("Lambert tolerances must be finite and non-negative.");

  const chord = subtract(arrivalPositionKm, departurePositionKm);
  const chordLength = magnitude(chord);
  const departureRadius = magnitude(departurePositionKm);
  const arrivalRadius = magnitude(arrivalPositionKm);
  if (departureRadius === 0 || arrivalRadius === 0) throw new LambertGeometryError("Lambert endpoint positions must be non-zero.");
  if (chordLength === 0) throw new LambertGeometryError("Lambert transfer endpoints must not be identical.");
  const departureUnit = unit(departurePositionKm);
  const arrivalUnit = unit(arrivalPositionKm);
  const angularMomentumUnit = cross(departureUnit, arrivalUnit);
  if (magnitude(angularMomentumUnit) === 0) throw new LambertGeometryError("Lambert transfer angle must not be exactly 0 or 180 degrees.");
  const transferNormal = unit(angularMomentumUnit);
  const semiperimeter = (departureRadius + arrivalRadius + chordLength) / 2;
  let lambda = Math.sqrt(Math.max(0, 1 - chordLength / semiperimeter));
  let departureTangent: Vector3Km;
  let arrivalTangent: Vector3Km;
  if (transferNormal.z < 0) {
    lambda = -lambda;
    departureTangent = cross(departureUnit, transferNormal);
    arrivalTangent = cross(arrivalUnit, transferNormal);
  } else {
    departureTangent = cross(transferNormal, departureUnit);
    arrivalTangent = cross(transferNormal, arrivalUnit);
  }
  if (!(options.isPrograde ?? true)) {
    lambda = -lambda;
    departureTangent = scale(departureTangent, -1);
    arrivalTangent = scale(arrivalTangent, -1);
  }

  const dimensionlessTime = Math.sqrt((2 * mu) / semiperimeter ** 3) * timeOfFlightSeconds;
  const { x, y, iterations, maxRevolutions } = findXY(lambda, dimensionlessTime, revolutions, options.isLowPath ?? true, maxIterations, absoluteTolerance, relativeTolerance);
  const gamma = Math.sqrt((mu * semiperimeter) / 2);
  const rho = (departureRadius - arrivalRadius) / chordLength;
  const sigma = Math.sqrt(Math.max(0, 1 - rho * rho));
  const radialDeparture = (gamma * ((lambda * y - x) - rho * (lambda * y + x))) / departureRadius;
  const radialArrival = (-gamma * ((lambda * y - x) + rho * (lambda * y + x))) / arrivalRadius;
  const tangential = gamma * sigma * (y + lambda * x);
  return {
    departureVelocityKmPerSecond: add(scale(departureUnit, radialDeparture), scale(departureTangent, tangential / departureRadius)),
    arrivalVelocityKmPerSecond: add(scale(arrivalUnit, radialArrival), scale(arrivalTangent, tangential / arrivalRadius)),
    iterations,
    maxRevolutions
  };
};
