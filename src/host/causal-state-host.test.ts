import { describe, expect, it } from "vitest";

import { simTimeMs } from "../sim/clock.js";
import type { SimEvent } from "../sim/event-log.js";
import type { StoredEventForEmission } from "./causal-state-host.js";
import { projectStoredEvent } from "./causal-state-host.js";

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

  it("projects durable command identities and rejects an ambiguous outcome", () => {
    const applied = stored({
      type: "planRevisionApplied", commandId: "command-7", replacedNodeIds: [],
      flightPlan: { destination: "mars", nodes: [] }
    });
    expect(projectStoredEvent("player-1", observerPositionAt, applied)).toMatchObject({
      message: { class: "commandOutcomeReport", payload: { outcome: "applied", commandId: "command-7" } }
    });

    const ambiguous = stored({ type: "planRevisionApplied", flightPlan: { destination: "mars", nodes: [] } });
    expect(() => projectStoredEvent("player-1", observerPositionAt, ambiguous)).toThrow("durable command ID");
  });
});
