import { describe, expect, it, vi } from "vitest";

import { simTimeMs } from "../sim/clock.js";
import { InMemoryDeliveryCursorStore } from "../sim/delivery-cursor.js";
import { InMemorySimulationEventStore, type StoredSimEvent } from "../sim/event-store.js";
import { validateEmittedMessage, type EmittableMessage } from "../sim/emitted-message.js";
import { AuthoritativeSimLoop } from "../sim/loop.js";
import { burnDurationMs } from "../sim/mass-cargo.js";
import { CausalStateHost, type StoredEventForEmission } from "./causal-state-host.js";

// Deliberately independent from ../sim/causality.ts. These are physical
// oracles for the end-to-end composition.
const LIGHT_METERS_PER_SECOND = 299_792_458;
const DAY_MS = 24 * 60 * 60 * 1_000;
const HQ = { x: 0, y: 0, z: 0 };

const distanceFromHq = (position: { readonly x: number; readonly y: number; readonly z: number }): number =>
  Math.hypot(position.x - HQ.x, position.y - HQ.y, position.z - HQ.z);

const independentEarliestTick = (eventTimeMs: number, eventPosition: { readonly x: number; readonly y: number; readonly z: number }): number =>
  eventTimeMs + Math.ceil((distanceFromHq(eventPosition) / LIGHT_METERS_PER_SECOND) * 1_000);

/** Exact arrival for a receiver moving at constant velocity from the origin. */
const movingObserverEarliestTick = (
  eventTimeMs: number,
  eventPosition: { readonly x: number; readonly y: number; readonly z: number },
  velocityMetersPerSecond: number
): number => {
  const elapsedSecondsAtEvent = eventTimeMs / 1_000;
  const xSquared = eventPosition.x ** 2 + eventPosition.z ** 2;
  const yOffset = eventPosition.y - velocityMetersPerSecond * elapsedSecondsAtEvent;
  const cSquared = LIGHT_METERS_PER_SECOND ** 2;
  const quadraticA = cSquared - velocityMetersPerSecond ** 2;
  const quadraticB = 2 * velocityMetersPerSecond * yOffset;
  const quadraticC = -(xSquared + yOffset ** 2);
  const elapsedSeconds = (-quadraticB + Math.sqrt(quadraticB ** 2 - 4 * quadraticA * quadraticC)) / (2 * quadraticA);
  return eventTimeMs + Math.ceil(elapsedSeconds * 1_000);
};

const report = (
  globalPosition: number,
  eventTimeMs: number,
  eventPosition: { readonly x: number; readonly y: number; readonly z: number },
  event: "departureRecorded" | "arrivalRecorded" = "departureRecorded"
): StoredEventForEmission => ({
  streamId: "ship-1",
  event: {
    streamSequence: globalPosition,
    globalPosition,
    eventTime: simTimeMs(eventTimeMs),
    eventPosition,
    event: event === "arrivalRecorded"
      ? {
          type: event,
          arrivalState: {
            arrivedAtMs: simTimeMs(eventTimeMs), destination: "mars", targetPositionMeters: eventPosition,
            terminalPositionMeters: eventPosition, positionGapMeters: { x: 0, y: 0, z: 0 }, velocityGapMmPerSecond: { x: 0, y: 0, z: 0 }
          }
        }
      : {
          type: event,
          departureState: { departureAtMs: simTimeMs(eventTimeMs), positionMeters: eventPosition, velocityMmPerSecond: { x: 0, y: 0, z: 0 } }
        }
  }
});

const storedArrival = (arrival: StoredSimEvent): StoredEventForEmission => {
  if (arrival.event.type !== "arrivalRecorded") throw new Error("Expected an authoritative arrival record.");
  return {
    streamId: "arrival-position-regression",
    event: arrival
  };
};

const wiredHost = (received: EmittableMessage[], observerPositionAt: (timeMs: number) => { readonly x: number; readonly y: number; readonly z: number } = () => HQ) => {
  const recordIncident = vi.fn();
  const incrementCausalityFailure = vi.fn();
  const host = new CausalStateHost({
    cursors: new InMemoryDeliveryCursorStore(),
    observerId: "hq-player",
    observerPositionAt,
    socket: { writeText: (payload) => received.push(validateEmittedMessage(JSON.parse(payload))) },
    recordIncident, incrementCausalityFailure, incrementBelowCursorSuppression: vi.fn()
  });
  return { host, recordIncident, incrementCausalityFailure };
};

describe("causal state egress end-to-end", () => {
  it("tick-steps the complete seeded 40-day transit stream at HQ with causal provenance and authoritative staleness", async () => {
    // Earth, Moon, a point mid-transit, and Mars. The values are seeded test
    // data, not ephemeris queries, so the virtual-clock run is reproducible.
    const scenarios = [
      report(1, 1_000, { x: 0, y: 0, z: 0 }),
      report(2, 4 * DAY_MS, { x: 384_400_000, y: 0, z: 0 }),
      report(3, 20 * DAY_MS, { x: 72_000_000_000, y: 9_000_000_000, z: 0 }),
      report(4, 39 * DAY_MS, { x: 224_000_000_000, y: -4_000_000_000, z: 0 }, "arrivalRecorded")
    ];
    const received: EmittableMessage[] = [];
    const { host, recordIncident, incrementCausalityFailure } = wiredHost(received);

    for (const [index, scenario] of scenarios.entries()) {
      const earliest = independentEarliestTick(scenario.event.eventTime, scenario.event.eventPosition);
      const messageId = `observer:hq-player/stream:ship-1/event:${scenario.event.streamSequence}/class:shipReport`;
      expect(await host.run(simTimeMs(earliest - 1), scenarios)).toMatchObject({ emitted: [], deferred: expect.arrayContaining([messageId]), blocked: [] });
      expect(await host.run(simTimeMs(earliest), scenarios)).toMatchObject({ emitted: [messageId], blocked: [] });
      expect(received).toHaveLength(index + 1);
    }
    expect(received).toHaveLength(scenarios.length); // Liveness: the gate cannot pass by sending nothing.
    expect(recordIncident).not.toHaveBeenCalled();
    expect(incrementCausalityFailure).not.toHaveBeenCalled();
    for (const message of received) {
      expect(message.emissionTimeMs).toBeGreaterThanOrEqual(independentEarliestTick(message.eventTimeMs, message.eventPosition));
      expect(message.stalenessMs).toBe(message.emissionTimeMs - message.eventTimeMs);
      expect(message.observerPosition).toEqual(HQ);
    }
  });

  it("blocks ceil(exact)-1 and releases ceil(exact) through the scheduler-to-egress transport boundary", async () => {
    const eventPosition = { x: 1_234_567_890, y: 0, z: 0 };
    const earliest = independentEarliestTick(50_000, eventPosition);
    const received: EmittableMessage[] = [];
    const { host } = wiredHost(received);
    const boundary = report(1, 50_000, eventPosition);

    await expect(host.run(simTimeMs(earliest - 1), [boundary])).resolves.toMatchObject({ emitted: [], deferred: [expect.any(String)], blocked: [] });
    expect(received).toEqual([]);
    await expect(host.run(simTimeMs(earliest), [boundary])).resolves.toMatchObject({ emitted: [expect.any(String)], deferred: [], blocked: [] });
    expect(received).toHaveLength(1);
  });

  it("delivers a near event while the same composed pass defers a farther event", async () => {
    const received: EmittableMessage[] = [];
    const { host } = wiredHost(received);
    const near = report(2, 10_000, { x: LIGHT_METERS_PER_SECOND, y: 0, z: 0 });
    const far = report(1, 10_000, { x: LIGHT_METERS_PER_SECOND * 3, y: 0, z: 0 });

    await expect(host.run(simTimeMs(11_000), [near, far])).resolves.toMatchObject({
      emitted: ["observer:hq-player/stream:ship-1/event:2/class:shipReport"],
      deferred: ["observer:hq-player/stream:ship-1/event:1/class:shipReport"], blocked: []
    });
    expect(received).toHaveLength(1);
    expect(received[0]?.eventPosition).toEqual(near.event.eventPosition);
  });

  it("uses a moving observer worldline at the independent retarded-time boundary", async () => {
    const marsDistanceMeters = 224_000_000_000;
    const marsLightTimeSeconds = marsDistanceMeters / LIGHT_METERS_PER_SECOND;
    // Earth moves about 0.07 light-seconds over this Mars light time.
    const velocityMetersPerSecond = (0.07 * LIGHT_METERS_PER_SECOND) / marsLightTimeSeconds;
    const observerPositionAt = (timeMs: number) => ({ x: 0, y: velocityMetersPerSecond * (timeMs / 1_000), z: 0 });
    const movingReport = report(1, 1_000, { x: 0, y: -marsDistanceMeters, z: 0 });
    const earliest = movingObserverEarliestTick(movingReport.event.eventTime, movingReport.event.eventPosition, velocityMetersPerSecond);
    expect(earliest).not.toBe(independentEarliestTick(movingReport.event.eventTime, movingReport.event.eventPosition));
    const received: EmittableMessage[] = [];
    const { host } = wiredHost(received, observerPositionAt);

    await expect(host.run(simTimeMs(earliest - 1), [movingReport])).resolves.toMatchObject({ emitted: [], deferred: [expect.any(String)], blocked: [] });
    await expect(host.run(simTimeMs(earliest), [movingReport])).resolves.toMatchObject({ emitted: [expect.any(String)], blocked: [] });
    expect(received[0]?.observerPosition).toEqual(observerPositionAt(earliest));
  });

  it("uses an authoritative arrivalRecorded stored terminal position over a disagreeing event-position resolver", async () => {
    // This dock is intentionally 3.3 light-seconds from HQ while the resolver
    // supplied to the live loop reports HQ. The persisted arrival must retain
    // the transit terminal position, or the scheduler would release it early.
    const terminalPositionMeters = { x: Math.round(LIGHT_METERS_PER_SECOND * 3.3), y: 0, z: 0 };
    const dock = {
      positionMeters: terminalPositionMeters,
      velocityMmPerSecond: { x: 0, y: 0, z: 0 }
    };
    const loop = await AuthoritativeSimLoop.create({
      store: new InMemorySimulationEventStore(),
      stream: { id: "arrival-position-regression", seed: 1, initialTime: simTimeMs(0) },
      departureStateAt: (time) => ({ departureAtMs: time, ...dock }),
      destinationStateAt: () => dock
    });
    const eventPositionAt = vi.fn(() => HQ);
    await loop.applyPlanRevision({
      destination: "mars",
      nodes: [{
        nodeId: "dock", executeAtMs: simTimeMs(1), kind: "decel",
        burn: { burnDurationMs: burnDurationMs(1) },
        deltaVMmPerSecond: { x: 0, y: 0, z: 0 }
      }]
    }, eventPositionAt);
    await loop.advance(2, eventPositionAt);
    const arrival = (await loop.persistedStream()).events.find(({ event }) => event.type === "arrivalRecorded");
    if (arrival === undefined) throw new Error("Expected AuthoritativeSimLoop to persist arrivalRecorded.");
    expect(arrival.eventPosition).toEqual(terminalPositionMeters);

    const received: EmittableMessage[] = [];
    const { host } = wiredHost(received);
    const earliest = independentEarliestTick(arrival.eventTime, terminalPositionMeters);
    const stored = storedArrival(arrival);

    expect(await host.run(simTimeMs(earliest - 1), [stored])).toMatchObject({ deferred: [expect.any(String)] });
    expect(received).toEqual([]);
    expect(await host.run(simTimeMs(earliest), [stored])).toMatchObject({ emitted: [expect.any(String)] });
    expect(received[0]).toMatchObject({ eventPosition: terminalPositionMeters, stalenessMs: earliest - arrival.eventTime });
  });
});
