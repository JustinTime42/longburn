import { describe, expect, it, vi } from "vitest";

import { simTimeMs } from "../sim/clock.js";
import { InMemoryNotificationQueueStore, NotificationQueue } from "./notification-queue.js";

const notification = (id = "notification:arrival"): import("../sim/notification-derivation.js").NotificationMoment => ({
  id, kind: "arrival", destination: "mars", deliverAtMs: simTimeMs(1_000), sourceGlobalPosition: 1, eventTimeMs: simTimeMs(500)
});

describe("NotificationQueue", () => {
  it("delivers only after the wall-clock anchor maps past the sim-time floor", async () => {
    const send = vi.fn(async () => ({ delivered: true as const }));
    const queue = new NotificationQueue({ store: new InMemoryNotificationQueueStore(), wallClockToSimTime: { simTimeAt: (wallMs) => simTimeMs(wallMs - 10_000) }, deliver: send });
    await queue.enqueue([notification()]);

    await expect(queue.run(10_999)).resolves.toEqual({ nowMs: 999, delivered: [], retrying: [] });
    await expect(queue.run(11_000)).resolves.toEqual({ nowMs: 1_000, delivered: ["notification:arrival"], retrying: [] });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("deduplicates enqueue and retries the stable ID after an unsuccessful send", async () => {
    const store = new InMemoryNotificationQueueStore();
    const send = vi.fn()
      .mockResolvedValueOnce({ delivered: false as const })
      .mockResolvedValueOnce({ delivered: true as const });
    const queue = new NotificationQueue({ store, wallClockToSimTime: { simTimeAt: () => simTimeMs(1_000) }, deliver: send });
    await queue.enqueue([notification(), notification()]);

    await expect(queue.run(1)).resolves.toEqual({ nowMs: 1_000, delivered: [], retrying: ["notification:arrival"] });
    await expect(store.dueAtOrBefore(simTimeMs(1_000))).resolves.toMatchObject([{ attempts: 1 }]);
    await expect(queue.run(2)).resolves.toEqual({ nowMs: 1_000, delivered: ["notification:arrival"], retrying: [] });
    await expect(store.dueAtOrBefore(simTimeMs(1_000))).resolves.toEqual([]);
    expect(send.mock.calls.map(([sent]) => sent.id)).toEqual(["notification:arrival", "notification:arrival"]);
  });

  it("keeps delivered records durable across a worker restart", async () => {
    const store = new InMemoryNotificationQueueStore();
    const firstSend = vi.fn(async () => ({ delivered: true as const }));
    const first = new NotificationQueue({ store, wallClockToSimTime: { simTimeAt: () => simTimeMs(1_000) }, deliver: firstSend });
    await first.enqueue([notification()]);
    await first.run(1);

    const restartedSend = vi.fn(async () => ({ delivered: true as const }));
    const restarted = new NotificationQueue({ store, wallClockToSimTime: { simTimeAt: () => simTimeMs(1_000) }, deliver: restartedSend });
    await expect(restarted.run(2)).resolves.toEqual({ nowMs: 1_000, delivered: [], retrying: [] });
    expect(restartedSend).not.toHaveBeenCalled();
  });
});
