import { describe, expect, it } from "vitest";

import { conicElements, isNearParabolic, KEPLER_REFINEMENT_ITERATIONS, KEPLER_RESIDUAL_RELATIVE_TOLERANCE, KeplerPropagationConvergenceError, propagateKepler, stateFromConicElements, stumpffC2C3, type KeplerState } from "./kepler.js";

const EARTH_MU = 398_600.4418;
const SUN_MU = 132_712_440_018;

const magnitude = (value: { readonly x: number; readonly y: number; readonly z: number }): number => Math.sqrt(value.x * value.x + value.y * value.y + value.z * value.z);
const difference = (left: { readonly x: number; readonly y: number; readonly z: number }, right: { readonly x: number; readonly y: number; readonly z: number }) => magnitude({ x: left.x - right.x, y: left.y - right.y, z: left.z - right.z });
const stateAtPeriapsis = (eccentricity: number): KeplerState => {
  const periapsisKm = 7_000;
  const semiMajorAxisKm = periapsisKm / (1 - eccentricity);
  return stateFromConicElements(EARTH_MU, { semiMajorAxisKm, semiLatusRectumKm: periapsisKm * (1 + eccentricity), eccentricity, inclinationRadians: 0, longitudeOfAscendingNodeRadians: 0, argumentOfPeriapsisRadians: 0, trueAnomalyRadians: 0 });
};

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
    expect(KEPLER_REFINEMENT_ITERATIONS).toBe(200);
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

  it("preserves orbital invariants across the near-parabolic propagator cases that once silently failed", () => {
    // Research §4's propagator oracle failures must be distinguished from a
    // Lambert failure by this module's own invariant checks.
    for (const eccentricity of [0.995, 0.9968, 0.999, 0.99975]) {
      const periapsisKm = 7_000;
      const semiMajorAxisKm = periapsisKm / (1 - eccentricity);
      const state = stateFromConicElements(EARTH_MU, { semiMajorAxisKm, semiLatusRectumKm: periapsisKm * (1 + eccentricity), eccentricity, inclinationRadians: 0, longitudeOfAscendingNodeRadians: 0, argumentOfPeriapsisRadians: 0, trueAnomalyRadians: 0 });
      const initialElements = conicElements(EARTH_MU, state);
      for (const elapsedSeconds of [1_000_000, 2_000_000, 10_000_000]) {
        const propagated = propagateKepler(EARTH_MU, state, elapsedSeconds);
        const result = conicElements(EARTH_MU, propagated);
        expect(result.semiMajorAxisKm / initialElements.semiMajorAxisKm - 1).toBeCloseTo(0, 11);
        expect(result.eccentricity - initialElements.eccentricity).toBeCloseTo(0, 13);
        expect(result.semiLatusRectumKm / initialElements.semiLatusRectumKm - 1).toBeCloseTo(0, 11);
      }
    }
  });

  it("keeps near-parabolic labelling diagnostic-only", () => {
    expect(isNearParabolic({ eccentricity: 0.999 })).toBe(true);
    expect(isNearParabolic({ eccentricity: 0.9968 })).toBe(false);
  });

  it("refuses a stagnated extreme-eccentricity propagation at the pinned residual tolerance", () => {
    expect(KEPLER_RESIDUAL_RELATIVE_TOLERANCE).toBe(1e-11);
    expect(() => propagateKepler(EARTH_MU, stateAtPeriapsis(0.99999), 100_000_000)).toThrow(KeplerPropagationConvergenceError);
  });

  it("accepts the adjacent extreme-eccentricity case when it remains on-orbit", () => {
    const initial = stateAtPeriapsis(0.9999999);
    const initialElements = conicElements(EARTH_MU, initial);
    let propagated: KeplerState | undefined;
    expect(() => {
      propagated = propagateKepler(EARTH_MU, initial, 1_000_000_000);
    }).not.toThrow();
    if (propagated === undefined) throw new Error("Expected accepted propagation to produce a state.");
    const result = conicElements(EARTH_MU, propagated);
    expect(Math.abs(result.eccentricity - initialElements.eccentricity)).toBeLessThanOrEqual(1e-14);
  });

  it("round-trips retrograde equatorial eccentric states", () => {
    const elements = { semiMajorAxisKm: 20_000, semiLatusRectumKm: 20_000 * (1 - 0.5 ** 2), eccentricity: 0.5, inclinationRadians: Math.PI, longitudeOfAscendingNodeRadians: 0, argumentOfPeriapsisRadians: 1, trueAnomalyRadians: 0.4 };
    const initial = stateFromConicElements(EARTH_MU, elements);
    const reconstructed = stateFromConicElements(EARTH_MU, conicElements(EARTH_MU, initial));
    expect(difference(reconstructed.positionKm, initial.positionKm)).toBeLessThan(1e-8);
    expect(difference(reconstructed.velocityKmPerSecond, initial.velocityKmPerSecond)).toBeLessThan(1e-11);
  });

  it("classifies near-parabolic heliocentric elements relative to the current radius", () => {
    const periapsisKm = 149_597_870.7;
    const eccentricity = 0.9999;
    const semiMajorAxisKm = periapsisKm / (1 - eccentricity);
    const state = stateFromConicElements(SUN_MU, {
      semiMajorAxisKm,
      semiLatusRectumKm: periapsisKm * (1 + eccentricity),
      eccentricity,
      inclinationRadians: 0,
      longitudeOfAscendingNodeRadians: 0,
      argumentOfPeriapsisRadians: 0,
      trueAnomalyRadians: 0
    });

    const recovered = conicElements(SUN_MU, state).semiMajorAxisKm;
    expect(Number.isFinite(recovered)).toBe(true);
    expect(recovered).toBeGreaterThan(1e12);
  });

  it("uses angular-momentum-relative equatorial conventions at heliocentric scale", () => {
    const radiusKm = 149_597_870.7;
    const state = stateFromConicElements(SUN_MU, {
      semiMajorAxisKm: radiusKm,
      semiLatusRectumKm: radiusKm,
      eccentricity: 0,
      inclinationRadians: 1e-11,
      longitudeOfAscendingNodeRadians: 0.8,
      argumentOfPeriapsisRadians: 0,
      trueAnomalyRadians: 0.4
    });

    expect(conicElements(SUN_MU, state).longitudeOfAscendingNodeRadians).toBe(0);
  });

  it("matches Vallado Example 2-4 after 2,400 seconds", () => {
    const initial: KeplerState = { positionKm: { x: 1_131.340, y: -2_282.343, z: 6_672.423 }, velocityKmPerSecond: { x: -5.64305, y: 4.30333, z: 2.42879 } };
    const propagated = propagateKepler(EARTH_MU, initial, 2_400);
    expect(propagated.positionKm.x).toBeCloseTo(-4_219.7527, 4);
    expect(propagated.positionKm.y).toBeCloseTo(4_363.0292, 4);
    expect(propagated.positionKm.z).toBeCloseTo(-3_958.7666, 4);
    expect(propagated.velocityKmPerSecond.x).toBeCloseTo(3.689866, 6);
    expect(propagated.velocityKmPerSecond.y).toBeCloseTo(-1.916735, 6);
    expect(propagated.velocityKmPerSecond.z).toBeCloseTo(-6.112511, 6);
  });
});
