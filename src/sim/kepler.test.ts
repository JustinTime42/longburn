import { describe, expect, it } from "vitest";

import { conicElements, isNearParabolic, KEPLER_REFINEMENT_ITERATIONS, propagateKepler, stateFromConicElements, stumpffC2C3, type KeplerState } from "./kepler.js";

const EARTH_MU = 398_600.4418;

const magnitude = (value: { readonly x: number; readonly y: number; readonly z: number }): number => Math.sqrt(value.x * value.x + value.y * value.y + value.z * value.z);
const difference = (left: { readonly x: number; readonly y: number; readonly z: number }, right: { readonly x: number; readonly y: number; readonly z: number }) => magnitude({ x: left.x - right.x, y: left.y - right.y, z: left.z - right.z });

describe("kepler core", () => {
  it("uses Stumpff series at the removable singularity", () => {
    expect(stumpffC2C3(0)).toEqual({ c2: 0.5, c3: 1 / 6 });
    expect(stumpffC2C3(1e-8).c2).toBeCloseTo(0.5, 8);
    expect(stumpffC2C3(-1e-8).c3).toBeCloseTo(1 / 6, 8);
  });

  it("propagates a circular low-Earth orbit through a quarter period", () => {
    const radiusKm = 7_000;
    const state: KeplerState = { positionKm: { x: radiusKm, y: 0, z: 0 }, velocityKmPerSecond: { x: 0, y: Math.sqrt(EARTH_MU / radiusKm), z: 0 } };
    const quarterPeriodSeconds = (Math.PI / 2) * Math.sqrt(radiusKm ** 3 / EARTH_MU);
    const propagated = propagateKepler(EARTH_MU, state, quarterPeriodSeconds);
    expect(propagated.positionKm.x).toBeCloseTo(0, 7);
    expect(propagated.positionKm.y).toBeCloseTo(radiusKm, 7);
    expect(propagated.velocityKmPerSecond.x).toBeCloseTo(-Math.sqrt(EARTH_MU / radiusKm), 9);
    expect(propagated.velocityKmPerSecond.y).toBeCloseTo(0, 9);
    expect(KEPLER_REFINEMENT_ITERATIONS).toBe(35);
  });

  it("round-trips general three-dimensional elliptic elements", () => {
    const elements = { semiMajorAxisKm: 20_002.88492, semiLatusRectumKm: 20_002.88492 * (1 - 0.433487451 ** 2), eccentricity: 0.433487451, inclinationRadians: 0.7, longitudeOfAscendingNodeRadians: 1.1, argumentOfPeriapsisRadians: 2.2, trueAnomalyRadians: 0.9 };
    const initial = stateFromConicElements(EARTH_MU, elements);
    const recovered = conicElements(EARTH_MU, initial);
    const reconstructed = stateFromConicElements(EARTH_MU, recovered);
    expect(recovered.semiMajorAxisKm).toBeCloseTo(elements.semiMajorAxisKm, 8);
    expect(recovered.eccentricity).toBeCloseTo(elements.eccentricity, 12);
    expect(difference(reconstructed.positionKm, initial.positionKm)).toBeLessThan(1e-8);
    expect(difference(reconstructed.velocityKmPerSecond, initial.velocityKmPerSecond)).toBeLessThan(1e-11);
  });

  it("propagates forward then backward across an eccentric orbit", () => {
    const initial = stateFromConicElements(EARTH_MU, { semiMajorAxisKm: 26_560, semiLatusRectumKm: 26_560 * (1 - 0.72 ** 2), eccentricity: 0.72, inclinationRadians: 0.9, longitudeOfAscendingNodeRadians: 0.2, argumentOfPeriapsisRadians: 0.4, trueAnomalyRadians: 0.3 });
    const recovered = propagateKepler(EARTH_MU, propagateKepler(EARTH_MU, initial, 12_345), -12_345);
    expect(difference(recovered.positionKm, initial.positionKm)).toBeLessThan(1e-7);
    expect(difference(recovered.velocityKmPerSecond, initial.velocityKmPerSecond)).toBeLessThan(1e-10);
  });

  it("labels near-parabolic conditioning as propagator-local rather than a future Lambert failure", () => {
    // Research §4 observed universal-variable propagation degrading before the
    // Izzo solver near e=1. This fixture deliberately exercises only module A.
    const state = stateFromConicElements(EARTH_MU, { semiMajorAxisKm: 10_000_000, semiLatusRectumKm: 10_000_000 * (1 - 0.99975 ** 2), eccentricity: 0.99975, inclinationRadians: 0.4, longitudeOfAscendingNodeRadians: 0.2, argumentOfPeriapsisRadians: 1.1, trueAnomalyRadians: 0.01 });
    const elements = conicElements(EARTH_MU, state);
    expect(isNearParabolic(elements)).toBe(true);
    expect(() => propagateKepler(EARTH_MU, state, 86_400)).not.toThrow();
  });
});
