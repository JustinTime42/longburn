import { describe, expect, it } from "vitest";

import { simTimeMs } from "./clock.js";
import { buildEmittedMessage, emittedMessageId, youngestStoredEmissionEvent, validateEmittedMessage } from "./emitted-message.js";

const storedEvent = {
  streamId: "sol-1",
  streamSequence: 41,
  eventTime: simTimeMs(1_000),
  eventPosition: { x: 1_000, y: 2_000, z: 3_000 }
};

describe("emitted message schema", () => {
  it("copies stored event provenance, never resolving a newer position", () => {
    const message = buildEmittedMessage({
      observerId: "player-1", event: storedEvent, class: "shipReport",
      payload: { event: "arrivalRecorded", destination: "mars" },
      emissionTimeMs: simTimeMs(4_300), observerPosition: { x: 4_000, y: 0, z: 0 }
    });

    storedEvent.eventPosition.x = 99_999;
    expect(message.eventPosition).toEqual({ x: 1_000, y: 2_000, z: 3_000 });
    expect(message.stalenessMs).toBe(3_300);
  });

  it("uses the youngest event, then log order, for aggregate provenance and idempotence", () => {
    const older = { ...storedEvent, streamSequence: 7, eventTime: simTimeMs(10), eventPosition: { x: 7, y: 0, z: 0 } };
    const younger = { ...storedEvent, streamSequence: 9, eventTime: simTimeMs(20), eventPosition: { x: 9, y: 0, z: 0 } };
    const sameTimeLaterInLog = { ...storedEvent, streamSequence: 10, eventTime: simTimeMs(20), eventPosition: { x: 10, y: 0, z: 0 } };
    const youngest = youngestStoredEmissionEvent([younger, older, sameTimeLaterInLog]);

    expect(youngest).toBe(sameTimeLaterInLog);
    expect(emittedMessageId("player-1", youngest, "shipReport")).toContain("/event:10/");
  });

  it("keeps an idempotence key stable across redelivery ticks", () => {
    const first = buildEmittedMessage({
      observerId: "player-1", event: storedEvent, class: "shipReport", payload: { event: "burnEnded", nodeId: "burn-1" },
      emissionTimeMs: simTimeMs(1_000), observerPosition: { x: 0, y: 0, z: 0 }
    });
    const retry = buildEmittedMessage({
      observerId: "player-1", event: storedEvent, class: "shipReport", payload: { event: "burnEnded", nodeId: "burn-1" },
      emissionTimeMs: simTimeMs(1_001), observerPosition: { x: 0, y: 0, z: 0 }
    });

    expect(retry.messageId).toBe(first.messageId);
    expect(retry.stalenessMs).toBe(1);
  });

  it("permits all current payload classes and keeps observer-local classes at zero lag", () => {
    expect(() => buildEmittedMessage({
      observerId: "player-1", event: storedEvent, class: "shipReport", payload: { event: "burnStarted", nodeId: "burn-1" },
      emissionTimeMs: simTimeMs(1_001), observerPosition: { x: 0, y: 0, z: 0 }
    })).not.toThrow();
    expect(() => buildEmittedMessage({
      observerId: "player-1", event: storedEvent, class: "commandOutcomeReport",
      payload: { outcome: "refused", commandId: "cmd-1", reason: "invalid-plan" },
      emissionTimeMs: simTimeMs(1_001), observerPosition: { x: 0, y: 0, z: 0 }
    })).not.toThrow();
    expect(() => buildEmittedMessage({
      observerId: "player-1", event: storedEvent, class: "commandEcho", payload: { commandId: "cmd-1" },
      emissionTimeMs: simTimeMs(1_001), observerPosition: { x: 0, y: 0, z: 0 }
    })).toThrow("zero staleness");
  });

  it("fails closed on malformed provenance, NaN, stale metadata, and reserved classes", () => {
    const valid = buildEmittedMessage({
      observerId: "player-1", event: storedEvent, class: "simClock", payload: { currentTimeMs: simTimeMs(1_000) },
      emissionTimeMs: simTimeMs(1_000), observerPosition: { x: 0, y: 0, z: 0 }
    });

    expect(() => validateEmittedMessage({ ...valid, eventTimeMs: Number.NaN })).toThrow("provenance times");
    expect(() => validateEmittedMessage({ ...valid, stalenessMs: 1 })).toThrow("staleness");
    expect(() => validateEmittedMessage({ ...valid, class: "marketEvent" })).toThrow("not an emitted T0");
  });
});
