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
    if (impulsive.kind === "feasible") {
      // The measured unrounded value is 1 - 2^-52 on this fixture; the public
      // lower-bound invariant deliberately clamps that benign roundoff.
      expect(impulsive.kappa).toBe(1);
      expect(impulsive.impulsive.firstBurnDurationSeconds).toBeGreaterThan(0);
      expect(impulsive.impulsive.firstBurnDurationSeconds).toBeLessThan(1e-10);
    }

    const longCoast = flatspaceKappa(stationaryRequest(1, 10_000_000));
    expect(longCoast.kind).toBe("feasible");
    if (longCoast.kind === "feasible") expect(longCoast.kappa).toBeCloseTo(1, 4);
  });

  it("does not construct an overflowing limit solve at the maximum valid acceleration", () => {
    const result = flatspaceKappa(stationaryRequest(Number.MAX_VALUE));
    expect(result.kind).toBe("feasible");
    if (result.kind === "feasible") {
      expect(result.kappa).toBe(1);
      expect(result.impulsive).toBe(result.actual);
    }

    // The quotient comparison used to sit on this rounded overflow boundary.
    // Product finiteness, rather than a pre-multiplication threshold, must
    // retain the actual plan when the scaled value is not representable.
    const boundary = flatspaceKappa(stationaryRequest(Number.MAX_VALUE / 1_000_000));
    expect(boundary.kind).toBe("feasible");
    if (boundary.kind === "feasible") expect(boundary.impulsive).toBe(boundary.actual);
  });

  it("returns kappa one for a zero-delta-v coast instead of a false bound refusal", () => {
    const request = stationaryRequest(1);
    const result = flatspaceKappa({ ...request, arrivalPositionMeters: request.departurePositionMeters });
    expect(result).toMatchObject({ kind: "feasible", kappa: 1 });
    if (result.kind === "feasible") {
      expect(result.actual.totalDeltaVMetersPerSecond).toBe(0);
      expect(result.impulsive.totalDeltaVMetersPerSecond).toBe(0);
    }
  });

  it("pins kappa to the stationary closed form within the scaled-limit bias", () => {
    const acceleration = 1;
    const durationSeconds = 100_000;
    const distanceMeters = 1_000_000;
    const result = flatspaceKappa(stationaryRequest(acceleration, durationSeconds));
    expect(result.kind).toBe("feasible");
    if (result.kind !== "feasible") throw new Error("Expected a feasible correction.");

    const exact = acceleration * durationSeconds *
      (1 - Math.sqrt(1 - 4 * distanceMeters / (acceleration * durationSeconds ** 2))) *
      durationSeconds / (2 * distanceMeters);
    expect(result.kappa).toBeLessThanOrEqual(exact);
    expect(Math.abs(result.kappa / exact - 1)).toBeLessThan(1.1e-6);
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
        expect(result.quotedDutyCycle).toBeCloseTo(result.heliocentricDeltaVMetersPerSecond / (request.accelerationMetersPerSecondSquared * duration), 12);
        expect(result.finiteBurnCaution).toBe(false);
      }
    }
  });

  it("has no step anywhere on an independently costed Lambert curve", () => {
    const durationSeconds = 100_000;
    const departure = { x: AU_KM, y: 0, z: 0 };
    const departureVelocity = { x: 0, y: Math.sqrt(SUN_MU_KM3_PER_SECOND2 / AU_KM), z: 0 };
    const samples = Array.from({ length: 41 }, (_, index) => {
      const arrivalAngle = 0.1 + index * 0.0001;
      const arrival = { x: 1.01 * AU_KM * Math.cos(arrivalAngle), y: 1.01 * AU_KM * Math.sin(arrivalAngle), z: 0 };
      const arrivalVelocity = {
        x: -Math.sqrt(SUN_MU_KM3_PER_SECOND2 / (1.01 * AU_KM)) * Math.sin(arrivalAngle),
        y: Math.sqrt(SUN_MU_KM3_PER_SECOND2 / (1.01 * AU_KM)) * Math.cos(arrivalAngle),
        z: 0
      };
      // This is the same Earth-to-arrival leg used to price Lambert, not an
      // unrelated stationary 1,000 km hop. Its finite-burn correction must
      // therefore contribute materially to every sampled quote.
      const request = {
        accelerationMetersPerSecondSquared: 10,
        durationSeconds,
        departurePositionMeters: { x: departure.x * 1_000, y: departure.y * 1_000, z: 0 },
        departureVelocityMetersPerSecond: { x: departureVelocity.x * 1_000, y: departureVelocity.y * 1_000, z: 0 },
        arrivalPositionMeters: { x: arrival.x * 1_000, y: arrival.y * 1_000, z: 0 },
        arrivalVelocityMetersPerSecond: { x: arrivalVelocity.x * 1_000, y: arrivalVelocity.y * 1_000, z: 0 }
      };
      const chord = magnitude(difference(request.arrivalPositionMeters, request.departurePositionMeters));
      const radiusForEta = (eta: number) => Math.sqrt((132_712_440_018_000_000_000_000 * durationSeconds ** 2) / (2 * chord * eta));
      const lambert = solveLambertIzzo(SUN_MU_KM3_PER_SECOND2, departure, arrival, durationSeconds);
      const lambertCost = magnitude(difference(lambert.departureVelocityKmPerSecond, departureVelocity)) * 1_000;
      const result = solveContinuumLeg({
        lambertDeltaVMetersPerSecond: lambertCost,
        flatspaceRequest: request,
        solarRadiusMeters: radiusForEta(0.1 + index * 0.02)
      });
      expect(result.kind).toBe("feasible");
      if (result.kind !== "feasible") throw new Error("Expected a feasible continuum sample.");
      return { kappa: result.kappa, quote: result.heliocentricDeltaVMetersPerSecond };
    });
    expect(Math.min(...samples.map((sample) => sample.kappa))).toBeGreaterThan(1.01);
    const largestStep = Math.max(...samples.slice(1).map((sample, index) => Math.abs(sample.quote - samples[index]!.quote)));
    // The adjacent independently-computed Lambert samples vary smoothly at
    // roughly 1e-3 relative. A revived eta switch would create a ~9% cliff.
    expect(largestStep / Math.max(...samples.map((sample) => sample.quote))).toBeLessThan(0.002);
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
      expect(cautious.quotedDutyCycle).toBeCloseTo(0.9, 12);
      expect(cautious.quotedDutyCycle).toBeGreaterThan(FINITE_BURN_CAUTION_DUTY_CYCLE);
      expect(cautious.flatspacePlan.burnDutyCycle).not.toBeCloseTo(cautious.quotedDutyCycle, 2);
    }

    const refused = solveContinuumLeg({ lambertDeltaVMetersPerSecond: quotedLambertForDuty(1.01), flatspaceRequest: request });
    expect(refused).toMatchObject({ kind: "infeasible", reason: "duty-cycle-exceeded" });
    if (refused.kind === "infeasible" && refused.reason === "duty-cycle-exceeded") {
      expect(refused.quotedDutyCycle).toBeCloseTo(1.01, 12);
      expect(refused.flatspacePlan.burnDutyCycle).toBeGreaterThan(0);
    }
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
    expect(gravityLoadingParameter(AU_METERS, durationSeconds, magnitude(difference({ x: mars.x * 1_000, y: mars.y * 1_000, z: 0 }, { x: earth.x * 1_000, y: earth.y * 1_000, z: 0 })))).toBeCloseTo(3_928.321, 3);
  });
});
