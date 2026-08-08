import { describe, expect, it, vi } from "vitest";

import { simTimeMs } from "../sim/clock.js";
import { InMemoryDeliveryCursorStore } from "../sim/delivery-cursor.js";
import type { EmissionCandidate, EmittableMessage } from "../sim/emitted-message.js";
import { EmissionScheduler, type ScheduledEmission } from "../sim/emission-scheduler.js";
import { CausalStateEgress } from "./causal-state-egress.js";

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
): ScheduledEmission => ({
  sourceGlobalPosition: globalPosition,
  message: {
    observerId: "hq-player",
    event: {
      streamId: "ship-1",
      streamSequence: globalPosition,
      globalPosition,
      eventTime: simTimeMs(eventTimeMs),
      eventPosition
    },
    class: "shipReport",
    payload: event === "arrivalRecorded" ? { event, destination: "mars" } : { event },
    observerPositionAt: () => HQ
  }
});

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

const wiredScheduler = (received: EmittableMessage[]) => {
  const recordIncident = vi.fn();
  const incrementCausalityFailure = vi.fn();
  const egress = new CausalStateEgress({ recordIncident, incrementCausalityFailure });
  const subscription = egress.subscribe("hq-player", {
    writeText: (payload) => received.push(JSON.parse(payload) as EmittableMessage)
  });
  const scheduler = new EmissionScheduler({
    cursors: new InMemoryDeliveryCursorStore(),
    emit: async (emission) => {
      const result = subscription.emit(emission);
      // Scheduler input is bound to this observer before egress. Keep the
      // impossible boundary refusal out of the scheduler's gate-result type.
      if (!result.sent && result.reason === "observer-mismatch") {
        throw new Error("Wired scheduler emitted for the wrong observer.");
      }
      return result;
    },
    recordIncident,
    incrementCausalityFailure,
    incrementBelowCursorSuppression: vi.fn()
  });
  return { scheduler, recordIncident, incrementCausalityFailure };
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
    const { scheduler, recordIncident, incrementCausalityFailure } = wiredScheduler(received);

    const result = await scheduler.run("hq-player", simTimeMs(40 * DAY_MS), scenarios);

    expect(result).toEqual({ emitted: scenarios.map((entry) =>
      `observer:hq-player/stream:ship-1/event:${entry.sourceGlobalPosition}/class:shipReport`), deferred: [], blocked: [] });
    expect(received).toHaveLength(scenarios.length); // Liveness: the gate cannot pass by sending nothing.
    expect(recordIncident).not.toHaveBeenCalled();
    expect(incrementCausalityFailure).not.toHaveBeenCalled();
    for (const message of received) {
      expect(message.emissionTimeMs).toBeGreaterThanOrEqual(independentEarliestTick(message.eventTimeMs, message.eventPosition));
      expect(message.stalenessMs).toBe(message.emissionTimeMs - message.eventTimeMs);
      expect(message.observerPosition).toEqual(HQ);
    }
  });

  it("blocks ceil(exact)-1 and releases ceil(exact) through the real WebSocket transport", () => {
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

  it("uses arrivalRecorded's stored terminal position, never the disagreeing body resolver position", async () => {
    // This is intentionally 3.3 light-seconds from HQ while the body resolver
    // would report HQ. Using the resolver would leak the report immediately.
    const terminalPositionMeters = { x: LIGHT_METERS_PER_SECOND * 3.3, y: 0, z: 0 };
    const bodyResolver = vi.fn(() => HQ);
    const arrival = report(1, 0, terminalPositionMeters, "arrivalRecorded");
    const received: EmittableMessage[] = [];
    const { scheduler } = wiredScheduler(received);
    const earliest = independentEarliestTick(0, terminalPositionMeters);

    expect(await scheduler.run("hq-player", simTimeMs(earliest - 1), [arrival])).toMatchObject({ deferred: [expect.any(String)] });
    expect(received).toEqual([]);
    expect(bodyResolver).not.toHaveBeenCalled();
    expect(await scheduler.run("hq-player", simTimeMs(earliest), [arrival])).toMatchObject({ emitted: [expect.any(String)] });
    expect(received[0]).toMatchObject({ eventPosition: terminalPositionMeters, stalenessMs: earliest });
    expect(bodyResolver).not.toHaveBeenCalled();
  });
});
