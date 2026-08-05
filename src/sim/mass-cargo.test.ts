import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  assessCargo,
  burnDurationMs,
  BURN_DURATION_QUANTUM_MILLISECONDS,
  deltaVForBurn,
  dequantizeBurnParameters,
  massRatioForDeltaV,
  quantizeBurnParameters,
  TIER0_SHIP,
  viabilityWallDeltaV,
  type QuantizedBurnParameters
} from "./mass-cargo.js";

describe("mass and cargo", () => {
  it("uses the exact constant-acceleration burn relation", () => {
    expect(deltaVForBurn(0.009_806_65, 86_400)).toBeCloseTo(847.29456, 10);
    expect(() => deltaVForBurn(0, 1)).toThrow(RangeError);
  });

  it("matches the research mass-ratio table", () => {
    expect(massRatioForDeltaV(200, 100)).toBeCloseTo(7.389056, 5);
    expect(massRatioForDeltaV(600, 100)).toBeCloseTo(403.428793, 5);
    expect(massRatioForDeltaV(600, 300)).toBeCloseTo(7.389056, 5);
    expect(massRatioForDeltaV(1_750, 300)).toBeCloseTo(341.495, 2);
    expect(massRatioForDeltaV(1_750, 1_000)).toBeCloseTo(5.754603, 5);
    expect(massRatioForDeltaV(600, 1_000)).toBeCloseTo(1.822119, 5);
  });

  it("matches the research cargo table and makes payload failure typed", () => {
    const rows = [
      [100, 200, 0.085335, -0.014665],
      [100, 600, -0.047521, -0.147521],
      [300, 600, 0.085335, -0.014665],
      [300, 1_750, -0.047072, -0.147072],
      [1_000, 1_750, 0.123774, 0.023774],
      [1_000, 600, 0.498812, 0.398812]
    ] as const;
    for (const [exhaustVelocityKmPerSecond, deltaVKmPerSecond, lowStructureCargo, highStructureCargo] of rows) {
      const lowStructure = { ...TIER0_SHIP, exhaustVelocityKmPerSecond, structuralMassFraction: 0.05 };
      const highStructure = { ...lowStructure, structuralMassFraction: 0.15 };
      const lowStructureResult = assessCargo(deltaVKmPerSecond, lowStructure);
      const highStructureResult = assessCargo(deltaVKmPerSecond, highStructure);
      expect(lowStructureResult.cargoFraction).toBeCloseTo(lowStructureCargo, 5);
      expect(highStructureResult.cargoFraction).toBeCloseTo(highStructureCargo, 5);
      expect(lowStructureResult.kind).toBe(lowStructureCargo > 0 ? "viable" : "nonviable");
      expect(highStructureResult.kind).toBe(highStructureCargo > 0 ? "viable" : "nonviable");
      if (lowStructureResult.kind === "viable") expect(lowStructureResult.cargoFraction).toBeGreaterThan(0);
      else expect(lowStructureResult.cargoFraction).toBeLessThanOrEqual(0);
      if (highStructureResult.kind === "viable") expect(highStructureResult.cargoFraction).toBeGreaterThan(0);
      else expect(highStructureResult.cargoFraction).toBeLessThanOrEqual(0);
    }
  });

  it("places the 15% structural viability wall at 1.90 exhaust velocities", () => {
    const wall = viabilityWallDeltaV(TIER0_SHIP);
    expect(wall / TIER0_SHIP.exhaustVelocityKmPerSecond).toBeCloseTo(1.89712, 5);
    expect(assessCargo(wall, TIER0_SHIP).kind).toBe("nonviable");
    expect(assessCargo(wall - 0.000_001, TIER0_SHIP).kind).toBe("viable");
  });
});

describe("burn commitment quantization", () => {
  it("round-trips every duration commitment and derives a self-consistent delta-v and propellant triple", () => {
    fc.assert(fc.property(
      fc.record({
        burnDurationMs: fc.integer({ min: 0, max: 1_000_000_000 }).map(burnDurationMs)
      }),
      (committed: QuantizedBurnParameters) => {
        const burn = dequantizeBurnParameters(committed);
        const cargo = assessCargo(burn.deltaVKmPerSecond);
        expect(quantizeBurnParameters(burn)).toEqual(committed);
        expect(burn.deltaVKmPerSecond).toBe(deltaVForBurn(TIER0_SHIP.accelerationKmPerSecond2, burn.burnDurationSeconds));
        expect(cargo.massRatio).toBe(massRatioForDeltaV(burn.deltaVKmPerSecond, TIER0_SHIP.exhaustVelocityKmPerSecond));
        if (cargo.kind === "viable") expect(cargo.cargoFraction).toBeGreaterThan(0);
        else expect(cargo.cargoFraction).toBeLessThanOrEqual(0);
      }
    ));
  });

  it("uses the documented one-millisecond burn-duration quantum", () => {
    expect(BURN_DURATION_QUANTUM_MILLISECONDS).toBe(1);
    expect(quantizeBurnParameters({ burnDurationSeconds: 98.7654 })).toEqual({
      burnDurationMs: burnDurationMs(98_765)
    });
    expect(dequantizeBurnParameters({ burnDurationMs: burnDurationMs(1) })).toEqual({
      deltaVKmPerSecond: deltaVForBurn(TIER0_SHIP.accelerationKmPerSecond2, 0.001),
      burnDurationSeconds: 0.001
    });
  });
});
