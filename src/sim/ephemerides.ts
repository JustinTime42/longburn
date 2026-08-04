import {
  AstroTime,
  Body,
  DeltaT_JplHorizons,
  HelioState,
  KM_PER_AU,
  MakeTime,
  SetDeltaTFunction
} from "astronomy-engine";

import type { SimTimeMs } from "./clock.js";

const MILLISECONDS_PER_DAY = 86_400_000;
const SECONDS_PER_DAY = 86_400;

/** A Universal Time day count from J2000.0 (2000-01-01T12:00:00Z). */
export type UtDaysSinceJ2000 = number & { readonly __utDaysSinceJ2000: unique symbol };

/** A Cartesian vector in the heliocentric J2000 equatorial frame. */
export interface Vector3Km {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** A heliocentric J2000 state vector, in simulation units. */
export interface HeliocentricState {
  readonly positionKm: Vector3Km;
  readonly velocityKmPerSecond: Vector3Km;
}

export interface Tier0Ephemerides {
  readonly sun: HeliocentricState;
  readonly earth: HeliocentricState;
  readonly moon: HeliocentricState;
  readonly mars: HeliocentricState;
}

/**
 * Validates a UT day count at the adapter boundary. Astronomy Engine converts
 * this UT input to TT internally. Horizons fixtures use the matching TDB
 * instant and preserve the UT/TDB conversion alongside their source data.
 */
export const utDaysSinceJ2000 = (value: number): UtDaysSinceJ2000 => {
  if (!Number.isFinite(value)) {
    throw new RangeError("Ephemeris time must be a finite UT day count since J2000.");
  }

  return value as UtDaysSinceJ2000;
};

/** Maps the virtual simulation clock onto an explicitly selected UT epoch. */
export const simTimeToUtDays = (
  epochUtDaysSinceJ2000: UtDaysSinceJ2000,
  simTime: SimTimeMs
): UtDaysSinceJ2000 => utDaysSinceJ2000(epochUtDaysSinceJ2000 + simTime / MILLISECONDS_PER_DAY);

// The package's delta-T selector is process-global. Reset it before every
// provider call so another consumer cannot make this adapter history-dependent.
const tier0DeltaT = (ut: number): number => DeltaT_JplHorizons(ut);

const pinDeltaT = (): void => {
  SetDeltaTFunction(tier0DeltaT);
};

// Set the process-global provider convention as this module initializes. Each
// lookup repeats this because other consumers can still alter the global later.
pinDeltaT();

/**
 * Converts a Horizons TDB Julian day to the corresponding UT J2000-day input.
 *
 * Horizons VECTORS fixtures name their instant in TDB. For this Tier 0
 * comparison boundary, TDB is treated as TT (their periodic difference is at
 * most a couple of milliseconds), then Astronomy Engine's pinned JPL Horizons
 * delta-T model derives UT. Runtime callers continue to provide UT directly.
 */
export const horizonsTdbJulianDayToUtDays = (tdbJulianDay: number): UtDaysSinceJ2000 => {
  if (!Number.isFinite(tdbJulianDay)) {
    throw new RangeError("Horizons TDB Julian day must be finite.");
  }

  pinDeltaT();
  return utDaysSinceJ2000(AstroTime.FromTerrestrialTime(tdbJulianDay - 2_451_545).ut);
};

const vectorFromState = (state: ReturnType<typeof HelioState>): HeliocentricState => ({
  positionKm: {
    x: state.x * KM_PER_AU,
    y: state.y * KM_PER_AU,
    z: state.z * KM_PER_AU
  },
  velocityKmPerSecond: {
    x: (state.vx * KM_PER_AU) / SECONDS_PER_DAY,
    y: (state.vy * KM_PER_AU) / SECONDS_PER_DAY,
    z: (state.vz * KM_PER_AU) / SECONDS_PER_DAY
  }
});

const stateFor = (body: Body, utDays: UtDaysSinceJ2000): HeliocentricState => {
  pinDeltaT();
  return vectorFromState(HelioState(body, MakeTime(utDays)));
};

/**
 * Returns only heliocentric EQJ states for the Tier 0 bodies. This provider is
 * a pure function of the supplied virtual sim time and epoch; it never reads a
 * host clock. The Sun is intentionally the zero vector in this frame.
 */
export const ephemeridesAt = (
  epochUtDaysSinceJ2000: UtDaysSinceJ2000,
  simTime: SimTimeMs
): Tier0Ephemerides => {
  const utDays = simTimeToUtDays(epochUtDaysSinceJ2000, simTime);

  return {
    sun: stateFor(Body.Sun, utDays),
    earth: stateFor(Body.Earth, utDays),
    moon: stateFor(Body.Moon, utDays),
    mars: stateFor(Body.Mars, utDays)
  };
};
