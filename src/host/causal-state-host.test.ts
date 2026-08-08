import { describe, expect, it, vi } from "vitest";

import { simTimeMs } from "../sim/clock.js";
import { InMemoryDeliveryCursorStore } from "../sim/delivery-cursor.js";
import type { SimEvent } from "../sim/event-log.js";
import type { EmittableMessage } from "../sim/emitted-message.js";
import { CausalStateHost, type StoredEventForEmission, projectStoredEvent } from "./causal-state-host.js";

const HQ = { x: 0, y: 0, z: 0 };
const observerPositionAt = () => HQ;

const stored = (event: SimEvent): StoredEventForEmission => ({
  streamId: "ship-1",
  event: {
    streamSequence: 4,
    globalPosition: 7,
    eventTime: simTimeMs(12_000),
    eventPosition: { x: 987_654_321, y: 0, z: 0 },
    event
  }
});

describe("projectStoredEvent", () => {
  it("derives a ship report solely from an arrival's persisted provenance", () => {
    const source = stored({
      type: "arrivalRecorded",
      arrivalState: {
        arrivedAtMs: simTimeMs(12_000), destination: "mars", targetPositionMeters: HQ,
        terminalPositionMeters: { x: 987_654_321, y: 0, z: 0 }, positionGapMeters: HQ,
        velocityGapMmPerSecond: { x: 0, y: 0, z: 0 }
      }
    });

    expect(projectStoredEvent("player-1", observerPositionAt, source)).toEqual({
      sourceGlobalPosition: 7,
      message: {
        observerId: "player-1",
        event: {
          streamId: "ship-1", streamSequence: 4, globalPosition: 7,
          eventTime: simTimeMs(12_000), eventPosition: { x: 987_654_321, y: 0, z: 0 }
        },
        class: "shipReport", payload: { event: "arrivalRecorded", destination: "mars" }, observerPositionAt
      }
    });
  });

  it("projects durable command identities and omits observer-local command echoes", () => {
    const applied = stored({
      type: "planRevisionApplied", commandId: "command-7", replacedNodeIds: [],
      flightPlan: { destination: "mars", nodes: [] }
    });
    expect(projectStoredEvent("player-1", observerPositionAt, applied)).toMatchObject({
      message: { class: "commandOutcomeReport", payload: { outcome: "applied", commandId: "command-7" } }
    });

    expect(projectStoredEvent("player-1", observerPositionAt, stored({
      type: "commandIssued", commandId: "command-8", issuedAtMs: simTimeMs(12_000), arrivalAtMs: simTimeMs(12_000),
      hqPosition: HQ, arrivalPosition: HQ, replacedNodeIds: [], flightPlan: { destination: "mars", nodes: [] }
    }))).toBeUndefined();
  });

  it("quarantines an unprojectable record without aborting a later delivery or raising a causality alarm", async () => {
    const received: EmittableMessage[] = [];
    const recordIncident = vi.fn();
    const incrementCausalityFailure = vi.fn();
    const host = new CausalStateHost({
      cursors: new InMemoryDeliveryCursorStore(), observerId: "player-1", observerPositionAt,
      socket: { writeText: (payload) => received.push(JSON.parse(payload) as EmittableMessage) },
      recordIncident, incrementCausalityFailure, incrementBelowCursorSuppression: vi.fn()
    });
    const malformed = { ...stored({ type: "clockAdvanced", elapsedMs: 1 }), streamId: "" };
    const deliverable = {
      ...stored({ type: "departureRecorded", departureState: { departureAtMs: simTimeMs(12_000), positionMeters: HQ, velocityMmPerSecond: HQ } }),
      event: { ...stored({ type: "departureRecorded", departureState: { departureAtMs: simTimeMs(12_000), positionMeters: HQ, velocityMmPerSecond: HQ } }).event, streamSequence: 5, globalPosition: 8, eventPosition: HQ,
        event: { type: "departureRecorded" as const, departureState: { departureAtMs: simTimeMs(12_000), positionMeters: HQ, velocityMmPerSecond: HQ } } }
    };

    await expect(host.run(simTimeMs(12_001), [malformed, deliverable])).resolves.toMatchObject({
      emitted: ["observer:player-1/stream:ship-1/event:5/class:shipReport"], blocked: ["position:7"]
    });
    expect(received).toHaveLength(1);
    expect(recordIncident).toHaveBeenCalledWith(expect.objectContaining({ reason: "invalid-envelope" }));
    expect(incrementCausalityFailure).not.toHaveBeenCalled();

    await expect(host.run(simTimeMs(12_002), [malformed])).resolves.toEqual({
      emitted: [], deferred: [], blocked: ["position:7"]
    });
    expect(recordIncident).toHaveBeenCalledOnce();
    expect(incrementCausalityFailure).not.toHaveBeenCalled();
  });
});
