import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { simTimeMs } from "./clock.js";
import { InMemorySimulationEventStore } from "./event-store.js";
import { replayPersistedSegment } from "./event-log.js";
import { AuthoritativeSimLoop, AuthoritativeSimLoopConflictError } from "./loop.js";

const actionArbitrary = fc.oneof(
  fc.record({ kind: fc.constant<"advance">("advance"), elapsedMs: fc.integer({ min: 0, max: 10_000 }) }),
  fc.record({ kind: fc.constant<"random">("random"), upperExclusive: fc.integer({ min: 1, max: 1_000_000 }) })
);

const eventPosition = { x: 0, y: 0, z: 0 };

describe("authoritative simulation loop", () => {
  it("persists append-only provenance and resumes to the same state", async () => {
    const store = new InMemorySimulationEventStore();
    const loop = await AuthoritativeSimLoop.create({
      store, stream: { id: "golden", seed: 0x1234_5678, initialTime: simTimeMs(10) }
    });

    await loop.advance(120, { x: 1, y: 2, z: 3 });
    await loop.requestRandom(100, { x: 4, y: 5, z: 6 });
    await loop.advance(380, { x: 7, y: 8, z: 9 });

    const persisted = await loop.persistedStream();
    expect(persisted.events).toEqual([
      expect.objectContaining({ streamSequence: 1, globalPosition: expect.any(Number), eventTime: 130, eventPosition: { x: 1, y: 2, z: 3 } }),
      expect.objectContaining({ streamSequence: 2, globalPosition: expect.any(Number), eventTime: 130, eventPosition: { x: 4, y: 5, z: 6 } }),
      expect.objectContaining({ streamSequence: 3, globalPosition: expect.any(Number), eventTime: 510, eventPosition: { x: 7, y: 8, z: 9 } })
    ]);
    expect(replayPersistedSegment(persisted)).toEqual(loop.state);
    expect((await AuthoritativeSimLoop.resume(store, "golden")).state).toEqual(loop.state);
  });

  it("replays every persisted generated segment identically from its recorded seed", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 0xffff_ffff }),
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.array(actionArbitrary, { maxLength: 200 }),
        async (seed, initialTime, actions) => {
          const store = new InMemorySimulationEventStore();
          const loop = await AuthoritativeSimLoop.create({
            store, stream: { id: "property", seed, initialTime: simTimeMs(initialTime) }
          });
          for (const action of actions) {
            if (action.kind === "advance") {
              await loop.advance(action.elapsedMs, eventPosition);
            } else {
              await loop.requestRandom(action.upperExclusive, eventPosition);
            }
          }
          const persisted = await loop.persistedStream();
          expect(replayPersistedSegment(persisted)).toEqual(loop.state);
          expect((await AuthoritativeSimLoop.resume(store, "property")).state).toEqual(loop.state);
        }
      ),
      { seed: 0xb0b, numRuns: 500 }
    );
  });

  it("rejects a persisted record whose provenance time disagrees with the sim clock", async () => {
    const store = new InMemorySimulationEventStore();
    await store.createStream({ id: "invalid-time", seed: 1, initialTime: simTimeMs(0) });
    await store.append("invalid-time", {
      event: { type: "clockAdvanced", elapsedMs: 10 },
      eventTime: simTimeMs(9),
      eventPosition: { x: 0, y: 0, z: 0 }
    });

    await expect(AuthoritativeSimLoop.resume(store, "invalid-time")).rejects.toThrow(
      "Persisted event time does not match the authoritative clock."
    );
  });

  it("rejects a stale loop instance with the typed stream sequence conflict", async () => {
    const store = new InMemorySimulationEventStore();
    const firstLoop = await AuthoritativeSimLoop.create({
      store, stream: { id: "concurrent", seed: 1, initialTime: simTimeMs(0) }
    });
    const staleLoop = await AuthoritativeSimLoop.resume(store, "concurrent");

    await firstLoop.advance(10, eventPosition);

    const conflict = await staleLoop.advance(20, eventPosition).then(
      () => { throw new Error("Expected stale loop append to conflict."); },
      error => error
    );

    expect(conflict).toBeInstanceOf(AuthoritativeSimLoopConflictError);
    expect(conflict).toMatchObject({
      expectedStreamSequence: 0,
      actualStreamSequence: 1
    });
    expect((await store.readStream("concurrent")).events).toHaveLength(1);
    expect(staleLoop.state.time).toBe(simTimeMs(0));
  });
});
