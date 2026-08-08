import type { SimulationEventStore, SimulationStream } from "./event-store.js";
import type { SimTimeMs } from "./clock.js";
import type { DepartureState, DestinationBody } from "./event-log.js";
import { ephemeridesAt, type UtDaysSinceJ2000 } from "./ephemerides.js";
import { AuthoritativeSimLoop } from "./loop.js";

const positionMeters = (positionKm: { readonly x: number; readonly y: number; readonly z: number }) => ({
  x: Math.round(positionKm.x * 1_000), y: Math.round(positionKm.y * 1_000), z: Math.round(positionKm.z * 1_000)
});

const velocityMmPerSecond = (velocityKmPerSecond: { readonly x: number; readonly y: number; readonly z: number }) => ({
  x: Math.round(velocityKmPerSecond.x * 1_000_000), y: Math.round(velocityKmPerSecond.y * 1_000_000), z: Math.round(velocityKmPerSecond.z * 1_000_000)
});

/** Live composition boundary for the fixed Earth-origin Tier 0 ship. */
export const createTier0AuthoritativeSimLoop = (
  stream: SimulationStream,
  store: SimulationEventStore,
  epochUtDaysSinceJ2000: UtDaysSinceJ2000
): Promise<AuthoritativeSimLoop> => AuthoritativeSimLoop.create({
  stream,
  store,
  departureStateAt: (time): DepartureState => {
    const earth = ephemeridesAt(epochUtDaysSinceJ2000, time).earth;
    return { departureAtMs: time, positionMeters: positionMeters(earth.positionKm), velocityMmPerSecond: velocityMmPerSecond(earth.velocityKmPerSecond) };
  },
  destinationStateAt: (destination: DestinationBody, time) => {
    const states = ephemeridesAt(epochUtDaysSinceJ2000, time as SimTimeMs);
    return {
      positionMeters: positionMeters(states[destination].positionKm),
      velocityMmPerSecond: velocityMmPerSecond(states[destination].velocityKmPerSecond)
    };
  }
});
