import { describe, expect, it, vi } from "vitest";

import { SPEED_OF_LIGHT_METERS_PER_SECOND } from "../sim/causality.js";
import { simTimeMs } from "../sim/clock.js";
import { burnDurationMs } from "../sim/mass-cargo.js";
import { enqueuePlanChangeWarnings } from "./notification-plan-changes.js";

const atOrigin = () => ({ x: 0, y: 0, z: 0 });
const paperProjection = () => ({ x: SPEED_OF_LIGHT_METERS_PER_SECOND, y: 0, z: 0 });
const node = { nodeId: "capture", executeAtMs: simTimeMs(10_000), kind: "decel" as const, burn: { burnDurationMs: burnDurationMs(1) }, deltaVMmPerSecond: { x: 0, y: 0, z: 0 } };

describe("enqueuePlanChangeWarnings", () => {
  it("derives against the supplied HQ paper projection only when called for a plan change", async () => {
    const enqueue = vi.fn(async () => undefined);
    await enqueuePlanChangeWarnings([node], simTimeMs(0), {
      sink: { enqueue }, hqPositionAt: atOrigin, paperProjection: { shipPositionAt: paperProjection }
    });

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith([expect.objectContaining({
      id: "notification:last-revision:capture", kind: "lastRevisionInstant", deliverAtMs: simTimeMs(8_999)
    })]);
  });

  it("does not enqueue an expired deadline", async () => {
    const enqueue = vi.fn(async () => undefined);
    await enqueuePlanChangeWarnings([node], simTimeMs(8_999), {
      sink: { enqueue }, hqPositionAt: atOrigin, paperProjection: { shipPositionAt: paperProjection }
    });

    expect(enqueue).toHaveBeenCalledWith([]);
  });
});
