import { describe, expect, it } from "vitest";

import { simTimeMs } from "./clock.js";
import { burnDurationMs } from "./mass-cargo.js";
import { shipPositionAt } from "./worldline.js";

describe("authoritative ship worldline", () => {
  it("is deterministic and applies a committed burn vector instead of planner state", () => {
    const worldline = {
      departureState: {
        departureAtMs: simTimeMs(0), positionMeters: { x: 149_597_870_700, y: 0, z: 0 }, velocityMmPerSecond: { x: 0, y: 29_780_000, z: 0 }
      },
      executedBurns: [{
        node: { nodeId: "burn", executeAtMs: simTimeMs(1_000), kind: "accel" as const, burn: { burnDurationMs: burnDurationMs(1_000) }, deltaVMmPerSecond: { x: 10_000, y: 0, z: 0 } },
        startedAtMs: simTimeMs(1_000), endedAtMs: simTimeMs(2_000)
      }],
      flightPlan: { destination: "earth" as const, nodes: [] }
    };
    expect(shipPositionAt(worldline, 5_000)).toEqual(shipPositionAt(worldline, 5_000));
    expect(shipPositionAt(worldline, 2_000).x).toBeGreaterThan(shipPositionAt({ ...worldline, executedBurns: [] }, 2_000).x);
  });
});
