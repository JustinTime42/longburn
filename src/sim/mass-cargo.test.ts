import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  assessCargo,
  BURN_DURATION_QUANTUM_SECONDS,
  DELTA_V_QUANTUM_KM_PER_SECOND,
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
    const  highStructure = { ...TIER0_SHIP, exhaustVelocityKmPerSecond: 100, structuralMassFraction: 0.15 };
    const lowStructure = { ...highStructure, structuralMassFraction: 0.05 };
    const viable = assessCargo(200, lowStructure);
    const nonviable = assessCargo(200, highStructure);
    const torchCargo = assessCargo(1_750, TIER0_SHIP);
    expect(viable.kind).toBe("viable");
    expect(viable.cargoFraction).toBeCloseTo(0.085335, 5);
    expect(nonviable.kind).toBe("nonviable");
    expect(nonviable.cargoFraction).toBeCloseTo(-0.014665, 5);
    expect(torchCargo.kind).toBe("viable");
    expect(torchCargo.cargoFraction).toBeCloseTo(0.023774, 5);
  });

  it("places the 15% structural viability wall at 1.90 exhaust velocities", () => {
    const wall = viabilityWallDeltaV(TIER0_SHIP);
    expect(wall / TIER0_SHIP.exhaustVelocityKmPerSecond).toBeCloseTo(1.89712, 5);
    expect(assessCargo(wall, TIER0_SHIP).kind).toBe("nonviable");
    expect(assessCargo(wall - DELTA_V_QUANTUM_KM_PER_SECOND, TIER0_SHIP).kind).toBe("viable");
  });
});

describe("burn commitment quantization", () => {
  it("round-trips every fixed-point commitment identity", () => {
    fc.assert(fc.property(
      fc.record({
        deltaVQuantum: fc.integer({ min: 0, max: 1_000_000_000 }),
        burnDurationQuantum: fc.integer({ min: 0, max: 1_000_000_000 })
      }),
      (committed: QuantizedBurnParameters) => {
        expect(quantizeBurnParameters(dequantizeBurnParameters(committed))).toEqual(committed);
      }
    ));
  });

  it("uses documented fixed-point quanta", () => {
    expect(quantizeBurnParameters({ deltaVKmPerSecond: 12.3456784, burnDurationSeconds: 98.7654 })).toEqual({
      deltaVQuantum: 12_345_678,
      burnDurationQuantum: 98_765
    });
    expect(dequantizeBurnParameters({ deltaVQuantum: 1, burnDurationQuantum: 1 })).toEqual({
      deltaVKmPerSecond: DELTA_V_QUANTUM_KM_PER_SECOND,
      burnDurationSeconds: BURN_DURATION_QUANTUM_SECONDS
    });
  });
});
