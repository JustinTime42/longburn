/**
 * Player-facing trajectory planning boundary.
 *
 * This module is deliberately outside `src/sim`: its floating-point results
 * advise a later quantized commitment and never enter authoritative state.
 * A planner implementation consumes candidate cells and an ephemeris provider
 * rather than owning either, so later fidelity tiers can implement the same
 * `TrajectoryPlanner` interface without changing its consumers.
 */
import { solveContinuumLeg, type ContinuumResult } from "../sim/continuum-blend.js";
import { assessCargo, type ShipMassConfig } from "../sim/mass-cargo.js";
import { parkingOrbitWellDeltaV, type PorkchopCell, type ValidPorkchopCell } from "../sim/window-search.js";
import type { HeliocentricState, UtDaysSinceJ2000 } from "../sim/ephemerides.js";

const SECONDS_PER_DAY = 86_400;
const KILOMETERS_TO_METERS = 1_000;

/** Mars 400 km circular-orbit capture, the Tier 0 default. */
export const TIER0_MARS_CAPTURE_TARGET: ArrivalCaptureTarget = Object.freeze({
  gravitationalParameterKm3PerSecond2: 42_828.375_214,
  parkingRadiusKm: 3_396.19 + 400
});

export interface ArrivalCaptureTarget {
  /** Target body's GM, in km³/s². */
  readonly gravitationalParameterKm3PerSecond2: number;
  /** Radius of the circular target parking orbit, in km. */
  readonly parkingRadiusKm: number;
}

/** Caller-owned ephemerides permit another planner fidelity behind this API. */
export interface PlannerEphemerides {
  readonly statesAt: (utDays: UtDaysSinceJ2000) => Readonly<{ earth: HeliocentricState; mars: HeliocentricState }>;
}

export interface ParetoPlannerRequest {
  readonly cells: readonly PorkchopCell[];
  readonly ephemerides: PlannerEphemerides;
  /** Explicit at the boundary: no hidden default ship tuple. */
  readonly ship: ShipMassConfig;
  /** Defaults to the documented 400 km circular Mars capture target. */
  readonly arrivalCaptureTarget?: ArrivalCaptureTarget;
}

export interface ParetoPoint {
  readonly kind: "viable";
  readonly departureUtDays: UtDaysSinceJ2000;
  /** Duration is one axis of the per-window 2-D curve. */
  readonly timeOfFlightDays: number;
  /**
   * Absolute UT days since J2000.0, defined exactly as departureUtDays +
   * timeOfFlightDays. It is an arrival epoch, not a duration or a sim-clock
   * offset.
   */
  readonly arrivalTime: UtDaysSinceJ2000;
  /** Total patched-conic and quoted heliocentric burn, the curve's second axis. */
  readonly totalDeltaVKmPerSecond: number;
  /** Derived readout, never a third Pareto dimension. */
  readonly cargoFraction: number;
  readonly massRatio: number;
  readonly quotedDutyCycle: number;
  readonly finiteBurnCaution: boolean;
  readonly eta: number;
}

export interface InfeasibleWall {
  readonly kind: "infeasible";
  readonly departureUtDays: UtDaysSinceJ2000;
  readonly timeOfFlightDays: number;
  readonly arrivalTime: UtDaysSinceJ2000;
  readonly reason: string;
}

export interface NonviableWall {
  readonly kind: "nonviable";
  readonly departureUtDays: UtDaysSinceJ2000;
  readonly timeOfFlightDays: number;
  readonly arrivalTime: UtDaysSinceJ2000;
  readonly reason: "cargo-exhausted";
  readonly viabilityWallDeltaVKmPerSecond: number;
}

export type ParetoWall = InfeasibleWall | NonviableWall;

/** One departure epoch's curve. Curves are never compared across windows. */
export interface ParetoWindow {
  readonly departureUtDays: UtDaysSinceJ2000;
  readonly points: readonly ParetoPoint[];
  readonly walls: readonly ParetoWall[];
}

/** A synodic-periodic landscape, not a globally monotone best-route list. */
export interface ParetoLandscape {
  readonly windows: readonly ParetoWindow[];
}

export interface TrajectoryPlanner {
  assemble(request: ParetoPlannerRequest): ParetoLandscape;
}

const magnitude = (vector: { readonly x: number; readonly y: number; readonly z: number }): number =>
  Math.hypot(vector.x, vector.y, vector.z);

const valid = (cell: PorkchopCell): cell is ValidPorkchopCell => cell.kind === "valid";

const infeasibleReason = (result: Exclude<ContinuumResult, { readonly kind: "feasible" }>): string =>
  result.reason;

const dominates = (left: ParetoPoint, right: ParetoPoint): boolean =>
  left.timeOfFlightDays <= right.timeOfFlightDays &&
  left.totalDeltaVKmPerSecond <= right.totalDeltaVKmPerSecond &&
  (left.timeOfFlightDays < right.timeOfFlightDays || left.totalDeltaVKmPerSecond < right.totalDeltaVKmPerSecond);

const paretoFront = (points: readonly ParetoPoint[]): readonly ParetoPoint[] =>
  points.filter((point, index) => !points.some((candidate, candidateIndex) => candidateIndex !== index && dominates(candidate, point)))
    .toSorted((left, right) => left.timeOfFlightDays - right.timeOfFlightDays || left.totalDeltaVKmPerSecond - right.totalDeltaVKmPerSecond);

const assembleCell = (cell: ValidPorkchopCell, request: ParetoPlannerRequest, capture: ArrivalCaptureTarget): ParetoPoint | ParetoWall => {
  const arrivalTime = (cell.departureUtDays + cell.timeOfFlightDays) as UtDaysSinceJ2000;
  // The porkchop's arrival coordinate is the authoritative convention too.
  if (arrivalTime !== cell.arrivalUtDays) throw new RangeError("Porkchop cell arrival epoch must equal departure plus time of flight.");
  const departure = request.ephemerides.statesAt(cell.departureUtDays).earth;
  const arrival = request.ephemerides.statesAt(arrivalTime).mars;
  const heliocentricLambertDeltaVMetersPerSecond =
    (Math.sqrt(cell.c3Km2PerSecond2) + cell.arrivalVInfinityKmPerSecond) * KILOMETERS_TO_METERS;
  const continuum = solveContinuumLeg({
    lambertDeltaVMetersPerSecond: heliocentricLambertDeltaVMetersPerSecond,
    flatspaceRequest: {
      accelerationMetersPerSecondSquared: request.ship.accelerationKmPerSecond2 * KILOMETERS_TO_METERS,
      durationSeconds: cell.timeOfFlightDays * SECONDS_PER_DAY,
      departurePositionMeters: { x: departure.positionKm.x * KILOMETERS_TO_METERS, y: departure.positionKm.y * KILOMETERS_TO_METERS, z: departure.positionKm.z * KILOMETERS_TO_METERS },
      departureVelocityMetersPerSecond: { x: departure.velocityKmPerSecond.x * KILOMETERS_TO_METERS, y: departure.velocityKmPerSecond.y * KILOMETERS_TO_METERS, z: departure.velocityKmPerSecond.z * KILOMETERS_TO_METERS },
      arrivalPositionMeters: { x: arrival.positionKm.x * KILOMETERS_TO_METERS, y: arrival.positionKm.y * KILOMETERS_TO_METERS, z: arrival.positionKm.z * KILOMETERS_TO_METERS },
      arrivalVelocityMetersPerSecond: { x: arrival.velocityKmPerSecond.x * KILOMETERS_TO_METERS, y: arrival.velocityKmPerSecond.y * KILOMETERS_TO_METERS, z: arrival.velocityKmPerSecond.z * KILOMETERS_TO_METERS }
    },
    solarRadiusMeters: magnitude(departure.positionKm) * KILOMETERS_TO_METERS
  });
  if (continuum.kind !== "feasible") return { kind: "infeasible", departureUtDays: cell.departureUtDays, timeOfFlightDays: cell.timeOfFlightDays, arrivalTime, reason: infeasibleReason(continuum) };
  const arrivalWellDeltaVKmPerSecond = parkingOrbitWellDeltaV(
    cell.arrivalVInfinityKmPerSecond,
    capture.gravitationalParameterKm3PerSecond2,
    capture.parkingRadiusKm
  );
  const totalDeltaVKmPerSecond = cell.departureWellDeltaVKmPerSecond + continuum.heliocentricDeltaVMetersPerSecond / KILOMETERS_TO_METERS + arrivalWellDeltaVKmPerSecond;
  const cargo = assessCargo(totalDeltaVKmPerSecond, request.ship);
  if (cargo.kind === "nonviable") return { kind: "nonviable", departureUtDays: cell.departureUtDays, timeOfFlightDays: cell.timeOfFlightDays, arrivalTime, reason: "cargo-exhausted", viabilityWallDeltaVKmPerSecond: cargo.viabilityWallDeltaVKmPerSecond };
  return { kind: "viable", departureUtDays: cell.departureUtDays, timeOfFlightDays: cell.timeOfFlightDays, arrivalTime, totalDeltaVKmPerSecond, cargoFraction: cargo.cargoFraction, massRatio: cargo.massRatio, quotedDutyCycle: continuum.quotedDutyCycle, finiteBurnCaution: continuum.finiteBurnCaution, eta: continuum.eta };
};

/** Default Tier-0 fidelity. It retains all windows to expose the periodic landscape. */
export const assembleParetoLandscape = (request: ParetoPlannerRequest): ParetoLandscape => {
  const capture = request.arrivalCaptureTarget ?? TIER0_MARS_CAPTURE_TARGET;
  const grouped = new Map<UtDaysSinceJ2000, Array<ParetoPoint | ParetoWall>>();
  for (const cell of request.cells) {
    if (!valid(cell)) continue;
    const entries = grouped.get(cell.departureUtDays) ?? [];
    entries.push(assembleCell(cell, request, capture));
    grouped.set(cell.departureUtDays, entries);
  }
  return {
    windows: [...grouped.entries()]
      .toSorted(([left], [right]) => left - right)
      .map(([departureUtDays, entries]) => ({
        departureUtDays,
        points: paretoFront(entries.filter((entry): entry is ParetoPoint => entry.kind === "viable")),
        walls: entries.filter((entry): entry is ParetoWall => entry.kind !== "viable")
      }))
  };
};

export const tier0TrajectoryPlanner: TrajectoryPlanner = Object.freeze({ assemble: assembleParetoLandscape });
