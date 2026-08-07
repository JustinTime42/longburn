import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { SPEED_OF_LIGHT_METERS_PER_SECOND } from "./causality.js";
import { simTimeMs } from "./clock.js";
import { replayPersistedSegment, replaySegment, type SimEvent } from "./event-log.js";
import { burnDurationMs, dequantizeBurnParameters, quantizeBurnParameters } from "./mass-cargo.js";

const node = (nodeId: string, executeAtMs: number, durationMs = 1) => ({
  nodeId, executeAtMs: simTimeMs(executeAtMs), kind: "accel" as const,
  burn: { burnDurationMs: burnDurationMs(durationMs) }
});

const replayBothPaths = (events: readonly SimEvent[], initialTime = 0): void => {
  const persisted = { seed: 1, initialTime: simTimeMs(initialTime), events: events.map((event) => ({ event })) };
  expect(replayPersistedSegment(persisted)).toEqual(replaySegment(1, events, simTimeMs(initialTime)));
};

describe("inbound causality invariant", () => {
  it("accepts the exact static light-time boundary and rejects one millisecond early on both replay paths", () => {
    fc.assert(fc.property(
      fc.integer({ min: 0, max: 1_000_000 }),
      fc.integer({ min: -20_000_000_000, max: 20_000_000_000 }),
      fc.integer({ min: -20_000_000_000, max: 20_000_000_000 }),
      fc.integer({ min: -20_000_000_000, max: 20_000_000_000 }),
      (issuedAtMs, x, y, z) => {
        const hqPosition = { x, y, z };
        const arrivalPosition = { x: 0, y: 0, z: 0 };
        const lightTimeMs = Math.ceil((Math.hypot(x, y, z) / SPEED_OF_LIGHT_METERS_PER_SECOND) * 1_000);
        const arrivalAtMs = issuedAtMs + lightTimeMs;
        const command: SimEvent = {
          type: "commandIssued", commandId: "command", issuedAtMs: simTimeMs(issuedAtMs), arrivalAtMs: simTimeMs(arrivalAtMs),
          hqPosition, arrivalPosition, replacedNodeIds: [], flightPlan: { nodes: [] }
        };
        const prefix: SimEvent[] = issuedAtMs === 0 ? [] : [{ type: "clockAdvanced", elapsedMs: issuedAtMs }];
        expect(() => replayBothPaths([...prefix, command])).not.toThrow();
        if (lightTimeMs > 0) {
          const early: SimEvent = { ...command, arrivalAtMs: simTimeMs(arrivalAtMs - 1) };
          expect(() => replayBothPaths([...prefix, early])).toThrow("Causality invariant violated");
        }
      }
    ), { seed: 0x1ab0ad, numRuns: 400 });
  });

  it("preserves revision-race streams identically through direct and persisted replay", () => {
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 1_000 }),
      fc.constantFrom(-1, 0, 1),
      (lightSeconds, raceOffset) => {
        const arrivalAtMs = lightSeconds * 1_000;
        const burnAtMs = arrivalAtMs + raceOffset;
        const issued: SimEvent = {
          type: "commandIssued", commandId: "command", issuedAtMs: simTimeMs(0), arrivalAtMs: simTimeMs(arrivalAtMs),
          hqPosition: { x: 0, y: 0, z: 0 },
          arrivalPosition: { x: SPEED_OF_LIGHT_METERS_PER_SECOND * lightSeconds, y: 0, z: 0 },
          replacedNodeIds: ["old"], flightPlan: { nodes: [node("replacement", arrivalAtMs + 2)] }
        };
        const initial: readonly SimEvent[] = [
          { type: "planRevisionApplied", flightPlan: { nodes: [node("old", burnAtMs)] } },
          issued
        ];
        const events: readonly SimEvent[] = raceOffset > 0
          ? [...initial,
            { type: "clockAdvanced", elapsedMs: arrivalAtMs },
            { type: "planRevisionApplied", commandId: "command", replacedNodeIds: ["old"], flightPlan: { nodes: [node("replacement", arrivalAtMs + 2)] } }
          ]
          : [...initial,
            { type: "clockAdvanced", elapsedMs: burnAtMs },
            { type: "burnStarted", node: node("old", burnAtMs) },
            { type: "clockAdvanced", elapsedMs: arrivalAtMs - burnAtMs },
            ...(raceOffset < 0 ? [{ type: "burnEnded" as const, nodeId: "old" }] : []),
            { type: "planRevisionRefused", commandId: "command", reason: "executed-burn-conflict", flightPlan: { nodes: [node("replacement", arrivalAtMs + 2)] } }
          ];
        // Equal timestamps are burn-first, so both zero and negative offsets refuse.
        replayBothPaths(events);
      }
    ), { seed: 0x4015, numRuns: 200 });
  });

  it("round-trips each node's quantized commitment without changing its stored duration", () => {
    fc.assert(fc.property(fc.double({ min: 0, max: 1_000_000, noNaN: true }), (seconds) => {
      const burn = quantizeBurnParameters({ burnDurationSeconds: seconds });
      const restored = quantizeBurnParameters(dequantizeBurnParameters(burn));
      const event: SimEvent = { type: "planRevisionApplied", flightPlan: { nodes: [node("quantized", 1, burn.burnDurationMs)] } };
      const state = replaySegment(1, [event]);
      expect(restored).toEqual(burn);
      expect(state.ship?.flightPlan.nodes[0]?.burn).toEqual(burn);
    }), { seed: 0xa11ce, numRuns: 300 });
  });
});
