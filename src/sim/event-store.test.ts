import { describe, expect, it } from "vitest";

import { simTimeMs } from "./clock.js";
import {
  InMemorySimulationEventStore,
  type AppendSimEventResult,
  type SimulationEventStore
} from "./event-store.js";

const event = (elapsedMs: number) => ({
  event: { type: "clockAdvanced" as const, elapsedMs },
  eventTime: simTimeMs(elapsedMs),
  eventPosition: { x: 0, y: 0, z: 0 }
});

const appended = (result: AppendSimEventResult) => {
  expect(result.kind).toBe("appended");
  if (result.kind !== "appended") throw new Error("Expected an appended event.");
  return result.event;
};

/** Shared store contract; the Postgres integration suite mirrors these assertions. */
const assertSequenceContract = (makeStore: () => SimulationEventStore): void => {
  it("keeps stream sequences contiguous while global positions order all streams", async () => {
    const store = makeStore();
    await store.createStream({ id: "alpha", seed: 1, initialTime: simTimeMs(0) });
    await store.createStream({ id: "beta", seed: 2, initialTime: simTimeMs(0) });

    const firstAlpha = appended(await store.append("alpha", event(1)));
    const firstBeta = appended(await store.append("beta", event(2)));
    const secondAlpha = appended(await store.append("alpha", event(3)));

    expect([firstAlpha.streamSequence, secondAlpha.streamSequence]).toEqual([1, 2]);
    expect(firstBeta.streamSequence).toBe(1);
    expect(new Set([`${"alpha"}:${firstAlpha.streamSequence}`, `${"beta"}:${firstBeta.streamSequence}`, `${"alpha"}:${secondAlpha.streamSequence}`]).size).toBe(3);
    expect([firstAlpha.globalPosition, firstBeta.globalPosition, secondAlpha.globalPosition]).toEqual(
      [...[firstAlpha.globalPosition, firstBeta.globalPosition, secondAlpha.globalPosition]].sort((a, b) => a - b)
    );
  });

  it("returns a typed conflict without appending when the expected stream sequence is stale", async () => {
    const store = makeStore();
    await store.createStream({ id: "conflict", seed: 1, initialTime: simTimeMs(0) });
    appended(await store.append("conflict", event(1), 0));

    await expect(store.append("conflict", event(2), 0)).resolves.toEqual({
      kind: "conflict", expectedStreamSequence: 0, actualStreamSequence: 1
    });
    expect((await store.readStream("conflict")).events).toHaveLength(1);
  });
};

describe("InMemorySimulationEventStore", () => {
  assertSequenceContract(() => new InMemorySimulationEventStore());
});
