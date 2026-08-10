import { describe, expect, it, vi } from "vitest";

import { CausalEmissionGate, SPEED_OF_LIGHT_METERS_PER_SECOND } from "./causality.js";
import { simTimeMs } from "./clock.js";
import { InMemoryDeliveryCursorStore } from "./delivery-cursor.js";
import { DeliveryProjectionViolation, EmissionScheduler, type ScheduledEmission } from "./emission-scheduler.js";

const observerPositionAt = () => ({ x: SPEED_OF_LIGHT_METERS_PER_SECOND, y: 0, z: 0 });
const scheduled = (globalPosition: number, eventTime = 0): ScheduledEmission => ({
  sourceGlobalPosition: globalPosition,
  message: {
    observerId: "hq-player",
    event: {
      streamId: "sol", streamSequence: globalPosition, globalPosition,
      eventTime: simTimeMs(eventTime), eventPosition: { x: 0, y: 0, z: 0 }
    },
    class: "shipReport",
    payload: { event: "departureRecorded" },
    observerPositionAt
  }
});

const gateEmitter = (sent: string[]) => {
  const gate = new CausalEmissionGate({
    send: (message) => sent.push(message.messageId), recordIncident: () => {}, incrementCausalityFailure: () => {}
  });
  return async (candidate: Parameters<CausalEmissionGate["emit"]>[0]) => gate.emit(candidate);
};

const schedulerOptions = (cursors: InMemoryDeliveryCursorStore, emit: ReturnType<typeof gateEmitter>) => ({
  cursors, emit, recordIncident: () => {}, incrementCausalityFailure: () => {}, incrementDeliveryIntegrityCounter: () => {}
});

describe("EmissionScheduler", () => {
  it("schedules at the earliest legal tick from the stored event position", async () => {
    const sent: string[] = [];
    const scheduler = new EmissionScheduler(schedulerOptions(new InMemoryDeliveryCursorStore(), gateEmitter(sent)));
    const work = scheduled(1);

    expect(await scheduler.run("hq-player", simTimeMs(999), [work])).toMatchObject({ deferred: [expect.any(String)] });
    expect(sent).toEqual([]);
    expect(await scheduler.run("hq-player", simTimeMs(1_000), [work])).toMatchObject({ emitted: [expect.any(String)] });
    expect(sent).toHaveLength(1);
  });

  it("acknowledges only after transport, so a restart redelivers but never skips", async () => {
    const cursors = new InMemoryDeliveryCursorStore();
    const firstAttempt = vi.fn(async () => ({ sent: false as const, reason: "transport-failure" as const }));
    const work = [scheduled(1), scheduled(3)];
    const failed = new EmissionScheduler({ cursors, emit: firstAttempt, recordIncident: () => {}, incrementCausalityFailure: () => {}, incrementDeliveryIntegrityCounter: () => {} });
    await expect(failed.run("hq-player", simTimeMs(1_000), work)).resolves.toMatchObject({ blocked: [expect.any(String), expect.any(String)] });
    expect(await cursors.read("hq-player")).toBeUndefined();

    const redelivered: string[] = [];
    const restarted = new EmissionScheduler(schedulerOptions(cursors, gateEmitter(redelivered)));
    await expect(restarted.run("hq-player", simTimeMs(1_000), work)).resolves.toMatchObject({ emitted: [expect.any(String), expect.any(String)] });
    expect(redelivered).toHaveLength(2);
    expect(await cursors.read("hq-player")).toMatchObject({ lowWatermark: 2, delivered: [] });
    await restarted.run("hq-player", simTimeMs(1_000), work);
    expect(redelivered).toHaveLength(2);
  });

  it("rejects malformed stored provenance before it can become a send", async () => {
    const emit = vi.fn(gateEmitter([]));
    const recordIncident = vi.fn();
    const incrementCausalityFailure = vi.fn();
    const scheduler = new EmissionScheduler({ cursors: new InMemoryDeliveryCursorStore(), emit, recordIncident, incrementCausalityFailure, incrementDeliveryIntegrityCounter: () => {} });
    const malformed = scheduled(1);
    (malformed.message.event.eventPosition as { x: number }).x = Number.NaN;

    await expect(scheduler.run("hq-player", simTimeMs(1_000), [malformed])).resolves.toMatchObject({ blocked: ["position:1"] });
    expect(emit).not.toHaveBeenCalled();
    expect(recordIncident).toHaveBeenCalledWith(expect.objectContaining({ reason: "invalid-position" }));
    expect(incrementCausalityFailure).toHaveBeenCalledOnce();
  });

  it("counts acknowledged-message suppression so duplicate presentation is observable", async () => {
    const cursors = new InMemoryDeliveryCursorStore();
    await cursors.acknowledge("hq-player", { deliverySequence: 1, messageId: "observer:hq-player/stream:sol/event:3/class:shipReport" });
    const emit = vi.fn(gateEmitter([]));
    const incrementDeliveryIntegrityCounter = vi.fn();
    const scheduler = new EmissionScheduler({
      cursors, emit, recordIncident: () => {}, incrementCausalityFailure: () => {}, incrementDeliveryIntegrityCounter
    });

    await expect(scheduler.run("hq-player", simTimeMs(1_000), [scheduled(3)])).resolves.toEqual({ emitted: [], deferred: [], blocked: [] });
    expect(emit).not.toHaveBeenCalled();
    expect(incrementDeliveryIntegrityCounter).toHaveBeenCalledOnce();
  });

  it("refuses a later pass that omits the acknowledged projection prefix", async () => {
    const cursors = new InMemoryDeliveryCursorStore();
    const sent: string[] = [];
    const scheduler = new EmissionScheduler(schedulerOptions(cursors, gateEmitter(sent)));
    const deferred = {
      ...scheduled(30),
      message: {
        ...scheduled(30).message,
        event: { ...scheduled(30).message.event, eventPosition: { x: SPEED_OF_LIGHT_METERS_PER_SECOND * 3, y: 0, z: 0 } }
      }
    };

    await expect(scheduler.run("hq-player", simTimeMs(1_000), [scheduled(10), scheduled(20), deferred])).resolves.toMatchObject({
      emitted: [expect.any(String), expect.any(String)], deferred: [expect.any(String)]
    });
    expect(await cursors.read("hq-player")).toMatchObject({ lowWatermark: 2, delivered: [] });

    await expect(scheduler.run("hq-player", simTimeMs(2_000), [deferred]))
      .rejects.toThrow(DeliveryProjectionViolation);
    expect(sent).toHaveLength(2);
  });

  it("delivers later-arriving events without head-of-line blocking and uses global position only for ties", async () => {
    const sent: string[] = [];
    const emit = vi.fn(gateEmitter(sent));
    const scheduler = new EmissionScheduler({
      cursors: new InMemoryDeliveryCursorStore(), emit, recordIncident: () => {}, incrementCausalityFailure: () => {}, incrementDeliveryIntegrityCounter: () => {}
    });

    const delayed = {
      ...scheduled(1),
      message: {
        ...scheduled(1).message,
        event: { ...scheduled(1).message.event, eventPosition: { x: SPEED_OF_LIGHT_METERS_PER_SECOND * 10, y: 0, z: 0 } }
      }
    };
    const readyLater = scheduled(3);
    const tiedHigher = scheduled(5);
    await expect(scheduler.run("hq-player", simTimeMs(1_000), [tiedHigher, delayed, readyLater])).resolves.toMatchObject({
      emitted: ["observer:hq-player/stream:sol/event:3/class:shipReport", "observer:hq-player/stream:sol/event:5/class:shipReport"],
      deferred: ["observer:hq-player/stream:sol/event:1/class:shipReport"]
    });
    expect(sent).toEqual(["observer:hq-player/stream:sol/event:3/class:shipReport", "observer:hq-player/stream:sol/event:5/class:shipReport"]);
  });
});
