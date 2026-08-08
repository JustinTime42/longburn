import type { PositionMeters } from "./causality.js";
import type { SimTimeMs } from "./clock.js";
import { ephemeridesAt, type UtDaysSinceJ2000 } from "./ephemerides.js";

/**
 * HQ is fixed at Earth for Tier 0. The ephemerides adapter is consulted only
 * at this live boundary; the resulting position is persisted on the command.
 */
export const hqPositionAt = (epochUtDaysSinceJ2000: UtDaysSinceJ2000, time: SimTimeMs): PositionMeters => {
  const positionKm = ephemeridesAt(epochUtDaysSinceJ2000, time).earth.positionKm;
  return Object.freeze({ x: Math.round(positionKm.x * 1_000), y: Math.round(positionKm.y * 1_000), z: Math.round(positionKm.z * 1_000) });
};
