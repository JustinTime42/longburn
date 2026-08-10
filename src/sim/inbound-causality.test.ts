import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { SPEED_OF_LIGHT_METERS_PER_SECOND } from "./causality.js";
import { simTimeMs } from "./clock.js";
import { InMemorySimulationEventStore } from "./event-store.js";
import { replayPersistedSegment, replaySegment, type SimEvent } from "./event-log.js";
import { PlanRevisionTransport } from "../host/plan-revision-transport.js";
import { AuthoritativeSimLoop } from "./loop.js";
import { burnDurationMs, dequantizeBurnParameters, quantizeBurnParameters } from "./mass-cargo.js";

const node = (nodeId: string, executeAtMs: number, durationMs = 1) => ({
  nodeId, executeAtMs: simTimeMs(executeAtMs), kind: "accel" as const,
  burn: { burnDurationMs: burnDurationMs(durationMs) }, deltaVMmPerSecond: { x: 0, y: 0, z: 0 }
});

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
          hqPosition, arrivalPosition, replacedNodeIds: [], flightPlan: { destination: "earth", nodes: [] }
        };
        const prefix: SimEvent[] = issuedAtMs === 0 ? [] : [{ type: "clockAdvanced", elapsedMs: issuedAtMs }];
        const events = [...prefix, command];
        const persisted = { seed: 1, initialTime: simTimeMs(0), events: events.map((event) => ({ event })) };
        expect(() => replaySegment(1, events)).not.toThrow();
        expect(() => replayPersistedSegment(persisted)).not.toThrow();
        if (lightTimeMs > 0) {
          const early: SimEvent = { ...command, arrivalAtMs: simTimeMs(arrivalAtMs - 1) };
          const earlyEvents = [...prefix, early];
          const earlyPersisted = { seed: 1, initialTime: simTimeMs(0), events: earlyEvents.map((event) => ({ event })) };
          expect(() => replaySegment(1, earlyEvents)).toThrow("Causality invariant violated");
          expect(() => replayPersistedSegment(earlyPersisted)).toThrow("Causality invariant violated");
        }
      }
    ), { seed: 0x1ab0ad, numRuns: 400 });
  });

  it("rejects faster-than-light commands before any inbound writer appends them", async () => {
    const store = new InMemorySimulationEventStore();
    const loop = await AuthoritativeSimLoop.create({
      store, stream: { id: "pre-append-inbound-causality", seed: 1, initialTime: simTimeMs(0) }
    });
    const hqPosition = () => ({ x: 0, y: 0, z: 0 });
    const shipPosition = () => ({ x: SPEED_OF_LIGHT_METERS_PER_SECOND, y: 0, z: 0 });
    const oneMillisecondEarly = () => simTimeMs(999);

    await expect(loop.scheduleInboundPlanRevision(
      { destination: "earth", nodes: [] }, oneMillisecondEarly, hqPosition, shipPosition
    )).rejects.toThrow("Causality invariant violated");
    await expect(loop.scheduleInboundSellOrder(
      oneMillisecondEarly, hqPosition, shipPosition
    )).rejects.toThrow("Causality invariant violated");
    await expect(loop.scheduleInboundSpotDispositionRevision(
      "manual", oneMillisecondEarly, hqPosition, shipPosition
    )).rejects.toThrow("Causality invariant violated");

    expect((await loop.persistedStream()).events).toEqual([]);
    await expect(AuthoritativeSimLoop.resume(store, "pre-append-inbound-causality")).resolves.toBeDefined();
  });

  it("replays generated inbound revision races from live, durable, and resumed paths", async () => {
    await fc.assert(fc.asyncProperty(
      fc.integer({ min: 1, max: 1_000 }),
      fc.constantFrom(-1, 0, 1),
      fc.integer({ min: 0, max: 1_000 }),
      fc.constantFrom<"x" | "y" | "z">("x", "y", "z"),
      fc.constantFrom(-1, 1),
      async (lightSeconds, raceOffset, issueDelayMs, axis, sign) => {
        const store = new InMemorySimulationEventStore();
        const loop = await AuthoritativeSimLoop.create({
          store, stream: { id: `inbound-race-${lightSeconds}-${raceOffset}-${issueDelayMs}-${axis}-${sign}`, seed: 1, initialTime: simTimeMs(0) }
        });
        const distance = sign * SPEED_OF_LIGHT_METERS_PER_SECOND * lightSeconds;
        const shipPosition = {
          x: axis === "x" ? distance : 0,
          y: axis === "y" ? distance : 0,
          z: axis === "z" ? distance : 0
        };
        const arrivalAtMs = issueDelayMs + lightSeconds * 1_000;
        const burnAtMs = arrivalAtMs + raceOffset;
        const replacement = { destination: "earth" as const, nodes: [node("replacement", arrivalAtMs + 2)] };
        await loop.applyPlanRevision({ destination: "earth", nodes: [node("old", burnAtMs)] }, () => shipPosition);
        await loop.advance(issueDelayMs, () => shipPosition);
        const transport = new PlanRevisionTransport({ loop, shipPositionAt: () => shipPosition, hqPositionAt: () => ({ x: 0, y: 0, z: 0 }) });
        await transport.issue(replacement);
        await loop.advance(lightSeconds * 1_000 + 2, () => shipPosition);

        const persisted = await loop.persistedStream();
        expect(replayPersistedSegment(persisted)).toEqual(loop.state);
        expect((await AuthoritativeSimLoop.resume(store, persisted.id)).state).toEqual(loop.state);
        const inboundCommand = persisted.events.find(({ event }) => event.type === "commandIssued")?.event;
        const inboundCommandId = inboundCommand?.type === "commandIssued" ? inboundCommand.commandId : undefined;
        const arrival = persisted.events.find(({ event }) =>
          (event.type === "planRevisionApplied" || event.type === "planRevisionRefused") && event.commandId === inboundCommandId
        )?.event;
        if (raceOffset > 0) {
          expect(arrival).toMatchObject({ type: "planRevisionApplied", replacedNodeIds: ["old"] });
          expect(loop.state.ship?.executedBurns.map(({ node: executed }) => executed.nodeId)).not.toContain("old");
        } else {
          expect(arrival).toMatchObject({ type: "planRevisionRefused", reason: "executed-burn-conflict" });
          expect(loop.state.ship?.executedBurns.map(({ node: executed }) => executed.nodeId)).toContain("old");
        }
      }
    ), { seed: 0x4015, numRuns: 200 });
  });

  it("round-trips each node's quantized commitment without changing its stored duration", () => {
    // This property enters the authoritative reducer, so its generated node
    // must stay below the fixed ship's propellant wall.
    fc.assert(fc.property(fc.double({ min: 0, max: 100_000, noNaN: true }), (seconds) => {
      const burn = quantizeBurnParameters({ burnDurationSeconds: seconds });
      const restored = quantizeBurnParameters(dequantizeBurnParameters(burn));
      const event: SimEvent = { type: "planRevisionApplied", commandId: "command-1", flightPlan: { destination: "earth", nodes: [node("quantized", 1, burn.burnDurationMs)] } };
      const state = replaySegment(1, [event]);
      expect(restored).toEqual(burn);
      expect(state.ship?.flightPlan.nodes[0]?.burn).toEqual(burn);
    }), { seed: 0xa11ce, numRuns: 300 });
  });
});
