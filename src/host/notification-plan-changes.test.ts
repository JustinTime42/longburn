import { describe, expect, it, vi } from "vitest";

import { SPEED_OF_LIGHT_METERS_PER_SECOND } from "../sim/causality.js";
import { simTimeMs } from "../sim/clock.js";
import { burnDurationMs } from "../sim/mass-cargo.js";
import { InMemoryNotificationQueueStore, NotificationQueue } from "./notification-queue.js";
import { enqueuePlanChangeWarnings } from "./notification-plan-changes.js";

const atOrigin = () => ({ x: 0, y: 0, z: 0 });
const paperProjection = () => ({ x: SPEED_OF_LIGHT_METERS_PER_SECOND, y: 0, z: 0 });
const node = { nodeId: "capture", executeAtMs: simTimeMs(10_000), kind: "decel" as const, burn: { burnDurationMs: burnDurationMs(1) }, deltaVMmPerSecond: { x: 0, y: 0, z: 0 } };

describe("enqueuePlanChangeWarnings", () => {
  it("derives against the supplied HQ paper projection only when called for a plan change", async () => {
    const reconcilePendingLastRevisionWarnings = vi.fn(async () => undefined);
    await enqueuePlanChangeWarnings([node], simTimeMs(0), {
      sink: { reconcilePendingLastRevisionWarnings }, hqPositionAt: atOrigin, paperProjection: { shipPositionAt: paperProjection }, lastRevisionLeadTimesMs: [1_000]
    });

    expect(reconcilePendingLastRevisionWarnings).toHaveBeenCalledTimes(1);
    expect(reconcilePendingLastRevisionWarnings).toHaveBeenCalledWith([expect.objectContaining({
      id: "notification:last-revision:capture:10000:lead:1000", kind: "lastRevisionInstant", deliverAtMs: simTimeMs(7_999)
    })]);
  });

  it("does not enqueue an expired deadline", async () => {
    const reconcilePendingLastRevisionWarnings = vi.fn(async () => undefined);
    await enqueuePlanChangeWarnings([node], simTimeMs(8_999), {
      sink: { reconcilePendingLastRevisionWarnings }, hqPositionAt: atOrigin, paperProjection: { shipPositionAt: paperProjection }, lastRevisionLeadTimesMs: [1_000]
    });

    expect(reconcilePendingLastRevisionWarnings).toHaveBeenCalledWith([]);
  });

  it("retires an undelivered warning when its node's execution time changes", async () => {
    const store = new InMemoryNotificationQueueStore();
    const delivered = vi.fn(async () => ({ delivered: true as const }));
    const queue = new NotificationQueue({ store, wallClockToSimTime: { simTimeAt: (wallMs) => simTimeMs(wallMs) }, deliver: delivered });
    const options = { sink: store, hqPositionAt: atOrigin, paperProjection: { shipPositionAt: paperProjection }, lastRevisionLeadTimesMs: [1_000] };

    await enqueuePlanChangeWarnings([node], simTimeMs(0), options);
    await enqueuePlanChangeWarnings([{ ...node, executeAtMs: simTimeMs(20_000) }], simTimeMs(0), options);
    await expect(queue.run(8_999)).resolves.toMatchObject({ delivered: [] });
    await enqueuePlanChangeWarnings([{ ...node, executeAtMs: simTimeMs(15_000) }], simTimeMs(9_000), options);

    await expect(queue.run(12_998)).resolves.toMatchObject({ delivered: [] });
    await expect(queue.run(12_999)).resolves.toMatchObject({ delivered: ["notification:last-revision:capture:15000:lead:1000"] });
    expect(delivered).toHaveBeenCalledWith(expect.objectContaining({ deliverAtMs: simTimeMs(12_999) }), 12_999);
  });

  it("schedules a later deadline after the prior deadline was delivered", async () => {
    const store = new InMemoryNotificationQueueStore();
    const delivered = vi.fn(async () => ({ delivered: true as const }));
    const queue = new NotificationQueue({ store, wallClockToSimTime: { simTimeAt: (wallMs) => simTimeMs(wallMs) }, deliver: delivered });
    const options = { sink: store, hqPositionAt: atOrigin, paperProjection: { shipPositionAt: paperProjection }, lastRevisionLeadTimesMs: [1_000] };

    await enqueuePlanChangeWarnings([node], simTimeMs(0), options);
    await expect(queue.run(7_999)).resolves.toMatchObject({ delivered: ["notification:last-revision:capture:10000:lead:1000"] });
    await enqueuePlanChangeWarnings([{ ...node, executeAtMs: simTimeMs(20_000) }], simTimeMs(8_999), options);

    await expect(queue.run(17_998)).resolves.toMatchObject({ delivered: [] });
    await expect(queue.run(17_999)).resolves.toMatchObject({ delivered: ["notification:last-revision:capture:20000:lead:1000"] });
    expect(delivered).toHaveBeenCalledTimes(2);
  });

  it("withdraws an undelivered warning when its node leaves the plan", async () => {
    const store = new InMemoryNotificationQueueStore();
    const delivered = vi.fn(async () => ({ delivered: true as const }));
    const queue = new NotificationQueue({ store, wallClockToSimTime: { simTimeAt: (wallMs) => simTimeMs(wallMs) }, deliver: delivered });
    const options = { sink: store, hqPositionAt: atOrigin, paperProjection: { shipPositionAt: paperProjection }, lastRevisionLeadTimesMs: [1_000] };

    await enqueuePlanChangeWarnings([node], simTimeMs(0), options);
    await enqueuePlanChangeWarnings([], simTimeMs(0), options);

    await expect(queue.run(7_999)).resolves.toMatchObject({ delivered: [] });
    expect(delivered).not.toHaveBeenCalled();
  });
});
