import { ephemeridesAt, type HeliocentricState, type UtDaysSinceJ2000, type Vector3Km } from "./ephemerides.js";
import { LambertConvergenceError, LambertGeometryError, LambertNoFeasibleSolutionError, solveLambertIzzo } from "./lambert.js";
import { simTimeMs } from "./clock.js";

/** Sun GM, in km^3/s^2. */
export const SUN_GRAVITATIONAL_PARAMETER_KM3_PER_SECOND2 = 132_712_440_018;
export const NASA_DEPARTURE_SPAN_DAYS = 160;
export const NASA_MINIMUM_TIME_OF_FLIGHT_DAYS = 100;
export const NASA_MAXIMUM_TIME_OF_FLIGHT_DAYS = 450;
export const C3_DISPLAY_CAP_KM2_PER_SECOND2 = 50;

const SECONDS_PER_DAY = 86_400;
const DEGREES_PER_RADIAN = 180 / Math.PI;
const SINGULAR_TRANSFER_ANGLE_DEGREES = 180;
const SINGULAR_TRANSFER_ANGLE_GUARD_DEGREES = 0.05;

const EARTH_MU = 398_600.4418;
const EARTH_PARKING_RADIUS_KM = 6_378.1363 + 200;
const MARS_MU = 42_828.375_214;
const MARS_PARKING_RADIUS_KM = 3_396.19 + 400;

export interface PorkchopSearchInput {
  /** UT day count for the first departure column. This is supplied virtual time, never a host clock. */
  readonly departureStartUtDays: UtDaysSinceJ2000;
  readonly departureSpanDays?: number;
  readonly departureStepDays?: number;
  readonly minimumTimeOfFlightDays?: number;
  readonly maximumTimeOfFlightDays?: number;
  readonly timeOfFlightStepDays?: number;
  /** Allows fixture tests and a future ephemeris provider to supply states without changing the search. */
  readonly statesAt?: (utDays: UtDaysSinceJ2000) => Readonly<{ earth: HeliocentricState; mars: HeliocentricState }>;
}

export interface ValidPorkchopCell {
  readonly kind: "valid";
  readonly departureUtDays: UtDaysSinceJ2000;
  readonly arrivalUtDays: UtDaysSinceJ2000;
  readonly timeOfFlightDays: number;
  /** Heliocentric departure excess energy, the conventional C3 overlay. */
  readonly c3Km2PerSecond2: number;
  readonly arrivalVInfinityKmPerSecond: number;
  readonly departureWellDeltaVKmPerSecond: number;
  readonly arrivalWellDeltaVKmPerSecond: number;
  /** TMI plus Mars insertion from the specified parking orbits; this is the ranking value. */
  readonly totalDeltaVKmPerSecond: number;
}

export interface InvalidPorkchopCell {
  readonly kind: "invalid";
  readonly departureUtDays: UtDaysSinceJ2000;
  readonly arrivalUtDays: UtDaysSinceJ2000;
  readonly timeOfFlightDays: number;
  readonly reason: "near-180-degree-transfer" | "lambert-unavailable";
}

export type PorkchopCell = ValidPorkchopCell | InvalidPorkchopCell;

export interface PorkchopGrid {
  /** Cells are emitted in departure-major, TOF-minor order for stable reductions. */
  readonly cells: readonly PorkchopCell[];
  readonly departureCount: number;
  readonly timeOfFlightCount: number;
  readonly c3DisplayCapKm2PerSecond2: number;
}

const dot = (left: Vector3Km, right: Vector3Km): number => left.x * right.x + left.y * right.y + left.z * right.z;
const crossZ = (left: Vector3Km, right: Vector3Km): number => left.x * right.y - left.y * right.x;
const magnitude = (vector: Vector3Km): number => Math.sqrt(dot(vector, vector));
const differenceMagnitude = (left: Vector3Km, right: Vector3Km): number => magnitude({ x: left.x - right.x, y: left.y - right.y, z: left.z - right.z });

const positiveFinite = (name: string, value: number): void => {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be a positive finite number.`);
};

const integerSteps = (name: string, span: number, step: number): number => {
  if (!Number.isFinite(span) || span < 0) throw new RangeError(`${name} must be a non-negative finite number.`);
  positiveFinite(`${name} step`, step);
  const steps = span / step;
  const roundedSteps = Math.round(steps);
  if (Math.abs(steps - roundedSteps) > 1e-10) throw new RangeError(`${name} must be an exact multiple of its step.`);
  return roundedSteps;
};

const progradeTransferAngleDegrees = (departure: Vector3Km, arrival: Vector3Km): number => {
  const denominator = magnitude(departure) * magnitude(arrival);
  const shortAngle = Math.acos(Math.max(-1, Math.min(1, dot(departure, arrival) / denominator))) * DEGREES_PER_RADIAN;
  return crossZ(departure, arrival) < 0 ? 360 - shortAngle : shortAngle;
};

/** Patched-conic burn from a circular parking orbit to a hyperbolic excess speed. */
export const parkingOrbitWellDeltaV = (vInfinityKmPerSecond: number, gravitationalParameterKm3PerSecond2: number, parkingRadiusKm: number): number => {
  if (!Number.isFinite(vInfinityKmPerSecond) || vInfinityKmPerSecond < 0) throw new RangeError("Hyperbolic excess speed must be finite and non-negative.");
  positiveFinite("Body gravitational parameter", gravitationalParameterKm3PerSecond2);
  positiveFinite("Parking radius", parkingRadiusKm);
  const circularSpeed = Math.sqrt(gravitationalParameterKm3PerSecond2 / parkingRadiusKm);
  return Math.sqrt(vInfinityKmPerSecond ** 2 + 2 * gravitationalParameterKm3PerSecond2 / parkingRadiusKm) - circularSpeed;
};

const defaultStatesAt = (utDays: UtDaysSinceJ2000): Readonly<{ earth: HeliocentricState; mars: HeliocentricState }> => {
  const states = ephemeridesAt(utDays, simTimeMs(0));
  return { earth: states.earth, mars: states.mars };
};

/**
 * Evaluates one prograde, zero-revolution Earth-to-Mars Lambert transfer per
 * departure × TOF cell. The grid is computed in that natural coordinate system
 * but each cell includes arrivalUtDays so callers render departure × arrival.
 */
export const searchEarthMarsPorkchop = (input: PorkchopSearchInput): PorkchopGrid => {
  const departureSpanDays = input.departureSpanDays ?? NASA_DEPARTURE_SPAN_DAYS;
  const departureStepDays = input.departureStepDays ?? 1;
  const minimumTimeOfFlightDays = input.minimumTimeOfFlightDays ?? NASA_MINIMUM_TIME_OF_FLIGHT_DAYS;
  const maximumTimeOfFlightDays = input.maximumTimeOfFlightDays ?? NASA_MAXIMUM_TIME_OF_FLIGHT_DAYS;
  const timeOfFlightStepDays = input.timeOfFlightStepDays ?? 1;
  const departureSteps = integerSteps("Departure span", departureSpanDays, departureStepDays);
  if (maximumTimeOfFlightDays < minimumTimeOfFlightDays) throw new RangeError("Maximum time of flight must not precede minimum time of flight.");
  const timeOfFlightSteps = integerSteps("Time-of-flight span", maximumTimeOfFlightDays - minimumTimeOfFlightDays, timeOfFlightStepDays);
  const statesAt = input.statesAt ?? defaultStatesAt;
  const departureCount = departureSteps + 1;
  const timeOfFlightCount = timeOfFlightSteps + 1;
  const departureStates = new Map<number, HeliocentricState>();
  const marsStates = new Map<number, HeliocentricState>();
  const earthAt = (utDays: UtDaysSinceJ2000): HeliocentricState => {
    const cached = departureStates.get(utDays);
    if (cached !== undefined) return cached;
    const state = statesAt(utDays).earth;
    departureStates.set(utDays, state);
    return state;
  };
  const marsAt = (utDays: UtDaysSinceJ2000): HeliocentricState => {
    const cached = marsStates.get(utDays);
    if (cached !== undefined) return cached;
    const state = statesAt(utDays).mars;
    marsStates.set(utDays, state);
    return state;
  };
  const cells: PorkchopCell[] = [];

  for (let departureIndex = 0; departureIndex < departureCount; departureIndex += 1) {
    const departureUtDays = (input.departureStartUtDays + departureIndex * departureStepDays) as UtDaysSinceJ2000;
    const earth = earthAt(departureUtDays);
    for (let tofIndex = 0; tofIndex < timeOfFlightCount; tofIndex += 1) {
      const timeOfFlightDays = minimumTimeOfFlightDays + tofIndex * timeOfFlightStepDays;
      const arrivalUtDays = (departureUtDays + timeOfFlightDays) as UtDaysSinceJ2000;
      const mars = marsAt(arrivalUtDays);
      const base = { departureUtDays, arrivalUtDays, timeOfFlightDays };
      if (Math.abs(progradeTransferAngleDegrees(earth.positionKm, mars.positionKm) - SINGULAR_TRANSFER_ANGLE_DEGREES) < SINGULAR_TRANSFER_ANGLE_GUARD_DEGREES) {
        cells.push({ ...base, kind: "invalid", reason: "near-180-degree-transfer" });
        continue;
      }
      try {
        const solution = solveLambertIzzo(SUN_GRAVITATIONAL_PARAMETER_KM3_PER_SECOND2, earth.positionKm, mars.positionKm, timeOfFlightDays * SECONDS_PER_DAY, { revolutions: 0, isPrograde: true });
        const departureVInfinityKmPerSecond = differenceMagnitude(solution.departureVelocityKmPerSecond, earth.velocityKmPerSecond);
        // This intentionally uses Mars at arrival, not the departure epoch.
        const arrivalVInfinityKmPerSecond = differenceMagnitude(solution.arrivalVelocityKmPerSecond, mars.velocityKmPerSecond);
        const departureWellDeltaVKmPerSecond = parkingOrbitWellDeltaV(departureVInfinityKmPerSecond, EARTH_MU, EARTH_PARKING_RADIUS_KM);
        const arrivalWellDeltaVKmPerSecond = parkingOrbitWellDeltaV(arrivalVInfinityKmPerSecond, MARS_MU, MARS_PARKING_RADIUS_KM);
        cells.push({
          ...base,
          kind: "valid",
          c3Km2PerSecond2: departureVInfinityKmPerSecond ** 2,
          arrivalVInfinityKmPerSecond,
          departureWellDeltaVKmPerSecond,
          arrivalWellDeltaVKmPerSecond,
          totalDeltaVKmPerSecond: departureWellDeltaVKmPerSecond + arrivalWellDeltaVKmPerSecond
        });
      } catch (error) {
        if (error instanceof LambertConvergenceError || error instanceof LambertGeometryError || error instanceof LambertNoFeasibleSolutionError) {
          cells.push({ ...base, kind: "invalid", reason: "lambert-unavailable" });
        } else {
          throw error;
        }
      }
    }
  }
  return { cells, departureCount, timeOfFlightCount, c3DisplayCapKm2PerSecond2: C3_DISPLAY_CAP_KM2_PER_SECOND2 };
};

/** Stable ranking for the planner/API layer: player-facing patched-conic burn cost first. */
export const rankPorkchopCells = (cells: readonly PorkchopCell[]): readonly ValidPorkchopCell[] => cells
  .filter((cell): cell is ValidPorkchopCell => cell.kind === "valid")
  .toSorted((left, right) => left.totalDeltaVKmPerSecond - right.totalDeltaVKmPerSecond || left.departureUtDays - right.departureUtDays || left.arrivalUtDays - right.arrivalUtDays);
