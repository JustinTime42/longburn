import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { simTimeMs } from "./clock.js";
import { InMemorySimulationEventStore } from "./event-store.js";
import { replayPersistedSegment, replaySegment, type FlightPlan, type PlanRevisionRefusalReason, type SimEvent } from "./event-log.js";
import { AuthoritativeSimLoop } from "./loop.js";
import { burnDurationMs, projectPropellantForBurns, TIER0_SHIP } from "./mass-cargo.js";

const node = (nodeId: string, executeAtMs: number, kind: "accel" | "correction" | "decel" = "accel", durationMs = 1) => ({
  nodeId, executeAtMs: simTimeMs(executeAtMs), kind, burn: { burnDurationMs: burnDurationMs(durationMs) }, deltaVMmPerSecond: { x: 0, y: 0, z: 0 }
});

const plan = (...nodes: ReturnType<typeof node>[]): FlightPlan => ({ destination: "earth", nodes });

const eventArbitrary = fc.oneof(
  fc.record({ type: fc.constant<"clockAdvanced">("clockAdvanced"), elapsedMs: fc.integer({ min: 0, max: 10_000 }) }),
  fc.record({ type: fc.constant<"randomValueRequested">("randomValueRequested"), upperExclusive: fc.integer({ min: 1, max: 1_000_000 }) })
);

describe("event log replay", () => {
  it("replays recorded random segments identically", () => {
    fc.assert(fc.property(fc.integer({ min: 0, max: 0xffff_ffff }), fc.array(eventArbitrary, { maxLength: 200 }), (seed, events) => {
      expect(replaySegment(seed, events as SimEvent[])).toEqual(replaySegment(seed, events as SimEvent[]));
    }), { numRuns: 500 });
  });

  it("derives phases from burn history and elapsed time, never phase events", () => {
    const events: readonly SimEvent[] = [
      { type: "planRevisionApplied", commandId: "command-1", flightPlan: plan(node("outbound", 2, "accel"), node("capture", 6, "decel")) },
      { type: "clockAdvanced", elapsedMs: 2 }, { type: "burnStarted", node: node("outbound", 2, "accel") },
      { type: "clockAdvanced", elapsedMs: 1 }, { type: "burnEnded", nodeId: "outbound" },
      { type: "clockAdvanced", elapsedMs: 3 }, { type: "burnStarted", node: node("capture", 6, "decel") },
      { type: "clockAdvanced", elapsedMs: 1 }, { type: "burnEnded", nodeId: "capture" }
    ];
    expect(replaySegment(1, events)).toMatchObject({
      time: 7,
      ship: { phase: "coast", flightPlan: { nodes: [] }, executedBurns: [
        { node: { nodeId: "outbound" }, startedAtMs: 2, endedAtMs: 3 },
        { node: { nodeId: "capture" }, startedAtMs: 6, endedAtMs: 7 }
      ] }
    });
  });

  it("rejects reintroducing executed burns on both direct and persisted replay paths", () => {
    const events: readonly SimEvent[] = [
      { type: "planRevisionApplied", commandId: "command-1", flightPlan: plan(node("burn-1", 0)) },
      { type: "burnStarted", node: node("burn-1", 0) },
      { type: "clockAdvanced", elapsedMs: 1 }, { type: "burnEnded", nodeId: "burn-1" },
      { type: "planRevisionApplied", commandId: "command-2", flightPlan: plan(node("burn-1", 2, "decel")) }
    ];
    const replay = () => replaySegment(1, events);
    const persistedReplay = () => replayPersistedSegment({ seed: 1, initialTime: simTimeMs(0), events: events.map((event) => ({ event })) });
    expect(replay).toThrow("cannot reintroduce an executed burn");
    expect(persistedReplay).toThrow("cannot reintroduce an executed burn");
  });

  it("rejects an applied command whose issue-time replacement set includes an executed burn on both replay paths", () => {
    const events: readonly SimEvent[] = [
      { type: "planRevisionApplied", commandId: "command-1", flightPlan: plan(node("burn-1", 0)) },
      { type: "burnStarted", node: node("burn-1", 0) },
      { type: "clockAdvanced", elapsedMs: 1 }, { type: "burnEnded", nodeId: "burn-1" },
      { type: "planRevisionApplied", commandId: "command-2", flightPlan: plan(node("replacement", 2)), replacedNodeIds: ["burn-1"] }
    ];
    const replay = () => replaySegment(1, events);
    const persistedReplay = () => replayPersistedSegment({ seed: 1, initialTime: simTimeMs(0), events: events.map((event) => ({ event })) });
    expect(replay).toThrow("arrived after a burn it would replace started");
    expect(persistedReplay).toThrow("arrived after a burn it would replace started");
  });

  it("keeps a refused revision as history without changing the pending plan", () => {
    const events: readonly SimEvent[] = [
      { type: "planRevisionApplied", commandId: "command-1", flightPlan: plan(node("first", 4)) },
      { type: "planRevisionRefused", commandId: "command-2", flightPlan: plan(node("replacement", 4), node("replacement", 5)), reason: "invalid-plan" }
    ];
    expect(replaySegment(1, events).ship?.flightPlan.nodes.map(({ nodeId }) => nodeId)).toEqual(["first"]);
  });

  it("rejects revision outcomes without a non-empty command ID during replay", () => {
    expect(() => replaySegment(1, [{ type: "planRevisionApplied", commandId: "", flightPlan: plan() }]))
      .toThrow("non-empty command ID");
    expect(() => replaySegment(1, [{ type: "planRevisionRefused", commandId: "", flightPlan: plan(), reason: "invalid-plan" }]))
      .toThrow("non-empty command ID");
  });

  it("replays persisted plans with executed and revised pending nodes equivalently", async () => {
    await fc.assert(fc.asyncProperty(fc.integer({ min: 1, max: 100 }), async (offset) => {
      const store = new InMemorySimulationEventStore();
      const loop = await AuthoritativeSimLoop.create({
        store, stream: { id: `flight-plan-${offset}`, seed: offset, initialTime: simTimeMs(0) }
      });
      await loop.applyPlanRevision(plan(node("executed", 1, "accel"), node("superseded", 4 + offset, "decel")), () => ({ x: 0, y: 0, z: 0 }));
      await loop.advance(2, () => ({ x: 0, y: 0, z: 0 }));
      await loop.applyPlanRevision(plan(node("replacement", 5 + offset, "decel")), () => ({ x: 0, y: 0, z: 0 }));
      await loop.advance(4 + offset, () => ({ x: 0, y: 0, z: 0 }));
      const resumed = await AuthoritativeSimLoop.resume(store, `flight-plan-${offset}`);
      expect(resumed.state).toEqual(loop.state);
      expect(resumed.state.ship?.executedBurns.map(({ node: burn }) => burn.nodeId)).toEqual(["executed", "replacement"]);
    }), { numRuns: 100 });
  });

  it("rejects malformed plans and impossible burn history in the shared reducer", () => {
    expect(() => replaySegment(1, [{ type: "planRevisionApplied", commandId: "command-1", flightPlan: plan(node("late", 2), node("early", 1)) }]))
      .toThrow("strictly increasing");
    expect(() => replaySegment(1, [{ type: "planRevisionApplied", commandId: "command-2", flightPlan: plan(node("first", 0, "accel", 10), node("overlap", 5, "decel")) }]))
      .toThrow("cannot overlap");
    expect(() => replaySegment(1, [{ type: "burnStarted", node: node("orphan", 0) }])).toThrow("without a flight plan");
    expect(() => replaySegment(1, [{ type: "planRevisionApplied", commandId: "command-3", flightPlan: plan(node("one", 1)) }, { type: "burnStarted", node: node("one", 1) }]))
      .toThrow("scheduled simulation time");
  });

  it("validates an applied revision before it can enter the durable log", async () => {
    const store = new InMemorySimulationEventStore();
    const loop = await AuthoritativeSimLoop.create({ store, stream: { id: "preappend-validation", seed: 1, initialTime: simTimeMs(2) } });
    await expect(loop.applyPlanRevision(plan(node("past", 1)), () => ({ x: 0, y: 0, z: 0 }))).rejects.toThrow("cannot schedule a burn in the past");
    expect((await loop.persistedStream()).events).toEqual([]);
  });

  it("refuses a delta-v vector that exceeds its committed burn duration before append", async () => {
    const store = new InMemorySimulationEventStore();
    const loop = await AuthoritativeSimLoop.create({ store, stream: { id: "delta-v-duration-boundary", seed: 1, initialTime: simTimeMs(0) } });
    await expect(loop.applyPlanRevision(
      plan({ ...node("impossible", 1), deltaVMmPerSecond: { x: 1_000_000_000, y: 0, z: 0 } }),
      () => ({ x: 0, y: 0, z: 0 })
    )).rejects.toMatchObject({ reason: "invalid-plan" });
    expect((await loop.persistedStream()).events).toEqual([]);
  });

  it("rejects overlapping burns before they can enter the durable log", async () => {
    const store = new InMemorySimulationEventStore();
    const loop = await AuthoritativeSimLoop.create({ store, stream: { id: "overlapping-burns", seed: 1, initialTime: simTimeMs(0) } });
    await expect(loop.applyPlanRevision(plan(node("a", 0, "accel", 10), node("b", 5, "decel")), () => ({ x: 0, y: 0, z: 0 }))).rejects.toThrow("cannot overlap");
    expect((await loop.persistedStream()).events).toEqual([]);
  });

  it("replays an accepted revision after a ship config change makes it propellant-exhausted", () => {
    const historicallyAcceptedPlan = plan(node("long-burn", 0, "accel", 200_000_000));
    expect(projectPropellantForBurns(
      historicallyAcceptedPlan.nodes.map(({ burn }) => burn),
      {
        ...TIER0_SHIP,
        structuralMassFraction: 0.05,
        // A prior ship configuration carries its own frozen boundary fact.
        maxViableBurnDurationMs: burnDurationMs(200_000_001)
      }
    )).toMatchObject({ kind: "sufficient" });
    expect(projectPropellantForBurns(historicallyAcceptedPlan.nodes.map(({ burn }) => burn))).toMatchObject({ kind: "exhausted" });

    const events: readonly SimEvent[] = [{ type: "planRevisionApplied", commandId: "command-1", flightPlan: historicallyAcceptedPlan }];
    const persisted = { seed: 1, initialTime: simTimeMs(0), events: events.map((event) => ({ event })) };

    expect(replaySegment(1, events).ship?.flightPlan).toEqual({ ...historicallyAcceptedPlan, destination: "earth" });
    expect(replayPersistedSegment(persisted).ship?.flightPlan).toEqual({ ...historicallyAcceptedPlan, destination: "earth" });
  });

  it("replays an already-stored delta-v/duration mismatch as history", () => {
    const historicalPlan = plan({ ...node("historical", 0), deltaVMmPerSecond: { x: 1_000_000_000, y: 0, z: 0 } });
    const events: readonly SimEvent[] = [{ type: "planRevisionApplied", commandId: "command-1", flightPlan: historicalPlan }];
    expect(replaySegment(1, events).ship?.flightPlan).toEqual(historicalPlan);
    expect(replayPersistedSegment({ seed: 1, initialTime: simTimeMs(0), events: events.map((event) => ({ event })) }).ship?.flightPlan).toEqual(historicalPlan);
  });

  it("rejects a recorded plan without a durable destination instead of inventing Earth", () => {
    const missingDestination = { nodes: [] } as unknown as FlightPlan;
    expect(() => replaySegment(1, [{ type: "planRevisionApplied", commandId: "command-1", flightPlan: missingDestination }]))
      .toThrow("known destination body");
  });

  it("rejects a revision scheduled inside a burn that is firing before append", async () => {
    const store = new InMemorySimulationEventStore();
    const loop = await AuthoritativeSimLoop.create({ store, stream: { id: "in-flight-overlap", seed: 1, initialTime: simTimeMs(0) } });
    await loop.applyPlanRevision(plan(node("a", 0, "accel", 10)), () => ({ x: 0, y: 0, z: 0 }));
    await expect(loop.applyPlanRevision(plan(node("b", 5, "decel")), () => ({ x: 0, y: 0, z: 0 }))).rejects.toThrow("cannot overlap a burn that is firing");
    expect((await loop.persistedStream()).events).toHaveLength(2);
  });

  it("records a malformed refused revision as opaque history", async () => {
    const store = new InMemorySimulationEventStore();
    const loop = await AuthoritativeSimLoop.create({ store, stream: { id: "opaque-refusal", seed: 1, initialTime: simTimeMs(0) } });
    await loop.applyPlanRevision(plan(node("first", 4)), () => ({ x: 0, y: 0, z: 0 }));
    await loop.refusePlanRevision(plan(node("replacement", 4), node("replacement", 5)), "invalid-plan", () => ({ x: 0, y: 0, z: 0 }));
    const persisted = await loop.persistedStream();
    expect(persisted.events).toHaveLength(2);
    expect(replayPersistedSegment(persisted).ship?.flightPlan.nodes.map(({ nodeId }) => nodeId)).toEqual(["first"]);
    expect(persisted.events.map(({ event }) => event.type === "planRevisionApplied" || event.type === "planRevisionRefused" ? event.commandId : undefined))
      .toEqual(["local-1", "local-2"]);
  });

  it("validates a refusal reason before it can enter the durable log", async () => {
    const store = new InMemorySimulationEventStore();
    const loop = await AuthoritativeSimLoop.create({ store, stream: { id: "refusal-reason-validation", seed: 1, initialTime: simTimeMs(0) } });
    await expect(loop.refusePlanRevision(plan(node("replacement", 4)), "unknown" as PlanRevisionRefusalReason, () => ({ x: 0, y: 0, z: 0 })))
      .rejects.toThrow("require a known reason");
    expect((await loop.persistedStream()).events).toEqual([]);
    expect(() => replaySegment(1, [{ type: "planRevisionRefused", commandId: "command-1", flightPlan: plan(node("replacement", 4)), reason: "unknown" as PlanRevisionRefusalReason }]))
      .toThrow("require a known reason");
  });
});
