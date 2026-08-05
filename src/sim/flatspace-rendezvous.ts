/**
 * The flat-space, constant-acceleration rendezvous model.  This belongs to
 * the planner layer: callers supply all epochs and states explicitly.
 */

export interface FlatspaceVector {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface FlatspaceRendezvousRequest {
  /** Constant available acceleration, in m/s². */
  readonly accelerationMetersPerSecondSquared: number;
  /** Time of flight, in seconds. */
  readonly durationSeconds: number;
  readonly departurePositionMeters: FlatspaceVector;
  readonly departureVelocityMetersPerSecond: FlatspaceVector;
  /** Target position evaluated at the arrival epoch. */
  readonly arrivalPositionMeters: FlatspaceVector;
  /** Target velocity evaluated at the arrival epoch. */
  readonly arrivalVelocityMetersPerSecond: FlatspaceVector;
}

export interface FlatspaceRendezvousPlan {
  readonly kind: "feasible";
  readonly firstBurnImpulseMetersPerSecond: FlatspaceVector;
  readonly secondBurnImpulseMetersPerSecond: FlatspaceVector;
  readonly firstBurnDurationSeconds: number;
  readonly coastDurationSeconds: number;
  readonly secondBurnDurationSeconds: number;
  readonly totalDeltaVMetersPerSecond: number;
  /** Fraction of the trip for which the engine is firing. */
  readonly burnDutyCycle: number;
}

export interface FlatspaceRendezvousInfeasible {
  readonly kind: "infeasible";
  /** Physics forbids this duration: the required burns overlap. */
  readonly reason: "negative-coast";
  readonly coastDurationSeconds: number;
}

/** The deterministic planner could not validate a result; this is not physics. */
export interface FlatspaceRendezvousIndeterminate {
  readonly kind: "indeterminate";
  /** The fixed solver did not converge, or a derived kappa violated its bound. */
  readonly reason: "unconverged" | "kappa-below-one";
  readonly coastDurationSeconds: number;
}

export type FlatspaceRendezvousResult =
  | FlatspaceRendezvousPlan
  | FlatspaceRendezvousInfeasible
  | FlatspaceRendezvousIndeterminate;

export interface MinimumTimeSearch {
  /** Supplies target state at each candidate flight duration. */
  readonly requestAtDuration: (durationSeconds: number) => FlatspaceRendezvousRequest;
  /** A chord-distance estimate used only to form the initial upper bracket. */
  readonly chordDistanceMeters: number;
  readonly accelerationMetersPerSecondSquared: number;
}

export interface MinimumTimeResult {
  readonly kind: "feasible";
  readonly durationSeconds: number;
  readonly plan: FlatspaceRendezvousPlan;
  /**
   * Bisection probes the deterministic solver could not validate. The reported
   * plan is feasible, but its minimum may be above an indeterminate interval.
   */
  readonly indeterminateProbeCount: number;
}

export interface MinimumTimeNoFeasibleDuration {
  readonly kind: "no-feasible-duration";
}

export interface MinimumTimeIndeterminate {
  readonly kind: "indeterminate";
  readonly reason: "unconverged";
}

export type MinimumTimeSearchResult = MinimumTimeResult | MinimumTimeNoFeasibleDuration | MinimumTimeIndeterminate;

const ITERATIONS = 200;
const DAMPING = 0.5;
const BISECTION_ITERATIONS = 80;
const MAX_BRACKET_DOUBLINGS = 80;
const RESIDUAL_TOLERANCE = 256 * Number.EPSILON;
const REFINEMENT_ITERATIONS = 200;

const subtract = (left: FlatspaceVector, right: FlatspaceVector): FlatspaceVector => ({
  x: left.x - right.x,
  y: left.y - right.y,
  z: left.z - right.z
});

const scale = (vector: FlatspaceVector, factor: number): FlatspaceVector => ({
  x: vector.x * factor,
  y: vector.y * factor,
  z: vector.z * factor
});

const add = (left: FlatspaceVector, right: FlatspaceVector): FlatspaceVector => ({
  x: left.x + right.x,
  y: left.y + right.y,
  z: left.z + right.z
});

const magnitude = (vector: FlatspaceVector): number => Math.hypot(vector.x, vector.y, vector.z);

const dot = (left: FlatspaceVector, right: FlatspaceVector): number =>
  left.x * right.x + left.y * right.y + left.z * right.z;

const isCollinear = (left: FlatspaceVector, right: FlatspaceVector): boolean => {
  const scale = Math.max(1, magnitude(left) * magnitude(right));
  return magnitude({
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x
  }) <= 64 * Number.EPSILON * scale;
};

const finitePositive = (value: number, name: string): void => {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be finite and positive.`);
};

const assertFiniteVector = (vector: FlatspaceVector, name: string): void => {
  if (![vector.x, vector.y, vector.z].every(Number.isFinite)) {
    throw new RangeError(`${name} must contain only finite values.`);
  }
};

const validateRequest = (request: FlatspaceRendezvousRequest): void => {
  finitePositive(request.accelerationMetersPerSecondSquared, "Acceleration");
  finitePositive(request.durationSeconds, "Duration");
  assertFiniteVector(request.departurePositionMeters, "Departure position");
  assertFiniteVector(request.departureVelocityMetersPerSecond, "Departure velocity");
  assertFiniteVector(request.arrivalPositionMeters, "Arrival position");
  assertFiniteVector(request.arrivalVelocityMetersPerSecond, "Arrival velocity");
};

const positionResidual = (
  driftCorrectedDisplacement: FlatspaceVector,
  deltaVelocity: FlatspaceVector,
  firstImpulse: FlatspaceVector,
  firstDuration: number,
  secondDuration: number,
  duration: number
): number => magnitude(subtract(
  add(
    scale(firstImpulse, duration - firstDuration / 2),
    scale(subtract(deltaVelocity, firstImpulse), secondDuration / 2)
  ),
  driftCorrectedDisplacement
));

const residualIsAcceptable = (residual: number, driftCorrectedDisplacement: FlatspaceVector): boolean =>
  residual <= RESIDUAL_TOLERANCE * Math.max(1, magnitude(driftCorrectedDisplacement));

const outer = (left: FlatspaceVector, right: FlatspaceVector): readonly [number, number, number, number, number, number, number, number, number] => [
  left.x * right.x, left.x * right.y, left.x * right.z,
  left.y * right.x, left.y * right.y, left.y * right.z,
  left.z * right.x, left.z * right.y, left.z * right.z
];

type Matrix3 = readonly [number, number, number, number, number, number, number, number, number];

const solveLinear3 = (matrix: Matrix3, rhs: FlatspaceVector): FlatspaceVector | undefined => {
  const augmented: [number, number, number, number][] = [
    [matrix[0], matrix[1], matrix[2], rhs.x],
    [matrix[3], matrix[4], matrix[5], rhs.y],
    [matrix[6], matrix[7], matrix[8], rhs.z]
  ];
  for (let column = 0; column < 3; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 3; row += 1) {
      if (Math.abs(augmented[row]![column]!) > Math.abs(augmented[pivot]![column]!)) pivot = row;
    }
    if (augmented[pivot]![column]! === 0) return undefined;
    [augmented[column], augmented[pivot]] = [augmented[pivot]!, augmented[column]!];
    const divisor = augmented[column]![column]!;
    for (let entry = column; entry < 4; entry += 1) augmented[column]![entry]! /= divisor;
    for (let row = 0; row < 3; row += 1) {
      if (row === column) continue;
      const factor = augmented[row]![column]!;
      for (let entry = column; entry < 4; entry += 1) augmented[row]![entry]! -= factor * augmented[column]![entry]!;
    }
  }
  return { x: augmented[0]![3]!, y: augmented[1]![3]!, z: augmented[2]![3]! };
};

/**
 * Refines the six-equation solution after the required fixed-point pass.  The
 * Jacobian is analytic and the fixed work budget keeps planner results
 * reproducible.  This handles a general 3-D wall, where collinearity is not
 * available to reduce the problem to a quadratic.
 */
const refineGeneral = (
  initialImpulse: FlatspaceVector,
  driftCorrectedDisplacement: FlatspaceVector,
  deltaVelocity: FlatspaceVector,
  acceleration: number,
  duration: number
): FlatspaceRendezvousPlan | undefined => {
  let firstImpulse = initialImpulse;
  for (let iteration = 0; iteration < REFINEMENT_ITERATIONS; iteration += 1) {
    const firstMagnitude = magnitude(firstImpulse);
    const secondImpulse = subtract(deltaVelocity, firstImpulse);
    const secondMagnitude = magnitude(secondImpulse);
    if (firstMagnitude === 0 || secondMagnitude === 0) continue;
    const firstDuration = firstMagnitude / acceleration;
    const secondDuration = secondMagnitude / acceleration;
    const coastDuration = duration - firstDuration - secondDuration;
    const residualVector = subtract(add(
      scale(firstImpulse, duration - firstDuration / 2),
      scale(secondImpulse, secondDuration / 2)
    ), driftCorrectedDisplacement);
    const residual = magnitude(residualVector);
    if (residualIsAcceptable(residual, driftCorrectedDisplacement) && coastDuration >= -RESIDUAL_TOLERANCE * duration) {
      return {
        kind: "feasible",
        firstBurnImpulseMetersPerSecond: firstImpulse,
        secondBurnImpulseMetersPerSecond: secondImpulse,
        firstBurnDurationSeconds: firstDuration,
        coastDurationSeconds: Math.max(0, coastDuration),
        secondBurnDurationSeconds: secondDuration,
        totalDeltaVMetersPerSecond: acceleration * (firstDuration + secondDuration),
        burnDutyCycle: (firstDuration + secondDuration) / duration
      };
    }

    const firstOuter = outer(firstImpulse, firstImpulse);
    const secondOuter = outer(secondImpulse, secondImpulse);
    const jacobian = Array.from({ length: 9 }, (_, index) => {
      const diagonal = index % 4 === 0 ? duration - (firstDuration + secondDuration) / 2 : 0;
      return diagonal - firstOuter[index]! / (2 * acceleration * firstMagnitude) - secondOuter[index]! / (2 * acceleration * secondMagnitude);
    }) as unknown as Matrix3;
    // Levenberg damping makes the wall's singular Jacobian a deterministic
    // least-squares step instead of an accidental numerical refusal.
    const normal = Array.from({ length: 9 }, (_, index) => {
      const row = Math.floor(index / 3);
      const column = index % 3;
      let value = row === column ? 1e-24 * duration ** 2 : 0;
      for (let k = 0; k < 3; k += 1) value += jacobian[k * 3 + row]! * jacobian[k * 3 + column]!;
      return value;
    }) as unknown as Matrix3;
    const normalRhs = {
      x: -(jacobian[0] * residualVector.x + jacobian[3] * residualVector.y + jacobian[6] * residualVector.z),
      y: -(jacobian[1] * residualVector.x + jacobian[4] * residualVector.y + jacobian[7] * residualVector.z),
      z: -(jacobian[2] * residualVector.x + jacobian[5] * residualVector.y + jacobian[8] * residualVector.z)
    };
    const step = solveLinear3(normal, normalRhs);
    if (step !== undefined) firstImpulse = add(firstImpulse, step);
  }
  return undefined;
};

/**
 * At a collinear feasibility wall the fixed-point map has a double root and
 * therefore converges algebraically.  Solve that one-dimensional form of the
 * same six equations analytically after the mandated fixed iteration pass so
 * bisection can resolve the physical wall rather than iteration residue.
 */
const solveCollinear = (
  driftCorrectedDisplacement: FlatspaceVector,
  deltaVelocity: FlatspaceVector,
  acceleration: number,
  duration: number
): FlatspaceRendezvousPlan | undefined => {
  const distance = magnitude(driftCorrectedDisplacement);
  if (distance === 0 || !isCollinear(driftCorrectedDisplacement, deltaVelocity)) return undefined;
  const direction = scale(driftCorrectedDisplacement, 1 / distance);
  const requiredDeltaVelocity = dot(deltaVelocity, direction);
  let best: FlatspaceRendezvousPlan | undefined;

  for (const firstSign of [-1, 1]) {
    for (const secondSign of [-1, 1]) {
      const quadratic = (secondSign - firstSign) / (2 * acceleration);
      const linear = duration - (secondSign * requiredDeltaVelocity) / acceleration;
      const constant = (secondSign * requiredDeltaVelocity ** 2) / (2 * acceleration) - distance;
      const candidates: number[] = [];
      if (quadratic === 0) {
        if (linear !== 0) candidates.push(-constant / linear);
      } else {
        const discriminant = linear ** 2 - 4 * quadratic * constant;
        const roundoff = 64 * Number.EPSILON * (linear ** 2 + Math.abs(4 * quadratic * constant));
        if (discriminant >= -roundoff) {
          const root = Math.sqrt(Math.max(0, discriminant));
          candidates.push((-linear + root) / (2 * quadratic), (-linear - root) / (2 * quadratic));
        }
      }
      for (const firstScalarImpulse of candidates) {
        const secondScalarImpulse = requiredDeltaVelocity - firstScalarImpulse;
        if (firstSign * firstScalarImpulse < 0 || secondSign * secondScalarImpulse < 0) continue;
        const firstBurnDurationSeconds = Math.abs(firstScalarImpulse) / acceleration;
        const secondBurnDurationSeconds = Math.abs(secondScalarImpulse) / acceleration;
        const coastDurationSeconds = duration - firstBurnDurationSeconds - secondBurnDurationSeconds;
        const firstBurnImpulseMetersPerSecond = scale(direction, firstScalarImpulse);
        const residual = positionResidual(
          driftCorrectedDisplacement,
          deltaVelocity,
          firstBurnImpulseMetersPerSecond,
          firstBurnDurationSeconds,
          secondBurnDurationSeconds,
          duration
        );
        if (!residualIsAcceptable(residual, driftCorrectedDisplacement) || coastDurationSeconds < -RESIDUAL_TOLERANCE * duration) continue;
        const plan: FlatspaceRendezvousPlan = {
          kind: "feasible",
          firstBurnImpulseMetersPerSecond,
          secondBurnImpulseMetersPerSecond: scale(direction, secondScalarImpulse),
          firstBurnDurationSeconds,
          coastDurationSeconds: Math.max(0, coastDurationSeconds),
          secondBurnDurationSeconds,
          totalDeltaVMetersPerSecond: acceleration * (firstBurnDurationSeconds + secondBurnDurationSeconds),
          burnDutyCycle: (firstBurnDurationSeconds + secondBurnDurationSeconds) / duration
        };
        if (best === undefined || plan.totalDeltaVMetersPerSecond < best.totalDeltaVMetersPerSecond) best = plan;
      }
    }
  }
  return best;
};

/**
 * Solves research §3.2 verbatim.  Iteration count and damping are fixed so a
 * planner result never depends on host speed or tolerance termination.
 */
export const solveFlatspaceRendezvous = (request: FlatspaceRendezvousRequest): FlatspaceRendezvousResult => {
  validateRequest(request);
  const acceleration = request.accelerationMetersPerSecondSquared;
  const duration = request.durationSeconds;
  const deltaVelocity = subtract(request.arrivalVelocityMetersPerSecond, request.departureVelocityMetersPerSecond);
  const displacement = subtract(request.arrivalPositionMeters, request.departurePositionMeters);
  const driftCorrectedDisplacement = subtract(displacement, scale(request.departureVelocityMetersPerSecond, duration));

  // The f=1 endpoint is a relative stationary brachistochrone.  Its
  // discriminant is theoretically zero, so construct it directly rather than
  // allowing either floating-point sign noise or slow fixed-point convergence.
  const relativeDistance = magnitude(driftCorrectedDisplacement);
  const normalizedBrachistochrone = (4 * relativeDistance) / (acceleration * duration ** 2);
  if (
    magnitude(deltaVelocity) === 0 &&
    normalizedBrachistochrone >= 1 - 32 * Number.EPSILON &&
    normalizedBrachistochrone <= 1 + 32 * Number.EPSILON
  ) {
    const burn = duration / 2;
    const firstBurnImpulseMetersPerSecond = scale(driftCorrectedDisplacement, (acceleration * burn) / relativeDistance);
    const secondBurnImpulseMetersPerSecond = scale(firstBurnImpulseMetersPerSecond, -1);
    return {
      kind: "feasible",
      firstBurnImpulseMetersPerSecond,
      secondBurnImpulseMetersPerSecond,
      firstBurnDurationSeconds: burn,
      coastDurationSeconds: 0,
      secondBurnDurationSeconds: burn,
      totalDeltaVMetersPerSecond: acceleration * duration,
      burnDutyCycle: 1
    };
  }

  // Impulsive solution seed: A1 = R / T.
  let firstImpulse = scale(driftCorrectedDisplacement, 1 / duration);

  for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
    const firstDuration = magnitude(firstImpulse) / acceleration;
    const secondImpulse = subtract(deltaVelocity, firstImpulse);
    const secondDuration = magnitude(secondImpulse) / acceleration;
    const denominator = duration - (firstDuration + secondDuration) / 2;

    // Do not terminate the fixed-point solve early: an infeasible intermediate
    // can still be damped back into the feasible basin.
    if (denominator === 0) continue;
    const next = scale(
      subtract(driftCorrectedDisplacement, scale(deltaVelocity, secondDuration / 2)),
      1 / denominator
    );
    firstImpulse = add(scale(firstImpulse, DAMPING), scale(next, 1 - DAMPING));
  }

  const firstBurnDurationSeconds = magnitude(firstImpulse) / acceleration;
  const secondBurnImpulseMetersPerSecond = subtract(deltaVelocity, firstImpulse);
  const secondBurnDurationSeconds = magnitude(secondBurnImpulseMetersPerSecond) / acceleration;
  const coastDurationSeconds = duration - firstBurnDurationSeconds - secondBurnDurationSeconds;

  const residual = positionResidual(
    driftCorrectedDisplacement,
    deltaVelocity,
    firstImpulse,
    firstBurnDurationSeconds,
    secondBurnDurationSeconds,
    duration
  );
  if (!residualIsAcceptable(residual, driftCorrectedDisplacement)) {
    const collinear = magnitude(driftCorrectedDisplacement) > 0 && isCollinear(driftCorrectedDisplacement, deltaVelocity);
    const collinearPlan = solveCollinear(driftCorrectedDisplacement, deltaVelocity, acceleration, duration);
    if (collinearPlan !== undefined) return collinearPlan;
    if (collinear) return { kind: "infeasible", reason: "negative-coast", coastDurationSeconds };
    const refinedPlan = refineGeneral(firstImpulse, driftCorrectedDisplacement, deltaVelocity, acceleration, duration);
    if (refinedPlan !== undefined) return refinedPlan;
    // The fixed iterate may be residual-bearing, but a negative coast still
    // proves that its required burn intervals overlap.  The analytic and
    // residual-refined paths above have both been offered a chance to recover
    // a validated plan first.
    if (coastDurationSeconds < 0) return { kind: "infeasible", reason: "negative-coast", coastDurationSeconds };
    return { kind: "indeterminate", reason: "unconverged", coastDurationSeconds };
  }

  if (coastDurationSeconds < 0) {
    // A position-validated solution with overlapping burns is a physics
    // refusal, unlike an unvalidated fixed-point iterate.
    return { kind: "infeasible", reason: "negative-coast", coastDurationSeconds };
  }

  return {
    kind: "feasible",
    firstBurnImpulseMetersPerSecond: firstImpulse,
    secondBurnImpulseMetersPerSecond,
    firstBurnDurationSeconds,
    coastDurationSeconds,
    secondBurnDurationSeconds,
    totalDeltaVMetersPerSecond: acceleration * (firstBurnDurationSeconds + secondBurnDurationSeconds),
    burnDutyCycle: (firstBurnDurationSeconds + secondBurnDurationSeconds) / duration
  };
};

/** Closed-form stationary-target solution, including the f=1 endpoint path. */
export const solveStationaryFlatspaceRendezvous = (
  distanceMeters: number,
  accelerationMetersPerSecondSquared: number,
  durationSeconds: number
): FlatspaceRendezvousResult => {
  finitePositive(distanceMeters, "Distance");
  finitePositive(accelerationMetersPerSecondSquared, "Acceleration");
  finitePositive(durationSeconds, "Duration");
  const normalizedDiscriminant = 1 - (4 * distanceMeters) / (accelerationMetersPerSecondSquared * durationSeconds ** 2);

  // At f=1, avoid a subtraction involving a theoretically-zero discriminant.
  // A few ulps cover the same algebra evaluated in a different order.
  if (normalizedDiscriminant >= -32 * Number.EPSILON && normalizedDiscriminant <= 32 * Number.EPSILON) {
    const burn = durationSeconds / 2;
    return {
      kind: "feasible",
      firstBurnImpulseMetersPerSecond: { x: accelerationMetersPerSecondSquared * burn, y: 0, z: 0 },
      secondBurnImpulseMetersPerSecond: { x: -accelerationMetersPerSecondSquared * burn, y: 0, z: 0 },
      firstBurnDurationSeconds: burn,
      coastDurationSeconds: 0,
      secondBurnDurationSeconds: burn,
      totalDeltaVMetersPerSecond: 2 * accelerationMetersPerSecondSquared * burn,
      burnDutyCycle: 1
    };
  }
  if (normalizedDiscriminant < 0) {
    return {
      kind: "infeasible",
      reason: "negative-coast",
      coastDurationSeconds: durationSeconds - 2 * Math.sqrt(distanceMeters / accelerationMetersPerSecondSquared)
    };
  }
  const firstBurnDurationSeconds = (durationSeconds * (1 - Math.sqrt(normalizedDiscriminant))) / 2;
  const coastDurationSeconds = durationSeconds - 2 * firstBurnDurationSeconds;
  return {
    kind: "feasible",
    firstBurnImpulseMetersPerSecond: { x: accelerationMetersPerSecondSquared * firstBurnDurationSeconds, y: 0, z: 0 },
    secondBurnImpulseMetersPerSecond: { x: -accelerationMetersPerSecondSquared * firstBurnDurationSeconds, y: 0, z: 0 },
    firstBurnDurationSeconds,
    coastDurationSeconds,
    secondBurnDurationSeconds: firstBurnDurationSeconds,
    totalDeltaVMetersPerSecond: accelerationMetersPerSecondSquared * (durationSeconds - Math.sqrt(durationSeconds ** 2 - (4 * distanceMeters) / accelerationMetersPerSecondSquared)),
    burnDutyCycle: (2 * firstBurnDurationSeconds) / durationSeconds
  };
};

/**
 * Finds the moving-target minimum by bisection.  The chord brachistochrone is
 * deliberately only an initial bracket, never a feasibility decision.
 */
export const findMinimumFlatspaceRendezvousTime = (search: MinimumTimeSearch): MinimumTimeSearchResult => {
  finitePositive(search.chordDistanceMeters, "Chord distance");
  finitePositive(search.accelerationMetersPerSecondSquared, "Acceleration");
  let lower = 0;
  let upper = 2 * Math.sqrt(search.chordDistanceMeters / search.accelerationMetersPerSecondSquared);
  let upperResult = solveFlatspaceRendezvous(search.requestAtDuration(upper));
  let sawIndeterminate = upperResult.kind === "indeterminate";
  for (let doubling = 0; upperResult.kind !== "feasible" && doubling < MAX_BRACKET_DOUBLINGS; doubling += 1) {
    upper *= 2;
    upperResult = solveFlatspaceRendezvous(search.requestAtDuration(upper));
    sawIndeterminate ||= upperResult.kind === "indeterminate";
  }
  if (sawIndeterminate) return { kind: "indeterminate", reason: "unconverged" };
  if (upperResult.kind !== "feasible") return { kind: "no-feasible-duration" };

  let indeterminateProbeCount = 0;
  for (let iteration = 0; iteration < BISECTION_ITERATIONS; iteration += 1) {
    const midpoint = (lower + upper) / 2;
    const result = solveFlatspaceRendezvous(search.requestAtDuration(midpoint));
    if (result.kind === "feasible") {
      upper = midpoint;
      upperResult = result;
    } else {
      // An indeterminate midpoint is never accepted as a plan.  Keeping it
      // below the bracket preserves a validated upper plan while refinement
      // resolves the wall from the feasible side. Record it so consumers do
      // not mistake a solver artifact for a converged physical wall.
      if (result.kind === "indeterminate") indeterminateProbeCount += 1;
      lower = midpoint;
    }
  }
  return { kind: "feasible", durationSeconds: upper, plan: upperResult, indeterminateProbeCount };
};
