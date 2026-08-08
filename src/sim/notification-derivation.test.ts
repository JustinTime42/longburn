import { describe, expect, it } from "vitest";

import { earliestLegalEmissionTimeMs, SPEED_OF_LIGHT_METERS_PER_SECOND } from "./causality.js";
import { simTimeMs } from "./clock.js";
import { burnDurationMs } from "./mass-cargo.js";
import { deriveLastRevisionWarnings, deriveLocalNotifications, deriveReportNotifications, lastRevisionInstantMs, type NotificationStoredEvent } from "./notification-derivation.js";

const atOrigin = () => ({ x: 0, y: 0, z: 0 });
const atOneLightSecond = () => ({ x: SPEED_OF_LIGHT_METERS_PER_SECOND, y: 0, z: 0 });

const stored = (globalPosition: number, type: "burnStarted" | "planRevisionApplied" | "planRevisionRefused" | "arrivalRecorded"): NotificationStoredEvent => ({
  streamId: "sol",
  event: {
    streamSequence: globalPosition,
    globalPosition,
    eventTime: simTimeMs(10_000),
    eventPosition: atOrigin(),
    event: type === "burnStarted"
      ? { type, node: { nodeId: "burn-1", executeAtMs: simTimeMs(10_000), kind: "accel" as const, burn: { burnDurationMs: burnDurationMs(1) }, deltaVMmPerSecond: { x: 0, y: 0, z: 0 } } }
      : type === "planRevisionApplied"
        ? { type, commandId: "command-1", flightPlan: { destination: "mars" as const, nodes: [] } }
        : type === "planRevisionRefused"
          ? { type, commandId: "command-2", reason: "invalid-plan" as const, flightPlan: { destination: "mars" as const, nodes: [] } }
          : { type, arrivalState: { arrivedAtMs: simTimeMs(10_000), destination: "mars" as const, targetPositionMeters: atOrigin(), terminalPositionMeters: atOrigin(), positionGapMeters: atOrigin(), velocityGapMmPerSecond: { x: 0, y: 0, z: 0 } } }
  }
});

describe("notification derivation", () => {
  it("derives each remote report at exactly the gate's earliest legal delivery tick", () => {
    const reports = [stored(1, "burnStarted"), stored(2, "planRevisionApplied"), stored(3, "planRevisionRefused"), stored(4, "arrivalRecorded")];
    const notifications = deriveReportNotifications(reports, atOneLightSecond);

    expect(notifications.map(({ kind }) => kind)).toEqual(["burnExecuted", "revisionApplied", "revisionRefused", "arrival"]);
    for (const [index, notification] of notifications.entries()) {
      const source = reports[index]!.event;
      expect(notification.deliverAtMs).toBe(earliestLegalEmissionTimeMs({
        eventTime: source.eventTime, emissionTime: source.eventTime, eventPosition: source.eventPosition, observerPositionAt: atOneLightSecond
      }));
      expect(notification.deliverAtMs).toBe(11_000);
    }
  });

  it("does not turn non-report events into notifications", () => {
    expect(deriveReportNotifications([{ streamId: "sol", event: { streamSequence: 1, globalPosition: 1, eventTime: simTimeMs(0), eventPosition: atOrigin(), event: { type: "clockAdvanced", elapsedMs: 1 } } }], atOrigin)).toEqual([]);
  });

  it("keeps planner openings and revision-deadline warnings local to HQ", () => {
    expect(deriveLocalNotifications(
      [{ windowId: "earth-mars-2030", opensAtMs: simTimeMs(4_000) }],
      [{ nodeId: "capture", lastRevisionAtMs: simTimeMs(5_000) }]
    )).toMatchObject([
      { kind: "transferWindowOpened", deliverAtMs: 4_000 },
      { kind: "lastRevisionInstant", deliverAtMs: 5_000 }
    ]);
  });

  it("computes the latest causal issue instant with the shared light-cone solver", () => {
    const last = lastRevisionInstantMs({ executeAtMs: simTimeMs(10_000), hqPositionAt: atOrigin, shipPositionAt: atOneLightSecond });
    expect(last).toBe(8_999);
    expect(deriveLastRevisionWarnings([
      { nodeId: "capture", executeAtMs: simTimeMs(10_000), kind: "decel", burn: { burnDurationMs: burnDurationMs(1) }, deltaVMmPerSecond: { x: 0, y: 0, z: 0 } }
    ], { hqPositionAt: atOrigin, shipPositionAt: atOneLightSecond })).toEqual([{ nodeId: "capture", lastRevisionAtMs: simTimeMs(8_999) }]);
  });

  it("does not invent a warning when a burn was already unreachable at simulation start", () => {
    expect(lastRevisionInstantMs({ executeAtMs: simTimeMs(500), hqPositionAt: atOrigin, shipPositionAt: atOneLightSecond })).toBeUndefined();
  });
});
