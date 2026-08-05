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
  /**
   * `unconverged` means the fixed 200-step solve did not satisfy the position
   * equation closely enough to issue an irreversible flight plan.
   */
  readonly reason: "negative-coast" | "unconverged";
  readonly coastDurationSeconds: number;
}

export type FlatspaceRendezvousResult = FlatspaceRendezvousPlan | FlatspaceRendezvousInfeasible;

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
}

export interface MinimumTimeNoFeasibleDuration {
  readonly kind: "no-feasible-duration";
}

export type MinimumTimeSearchResult = MinimumTimeResult | MinimumTimeNoFeasibleDuration;

const ITERATIONS = 200;
const DAMPING = 0.5;
const BISECTION_ITERATIONS = 80;
const MAX_BRACKET_DOUBLINGS = 80;
const RESIDUAL_TOLERANCE = 256 * Number.EPSILON;

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

  if (coastDurationSeconds < 0) {
    return { kind: "infeasible", reason: "negative-coast", coastDurationSeconds };
  }

  const residual = positionResidual(
    driftCorrectedDisplacement,
    deltaVelocity,
    firstImpulse,
    firstBurnDurationSeconds,
    secondBurnDurationSeconds,
    duration
  );
  if (!residualIsAcceptable(residual, driftCorrectedDisplacement)) {
    const collinearPlan = solveCollinear(driftCorrectedDisplacement, deltaVelocity, acceleration, duration);
    if (collinearPlan !== undefined) return collinearPlan;
    return { kind: "infeasible", reason: "unconverged", coastDurationSeconds };
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
  for (let doubling = 0; upperResult.kind === "infeasible" && doubling < MAX_BRACKET_DOUBLINGS; doubling += 1) {
    upper *= 2;
    upperResult = solveFlatspaceRendezvous(search.requestAtDuration(upper));
  }
  if (upperResult.kind === "infeasible") return { kind: "no-feasible-duration" };

  for (let iteration = 0; iteration < BISECTION_ITERATIONS; iteration += 1) {
    const midpoint = (lower + upper) / 2;
    const result = solveFlatspaceRendezvous(search.requestAtDuration(midpoint));
    if (result.kind === "feasible") {
      upper = midpoint;
      upperResult = result;
    } else {
      lower = midpoint;
    }
  }
  return { kind: "feasible", durationSeconds: upper, plan: upperResult };
};
