import { describe, expect, it } from "vitest";

import {
  FINITE_BURN_CAUTION_DUTY_CYCLE,
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
  it("takes kappa to one for impulsive acceleration and long coast", () => {
    const impulsive = flatspaceKappa(stationaryRequest(1e12));
    expect(impulsive.kind).toBe("feasible");
    if (impulsive.kind === "feasible") expect(impulsive.kappa).toBeCloseTo(1, 10);

    const longCoast = flatspaceKappa(stationaryRequest(1, 10_000_000));
    expect(longCoast.kind).toBe("feasible");
    if (longCoast.kind === "feasible") expect(longCoast.kappa).toBeCloseTo(1, 4);
  });

  it("quotes Lambert times kappa at low, transition, and high eta", () => {
    const request = stationaryRequest(1);
    const chord = 1_000_000;
    const duration = request.durationSeconds;
    const radiusForEta = (eta: number) => Math.sqrt((132_712_440_018_000_000_000_000 * duration ** 2) / (2 * chord * eta));
    for (const eta of [0.1, 0.3, 0.6]) {
      const result = solveContinuumLeg({ lambertDeltaVMetersPerSecond: 10, flatspaceRequest: request, solarRadiusMeters: radiusForEta(eta) });
      expect(result.kind).toBe("feasible");
      if (result.kind === "feasible") {
        expect(result.eta).toBeCloseTo(eta, 12);
        expect(result.heliocentricDeltaVMetersPerSecond).toBeCloseTo(10 * result.kappa, 12);
        expect(result.dutyCycle).toBeCloseTo(result.heliocentricDeltaVMetersPerSecond / (request.accelerationMetersPerSecondSquared * duration), 12);
        expect(result.finiteBurnCaution).toBe(false);
      }
    }
  });

  it("has no step anywhere on an independently costed Lambert curve", () => {
    const durationSeconds = 100_000;
    const request = stationaryRequest(10_000, durationSeconds);
    const chord = 1_000_000;
    const radiusForEta = (eta: number) => Math.sqrt((132_712_440_018_000_000_000_000 * durationSeconds ** 2) / (2 * chord * eta));
    const departure = { x: AU_KM, y: 0, z: 0 };
    const departureVelocity = { x: 0, y: Math.sqrt(SUN_MU_KM3_PER_SECOND2 / AU_KM), z: 0 };
    const samples = Array.from({ length: 41 }, (_, index) => {
      const arrivalAngle = 0.1 + index * 0.0001;
      const arrival = { x: 1.01 * AU_KM * Math.cos(arrivalAngle), y: 1.01 * AU_KM * Math.sin(arrivalAngle), z: 0 };
      const lambert = solveLambertIzzo(SUN_MU_KM3_PER_SECOND2, departure, arrival, durationSeconds);
      const lambertCost = magnitude(difference(lambert.departureVelocityKmPerSecond, departureVelocity)) * 1_000;
      const result = solveContinuumLeg({
        lambertDeltaVMetersPerSecond: lambertCost,
        flatspaceRequest: request,
        solarRadiusMeters: radiusForEta(0.1 + index * 0.02)
      });
      expect(result.kind).toBe("feasible");
      if (result.kind !== "feasible") throw new Error("Expected a feasible continuum sample.");
      return result.heliocentricDeltaVMetersPerSecond;
    });
    const largestStep = Math.max(...samples.slice(1).map((sample, index) => Math.abs(sample - samples[index]!)));
    // The retired eta switch produced a ~9% cliff (finite-thrust correction research §1);
    // independently computed Lambert costs may vary smoothly, but must remain below that bound.
    expect(largestStep / Math.max(...samples)).toBeLessThan(0.09);
  });

  it("returns caution and typed duty-cycle refusals from the quoted delta-v", () => {
    const request = stationaryRequest(1, 100_000);
    const correction = flatspaceKappa(request);
    expect(correction.kind).toBe("feasible");
    if (correction.kind !== "feasible") throw new Error("Expected a feasible correction.");
    const quotedLambertForDuty = (dutyCycle: number) =>
      dutyCycle * request.accelerationMetersPerSecondSquared * request.durationSeconds / correction.kappa;

    const cautious = solveContinuumLeg({ lambertDeltaVMetersPerSecond: quotedLambertForDuty(0.9), flatspaceRequest: request });
    expect(cautious).toMatchObject({ kind: "feasible", finiteBurnCaution: true });
    if (cautious.kind === "feasible") {
      expect(cautious.dutyCycle).toBeCloseTo(0.9, 12);
      expect(cautious.dutyCycle).toBeGreaterThan(FINITE_BURN_CAUTION_DUTY_CYCLE);
    }

    const refused = solveContinuumLeg({ lambertDeltaVMetersPerSecond: quotedLambertForDuty(1.01), flatspaceRequest: request });
    expect(refused).toMatchObject({ kind: "infeasible", reason: "duty-cycle-exceeded" });
    if (refused.kind === "infeasible" && refused.reason === "duty-cycle-exceeded") expect(refused.dutyCycle).toBeCloseTo(1.01, 12);
  });

  it("validates flat-space inputs even when eta would previously select pure Lambert", () => {
    const request = stationaryRequest(1);
    const invalidRequest = { ...request, arrivalVelocityMetersPerSecond: { x: Number.NaN, y: 0, z: 0 } };
    expect(() => solveContinuumLeg({ lambertDeltaVMetersPerSecond: 10, flatspaceRequest: invalidRequest })).toThrow("Arrival velocity must contain only finite values.");
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
    expect(gravityLoadingParameter(AU_METERS, durationSeconds, magnitude(difference({ x: mars.x * 1_000, y: mars.y * 1_000, z: 0 }, { x: earth.x * 1_000, y: earth.y * 1_000, z: 0 })))).toBeGreaterThan(0);
  });
});
