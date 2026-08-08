import { describe, expect, it, vi } from "vitest";

import { simTimeMs } from "../sim/clock.js";
import { InMemoryDeliveryCursorStore } from "../sim/delivery-cursor.js";
import { InMemorySimulationEventStore, type StoredSimEvent } from "../sim/event-store.js";
import type { EmissionCandidate, EmittableMessage } from "../sim/emitted-message.js";
import { AuthoritativeSimLoop } from "../sim/loop.js";
import { burnDurationMs } from "../sim/mass-cargo.js";
import { CausalStateEgress } from "./causal-state-egress.js";
import { CausalStateHost, type StoredEventForEmission } from "./causal-state-host.js";

// Deliberately independent from ../sim/causality.ts. This is the physical
// oracle for the stationary Tier 0 HQ used by this end-to-end composition.
const LIGHT_METERS_PER_SECOND = 299_792_458;
const DAY_MS = 24 * 60 * 60 * 1_000;
const HQ = { x: 0, y: 0, z: 0 };

const distanceFromHq = (position: { readonly x: number; readonly y: number; readonly z: number }): number =>
  Math.hypot(position.x - HQ.x, position.y - HQ.y, position.z - HQ.z);

const independentEarliestTick = (eventTimeMs: number, eventPosition: { readonly x: number; readonly y: number; readonly z: number }): number =>
  eventTimeMs + Math.ceil((distanceFromHq(eventPosition) / LIGHT_METERS_PER_SECOND) * 1_000);

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

const candidate = (eventTimeMs: number, emissionTimeMs: number, eventPosition: { readonly x: number; readonly y: number; readonly z: number }): EmissionCandidate => ({
  messageId: "deliberately-violating-message",
  observerId: "hq-player",
  class: "shipReport",
  payload: { event: "departureRecorded" },
  eventTimeMs: simTimeMs(eventTimeMs),
  emissionTimeMs: simTimeMs(emissionTimeMs),
  eventPosition,
  observerPositionAt: () => HQ
});

const wiredHost = (received: EmittableMessage[]) => {
  const recordIncident = vi.fn();
  const incrementCausalityFailure = vi.fn();
  const host = new CausalStateHost({
    cursors: new InMemoryDeliveryCursorStore(),
    observerId: "hq-player",
    observerPositionAt: () => HQ,
    socket: { writeText: (payload) => received.push(JSON.parse(payload) as EmittableMessage) },
    recordIncident, incrementCausalityFailure, incrementBelowCursorSuppression: vi.fn()
  });
  return { host, recordIncident, incrementCausalityFailure };
};

describe("causal state egress end-to-end", () => {
  it("delivers the complete seeded 40-day transit stream at HQ with causal provenance and authoritative staleness", async () => {
    // Earth, Moon, a point mid-transit, and Mars. The values are seeded test
    // data, not ephemeris queries, so the virtual-clock run is reproducible.
    const scenarios = [
      report(1, 0, { x: 0, y: 0, z: 0 }),
      report(2, 4 * DAY_MS, { x: 384_400_000, y: 0, z: 0 }),
      report(3, 20 * DAY_MS, { x: 72_000_000_000, y: 9_000_000_000, z: 0 }),
      report(4, 39 * DAY_MS, { x: 224_000_000_000, y: -4_000_000_000, z: 0 }, "arrivalRecorded")
    ];
    const received: EmittableMessage[] = [];
    const { host, recordIncident, incrementCausalityFailure } = wiredHost(received);

    const result = await host.run(simTimeMs(40 * DAY_MS), scenarios);

    expect(result).toEqual({ emitted: scenarios.map((entry) =>
      `observer:hq-player/stream:ship-1/event:${entry.event.streamSequence}/class:shipReport`), deferred: [], blocked: [] });
    expect(received).toHaveLength(scenarios.length); // Liveness: the gate cannot pass by sending nothing.
    expect(recordIncident).not.toHaveBeenCalled();
    expect(incrementCausalityFailure).not.toHaveBeenCalled();
    for (const message of received) {
      expect(message.emissionTimeMs).toBeGreaterThanOrEqual(independentEarliestTick(message.eventTimeMs, message.eventPosition));
      expect(message.stalenessMs).toBe(message.emissionTimeMs - message.eventTimeMs);
      expect(message.observerPosition).toEqual(HQ);
    }
  });

  it("blocks ceil(exact)-1 and releases ceil(exact) through the egress transport boundary", () => {
    const eventPosition = { x: 1_234_567_890, y: 0, z: 0 };
    const earliest = independentEarliestTick(50_000, eventPosition);
    const writeText = vi.fn();
    const egress = new CausalStateEgress({ recordIncident: vi.fn(), incrementCausalityFailure: vi.fn() });
    const subscription = egress.subscribe("hq-player", { writeText });

    expect(subscription.emit(candidate(50_000, earliest - 1, eventPosition))).toEqual({ sent: false, reason: "early-emission" });
    expect(writeText).not.toHaveBeenCalled();
    expect(subscription.emit(candidate(50_000, earliest, eventPosition))).toEqual({ sent: true });
    expect(writeText).toHaveBeenCalledOnce();
  });

  it("proves the real transport fixture fails closed for a deliberately early message", () => {
    const writeText = vi.fn();
    const recordIncident = vi.fn();
    const incrementCausalityFailure = vi.fn();
    const egress = new CausalStateEgress({ recordIncident, incrementCausalityFailure });
    const subscription = egress.subscribe("hq-player", { writeText });
    const eventPosition = { x: LIGHT_METERS_PER_SECOND * 3, y: 0, z: 0 };

    expect(subscription.emit(candidate(0, 2_999, eventPosition))).toEqual({ sent: false, reason: "early-emission" });
    expect(writeText).not.toHaveBeenCalled();
    expect(recordIncident).toHaveBeenCalledWith(expect.objectContaining({ reason: "early-emission" }));
    expect(incrementCausalityFailure).toHaveBeenCalledOnce();
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
