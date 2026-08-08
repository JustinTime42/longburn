import type { PositionMeters } from "./causality.js";
import { simTimeMs, type SimTimeMs } from "./clock.js";
import type { ExecutedBurn, FlightPlan } from "./event-log.js";
import { propagateKepler } from "./kepler.js";

export interface DepartureState {
  readonly departureAtMs: SimTimeMs;
  readonly positionMeters: PositionMeters;
  readonly velocityMmPerSecond: { readonly x: number; readonly y: number; readonly z: number };
}

export interface ShipWorldline {
  readonly departureState: DepartureState;
  readonly executedBurns: readonly ExecutedBurn[];
  readonly flightPlan: FlightPlan;
}

export const SOLAR_GRAVITATIONAL_PARAMETER_KM3_PER_SECOND2 = 132_712_440_018;

const toKm = (position: PositionMeters) => ({ x: position.x / 1_000, y: position.y / 1_000, z: position.z / 1_000 });
const toMeters = (position: { readonly x: number; readonly y: number; readonly z: number }): PositionMeters => ({
  x: Math.round(position.x * 1_000), y: Math.round(position.y * 1_000), z: Math.round(position.z * 1_000)
});
const toKmPerSecond = (velocity: { readonly x: number; readonly y: number; readonly z: number }) => ({
  x: velocity.x / 1_000_000, y: velocity.y / 1_000_000, z: velocity.z / 1_000_000
});

/**
 * Pure authoritative resolver. It only consumes committed, quantized facts;
 * the planner and ephemerides adapter never enter replay through this path.
 */
export const shipPositionAt = (worldline: ShipWorldline, atMs: number): PositionMeters => {
  if (!Number.isFinite(atMs) || atMs < worldline.departureState.departureAtMs) {
    throw new RangeError("Ship worldline position requires a finite time at or after departure.");
  }
  let state = {
    positionKm: toKm(worldline.departureState.positionMeters),
    velocityKmPerSecond: toKmPerSecond(worldline.departureState.velocityMmPerSecond)
  };
  let cursor = worldline.departureState.departureAtMs;
  const burns = [...worldline.executedBurns].sort((left, right) => left.startedAtMs - right.startedAtMs);
  for (const burn of burns) {
    if (burn.startedAtMs > atMs) break;
    state = propagateKepler(SOLAR_GRAVITATIONAL_PARAMETER_KM3_PER_SECOND2, state, (burn.startedAtMs - cursor) / 1_000);
    const until = Math.min(atMs, burn.endedAtMs ?? atMs);
    const seconds = (until - burn.startedAtMs) / 1_000;
    const delta = burn.node.deltaVMmPerSecond;
    const acceleration = { x: delta.x / 1_000_000 / Math.max(seconds, Number.EPSILON), y: delta.y / 1_000_000 / Math.max(seconds, Number.EPSILON), z: delta.z / 1_000_000 / Math.max(seconds, Number.EPSILON) };
    state = {
      positionKm: {
        x: state.positionKm.x + state.velocityKmPerSecond.x * seconds + 0.5 * acceleration.x * seconds * seconds,
        y: state.positionKm.y + state.velocityKmPerSecond.y * seconds + 0.5 * acceleration.y * seconds * seconds,
        z: state.positionKm.z + state.velocityKmPerSecond.z * seconds + 0.5 * acceleration.z * seconds * seconds
      },
      velocityKmPerSecond: { x: state.velocityKmPerSecond.x + acceleration.x * seconds, y: state.velocityKmPerSecond.y + acceleration.y * seconds, z: state.velocityKmPerSecond.z + acceleration.z * seconds }
    };
    cursor = simTimeMs(until);
    if (until === atMs) return toMeters(state.positionKm);
  }
  return toMeters(propagateKepler(SOLAR_GRAVITATIONAL_PARAMETER_KM3_PER_SECOND2, state, (atMs - cursor) / 1_000).positionKm);
};
