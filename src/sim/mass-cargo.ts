/**
 * Fuel and payload accounting for the constant-acceleration trajectory model.
 *
 * This module deliberately has no constant-thrust alternative. A committed
 * maneuver stores the fixed-point values below; planning-layer floating point
 * values never become authoritative simulation state.
 */

/** One millimetre per second, expressed in the trajectory module's km/s units. */
export const DELTA_V_QUANTUM_KM_PER_SECOND = 0.000_001;
/** One millisecond, expressed in seconds. */
export const BURN_DURATION_QUANTUM_SECONDS = 0.001;

export interface ShipMassConfig {
  /** Effective exhaust velocity, in km/s. */
  readonly exhaustVelocityKmPerSecond: number;
  /** Throttled, constant acceleration while firing, in km/s². */
  readonly accelerationKmPerSecond2: number;
  /** Hull, tanks, engine, and radiators as a fraction of departure wet mass. */
  readonly structuralMassFraction: number;
}

/**
 * Tier 0 deliberately has one ship rather than a ship-design game. Values are
 * chosen from the research's viability anchor: a 1 g, 1,750 km/s torch burn is
 * still payload-positive with a 15% structural floor.
 */
export const TIER0_SHIP: Readonly<ShipMassConfig> = Object.freeze({
  exhaustVelocityKmPerSecond: 1_000,
  accelerationKmPerSecond2: 0.009_806_65,
  structuralMassFraction: 0.15
});

export interface BurnParameters {
  readonly deltaVKmPerSecond: number;
  readonly burnDurationSeconds: number;
}

/** Integer-only representation carried into authoritative sim state. */
export interface QuantizedBurnParameters {
  readonly deltaVQuantum: number;
  readonly burnDurationQuantum: number;
}

export interface ViableCargo {
  readonly kind: "viable";
  readonly massRatio: number;
  readonly cargoFraction: number;
  readonly viabilityWallDeltaVKmPerSecond: number;
}

/** A fuel-valid trajectory which has no payload after its structural mass. */
export interface NonviableCargo {
  readonly kind: "nonviable";
  readonly massRatio: number;
  /** Zero at the exact viability wall and negative beyond it. */
  readonly cargoFraction: number;
  readonly viabilityWallDeltaVKmPerSecond: number;
}

/**
 * This is intentionally separate from a trajectory solver's
 * `infeasible-trajectory` result: this function is called only after a solver
 * has established that the requested path can be flown.
 */
export type CargoAssessment = ViableCargo | NonviableCargo;

const positiveFinite = (name: string, value: number): void => {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number.`);
  }
};

const nonNegativeFinite = (name: string, value: number): void => {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number.`);
  }
};

const validateShip = (ship: ShipMassConfig): void => {
  positiveFinite("Exhaust velocity", ship.exhaustVelocityKmPerSecond);
  positiveFinite("Acceleration", ship.accelerationKmPerSecond2);
  if (!Number.isFinite(ship.structuralMassFraction) || ship.structuralMassFraction <= 0 || ship.structuralMassFraction >= 1) {
    throw new RangeError("Structural mass fraction must be finite and in (0, 1).");
  }
};

const quantizedInteger = (name: string, value: number): number => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
  return value;
};

const quantize = (name: string, value: number, quantum: number): number => {
  nonNegativeFinite(name, value);
  const result = Math.round(value / quantum);
  return quantizedInteger(`Quantized ${name}`, result);
};

/** Exact for the selected constant-acceleration burn model. */
export const deltaVForBurn = (accelerationKmPerSecond2: number, burnDurationSeconds: number): number => {
  positiveFinite("Acceleration", accelerationKmPerSecond2);
  nonNegativeFinite("Burn duration", burnDurationSeconds);
  return accelerationKmPerSecond2 * burnDurationSeconds;
};

/** Tsiolkovsky mass ratio for the exact delta-v expenditure. */
export const massRatioForDeltaV = (deltaVKmPerSecond: number, exhaustVelocityKmPerSecond: number): number => {
  nonNegativeFinite("Delta-v", deltaVKmPerSecond);
  positiveFinite("Exhaust velocity", exhaustVelocityKmPerSecond);
  return Math.exp(deltaVKmPerSecond / exhaustVelocityKmPerSecond);
};

/** The hard delta-v limit where all post-propellant mass is structure. */
export const viabilityWallDeltaV = (ship: ShipMassConfig): number => {
  validateShip(ship);
  return ship.exhaustVelocityKmPerSecond * Math.log(1 / ship.structuralMassFraction);
};

/**
 * Converts an already-feasible trajectory's delta-v into a typed payload
 * result. No clamp is applied: non-positive cargo is meaningful information.
 */
export const assessCargo = (deltaVKmPerSecond: number, ship: ShipMassConfig = TIER0_SHIP): CargoAssessment => {
  validateShip(ship);
  const massRatio = massRatioForDeltaV(deltaVKmPerSecond, ship.exhaustVelocityKmPerSecond);
  const cargoFraction = Math.exp(-deltaVKmPerSecond / ship.exhaustVelocityKmPerSecond) - ship.structuralMassFraction;
  const viabilityWallDeltaVKmPerSecond = viabilityWallDeltaV(ship);

  // The logarithmic wall is authoritative. Comparing against it prevents a
  // platform's exp/log rounding from turning an exactly empty ship positive.
  if (deltaVKmPerSecond >= viabilityWallDeltaVKmPerSecond) {
    return {
      kind: "nonviable",
      massRatio,
      cargoFraction: Math.min(cargoFraction, 0),
      viabilityWallDeltaVKmPerSecond
    };
  }
  return { kind: "viable", massRatio, cargoFraction, viabilityWallDeltaVKmPerSecond };
};

/** Rounds planning-layer values to the commitment representation. */
export const quantizeBurnParameters = (parameters: BurnParameters): QuantizedBurnParameters => ({
  deltaVQuantum: quantize("Delta-v", parameters.deltaVKmPerSecond, DELTA_V_QUANTUM_KM_PER_SECOND),
  burnDurationQuantum: quantize("Burn duration", parameters.burnDurationSeconds, BURN_DURATION_QUANTUM_SECONDS)
});

/** Reconstructs the planner-unit values exactly represented by a commitment. */
export const dequantizeBurnParameters = (parameters: QuantizedBurnParameters): BurnParameters => ({
  deltaVKmPerSecond: quantizedInteger("Delta-v quantum", parameters.deltaVQuantum) * DELTA_V_QUANTUM_KM_PER_SECOND,
  burnDurationSeconds: quantizedInteger("Burn duration quantum", parameters.burnDurationQuantum) * BURN_DURATION_QUANTUM_SECONDS
});
