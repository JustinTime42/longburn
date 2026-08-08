import { describe, expect, it } from "vitest";
import fc from "fast-check";

import {
  assertTier0DeltaVConsistentWithBurn,
  assessCargo,
  burnDurationMs,
  BURN_DURATION_QUANTUM_MILLISECONDS,
  deltaVForBurn,
  dequantizeBurnParameters,
  massRatioForDeltaV,
  projectPropellantForBurns,
  quantizeBurnParameters,
  TIER0_ACCELERATION_MICROMETERS_PER_SECOND2,
  TIER0_SHIP,
  viabilityWallDeltaV,
  type QuantizedBurnParameters
} from "./mass-cargo.js";

describe("mass and cargo", () => {
  it("pins the float economy acceleration to the bigint command-boundary acceleration", () => {
    expect(BigInt(TIER0_SHIP.accelerationKmPerSecond2 * 1_000_000_000))
      .toBe(TIER0_ACCELERATION_MICROMETERS_PER_SECOND2);
  });

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
  it("uses an exact integer impulse ceiling for committed delta-v vectors", () => {
    expect(() => assertTier0DeltaVConsistentWithBurn(
      { x: 9, y: 3, z: 0 }, { burnDurationMs: burnDurationMs(1) }
    )).not.toThrow();
    expect(() => assertTier0DeltaVConsistentWithBurn(
      { x: 10, y: 0, z: 0 }, { burnDurationMs: burnDurationMs(1) }
    )).toThrow("exceeds the fixed ship acceleration");
    expect(() => assertTier0DeltaVConsistentWithBurn(
      { x: 7, y: 7, z: 0 }, { burnDurationMs: burnDurationMs(1) }
    )).toThrow("exceeds the fixed ship acceleration");
    expect(() => assertTier0DeltaVConsistentWithBurn(
      { x: 980_665, y: 0, z: 0 }, { burnDurationMs: burnDurationMs(100_000) }
    )).not.toThrow();
  });

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

describe("sequential propellant projection", () => {
  it("refuses the same just-over-ceiling commitment independently of wet mass", () => {
    const ship = {
      exhaustVelocityKmPerSecond: 1,
      accelerationKmPerSecond2: 693.1471805599599,
      structuralMassFraction: 0.49999999999999445,
      wetMassGrams: 1,
      maxViableBurnDurationMs: burnDurationMs(0)
    };

    // This ship's frozen ceiling is zero milliseconds. The decision must not
    // depend on wet mass, which is a readout-only quantity at this boundary.
    const burns = [{ burnDurationMs: burnDurationMs(1) }];
    const gramShip = projectPropellantForBurns(burns, ship);
    const tonneShip = projectPropellantForBurns(burns, { ...ship, wetMassGrams: 1_000_000 });

    expect(gramShip.kind).toBe("exhausted");
    expect(tonneShip.kind).toBe("exhausted");
    expect(gramShip.nodes[0]?.remainingPropellantGrams).toBeLessThan(0);
    expect(tonneShip.nodes[0]?.remainingPropellantGrams).toBeLessThan(0);
  });

  it("straddles the authoritative Tier 0 ship's strict viability wall", () => {
    const belowWall = projectPropellantForBurns([{ burnDurationMs: burnDurationMs(193_452_400) }]);
    const aboveWall = projectPropellantForBurns([{ burnDurationMs: burnDurationMs(193_452_401) }]);

    expect(belowWall.kind).toBe("sufficient");
    expect(aboveWall.kind).toBe("exhausted");
    expect(belowWall.nodes[0]?.remainingPropellantGrams).toBeGreaterThan(0);
    expect(aboveWall.nodes[0]?.remainingPropellantGrams).toBeLessThan(0);
  });

  it("accepts by the frozen per-ship integer duration ceiling", () => {
    expect(TIER0_SHIP.maxViableBurnDurationMs).toBe(burnDurationMs(193_452_400));
  });

  it("accepts an empty committed-burn sequence", () => {
    expect(projectPropellantForBurns([])).toEqual({ kind: "sufficient", nodes: [] });
  });

  it("refuses a total duration that cannot remain a safe integer", () => {
    const largestDuration = { burnDurationMs: burnDurationMs(Number.MAX_SAFE_INTEGER) };

    expect(() => projectPropellantForBurns([largestDuration, largestDuration]))
      .toThrow("Total burn duration must be a non-negative safe integer in milliseconds.");
  });

  it("projects each node from the previous node's remaining wet mass", () => {
    const ship = { ...TIER0_SHIP, wetMassGrams: 1_000_000 };
    const projected = projectPropellantForBurns([
      { burnDurationMs: burnDurationMs(10_000) },
      { burnDurationMs: burnDurationMs(20_000) }
    ], ship);

    expect(projected.kind).toBe("sufficient");
    expect(projected.nodes).toHaveLength(2);
    expect(projected.nodes[1]?.wetMassGrams).toBeLessThan(projected.nodes[0]?.wetMassGrams ?? Infinity);
  });
});
