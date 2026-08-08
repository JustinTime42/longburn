import { describe, expect, it } from "vitest";

import { simTimeMs } from "./clock.js";
import { utDaysSinceJ2000 } from "./ephemerides.js";
import { hqPositionAt } from "./headquarters.js";

describe("Tier 0 Earth HQ position", () => {
  it("uses the quantized heliocentric Earth position rather than the frame origin", () => {
    const epoch = utDaysSinceJ2000(9_496.5);
    const first = hqPositionAt(epoch, simTimeMs(0));
    const later = hqPositionAt(epoch, simTimeMs(86_400_000));
    expect(first).toEqual(hqPositionAt(epoch, simTimeMs(0)));
    expect(Math.hypot(first.x, first.y, first.z)).toBeGreaterThan(100_000_000_000);
    expect(later).not.toEqual(first);
    expect(Object.values(first).every(Number.isSafeInteger)).toBe(true);
  });
});
