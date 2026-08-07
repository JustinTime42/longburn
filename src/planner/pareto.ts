/**
 * Player-facing trajectory planning boundary.
 *
 * This module is deliberately outside `src/sim`: its floating-point results
 * advise a later quantized commitment and never enter authoritative state.
 * A planner implementation consumes candidate cells and an ephemeris provider
 * rather than owning either, so later fidelity tiers can implement the same
 * `TrajectoryPlanner` interface without changing its consumers.
 */
import {
  solveContinuumLeg,
  type ContinuumDutyCycleInfeasible,
  type ContinuumIndeterminate,
  type ContinuumInfeasible
} from "../sim/continuum-blend.js";
import { assessCargo, type ShipMassConfig } from "../sim/mass-cargo.js";
import {
  parkingOrbitWellDeltaV,
  TIER0_MARS_GRAVITATIONAL_PARAMETER_KM3_PER_SECOND2,
  TIER0_MARS_PARKING_RADIUS_KM,
  type InvalidPorkchopCell,
  type PorkchopCell,
  type ValidPorkchopCell
} from "../sim/window-search.js";
import { simTimeToUtDays, type HeliocentricState, type UtDaysSinceJ2000 } from "../sim/ephemerides.js";
import type { SimTimeMs } from "../sim/clock.js";

const SECONDS_PER_DAY = 86_400;
const KILOMETERS_TO_METERS = 1_000;

/** Mars 400 km circular-orbit capture, the Tier 0 default. */
export const TIER0_MARS_CAPTURE_TARGET: ArrivalCaptureTarget = Object.freeze({
  gravitationalParameterKm3PerSecond2: TIER0_MARS_GRAVITATIONAL_PARAMETER_KM3_PER_SECOND2,
  parkingRadiusKm: TIER0_MARS_PARKING_RADIUS_KM
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
  /**
   * Optional caller-projected departure state for the continuum leg. This is
   * advisory planner input, never authoritative simulation state.
   */
  readonly departureStateOverride?: HeliocentricState;
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
  /** A physics wall: the actual-thrust flat-space burns overlap. */
  readonly reason: ContinuumInfeasible["reason"];
  readonly coastDurationSeconds: number;
}

/** The deterministic solver could not validate a trajectory; this is not physics. */
export interface IndeterminateWall {
  readonly kind: "indeterminate";
  readonly departureUtDays: UtDaysSinceJ2000;
  readonly timeOfFlightDays: number;
  readonly arrivalTime: UtDaysSinceJ2000;
  readonly reason: ContinuumIndeterminate["reason"];
  readonly coastDurationSeconds: number;
}

/** The quoted finite-thrust burn cannot fit inside the requested flight window. */
export interface DutyCycleInfeasibleWall {
  readonly kind: "infeasible";
  readonly departureUtDays: UtDaysSinceJ2000;
  readonly timeOfFlightDays: number;
  readonly arrivalTime: UtDaysSinceJ2000;
  readonly reason: ContinuumDutyCycleInfeasible["reason"];
  /** Amendment A diagnostics are first-class on this typed wall. */
  readonly quotedDutyCycle: number;
  readonly kappa: number;
  readonly eta: number;
  readonly heliocentricDeltaVMetersPerSecond: number;
}

/** A porkchop cell was evaluated but has no Lambert solution to assemble. */
export interface InvalidCellWall {
  readonly kind: "invalid";
  readonly departureUtDays: UtDaysSinceJ2000;
  readonly timeOfFlightDays: number;
  readonly arrivalTime: UtDaysSinceJ2000;
  readonly reason: InvalidPorkchopCell["reason"];
}

export interface NonviableWall {
  readonly kind: "nonviable";
  readonly departureUtDays: UtDaysSinceJ2000;
  readonly timeOfFlightDays: number;
  readonly arrivalTime: UtDaysSinceJ2000;
  readonly reason: "cargo-exhausted";
  readonly viabilityWallDeltaVKmPerSecond: number;
}

export type ParetoWall = InfeasibleWall | IndeterminateWall | DutyCycleInfeasibleWall | InvalidCellWall | NonviableWall;

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

/**
 * An advisory heliocentric ship state at the instant selected for replanning.
 *
 * This intentionally is not simulation state. The event log stores only
 * quantized burn nodes, whose duration alone cannot reproduce a directional
 * heliocentric velocity. A projection owner supplies this calculated state to
 * the planner; a committed revision still contains only BurnNodes.
 */
export interface ProjectedShipState extends HeliocentricState {
  /** Virtual-clock instant at which this position and velocity hold. */
  readonly atMs: SimTimeMs;
}

/** Builds origin-specific candidate cells from the chosen projected state. */
export interface ProjectedStateCellSource {
  cellsFrom(origin: ProjectedShipState): readonly PorkchopCell[];
}

/**
 * Planning request for a current state or any future state on a paper flight
 * plan. `worldEpochUtDaysSinceJ2000` maps the virtual origin time into the
 * planner's UT coordinate so candidate departures cannot precede that state.
 * This synchronous, local interface has no causal-transport input: planning is
 * never light-lagged; only a later PlanRevision is transported. A 64k-cell
 * sweep remains a seconds-scale advisory operation per Amendment C, not a
 * keystroke-time query.
 */
export interface ProjectedStatePlannerRequest extends Omit<ParetoPlannerRequest, "cells" | "departureStateOverride"> {
  readonly origin: ProjectedShipState;
  readonly worldEpochUtDaysSinceJ2000: UtDaysSinceJ2000;
  readonly cellSource: ProjectedStateCellSource;
}

/** Preserves the exact advisory origin alongside the resulting Pareto curve. */
export interface ProjectedStateParetoLandscape {
  readonly origin: ProjectedShipState;
  readonly landscape: ParetoLandscape;
}

export interface ProjectedStateTrajectoryPlanner extends TrajectoryPlanner {
  planFromProjectedState(request: ProjectedStatePlannerRequest): ProjectedStateParetoLandscape;
}

const magnitude = (vector: { readonly x: number; readonly y: number; readonly z: number }): number =>
  Math.hypot(vector.x, vector.y, vector.z);

const valid = (cell: PorkchopCell): cell is ValidPorkchopCell => cell.kind === "valid";

const dominates = (left: ParetoPoint, right: ParetoPoint): boolean =>
  left.timeOfFlightDays <= right.timeOfFlightDays &&
  left.totalDeltaVKmPerSecond <= right.totalDeltaVKmPerSecond &&
  (left.timeOfFlightDays < right.timeOfFlightDays || left.totalDeltaVKmPerSecond < right.totalDeltaVKmPerSecond);

const paretoFront = (points: readonly ParetoPoint[]): readonly ParetoPoint[] =>
  points.filter((point, index) => !points.some((candidate, candidateIndex) => candidateIndex !== index && dominates(candidate, point)))
    .toSorted((left, right) => left.timeOfFlightDays - right.timeOfFlightDays || left.totalDeltaVKmPerSecond - right.totalDeltaVKmPerSecond);

const continuumWall = (
  result: ContinuumInfeasible | ContinuumIndeterminate | ContinuumDutyCycleInfeasible,
  cell: ValidPorkchopCell,
  arrivalTime: UtDaysSinceJ2000
): ParetoWall => {
  const base = { departureUtDays: cell.departureUtDays, timeOfFlightDays: cell.timeOfFlightDays, arrivalTime };
  if (result.kind === "indeterminate") return { kind: "indeterminate", ...base, reason: result.reason, coastDurationSeconds: result.coastDurationSeconds };
  if (result.reason === "duty-cycle-exceeded") {
    return {
      kind: "infeasible",
      ...base,
      reason: result.reason,
      quotedDutyCycle: result.quotedDutyCycle,
      kappa: result.kappa,
      eta: result.eta,
      heliocentricDeltaVMetersPerSecond: result.heliocentricDeltaVMetersPerSecond
    };
  }
  return { kind: "infeasible", ...base, reason: result.reason, coastDurationSeconds: result.coastDurationSeconds };
};

const invalidCellWall = (cell: InvalidPorkchopCell): InvalidCellWall => ({
  kind: "invalid",
  departureUtDays: cell.departureUtDays,
  timeOfFlightDays: cell.timeOfFlightDays,
  arrivalTime: cell.arrivalUtDays,
  reason: cell.reason
});

const assembleCell = (cell: ValidPorkchopCell, request: ParetoPlannerRequest, capture: ArrivalCaptureTarget): ParetoPoint | ParetoWall => {
  const arrivalTime = (cell.departureUtDays + cell.timeOfFlightDays) as UtDaysSinceJ2000;
  // The porkchop's arrival coordinate is the authoritative convention too.
  if (arrivalTime !== cell.arrivalUtDays) throw new RangeError("Porkchop cell arrival epoch must equal departure plus time of flight.");
  const departure = request.departureStateOverride ?? request.ephemerides.statesAt(cell.departureUtDays).earth;
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
  if (continuum.kind !== "feasible") return continuumWall(continuum, cell, arrivalTime);
  const arrivalWellDeltaVKmPerSecond = parkingOrbitWellDeltaV(
    cell.arrivalVInfinityKmPerSecond,
    capture.gravitationalParameterKm3PerSecond2,
    capture.parkingRadiusKm
  );
  // The well burns already impart the two hyperbolic-excess speeds. Lambert's
  // leg is therefore charged only for its finite-burn correction, not twice.
  const totalDeltaVKmPerSecond = cell.departureWellDeltaVKmPerSecond +
    arrivalWellDeltaVKmPerSecond +
    (continuum.kappa - 1) * heliocentricLambertDeltaVMetersPerSecond / KILOMETERS_TO_METERS;
  const cargo = assessCargo(totalDeltaVKmPerSecond, request.ship);
  if (cargo.kind === "nonviable") return { kind: "nonviable", departureUtDays: cell.departureUtDays, timeOfFlightDays: cell.timeOfFlightDays, arrivalTime, reason: "cargo-exhausted", viabilityWallDeltaVKmPerSecond: cargo.viabilityWallDeltaVKmPerSecond };
  return { kind: "viable", departureUtDays: cell.departureUtDays, timeOfFlightDays: cell.timeOfFlightDays, arrivalTime, totalDeltaVKmPerSecond, cargoFraction: cargo.cargoFraction, massRatio: cargo.massRatio, quotedDutyCycle: continuum.quotedDutyCycle, finiteBurnCaution: continuum.finiteBurnCaution, eta: continuum.eta };
};

/** Default Tier-0 fidelity. It retains all windows to expose the periodic landscape. */
export const assembleParetoLandscape = (request: ParetoPlannerRequest): ParetoLandscape => {
  const capture = request.arrivalCaptureTarget ?? TIER0_MARS_CAPTURE_TARGET;
  const grouped = new Map<UtDaysSinceJ2000, Array<ParetoPoint | ParetoWall>>();
  for (const cell of request.cells) {
    const entries = grouped.get(cell.departureUtDays) ?? [];
    entries.push(valid(cell) ? assembleCell(cell, request, capture) : invalidCellWall(cell));
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

/**
 * Assembles advice from a caller-owned projected state. `cellSource` is the
 * fidelity boundary: it may run a patched-conic search from the supplied state
 * without allowing floating-point results into authoritative simulation state.
 */
export const planParetoFromProjectedState = (request: ProjectedStatePlannerRequest): ProjectedStateParetoLandscape => {
  const originUtDays = simTimeToUtDays(request.worldEpochUtDaysSinceJ2000, request.origin.atMs);
  const cells = request.cellSource.cellsFrom(request.origin);
  if (cells.some((cell) => cell.departureUtDays < originUtDays)) {
    throw new RangeError("Projected-state planner cells must depart at or after the selected origin.");
  }

  return {
    origin: request.origin,
    landscape: assembleParetoLandscape({
      cells,
      ephemerides: request.ephemerides,
      ship: request.ship,
      arrivalCaptureTarget: request.arrivalCaptureTarget,
      departureStateOverride: request.origin
    })
  };
};

export const tier0TrajectoryPlanner: ProjectedStateTrajectoryPlanner = Object.freeze({
  assemble: assembleParetoLandscape,
  planFromProjectedState: planParetoFromProjectedState
});
