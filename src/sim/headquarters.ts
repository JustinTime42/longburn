import type { PositionMeters } from "./causality.js";

/**
 * PLACEHOLDER: this is the heliocentric-frame origin (the Sun), not Earth.
 * It must be replaced with Earth-at-epoch when command transport is wired to
 * the ephemerides frame. Relocation remains a deliberately future-tier concern.
 */
export const T0_EARTH_HQ_POSITION_METERS: PositionMeters = Object.freeze({ x: 0, y: 0, z: 0 });
