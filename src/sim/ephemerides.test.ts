import { SetDeltaTFunction } from "astronomy-engine";
import { describe, expect, it } from "vitest";

import { simTimeMs } from "./clock.js";
import { ephemeridesAt, simTimeToUtDays, utDaysSinceJ2000 } from "./ephemerides.js";

const epoch = utDaysSinceJ2000(9_131.5); // 2025-01-01T00:00:00Z, UT.

describe("Tier 0 ephemerides", () => {
  it("maps virtual sim milliseconds to an explicit UT input", () => {
    expect(simTimeToUtDays(epoch, simTimeMs(86_400_000))).toBe(9_132.5);
    expect(() => utDaysSinceJ2000(Number.NaN)).toThrow(RangeError);
  });

  it("returns heliocentric EQJ states in kilometres and kilometres per second", () => {
    const states = ephemeridesAt(epoch, simTimeMs(0));

    expect(states.sun).toEqual({
      positionKm: { x: 0, y: 0, z: 0 },
      velocityKmPerSecond: { x: 0, y: 0, z: 0 }
    });
    expect(Math.hypot(states.earth.positionKm.x, states.earth.positionKm.y, states.earth.positionKm.z)).toBeGreaterThan(
      100_000_000
    );
    expect(Math.hypot(states.moon.velocityKmPerSecond.x, states.moon.velocityKmPerSecond.y, states.moon.velocityKmPerSecond.z)).toBeGreaterThan(
      10
    );
  });

  it("is byte-for-byte stable across warmed and deliberately altered global call history", () => {
    const instant = simTimeMs(2_592_000_000);
    const cold = JSON.stringify(ephemeridesAt(epoch, instant));

    ephemeridesAt(epoch, simTimeMs(0));
    ephemeridesAt(epoch, simTimeMs(86_400_000));
    SetDeltaTFunction(() => 0);

    const afterInterleaving = JSON.stringify(ephemeridesAt(epoch, instant));

    expect(afterInterleaving).toBe(cold);
  });
});
