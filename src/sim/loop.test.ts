import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { simTimeMs } from "./clock.js";
import { InMemorySimulationEventStore } from "./event-store.js";
import { replayPersistedSegment } from "./event-log.js";
import { AuthoritativeSimLoop, AuthoritativeSimLoopConflictError } from "./loop.js";
import { burnDurationMs } from "./mass-cargo.js";
import { TIER0_MARKET_CONFIG } from "./market.js";

const actionArbitrary = fc.oneof(
  fc.record({ kind: fc.constant<"advance">("advance"), elapsedMs: fc.integer({ min: 0, max: 10_000 }) }),
  fc.record({ kind: fc.constant<"random">("random"), upperExclusive: fc.integer({ min: 1, max: 1_000_000 }) })
);

const eventPosition = { x: 0, y: 0, z: 0 };

describe("authoritative simulation loop", () => {
  const dock = { positionMeters: { x: 149_597_870_700, y: 0, z: 0 }, velocityMmPerSecond: { x: 0, y: 29_780_000, z: 0 } };
  const marketPosition = { x: 9, y: 8, z: 7 };
  const arrivalPlan = (destination: "earth" | "moon" | "mars", at = 2) => ({
    destination,
    nodes: [{ nodeId: `arrive-${destination}-${at}`, executeAtMs: simTimeMs(at - 1), kind: "decel" as const,
      burn: { burnDurationMs: burnDurationMs(1) }, deltaVMmPerSecond: { x: 0, y: 0, z: 0 } }]
  });
  const tradeLoop = async (id: string) => AuthoritativeSimLoop.create({
    store: new InMemorySimulationEventStore(), stream: { id, seed: 7, initialTime: simTimeMs(0) },
    departureStateAt: (time) => ({ departureAtMs: time, ...dock }),
    destinationStateAt: () => dock,
    marketPositionAt: () => marketPosition
  });

  it("binds composition to Earth HQ, derives its quote horizon, and never appends an invalid purchase", async () => {
    const loop = await tradeLoop("trade-hq-and-append");
    await loop.applyPlanRevision(arrivalPlan("mars", 2), () => dock.positionMeters);
    await loop.composeCargo({ contractedTons: 0, spotTons: 1, spotDisposition: "manual" }, () => dock.positionMeters);
    const composed = (await loop.persistedStream()).events.find(({ event }) => event.type === "cargoComposed");
    expect(composed?.event).toMatchObject({ type: "cargoComposed" });
    if (composed?.event.type !== "cargoComposed") throw new Error("Expected composition.");
    // The only horizon accepted by the loop is its final planned burn boundary (2 ms).
    expect(composed.event.forwardRatePerTon).toBeGreaterThan(0);
    const beforeFailures = (await loop.persistedStream()).events.length;
    await expect(loop.composeCargo({ contractedTons: 17, spotTons: 0, spotDisposition: "manual" }, () => dock.positionMeters)).rejects.toThrow("unfunded purchase");
    await expect(loop.composeCargo({ contractedTons: 0, spotTons: 1, spotDisposition: "manual" }, () => dock.positionMeters)).rejects.toThrow("must be settled");
    expect((await loop.persistedStream()).events).toHaveLength(beforeFailures);
    await loop.advance(2, () => dock.positionMeters);
    await expect(loop.composeCargo({ contractedTons: 0, spotTons: 1, spotDisposition: "manual" }, () => dock.positionMeters)).rejects.toThrow("docked at HQ");
  });

  it("does not settle cargo at a non-market arrival body", async () => {
    const loop = await tradeLoop("trade-moon-no-settlement");
    await loop.applyPlanRevision(arrivalPlan("moon"), () => dock.positionMeters);
    await expect(loop.composeCargo({ contractedTons: 2, spotTons: 3, spotDisposition: "sell-on-arrival" }, () => dock.positionMeters)).rejects.toMatchObject({ reason: "forward-market-destination-mismatch" });
    await loop.composeCargo({ contractedTons: 0, spotTons: 3, spotDisposition: "sell-on-arrival" }, () => dock.positionMeters);
    await loop.advance(2, () => dock.positionMeters);
    expect(loop.state.cargo).toMatchObject({ contractedTons: 0, spotTons: 3 });
    expect((await loop.persistedStream()).events.some(({ event }) => event.type === "cargoSold")).toBe(false);
  });

  it("executes a sell command at the market arrival instant, not its issue price", async () => {
    const loop = await tradeLoop("trade-command-arrival-price");
    const arrivalAt = TIER0_MARKET_CONFIG.marketStepMs;
    await loop.applyPlanRevision(arrivalPlan("mars", arrivalAt), () => dock.positionMeters);
    await loop.composeCargo({ contractedTons: 0, spotTons: 2, spotDisposition: "manual" }, () => dock.positionMeters);
    await loop.advance(arrivalAt - 2_000, () => dock.positionMeters);
    const issuePrice = loop.state.market.price;
    await loop.scheduleInboundSellOrder(
      (issuedAt) => simTimeMs(issuedAt + 2_000), () => ({ x: 0, y: 0, z: 0 }), () => ({ x: 1, y: 0, z: 0 })
    );
    await loop.advance(2_000, () => dock.positionMeters);
    const sold = (await loop.persistedStream()).events.find(({ event }) => event.type === "cargoSold")!;
    expect(sold.event).toMatchObject({ type: "cargoSold", lot: "spot" });
    if (sold.event.type !== "cargoSold") throw new Error("Expected spot settlement.");
    expect(sold.event.commandId).toMatch(/^command-/);
    expect(sold.event.pricePerTon).toBe(loop.state.market.price);
    expect(sold.event.pricePerTon).not.toBe(issuePrice);
    expect(sold.eventPosition).toEqual(marketPosition);
  });

  it("records typed sell refusals and en-route disposition revisions through commandIssued", async () => {
    const loop = await tradeLoop("trade-command-refusals");
    await loop.scheduleInboundSellOrder((at) => at, () => ({ x: 0, y: 0, z: 0 }), () => ({ x: 0, y: 0, z: 0 }));
    expect((await loop.persistedStream()).events.map(({ event }) => event.type)).toEqual(["commandIssued", "sellRefused"]);
    await loop.applyPlanRevision(arrivalPlan("mars", 10), () => dock.positionMeters);
    await loop.composeCargo({ contractedTons: 0, spotTons: 1, spotDisposition: "manual" }, () => dock.positionMeters);
    await loop.scheduleInboundSpotDispositionRevision("sell-on-arrival", (at) => at, () => ({ x: 0, y: 0, z: 0 }), () => ({ x: 0, y: 0, z: 0 }));
    expect(loop.state.cargo.spotDisposition).toBe("sell-on-arrival");
    expect((await loop.persistedStream()).events.some(({ event }) => event.type === "spotDispositionRevised")).toBe(true);
  });
  it("persists append-only provenance and resumes to the same state", async () => {
    const store = new InMemorySimulationEventStore();
    const loop = await AuthoritativeSimLoop.create({
      store, stream: { id: "golden", seed: 0x1234_5678, initialTime: simTimeMs(10) }
    });

    await loop.advance(120, () => ({ x: 1, y: 2, z: 3 }));
    await loop.requestRandom(100, () => ({ x: 4, y: 5, z: 6 }));
    await loop.advance(380, () => ({ x: 7, y: 8, z: 9 }));

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
              await loop.advance(action.elapsedMs, () => eventPosition);
            } else {
              await loop.requestRandom(action.upperExclusive, () => eventPosition);
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

    await firstLoop.advance(10, () => eventPosition);

    const conflict = await staleLoop.advance(20, () => eventPosition).then(
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
