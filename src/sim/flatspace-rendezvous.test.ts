import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  findMinimumFlatspaceRendezvousTime,
  solveFlatspaceRendezvous,
  solveStationaryFlatspaceRendezvous,
  type FlatspaceRendezvousPlan,
  type FlatspaceVector
} from "./flatspace-rendezvous.js";

const magnitude = (vector: FlatspaceVector): number => Math.hypot(vector.x, vector.y, vector.z);

const propagate = (plan: FlatspaceRendezvousPlan, initialPosition: FlatspaceVector, initialVelocity: FlatspaceVector) => {
  const accelerate = (position: FlatspaceVector, velocity: FlatspaceVector, impulse: FlatspaceVector, burn: number) => ({
    position: {
      x: position.x + velocity.x * burn + impulse.x * burn / 2,
      y: position.y + velocity.y * burn + impulse.y * burn / 2,
      z: position.z + velocity.z * burn + impulse.z * burn / 2
    },
    velocity: { x: velocity.x + impulse.x, y: velocity.y + impulse.y, z: velocity.z + impulse.z }
  });
  const first = accelerate(initialPosition, initialVelocity, plan.firstBurnImpulseMetersPerSecond, plan.firstBurnDurationSeconds);
  const coastPosition = {
    x: first.position.x + first.velocity.x * plan.coastDurationSeconds,
    y: first.position.y + first.velocity.y * plan.coastDurationSeconds,
    z: first.position.z + first.velocity.z * plan.coastDurationSeconds
  };
  return accelerate(coastPosition, first.velocity, plan.secondBurnImpulseMetersPerSecond, plan.secondBurnDurationSeconds);
};

describe("flat-space rendezvous", () => {
  it("matches the stationary closed form to machine precision", () => {
    const distance = 0.75 * 149_597_870_700;
    const acceleration = 0.980665;
    const minimum = 2 * Math.sqrt(distance / acceleration);
    for (const multiple of [1, 1.2, 2, 10, 100]) {
      const duration = minimum * multiple;
      const result = solveStationaryFlatspaceRendezvous(distance, acceleration, duration);
      expect(result.kind).toBe("feasible");
      if (result.kind === "infeasible") continue;
      const expected = acceleration * (duration - Math.sqrt(duration ** 2 - (4 * distance) / acceleration));
      expect(result.totalDeltaVMetersPerSecond).toBeCloseTo(expected, 9);
      expect(result.coastDurationSeconds).toBeGreaterThanOrEqual(0);
    }
  });

  it("takes the analytic f=1 path at the brachistochrone endpoint", () => {
    const distance = 1_000_000;
    const acceleration = 2;
    const duration = 2 * Math.sqrt(distance / acceleration);
    const result = solveStationaryFlatspaceRendezvous(distance, acceleration, duration);
    expect(result).toMatchObject({ kind: "feasible", coastDurationSeconds: 0, burnDutyCycle: 1 });
    if (result.kind === "feasible") expect(result.totalDeltaVMetersPerSecond).toBe(2 * Math.sqrt(distance * acceleration));
  });

  it("converges to an exact 3D moving-target rendezvous", () => {
    const result = solveFlatspaceRendezvous({
      accelerationMetersPerSecondSquared: 1,
      durationSeconds: 10_000,
      departurePositionMeters: { x: 0, y: 0, z: 0 },
      departureVelocityMetersPerSecond: { x: 100, y: -30, z: 5 },
      arrivalPositionMeters: { x: 1_100_000, y: -310_000, z: 60_000 },
      arrivalVelocityMetersPerSecond: { x: 110, y: -25, z: 3 }
    });
    expect(result.kind).toBe("feasible");
    if (result.kind === "infeasible") return;
    const terminal = propagate(result, { x: 0, y: 0, z: 0 }, { x: 100, y: -30, z: 5 });
    expect(magnitude({ x: terminal.position.x - 1_100_000, y: terminal.position.y + 310_000, z: terminal.position.z - 60_000 })).toBeLessThan(1e-6);
    expect(magnitude({ x: terminal.velocity.x - 110, y: terminal.velocity.y + 25, z: terminal.velocity.z - 3 })).toBeLessThan(1e-12);
  });

  it("approaches the 2D/T impulsive limit", () => {
    const distance = 1_000_000;
    const duration = 1_000_000;
    const result = solveStationaryFlatspaceRendezvous(distance, 1, duration);
    expect(result.kind).toBe("feasible");
    if (result.kind === "feasible") expect(result.totalDeltaVMetersPerSecond).toBeCloseTo((2 * distance) / duration, 5);
  });

  it("returns a typed refusal when the coast would be negative", () => {
    const result = solveFlatspaceRendezvous({
      accelerationMetersPerSecondSquared: 1,
      durationSeconds: 1,
      departurePositionMeters: { x: 0, y: 0, z: 0 },
      departureVelocityMetersPerSecond: { x: 0, y: 0, z: 0 },
      arrivalPositionMeters: { x: 1_000_000, y: 0, z: 0 },
      arrivalVelocityMetersPerSecond: { x: 0, y: 0, z: 0 }
    });
    expect(result.kind).toBe("infeasible");
    expect(result).toMatchObject({ reason: "negative-coast" });
  });

  it("bisects moving-target feasibility instead of treating the chord as a bound", () => {
    const search = findMinimumFlatspaceRendezvousTime({
      accelerationMetersPerSecondSquared: 1,
      chordDistanceMeters: 1_000_000,
      requestAtDuration: (durationSeconds) => ({
        accelerationMetersPerSecondSquared: 1,
        durationSeconds,
        departurePositionMeters: { x: 0, y: 0, z: 0 },
        departureVelocityMetersPerSecond: { x: 0, y: 0, z: 0 },
        // The target moves toward us: true minimum is below the chord value.
        arrivalPositionMeters: { x: 1_000_000 - 100 * durationSeconds, y: 0, z: 0 },
        arrivalVelocityMetersPerSecond: { x: -100, y: 0, z: 0 }
      })
    });
    expect(search.durationSeconds).toBeLessThan(2 * Math.sqrt(1_000_000));
    expect(search.plan.burnDutyCycle).toBeGreaterThan(0.999_999);
  });

  it("holds rendezvous across fresh-world initial times including zero", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.double({ min: 1, max: 10, noNaN: true }),
        fc.double({ min: 100, max: 1_000, noNaN: true }),
        (initialTimeSeconds, acceleration, duration) => {
          const initialPosition = { x: initialTimeSeconds, y: -2 * initialTimeSeconds, z: 3 };
          const initialVelocity = { x: 30, y: -4, z: 2 };
          const request = {
            accelerationMetersPerSecondSquared: acceleration,
            durationSeconds: duration,
            departurePositionMeters: initialPosition,
            departureVelocityMetersPerSecond: initialVelocity,
            arrivalPositionMeters: {
              x: initialPosition.x + initialVelocity.x * duration + acceleration * duration ** 2 / 8,
              y: initialPosition.y + initialVelocity.y * duration,
              z: initialPosition.z + initialVelocity.z * duration
            },
            arrivalVelocityMetersPerSecond: { x: initialVelocity.x, y: initialVelocity.y, z: initialVelocity.z }
          };
          const result = solveFlatspaceRendezvous(request);
          expect(result.kind).toBe("feasible");
          if (result.kind === "infeasible") return;
          const terminal = propagate(result, initialPosition, initialVelocity);
          expect(magnitude({ x: terminal.position.x - request.arrivalPositionMeters.x, y: terminal.position.y - request.arrivalPositionMeters.y, z: terminal.position.z - request.arrivalPositionMeters.z })).toBeLessThan(1e-6);
        }
      ),
      { numRuns: 100 }
    );
  });
});
