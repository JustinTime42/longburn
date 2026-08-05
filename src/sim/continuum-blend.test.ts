import { describe, expect, it } from "vitest";

import {
  FLATSPACE_ETA_UPPER_BOUND,
  LAMBERT_ETA_LOWER_BOUND,
  continuumRegimeForEta,
  flatspaceKappa,
  gravityLoadingParameter,
  solveContinuumLeg
} from "./continuum-blend.js";
import { solveLambertIzzo } from "./lambert.js";

const AU_METERS = 149_597_870_700;
const AU_KM = AU_METERS / 1_000;
const SECONDS_PER_DAY = 86_400;
const SUN_MU_KM3_PER_SECOND2 = 132_712_440_018;

const magnitude = (vector: { readonly x: number; readonly y: number; readonly z: number }): number => Math.hypot(vector.x, vector.y, vector.z);
const difference = (left: { readonly x: number; readonly y: number; readonly z: number }, right: { readonly x: number; readonly y: number; readonly z: number }) => ({ x: left.x - right.x, y: left.y - right.y, z: left.z - right.z });

const stationaryRequest = (accelerationMetersPerSecondSquared: number, durationSeconds = 100_000) => ({
  accelerationMetersPerSecondSquared,
  durationSeconds,
  departurePositionMeters: { x: AU_METERS, y: 0, z: 0 },
  departureVelocityMetersPerSecond: { x: 0, y: 0, z: 0 },
  arrivalPositionMeters: { x: AU_METERS + 1_000_000, y: 0, z: 0 },
  arrivalVelocityMetersPerSecond: { x: 0, y: 0, z: 0 }
});

describe("torch-to-Hohmann continuum", () => {
  it("uses the stipulated eta boundaries per leg", () => {
    expect(continuumRegimeForEta(FLATSPACE_ETA_UPPER_BOUND - Number.EPSILON)).toBe("flatspace");
    expect(continuumRegimeForEta(FLATSPACE_ETA_UPPER_BOUND)).toBe("lambert-kappa");
    expect(continuumRegimeForEta(LAMBERT_ETA_LOWER_BOUND)).toBe("lambert-kappa");
    expect(continuumRegimeForEta(LAMBERT_ETA_LOWER_BOUND + Number.EPSILON)).toBe("lambert");
  });

  it("takes kappa to one for impulsive acceleration and long coast", () => {
    const impulsive = flatspaceKappa(stationaryRequest(1e12));
    expect(impulsive.kind).toBe("feasible");
    if (impulsive.kind === "feasible") expect(impulsive.kappa).toBeCloseTo(1, 10);

    const longCoast = flatspaceKappa(stationaryRequest(1, 10_000_000));
    expect(longCoast.kind).toBe("feasible");
    if (longCoast.kind === "feasible") expect(longCoast.kappa).toBeCloseTo(1, 4);
  });

  it("uses flat-space below the first switch, kappa in the transition, and Lambert above it", () => {
    const request = stationaryRequest(1);
    const chord = 1_000_000;
    const duration = request.durationSeconds;
    const radiusForEta = (eta: number) => Math.sqrt((132_712_440_018_000_000_000_000 * duration ** 2) / (2 * chord * eta));
    const flat = solveContinuumLeg({ lambertDeltaVMetersPerSecond: 10, flatspaceRequest: request, solarRadiusMeters: radiusForEta(0.1) });
    expect(flat).toMatchObject({ kind: "feasible", regime: "flatspace" });
    const transition = solveContinuumLeg({ lambertDeltaVMetersPerSecond: 10, flatspaceRequest: request, solarRadiusMeters: radiusForEta(0.3) });
    expect(transition).toMatchObject({ kind: "feasible", regime: "lambert-kappa" });
    if (transition.kind === "feasible") expect(transition.heliocentricDeltaVMetersPerSecond).toBeCloseTo(10 * transition.kappa, 12);
    const conic = solveContinuumLeg({ lambertDeltaVMetersPerSecond: 10, flatspaceRequest: request, solarRadiusMeters: radiusForEta(0.6) });
    expect(conic).toEqual(expect.objectContaining({ kind: "feasible", regime: "lambert", kappa: 1, heliocentricDeltaVMetersPerSecond: 10 }));
  });

  it("has no jump at either regime boundary for a near-impulsive leg", () => {
    const request = stationaryRequest(1e12);
    const chord = 1_000_000;
    const radiusForEta = (eta: number) => Math.sqrt((132_712_440_018_000_000_000_000 * request.durationSeconds ** 2) / (2 * chord * eta));
    for (const eta of [FLATSPACE_ETA_UPPER_BOUND, LAMBERT_ETA_LOWER_BOUND]) {
      const below = solveContinuumLeg({ lambertDeltaVMetersPerSecond: 20, flatspaceRequest: request, solarRadiusMeters: radiusForEta(eta - 1e-9) });
      const at = solveContinuumLeg({ lambertDeltaVMetersPerSecond: 20, flatspaceRequest: request, solarRadiusMeters: radiusForEta(eta) });
      const above = solveContinuumLeg({ lambertDeltaVMetersPerSecond: 20, flatspaceRequest: request, solarRadiusMeters: radiusForEta(eta + 1e-9) });
      expect(below.kind).toBe("feasible"); expect(at.kind).toBe("feasible"); expect(above.kind).toBe("feasible");
      if (below.kind === "feasible" && at.kind === "feasible" && above.kind === "feasible") {
        expect(Math.max(below.heliocentricDeltaVMetersPerSecond, at.heliocentricDeltaVMetersPerSecond, above.heliocentricDeltaVMetersPerSecond) - Math.min(below.heliocentricDeltaVMetersPerSecond, at.heliocentricDeltaVMetersPerSecond, above.heliocentricDeltaVMetersPerSecond)).toBeLessThan(1e-7);
      }
    }
  });

  it("reproduces the circular-coplanar Hohmann C3 and arrival v-infinity fixture", () => {
    const earthRadiusKm = AU_KM;
    const marsRadiusKm = 1.524 * AU_KM;
    const durationSeconds = 258.87 * SECONDS_PER_DAY;
    const departurePhase = 44.34 * Math.PI / 180;
    const earth = { x: earthRadiusKm, y: 0, z: 0 };
    const marsAngularRate = Math.sqrt(SUN_MU_KM3_PER_SECOND2 / marsRadiusKm ** 3);
    const arrivalPhase = departurePhase + marsAngularRate * durationSeconds;
    const mars = { x: marsRadiusKm * Math.cos(arrivalPhase), y: marsRadiusKm * Math.sin(arrivalPhase), z: 0 };
    const earthVelocity = { x: 0, y: Math.sqrt(SUN_MU_KM3_PER_SECOND2 / earthRadiusKm), z: 0 };
    const marsSpeed = Math.sqrt(SUN_MU_KM3_PER_SECOND2 / marsRadiusKm);
    const marsVelocity = { x: -marsSpeed * Math.sin(arrivalPhase), y: marsSpeed * Math.cos(arrivalPhase), z: 0 };
    const lambert = solveLambertIzzo(SUN_MU_KM3_PER_SECOND2, earth, mars, durationSeconds);
    const departureVInfinity = magnitude(difference(lambert.departureVelocityKmPerSecond, earthVelocity));
    const arrivalVInfinity = magnitude(difference(lambert.arrivalVelocityKmPerSecond, marsVelocity));
    // The committed phase and TOF are rounded to 0.01°, 0.01 d respectively.
    expect(departureVInfinity ** 2).toBeCloseTo(8.671, 1);
    expect(arrivalVInfinity).toBeCloseTo(2.649, 1);
    expect(gravityLoadingParameter(AU_METERS, durationSeconds, magnitude(difference({ x: mars.x * 1_000, y: mars.y * 1_000, z: 0 }, { x: earth.x * 1_000, y: earth.y * 1_000, z: 0 })))).toBeGreaterThan(LAMBERT_ETA_LOWER_BOUND);
  });
});
