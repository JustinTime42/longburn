import { describe, expect, it } from "vitest";

import { simTimeMs } from "./clock.js";
import { CausalEmissionGate } from "./causality.js";
import { buildEmittedMessage, emittedMessageId, youngestStoredEmissionEvent, validateEmittedMessage, type EmittedMessage } from "./emitted-message.js";

const storedEvent = {
  streamId: "sol-1",
  streamSequence: 41,
  globalPosition: 101,
  eventTime: simTimeMs(1_000),
  eventPosition: { x: 1_000, y: 2_000, z: 3_000 }
};

describe("emitted message schema", () => {
  const emit = (candidate: ReturnType<typeof buildEmittedMessage>) => {
    const sent: unknown[] = [];
    const gate = new CausalEmissionGate({ send: (message) => sent.push(message), recordIncident: () => {}, incrementCausalityFailure: () => {} });
    expect(gate.emit(candidate)).toEqual({ sent: true });
    return validateEmittedMessage(sent[0]);
  };
  const refusedReason = (message: EmittedMessage): string | undefined => {
    if (message.class === "commandOutcomeReport" && message.payload.outcome === "refused") return message.payload.reason;
    return undefined;
  };

  it("copies stored event provenance, never resolving a newer position", () => {
    const message = buildEmittedMessage({
      observerId: "player-1", event: storedEvent, class: "shipReport",
      payload: { event: "arrivalRecorded", destination: "mars" },
      emissionTimeMs: simTimeMs(4_300), observerPositionAt: () => ({ x: 4_000, y: 0, z: 0 })
    });

    storedEvent.eventPosition.x = 99_999;
    const emitted = emit(message);
    expect(emitted.eventPosition).toEqual({ x: 1_000, y: 2_000, z: 3_000 });
    expect(emitted.stalenessMs).toBe(3_300);
    expect(emitted.observerId).toBe("player-1");
  });

  it("uses the youngest event, then log order, for aggregate provenance and idempotence", () => {
    const older = { ...storedEvent, streamSequence: 7, eventTime: simTimeMs(10), eventPosition: { x: 7, y: 0, z: 0 } };
    const younger = { ...storedEvent, streamSequence: 9, eventTime: simTimeMs(20), eventPosition: { x: 9, y: 0, z: 0 } };
    const sameTimeLaterInLog = { ...storedEvent, streamSequence: 2, globalPosition: 109, eventTime: simTimeMs(20), eventPosition: { x: 10, y: 0, z: 0 } };
    const youngest = youngestStoredEmissionEvent([younger, older, sameTimeLaterInLog]);

    expect(youngest).toBe(sameTimeLaterInLog);
    expect(emittedMessageId("player-1", youngest, "shipReport")).toContain("/event:2/");
  });

  it("keeps an idempotence key stable across redelivery ticks", () => {
    const first = buildEmittedMessage({
      observerId: "player-1", event: storedEvent, class: "shipReport", payload: { event: "burnEnded", nodeId: "burn-1" },
      emissionTimeMs: simTimeMs(1_000), observerPositionAt: () => ({ x: 0, y: 0, z: 0 })
    });
    const retry = buildEmittedMessage({
      observerId: "player-1", event: storedEvent, class: "shipReport", payload: { event: "burnEnded", nodeId: "burn-1" },
      emissionTimeMs: simTimeMs(1_001), observerPositionAt: () => ({ x: 0, y: 0, z: 0 })
    });

    expect(retry.messageId).toBe(first.messageId);
    expect(emit(retry).stalenessMs).toBe(1);
  });

  it("leaves observer-local timing validation to the gate choke point", () => {
    expect(() => buildEmittedMessage({
      observerId: "player-1", event: storedEvent, class: "shipReport", payload: { event: "burnStarted", nodeId: "burn-1" },
      emissionTimeMs: simTimeMs(1_001), observerPositionAt: () => ({ x: 0, y: 0, z: 0 })
    })).not.toThrow();
    expect(() => buildEmittedMessage({
      observerId: "player-1", event: storedEvent, class: "commandOutcomeReport",
      payload: { outcome: "refused", commandId: "cmd-1", reason: "invalid-plan" },
      emissionTimeMs: simTimeMs(1_001), observerPositionAt: () => storedEvent.eventPosition
    })).not.toThrow();
    const invalidTiming = buildEmittedMessage({
      observerId: "player-1", event: storedEvent, class: "commandEcho", payload: { commandId: "cmd-1" },
      emissionTimeMs: simTimeMs(1_001), observerPositionAt: () => ({ x: 0, y: 0, z: 0 })
    });
    const sent: unknown[] = [];
    const gate = new CausalEmissionGate({ send: (message) => sent.push(message), recordIncident: () => {}, incrementCausalityFailure: () => {} });
    expect(gate.emit(invalidTiming)).toEqual({ sent: false, reason: "invalid-envelope" });
    expect(sent).toHaveLength(0);

    const outcome = emit(buildEmittedMessage({
      observerId: "player-1", event: storedEvent, class: "commandOutcomeReport",
      payload: { outcome: "refused", commandId: "cmd-1", reason: "invalid-plan" },
      emissionTimeMs: simTimeMs(1_001), observerPositionAt: () => ({ x: 0, y: 0, z: 0 })
    }));
    expect(refusedReason(outcome)).toBe("invalid-plan");
  });

  it("emits a zero-staleness command echo through the causal gate", () => {
    const echo = emit(buildEmittedMessage({
      observerId: "player-1", event: storedEvent, class: "commandEcho", payload: { commandId: "cmd-1" },
      emissionTimeMs: storedEvent.eventTime, observerPositionAt: () => storedEvent.eventPosition
    }));

    expect(echo).toMatchObject({
      class: "commandEcho",
      payload: { commandId: "cmd-1" },
      stalenessMs: 0
    });
  });

  it("defensively rejects an unsafe-cast unconstructible class", () => {
    const invalidInput = {
      observerId: "player-1", event: storedEvent, class: "bodyEphemerides", payload: {},
      emissionTimeMs: simTimeMs(1_000), observerPositionAt: () => ({ x: 0, y: 0, z: 0 })
    } as unknown as Parameters<typeof buildEmittedMessage>[0];

    expect(() => buildEmittedMessage(invalidInput)).toThrow("Cannot build an emitted message from class bodyEphemerides");
  });

  it("fails closed on malformed provenance, NaN, stale metadata, and reserved classes", () => {
    const valid = buildEmittedMessage({
      observerId: "player-1", event: storedEvent, class: "simClock", payload: { currentTimeMs: simTimeMs(1_000) },
      emissionTimeMs: simTimeMs(1_000), observerPositionAt: () => storedEvent.eventPosition
    });

    const emitted = emit(valid);
    expect(() => validateEmittedMessage({ ...emitted, eventTimeMs: Number.NaN })).toThrow("provenance times");
    expect(() => validateEmittedMessage({ ...emitted, stalenessMs: 1 })).toThrow("staleness");
    expect(() => validateEmittedMessage({ ...emitted, observerId: "" })).toThrow("observer IDs");
    expect(() => validateEmittedMessage({ ...emitted, class: "bodyEphemerides" })).toThrow("not an emitted T0");
  });
});
