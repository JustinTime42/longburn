import { DeltaT_JplHorizons, SetDeltaTFunction } from "astronomy-engine";
import { afterEach, describe, expect, it, vi } from "vitest";

import earthFixture from "../../test/fixtures/ephemerides/horizons/earth.json" with { type: "json" };
import marsFixture from "../../test/fixtures/ephemerides/horizons/mars.json" with { type: "json" };
import moonFixture from "../../test/fixtures/ephemerides/horizons/moon.json" with { type: "json" };
import sunFixture from "../../test/fixtures/ephemerides/horizons/sun.json" with { type: "json" };

import { simTimeMs } from "./clock.js";
import {
  ephemeridesAt,
  horizonsTdbJulianDayToUtDays,
  simTimeToUtDays,
  utDaysSinceJ2000,
  type HeliocentricState,
  type Tier0Ephemerides,
  type Vector3Km
} from "./ephemerides.js";

const epoch = utDaysSinceJ2000(9_131.5); // 2025-01-01T00:00:00Z, UT.

const fixtureBodies = ["sun", "earth", "moon", "mars"] as const;
type FixtureBody = (typeof fixtureBodies)[number];
const rawFixtures: Readonly<Record<FixtureBody, { readonly result: string }>> = {
  sun: sunFixture,
  earth: earthFixture,
  moon: moonFixture,
  mars: marsFixture
};

interface HorizonsSample {
  readonly tdbJulianDay: number;
  readonly positionKm: Vector3Km;
  readonly velocityKmPerSecond: Vector3Km;
}

const vectorRow =
  /^([0-9.]+) = .*\n X =\s*([+-]?[0-9.E+-]+) Y =\s*([+-]?[0-9.E+-]+) Z =\s*([+-]?[0-9.E+-]+)\n VX=\s*([+-]?[0-9.E+-]+) VY=\s*([+-]?[0-9.E+-]+) VZ=\s*([+-]?[0-9.E+-]+)/gm;

const parseHorizonsSamples = (body: FixtureBody): readonly HorizonsSample[] => {
  const fixture = rawFixtures[body];

  const samples = Array.from(fixture.result.matchAll(vectorRow), (match): HorizonsSample => ({
    tdbJulianDay: Number(match[1]),
    positionKm: { x: Number(match[2]), y: Number(match[3]), z: Number(match[4]) },
    velocityKmPerSecond: { x: Number(match[5]), y: Number(match[6]), z: Number(match[7]) }
  }));

  if (samples.length === 0) {
    throw new Error(`${body} Horizons fixture contained no VECTORS rows.`);
  }

  return samples;
};

const fixtureSamples: Readonly<Record<FixtureBody, readonly HorizonsSample[]>> = Object.fromEntries(
  fixtureBodies.map((body) => [body, parseHorizonsSamples(body)])
) as Record<FixtureBody, readonly HorizonsSample[]>;

const magnitudeOfDifference = (left: Vector3Km, right: Vector3Km): number =>
  Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);

const stateForBody = (states: Tier0Ephemerides, body: FixtureBody): HeliocentricState => states[body];

const positionErrorLimitsKm: Readonly<Record<FixtureBody, number>> = {
  // Observed maxima across the raw 2026-01-01 through 2027-04-26 fixtures:
  // Sun 0 km, Earth 1645.535 km, Moon 1652.148 km, Mars 4404.987 km.
  sun: 0,
  earth: 1_700,
  moon: 1_700,
  mars: 4_500
};

// These are the patched-conic scales used to enforce the validation decision.
// The Sun's heliocentric state is identically zero, so it has no relevant SOI
// limit at this adapter boundary.
const SPHERE_OF_INFLUENCE_KM = {
  earth: 924_000,
  moon: 66_000,
  mars: 577_000
} as const;

const velocityErrorLimitsKmPerSecond: Readonly<Record<FixtureBody, number>> = {
  // Observed maxima across the same rows: Sun 0, Earth 0.001502,
  // Moon 0.001515, Mars 0.000939 km/s.
  sun: 0,
  earth: 0.0016,
  moon: 0.0016,
  mars: 0.001
};

const observedMaximumErrors: Readonly<
  Record<FixtureBody, { readonly positionKm: number; readonly velocityKmPerSecond: number }>
> = {
  sun: { positionKm: 0, velocityKmPerSecond: 0 },
  earth: { positionKm: 1_645.534_789, velocityKmPerSecond: 0.001_501_137 },
  moon: { positionKm: 1_652.147_992, velocityKmPerSecond: 0.001_514_09 },
  mars: { positionKm: 4_404.986_594, velocityKmPerSecond: 0.000_938_804 }
};

const observedMaximumGeocentricLunarError = {
  positionKm: 13.946,
  velocityKmPerSecond: 0.000_051_9
} as const;

const geocentricLunarPositionErrorLimitKm = 15;

afterEach(() => {
  // SetDeltaTFunction is process-global. Leave the provider in this adapter's
  // documented convention after any test deliberately poisons it.
  SetDeltaTFunction(DeltaT_JplHorizons);
});

describe("Tier 0 ephemerides", () => {
  it("maps virtual sim milliseconds to an explicit UT input", () => {
    expect(simTimeToUtDays(epoch, simTimeMs(86_400_000))).toBe(9_132.5);
    expect(() => utDaysSinceJ2000(Number.NaN)).toThrow(RangeError);
  });

  it("converts each raw Horizons TDB epoch to the documented UT adapter input", () => {
    const sample = fixtureSamples.earth[0];
    expect(sample).toBeDefined();
    if (sample === undefined) {
      throw new Error("Earth fixture unexpectedly has no samples.");
    }

    // 2026-01-01T00:00 TDB, represented as a UT J2000 day count for MakeTime.
    expect(horizonsTdbJulianDayToUtDays(sample.tdbJulianDay)).toBeCloseTo(9_496.499_190, 3);
  });

  it("returns heliocentric EQJ states in kilometres and kilometres per second", () => {
    const states = ephemeridesAt(epoch, simTimeMs(0));

    expect(states.sun).toEqual({
      positionKm: { x: 0, y: 0, z: 0 },
      velocityKmPerSecond: { x: 0, y: 0, z: 0 }
    });
    expect(Math.hypot(states.earth.positionKm.x, states.earth.positionKm.y, states.earth.positionKm.z)).toBeGreaterThan(
      100_000_000
    );
    expect(Math.hypot(states.moon.velocityKmPerSecond.x, states.moon.velocityKmPerSecond.y, states.moon.velocityKmPerSecond.z)).toBeGreaterThan(
      10
    );
  });

  it("pins delta-T during a cold module initialization and is stable across warmed call histories", async () => {
    const instant = simTimeMs(2_592_000_000);
    SetDeltaTFunction(() => 0);
    vi.resetModules();
    const coldAdapter = await import("./ephemerides.js");
    const {
      AstroTime: coldAstroTime,
      DeltaT_JplHorizons: coldDeltaT_JplHorizons,
      SetDeltaTFunction: setColdDeltaTFunction
    } = await import("astronomy-engine");

    try {
      // This direct conversion runs after module initialization but before any
      // adapter lookup. It proves initialization reset the process-global hook.
      expect(coldAstroTime.FromTerrestrialTime(9_496.5).ut).toBeCloseTo(9_496.499_190, 3);

      const cold = JSON.stringify(coldAdapter.ephemeridesAt(epoch, instant));

      coldAdapter.ephemeridesAt(epoch, simTimeMs(0));
      coldAdapter.ephemeridesAt(epoch, simTimeMs(86_400_000));
      setColdDeltaTFunction(() => 0);

      const afterInterleaving = JSON.stringify(coldAdapter.ephemeridesAt(epoch, instant));

      expect(afterInterleaving).toBe(cold);
    } finally {
      setColdDeltaTFunction(coldDeltaT_JplHorizons);
    }
  });

  it("matches every raw Horizons VECTORS fixture inside observed-data-derived limits", () => {
    for (const body of ["earth", "mars"] as const) {
      expect(positionErrorLimitsKm[body], `${body} position limit must stay below 2% of SOI`).toBeLessThan(
        0.02 * SPHERE_OF_INFLUENCE_KM[body]
      );
    }

    for (const body of fixtureBodies) {
      let maximumPositionErrorKm = 0;
      let maximumVelocityErrorKmPerSecond = 0;

      for (const sample of fixtureSamples[body]) {
        const states = ephemeridesAt(horizonsTdbJulianDayToUtDays(sample.tdbJulianDay), simTimeMs(0));
        const actual = stateForBody(states, body);
        maximumPositionErrorKm = Math.max(
          maximumPositionErrorKm,
          magnitudeOfDifference(actual.positionKm, sample.positionKm)
        );
        maximumVelocityErrorKmPerSecond = Math.max(
          maximumVelocityErrorKmPerSecond,
          magnitudeOfDifference(actual.velocityKmPerSecond, sample.velocityKmPerSecond)
        );
      }

      expect(maximumPositionErrorKm, `${body} maximum position error (km)`).toBeLessThanOrEqual(
        positionErrorLimitsKm[body]
      );
      expect(maximumVelocityErrorKmPerSecond, `${body} maximum velocity error (km/s)`).toBeLessThanOrEqual(
        velocityErrorLimitsKmPerSecond[body]
      );
      expect(maximumPositionErrorKm, `${body} recorded maximum position error (km)`).toBeCloseTo(
        observedMaximumErrors[body].positionKm,
        3
      );
      expect(maximumVelocityErrorKmPerSecond, `${body} recorded maximum velocity error (km/s)`).toBeCloseTo(
        observedMaximumErrors[body].velocityKmPerSecond,
        9
      );
    }
  });

  it("pins the lunar extremes and solar-conjunction sample found in the fixture data", () => {
    const earth = fixtureSamples.earth;
    const moon = fixtureSamples.moon;
    const mars = fixtureSamples.mars;
    let perigee = { index: 0, distanceKm: Number.POSITIVE_INFINITY };
    let apogee = { index: 0, distanceKm: 0 };
    let conjunction = { index: 0, separationDegrees: 0 };
    let maximumGeocentricLunarPositionErrorKm = 0;
    let maximumGeocentricLunarVelocityErrorKmPerSecond = 0;

    expect(earth).toHaveLength(97);
    expect(moon).toHaveLength(97);
    expect(mars).toHaveLength(97);

    for (let index = 0; index < earth.length; index += 1) {
      const earthSample = earth[index];
      const moonSample = moon[index];
      const marsSample = mars[index];
      if (earthSample === undefined || moonSample === undefined || marsSample === undefined) {
        throw new Error("Horizons body fixtures must contain aligned epochs.");
      }

      const lunarDistanceKm = magnitudeOfDifference(moonSample.positionKm, earthSample.positionKm);
      if (lunarDistanceKm < perigee.distanceKm) perigee = { index, distanceKm: lunarDistanceKm };
      if (lunarDistanceKm > apogee.distanceKm) apogee = { index, distanceKm: lunarDistanceKm };

      const dot =
        earthSample.positionKm.x * marsSample.positionKm.x +
        earthSample.positionKm.y * marsSample.positionKm.y +
        earthSample.positionKm.z * marsSample.positionKm.z;
      const separationDegrees =
        (Math.acos(dot / (Math.hypot(...Object.values(earthSample.positionKm)) * Math.hypot(...Object.values(marsSample.positionKm)))) *
          180) /
        Math.PI;
      if (separationDegrees > conjunction.separationDegrees) conjunction = { index, separationDegrees };

      const actualStates = ephemeridesAt(horizonsTdbJulianDayToUtDays(earthSample.tdbJulianDay), simTimeMs(0));
      maximumGeocentricLunarPositionErrorKm = Math.max(
        maximumGeocentricLunarPositionErrorKm,
        magnitudeOfDifference(
          {
            x: actualStates.moon.positionKm.x - actualStates.earth.positionKm.x,
            y: actualStates.moon.positionKm.y - actualStates.earth.positionKm.y,
            z: actualStates.moon.positionKm.z - actualStates.earth.positionKm.z
          },
          {
            x: moonSample.positionKm.x - earthSample.positionKm.x,
            y: moonSample.positionKm.y - earthSample.positionKm.y,
            z: moonSample.positionKm.z - earthSample.positionKm.z
          }
        )
      );
      maximumGeocentricLunarVelocityErrorKmPerSecond = Math.max(
        maximumGeocentricLunarVelocityErrorKmPerSecond,
        magnitudeOfDifference(
          {
            x: actualStates.moon.velocityKmPerSecond.x - actualStates.earth.velocityKmPerSecond.x,
            y: actualStates.moon.velocityKmPerSecond.y - actualStates.earth.velocityKmPerSecond.y,
            z: actualStates.moon.velocityKmPerSecond.z - actualStates.earth.velocityKmPerSecond.z
          },
          {
            x: moonSample.velocityKmPerSecond.x - earthSample.velocityKmPerSecond.x,
            y: moonSample.velocityKmPerSecond.y - earthSample.velocityKmPerSecond.y,
            z: moonSample.velocityKmPerSecond.z - earthSample.velocityKmPerSecond.z
          }
        )
      );
    }

    expect(earth[perigee.index]?.tdbJulianDay).toBe(2_461_206.5);
    expect(perigee.distanceKm).toBeCloseTo(357_197.239_948, 3);
    expect(earth[apogee.index]?.tdbJulianDay).toBe(2_461_386.5);
    expect(apogee.distanceKm).toBeCloseTo(406_215.945_938, 3);
    // The sampled 2026 Mars solar-conjunction window has the largest
    // heliocentric Earth-Mars angular separation (not the 2027 opposition).
    expect(earth[conjunction.index]?.tdbJulianDay).toBe(2_461_051.5);
    expect(conjunction.separationDegrees).toBeCloseTo(178.275_711_835, 3);
    expect(maximumGeocentricLunarPositionErrorKm).toBeCloseTo(observedMaximumGeocentricLunarError.positionKm, 3);
    expect(geocentricLunarPositionErrorLimitKm, "geocentric lunar position limit must stay below 2% of SOI").toBeLessThan(
      0.02 * SPHERE_OF_INFLUENCE_KM.moon
    );
    expect(maximumGeocentricLunarPositionErrorKm).toBeLessThanOrEqual(geocentricLunarPositionErrorLimitKm);
    expect(maximumGeocentricLunarVelocityErrorKmPerSecond).toBeCloseTo(
      observedMaximumGeocentricLunarError.velocityKmPerSecond,
      7
    );
  });
});
