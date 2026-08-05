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
      if (result.kind !== "feasible") continue;
      const terminal = propagate(result, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
      expect(Math.abs(terminal.position.x - distance) / distance).toBeLessThan(1e-12);
      expect(terminal.position.y).toBe(0);
      expect(terminal.position.z).toBe(0);
      expect(terminal.velocity.x).toBeCloseTo(0, 9);
      expect(result.coastDurationSeconds).toBeCloseTo(duration - 2 * result.firstBurnDurationSeconds, 9);
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
    if (result.kind !== "feasible") return;
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
    expect(search.kind).toBe("feasible");
    if (search.kind !== "feasible") return;
    const truth = -100 + Math.sqrt(4_020_000);
    expect(search.durationSeconds).toBeCloseTo(truth, 3);
    expect(search.plan.burnDutyCycle).toBeCloseTo(1, 7);
    const belowWall = solveFlatspaceRendezvous({
      accelerationMetersPerSecondSquared: 1,
      durationSeconds: truth * (1 - 1e-4),
      departurePositionMeters: { x: 0, y: 0, z: 0 },
      departureVelocityMetersPerSecond: { x: 0, y: 0, z: 0 },
      arrivalPositionMeters: { x: 1_000_000 - 100 * truth * (1 - 1e-4), y: 0, z: 0 },
      arrivalVelocityMetersPerSecond: { x: -100, y: 0, z: 0 }
    });
    expect(belowWall.kind).toBe("infeasible");
  });

  it("returns a typed result when no feasible duration can be bracketed", () => {
    const result = findMinimumFlatspaceRendezvousTime({
      accelerationMetersPerSecondSquared: 1,
      chordDistanceMeters: 1,
      requestAtDuration: (durationSeconds) => ({
        accelerationMetersPerSecondSquared: 1,
        durationSeconds,
        departurePositionMeters: { x: 0, y: 0, z: 0 },
        departureVelocityMetersPerSecond: { x: 0, y: 0, z: 0 },
        arrivalPositionMeters: { x: 0, y: 0, z: 0 },
        // Required velocity change alone needs more burn time than the trip.
        arrivalVelocityMetersPerSecond: { x: 2 * durationSeconds, y: 0, z: 0 }
      })
    });
    expect(result).toEqual({ kind: "no-feasible-duration" });
  });

  it("matches the Earth-Mars reference-table flat-space delta-v values", () => {
    const au = 149_597_870_700;
    const angle = 0.9;
    const departurePosition = { x: au, y: 0, z: 0 };
    const departureVelocity = { x: 0, y: 29_780, z: 0 };
    const marsRadius = 1.524 * au;
    const marsSpeed = 24_070;
    const fixtures: ReadonlyArray<readonly [days: number, gee: number, expectedKilometersPerSecond: number]> = [
      [4, 1, 1252.27], [10, 0.1, 650.14], [20, 0.1, 208.17],
      [30, 0.1, 131.73], [60, 0.1, 68.35], [120, 0.1, 55.56]
    ];
    for (const [days, gee, expectedKilometersPerSecond] of fixtures) {
      const durationSeconds = days * 86_400;
      const arrivalAngle = angle + (marsSpeed / marsRadius) * durationSeconds;
      const result = solveFlatspaceRendezvous({
        accelerationMetersPerSecondSquared: gee * 9.80665,
        durationSeconds,
        departurePositionMeters: departurePosition,
        departureVelocityMetersPerSecond: departureVelocity,
        arrivalPositionMeters: { x: marsRadius * Math.cos(arrivalAngle), y: marsRadius * Math.sin(arrivalAngle), z: 0.02 * au },
        arrivalVelocityMetersPerSecond: { x: -marsSpeed * Math.sin(arrivalAngle), y: marsSpeed * Math.cos(arrivalAngle), z: 0 }
      });
      expect(result.kind).toBe("feasible");
      if (result.kind !== "feasible") continue;
      // §3.3 prints its oracle values rounded to 0.01 km/s; the circular
      // arrival-epoch reconstruction is intentionally checked within 0.5 km/s.
      expect(result.totalDeltaVMetersPerSecond / 1000).toBeCloseTo(expectedKilometersPerSecond, 0);
    }
  });

  it("reports the reference low-thrust cells as physics infeasible", () => {
    const au = 149_597_870_700;
    const departurePosition = { x: au, y: 0, z: 0 };
    const departureVelocity = { x: 0, y: 29_780, z: 0 };
    const marsRadius = 1.524 * au;
    const marsSpeed = 24_070;
    for (const [days, gee] of [[2, 1], [4, 0.1], [10, 0.01]] as const) {
      const durationSeconds = days * 86_400;
      const arrivalAngle = 0.9 + (marsSpeed / marsRadius) * durationSeconds;
      const result = solveFlatspaceRendezvous({
        accelerationMetersPerSecondSquared: gee * 9.80665,
        durationSeconds,
        departurePositionMeters: departurePosition,
        departureVelocityMetersPerSecond: departureVelocity,
        arrivalPositionMeters: { x: marsRadius * Math.cos(arrivalAngle), y: marsRadius * Math.sin(arrivalAngle), z: 0.02 * au },
        arrivalVelocityMetersPerSecond: { x: -marsSpeed * Math.sin(arrivalAngle), y: marsSpeed * Math.cos(arrivalAngle), z: 0 }
      });
      expect(result).toMatchObject({ kind: "infeasible", reason: "negative-coast" });
    }
  });

  it("resolves a non-collinear moving-target feasibility wall", () => {
    const result = findMinimumFlatspaceRendezvousTime({
      accelerationMetersPerSecondSquared: 1,
      chordDistanceMeters: 1_000_000,
      requestAtDuration: (durationSeconds) => ({
        accelerationMetersPerSecondSquared: 1,
        durationSeconds,
        departurePositionMeters: { x: 0, y: 0, z: 0 },
        departureVelocityMetersPerSecond: { x: 0, y: 0, z: 0 },
        arrivalPositionMeters: { x: 1_000_000 - 100 * durationSeconds, y: 0, z: durationSeconds },
        arrivalVelocityMetersPerSecond: { x: -100, y: 0, z: 1 }
      })
    });
    expect(result.kind).toBe("feasible");
    if (result.kind !== "feasible") return;
    // The out-of-plane velocity is deliberately tiny but makes this a true
    // 3-D wall; the old collinear-only rescue overestimated it by about 1%.
    expect(result.durationSeconds).toBeLessThan(1_910);
    expect(result.plan.burnDutyCycle).toBeCloseTo(1, 7);
  });

  it("covers duty cycles through the wall instead of only impulsive plans", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.05, max: 1, noNaN: true }),
        fc.double({ min: 1, max: 10, noNaN: true }),
        fc.double({ min: 1_000, max: 10_000, noNaN: true }),
        (dutyCycle, acceleration, duration) => {
          const burn = duration * dutyCycle / 2;
          const impulse = acceleration * burn;
          const expectedPlan: FlatspaceRendezvousPlan = {
            kind: "feasible",
            firstBurnImpulseMetersPerSecond: { x: impulse, y: 0, z: 0 },
            secondBurnImpulseMetersPerSecond: { x: -impulse, y: 0, z: 0 },
            firstBurnDurationSeconds: burn,
            coastDurationSeconds: duration - 2 * burn,
            secondBurnDurationSeconds: burn,
            totalDeltaVMetersPerSecond: 2 * impulse,
            burnDutyCycle: dutyCycle
          };
          const arrival = propagate(expectedPlan, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
          const result = solveFlatspaceRendezvous({
            accelerationMetersPerSecondSquared: acceleration,
            durationSeconds: duration,
            departurePositionMeters: { x: 0, y: 0, z: 0 },
            departureVelocityMetersPerSecond: { x: 0, y: 0, z: 0 },
            arrivalPositionMeters: arrival.position,
            arrivalVelocityMetersPerSecond: arrival.velocity
          });
          expect(result.kind).toBe("feasible");
          if (result.kind === "feasible") expect(result.burnDutyCycle).toBeCloseTo(dutyCycle, 8);
        }
      ),
      { numRuns: 100, seed: 2_026_080_5 }
    );
  });

  it("holds general 3D rendezvous across fresh-world initial times including zero", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.double({ min: 1, max: 10, noNaN: true }),
        fc.double({ min: 1_000, max: 10_000, noNaN: true }),
        fc.double({ min: -20, max: 20, noNaN: true }),
        fc.double({ min: -20, max: 20, noNaN: true }),
        fc.double({ min: -20, max: 20, noNaN: true }),
        fc.double({ min: -20, max: 20, noNaN: true }),
        fc.double({ min: -20, max: 20, noNaN: true }),
        fc.double({ min: -20, max: 20, noNaN: true }),
        (initialTimeSeconds, acceleration, duration, a1x, a1y, a1z, a2x, a2y, a2z) => {
          const initialPosition = { x: initialTimeSeconds, y: -2 * initialTimeSeconds, z: 3 };
          const initialVelocity = { x: 30, y: -4, z: 2 };
          const firstImpulse = { x: a1x, y: a1y, z: a1z };
          const secondImpulse = { x: a2x, y: a2y, z: a2z };
          const firstBurnDurationSeconds = magnitude(firstImpulse) / acceleration;
          const secondBurnDurationSeconds = magnitude(secondImpulse) / acceleration;
          const coastDurationSeconds = duration - firstBurnDurationSeconds - secondBurnDurationSeconds;
          fc.pre(coastDurationSeconds > 0);
          const expectedPlan: FlatspaceRendezvousPlan = {
            kind: "feasible",
            firstBurnImpulseMetersPerSecond: firstImpulse,
            secondBurnImpulseMetersPerSecond: secondImpulse,
            firstBurnDurationSeconds,
            coastDurationSeconds,
            secondBurnDurationSeconds,
            totalDeltaVMetersPerSecond: acceleration * (firstBurnDurationSeconds + secondBurnDurationSeconds),
            burnDutyCycle: (firstBurnDurationSeconds + secondBurnDurationSeconds) / duration
          };
          const expectedTerminal = propagate(expectedPlan, initialPosition, initialVelocity);
          const request = {
            accelerationMetersPerSecondSquared: acceleration,
            durationSeconds: duration,
            departurePositionMeters: initialPosition,
            departureVelocityMetersPerSecond: initialVelocity,
            arrivalPositionMeters: expectedTerminal.position,
            arrivalVelocityMetersPerSecond: expectedTerminal.velocity
          };
          const result = solveFlatspaceRendezvous(request);
          expect(result.kind).toBe("feasible");
          if (result.kind !== "feasible") return;
          const terminal = propagate(result, initialPosition, initialVelocity);
          expect(magnitude({ x: terminal.position.x - request.arrivalPositionMeters.x, y: terminal.position.y - request.arrivalPositionMeters.y, z: terminal.position.z - request.arrivalPositionMeters.z })).toBeLessThan(1e-6);
        }
      ),
      { numRuns: 100, seed: 2_026_080_5 }
    );
  });
});
