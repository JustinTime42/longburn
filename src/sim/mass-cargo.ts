/**
 * Fuel and payload accounting for the constant-acceleration trajectory model.
 *
 * This module deliberately has no constant-thrust alternative. A committed
 * maneuver stores the fixed-point values below; planning-layer floating point
 * values never become authoritative simulation state.
 */

/** The one-millisecond resolution pinned by trajectory subsystem spec §5. */
export const BURN_DURATION_QUANTUM_MILLISECONDS = 1;

/** A quantized burn duration carried in authoritative simulation state. */
export type BurnDurationMs = number & { readonly __burnDurationMs: unique symbol };

/** Integer velocity component carried across the planner/simulation boundary. */
export type VelocityMillimetersPerSecond = number & { readonly __velocityMillimetersPerSecond: unique symbol };

export const velocityMillimetersPerSecond = (value: number): VelocityMillimetersPerSecond => {
  if (!Number.isSafeInteger(value)) throw new RangeError("Velocity must be a safe integer in millimetres per second.");
  return value as VelocityMillimetersPerSecond;
};

/** Quantized Cartesian delta-v. Direction is authoritative, never planner-only. */
export interface QuantizedDeltaV {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export const quantizedDeltaV = (value: { readonly x: number; readonly y: number; readonly z: number }): QuantizedDeltaV => ({
  x: velocityMillimetersPerSecond(value.x),
  y: velocityMillimetersPerSecond(value.y),
  z: velocityMillimetersPerSecond(value.z)
});

export const burnDurationMs = (value: number): BurnDurationMs => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Burn duration must be a non-negative safe integer in milliseconds.");
  }

  return value as BurnDurationMs;
};

export interface ShipMassConfig {
  /** Effective exhaust velocity, in km/s. */
  readonly exhaustVelocityKmPerSecond: number;
  /** Throttled, constant acceleration while firing, in km/s². */
  readonly accelerationKmPerSecond2: number;
  /** Hull, tanks, engine, and radiators as a fraction of departure wet mass. */
  readonly structuralMassFraction: number;
  /** Authoritative departure wet mass used for propellant accounting. */
  readonly wetMassGrams: number;
  /**
   * Frozen, strict viability ceiling for total committed burn duration.
   *
   * This is derived when a ship configuration is authored, never while an
   * authoritative command is accepted or refused. Keeping the ceiling in the
   * same integer unit as commitments avoids engine-specific transcendental
   * rounding at the live boundary.
   */
  readonly maxViableBurnDurationMs: BurnDurationMs;
}

/**
 * Tier 0 deliberately has one ship rather than a ship-design game. Values are
 * chosen from the research's viability anchor: a 1 g, 1,750 km/s torch burn is
 * still payload-positive with a 15% structural floor.
 */
export const TIER0_SHIP: Readonly<ShipMassConfig> = Object.freeze({
  exhaustVelocityKmPerSecond: 1_000,
  accelerationKmPerSecond2: 0.009_806_65,
  structuralMassFraction: 0.15,
  wetMassGrams: 1_000_000_000,
  // Derived once from ve * ln(1 / f_struct), then frozen as the largest
  // millisecond commitment strictly below that wall.
  maxViableBurnDurationMs: burnDurationMs(193_452_400)
});

/**
 * The fixed Tier 0 ship acceleration in integer micrometres per second².
 * This is the exact representation used at the committed-command boundary.
 */
export const TIER0_ACCELERATION_MICROMETERS_PER_SECOND2 = 9_806_650n;
const NANOMETRES_PER_MILLIMETRE = 1_000_000n;

export interface BurnParameters {
  readonly deltaVKmPerSecond: number;
  readonly burnDurationSeconds: number;
}

/**
 * The authoritative scheduled firing duration. Each BurnNode also commits its
 * quantized delta-v vector. Propellant accounting derives from that vector's
 * full-throttle-equivalent duration, not this schedule slot.
 */
export interface QuantizedBurnParameters {
  readonly burnDurationMs: BurnDurationMs;
}

/**
 * A scheduled burn paired with its committed quantized delta-v. The schedule
 * duration controls when the engine fires; propellant billing derives from
 * delta-v as its conservative full-throttle-equivalent duration, per the
 * 2026-08-09 Overseer ruling. A throttled burn therefore pays for the delta-v
 * it ejects, not its longer schedule slot.
 */
export interface PropellantCommittedBurn {
  readonly burn: QuantizedBurnParameters;
  readonly deltaVMmPerSecond: QuantizedDeltaV;
}

/**
 * Refuses a vector which the fixed Tier 0 ship cannot accumulate during its
 * committed duration. The squared comparison stays entirely in bigint space:
 * no square root or planner floating point may decide a live command.
 *
 * This intentionally hard-codes the Tier 0 acceleration rather than accepting
 * a ShipMassConfig. Tier 0 has one fixed ship; multi-ship parameterization is
 * future-tier work under standing order 13.
 *
 * A shorter vector is valid throttling. Propellant is charged from that vector
 * by fullThrottleEquivalentBurnDurationMs, rather than from the schedule slot.
 */
export const assertTier0DeltaVConsistentWithBurn = (
  deltaV: QuantizedDeltaV,
  burn: QuantizedBurnParameters
): void => {
  const durationMs = BigInt(burnDurationMs(burn.burnDurationMs));
  const x = BigInt(deltaV.x);
  const y = BigInt(deltaV.y);
  const z = BigInt(deltaV.z);
  const squaredDeltaV = x * x + y * y + z * z;
  const impulseNumerator = TIER0_ACCELERATION_MICROMETERS_PER_SECOND2 * durationMs;
  const squaredImpulseCeiling = impulseNumerator * impulseNumerator;
  const squaredDeltaVScaled = squaredDeltaV * NANOMETRES_PER_MILLIMETRE * NANOMETRES_PER_MILLIMETRE;

  if (squaredDeltaVScaled > squaredImpulseCeiling) {
    throw new RangeError("Burn delta-v exceeds the fixed ship acceleration for its committed duration.");
  }
};

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

export interface ProjectedBurnFuelState {
  /** The scheduled engine-firing duration, retained for timeline readouts. */
  readonly burnDurationMs: BurnDurationMs;
  /** Conservative full-throttle duration charged against propellant. */
  readonly propellantDurationMs: BurnDurationMs;
  /** Wet mass immediately after this node's burn, in grams. */
  readonly wetMassGrams: number;
  /** Propellant available after this node's burn, in grams. */
  readonly remainingPropellantGrams: number;
}

export interface PropellantSufficient {
  readonly kind: "sufficient";
  readonly nodes: readonly ProjectedBurnFuelState[];
}

export interface PropellantExhausted {
  readonly kind: "exhausted";
  readonly nodes: readonly ProjectedBurnFuelState[];
}

export type PropellantProjection = PropellantSufficient | PropellantExhausted;

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
  positiveFinite("Wet mass", ship.wetMassGrams);
  burnDurationMs(ship.maxViableBurnDurationMs);
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

/** Converts an already-feasible trajectory's delta-v into a typed payload result. */
export const assessCargo = (deltaVKmPerSecond: number, ship: ShipMassConfig = TIER0_SHIP): CargoAssessment => {
  validateShip(ship);
  const massRatio = massRatioForDeltaV(deltaVKmPerSecond, ship.exhaustVelocityKmPerSecond);
  const cargoFraction = Math.exp(-deltaVKmPerSecond / ship.exhaustVelocityKmPerSecond) - ship.structuralMassFraction;
  const viabilityWallDeltaVKmPerSecond = viabilityWallDeltaV(ship);

  // The logarithmic wall is authoritative. Comparing against it prevents a
  // platform's exp/log rounding from turning an exactly empty ship positive.
  if (deltaVKmPerSecond >= viabilityWallDeltaVKmPerSecond || cargoFraction <= 0) {
    return {
      kind: "nonviable",
      massRatio,
      cargoFraction: Math.min(cargoFraction, 0),
      viabilityWallDeltaVKmPerSecond
    };
  }
  return { kind: "viable", massRatio, cargoFraction, viabilityWallDeltaVKmPerSecond };
};

/** Rounds a planning-layer burn duration to the single commitment representation. */
export const quantizeBurnParameters = (
  parameters: Pick<BurnParameters, "burnDurationSeconds">
): QuantizedBurnParameters => ({
  burnDurationMs: burnDurationMs(quantize("Burn duration", parameters.burnDurationSeconds, 0.001))
});

/** Reconstructs derived planner-unit readouts from the authoritative duration. */
export const dequantizeBurnParameters = (
  parameters: QuantizedBurnParameters,
  ship: ShipMassConfig = TIER0_SHIP
): BurnParameters => {
  validateShip(ship);
  const milliseconds = burnDurationMs(parameters.burnDurationMs);
  const burnDurationSeconds = milliseconds / 1_000;
  return {
    burnDurationSeconds,
    deltaVKmPerSecond: deltaVForBurn(ship.accelerationKmPerSecond2, burnDurationSeconds)
  };
};

/**
 * Projects every committed node through the rocket equation in execution
 * order. The ship configuration, not a command payload, owns its propellant
 * mass. The strict-< viability wall refuses equality with the structural floor:
 * a plan must retain propellant rather than spend the final gram.
 */
export const projectPropellantForBurns = (
  burns: readonly PropellantCommittedBurn[],
  ship: ShipMassConfig = TIER0_SHIP
): PropellantProjection => {
  validateShip(ship);
  const committedBurns = burns.map(assertBurnParameters);
  const propellantDurationsMs = committedBurns.map(fullThrottleEquivalentBurnDurationMs);
  const sufficient = hasSufficientCommittedPropellant(propellantDurationsMs, ship.maxViableBurnDurationMs);

  const structuralMassGrams = ship.wetMassGrams * ship.structuralMassFraction;
  let wetMassGrams = ship.wetMassGrams;
  const nodes: ProjectedBurnFuelState[] = [];

  for (let index = 0; index < committedBurns.length; index += 1) {
    const burn = committedBurns[index]!;
    const propellantDurationMs = propellantDurationsMs[index]!;
    const { deltaVKmPerSecond } = dequantizeBurnParameters({ burnDurationMs: propellantDurationMs }, ship);
    wetMassGrams /= massRatioForDeltaV(deltaVKmPerSecond, ship.exhaustVelocityKmPerSecond);
    nodes.push({
      burnDurationMs: burn.burn.burnDurationMs,
      propellantDurationMs,
      wetMassGrams,
      remainingPropellantGrams: wetMassGrams - structuralMassGrams
    });
  }

  return sufficient ? { kind: "sufficient", nodes } : { kind: "exhausted", nodes };
};

/**
 * The live accept/refuse predicate. It intentionally contains no calls: the
 * ESLint guard makes this an integer-arithmetic-only boundary so planner or
 * rocket-equation transcendentals cannot become authoritative by accident.
 */
function hasSufficientCommittedPropellant(
  propellantDurationsMs: readonly BurnDurationMs[],
  maxViableBurnDurationMs: BurnDurationMs
): boolean {
  let totalBurnDurationMs = 0;
  for (const propellantDurationMs of propellantDurationsMs) {
    if (totalBurnDurationMs > Number.MAX_SAFE_INTEGER - propellantDurationMs) {
      throw new RangeError("Total burn duration must be a non-negative safe integer in milliseconds.");
    }
    totalBurnDurationMs += propellantDurationMs;
  }
  return totalBurnDurationMs <= maxViableBurnDurationMs;
}

/**
 * Integer square root rounded upward. Delta-v components are quantized in
 * mm/s, so this never undercharges a non-axial vector.
 */
const ceilSquareRoot = (value: bigint): bigint => {
  if (value < 0n) throw new RangeError("Delta-v magnitude squared must be non-negative.");
  if (value < 2n) return value;
  let lower = 1n;
  let upper = value;
  while (lower < upper) {
    const middle = (lower + upper) / 2n;
    if (middle * middle < value) lower = middle + 1n;
    else upper = middle;
  }
  return lower;
};

/**
 * Converts committed |delta-v| into the integer full-throttle duration used
 * for propellant billing. Both rounding steps go upward: vector magnitude to
 * mm/s, then duration to ms.
 */
export const fullThrottleEquivalentBurnDurationMs = (burn: PropellantCommittedBurn): BurnDurationMs => {
  const x = BigInt(burn.deltaVMmPerSecond.x);
  const y = BigInt(burn.deltaVMmPerSecond.y);
  const z = BigInt(burn.deltaVMmPerSecond.z);
  const deltaVMmPerSecond = ceilSquareRoot(x * x + y * y + z * z);
  const durationMs = (deltaVMmPerSecond * 1_000_000n + TIER0_ACCELERATION_MICROMETERS_PER_SECOND2 - 1n)
    / TIER0_ACCELERATION_MICROMETERS_PER_SECOND2;
  if (durationMs > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("Full-throttle-equivalent burn duration must be a safe integer in milliseconds.");
  }
  return burnDurationMs(Number(durationMs));
};

const assertBurnParameters = (burn: PropellantCommittedBurn): PropellantCommittedBurn => ({
  burn: { burnDurationMs: burnDurationMs(burn.burn.burnDurationMs) },
  deltaVMmPerSecond: quantizedDeltaV(burn.deltaVMmPerSecond)
});
