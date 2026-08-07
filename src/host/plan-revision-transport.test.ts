import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { SPEED_OF_LIGHT_METERS_PER_SECOND } from "../sim/causality.js";
import { simTimeMs } from "../sim/clock.js";
import { InMemorySimulationEventStore, type SimulationEventStore } from "../sim/event-store.js";
import { AuthoritativeSimLoop } from "../sim/loop.js";
import { burnDurationMs } from "../sim/mass-cargo.js";
import { PlanRevisionTransport } from "./plan-revision-transport.js";

const position = () => ({ x: SPEED_OF_LIGHT_METERS_PER_SECOND, y: 0, z: 0 });
const node = (nodeId: string, executeAtMs: number) => ({
  nodeId, executeAtMs: simTimeMs(executeAtMs), kind: "accel" as const,
  burn: { burnDurationMs: burnDurationMs(1) }
});

const setup = async (id: string) => {
  const loop = await AuthoritativeSimLoop.create({
    store: new InMemorySimulationEventStore(), stream: { id, seed: 1, initialTime: simTimeMs(0) }
  });
  return { loop, transport: new PlanRevisionTransport({ loop, shipPositionAt: position }) };
};

describe("PlanRevision command transport", () => {
  it("uses the fixed Earth-HQ light-time solve and applies at the exact arrival boundary", async () => {
    const { loop, transport } = await setup("arrival-boundary");
    const issued = await transport.issue({ nodes: [node("arrival-burn", 2_000)] });

    expect(issued).toEqual({ issuedAtMs: simTimeMs(0), arrivalAtMs: simTimeMs(1_000) });
    await loop.advance(999, position);
    expect(loop.state.ship).toBeUndefined();
    await loop.advance(1, position);

    expect(loop.state.ship?.flightPlan.nodes.map(({ nodeId }) => nodeId)).toEqual(["arrival-burn"]);
    expect((await loop.persistedStream()).events.map(({ event, eventTime }) => [event.type, eventTime])).toEqual([
      ["commandIssued", 0], ["clockAdvanced", 999], ["clockAdvanced", 1_000], ["planRevisionApplied", 1_000]
    ]);
  });

  it("accepts an arrival before the pending burn and replaces the complete unexecuted set", async () => {
    const { loop, transport } = await setup("arrival-acceptance");
    await loop.applyPlanRevision({ nodes: [node("old", 2_000)] }, position);
    await transport.issue({ nodes: [node("replacement", 3_000)] });
    await loop.advance(1_000, position);

    expect(loop.state.ship?.flightPlan.nodes.map(({ nodeId }) => nodeId)).toEqual(["replacement"]);
  });

  it("records a typed interleaved refusal when a blocked tick carries the clock through the command's race boundary", async () => {
    const backingStore = new InMemorySimulationEventStore();
    let appendStarted: (() => void) | undefined;
    const appendBlocked = new Promise<void>((resolve) => { appendStarted = resolve; });
    let releaseAppend: (() => void) | undefined;
    const appendReleased = new Promise<void>((resolve) => { releaseAppend = resolve; });
    let blockNextAppend = false;
    const store: SimulationEventStore = {
      createStream: (stream) => backingStore.createStream(stream),
      append: async (...args) => {
        if (blockNextAppend) {
          blockNextAppend = false;
          appendStarted?.();
          await appendReleased;
        }
        return backingStore.append(...args);
      },
      readStream: (streamId) => backingStore.readStream(streamId)
    };
    const loop = await AuthoritativeSimLoop.create({
      store, stream: { id: "interleaved-rejection", seed: 1, initialTime: simTimeMs(0) }
    });
    const transport = new PlanRevisionTransport({ loop, shipPositionAt: position });
    await loop.applyPlanRevision({ nodes: [node("racing-burn", 1_000)] }, position);
    await transport.issue({ nodes: [node("replacement", 2_000)] });
    blockNextAppend = true;
    const tick = loop.advance(1_000, position);
    await appendBlocked;
    releaseAppend?.();
    await tick;

    const events = await loop.persistedStream();
    expect(events.events.map(({ event }) => event.type)).toEqual([
      "planRevisionApplied", "commandIssued", "clockAdvanced", "burnStarted", "planRevisionRefused"
    ]);
    expect(events.events.at(-1)?.event).toEqual(expect.objectContaining({
      type: "planRevisionRefused", reason: "executed-burn-conflict"
    }));
    expect(loop.state.ship?.flightPlan.nodes).toEqual([]);
  });

  it("records malformed payloads as typed arrival-time refusals without appending a revision", async () => {
    const { loop, transport } = await setup("invalid-arrival");
    await transport.issue({ nodes: [node("late", 2_000), node("early", 1_500)] });
    await loop.advance(1_000, position);

    const events = await loop.persistedStream();
    expect(events.events.at(-1)?.event).toEqual(expect.objectContaining({
      type: "planRevisionRefused", reason: "invalid-plan"
    }));
    expect(events.events.some(({ event }) => event.type === "planRevisionApplied")).toBe(false);
  });

  it("rebuilds an in-flight command from commandIssued after a restart", async () => {
    const store = new InMemorySimulationEventStore();
    const loop = await AuthoritativeSimLoop.create({
      store, stream: { id: "resume-inbound", seed: 1, initialTime: simTimeMs(0) }
    });
    const transport = new PlanRevisionTransport({ loop, shipPositionAt: position });
    await transport.issue({ nodes: [node("after-restart", 2_000)] });

    const resumed = await AuthoritativeSimLoop.resume(store, "resume-inbound");
    await resumed.advance(1_000, position);

    const events = await resumed.persistedStream();
    expect(events.events.map(({ event }) => event.type)).toEqual(["commandIssued", "clockAdvanced", "planRevisionApplied"]);
    expect(events.events[0]).toMatchObject({
      eventTime: 0, eventPosition: { x: 0, y: 0, z: 0 },
      event: { type: "commandIssued", issuedAtMs: 0, arrivalAtMs: 1_000, replacedNodeIds: [] }
    });
    expect(resumed.state.ship?.flightPlan.nodes.map(({ nodeId }) => nodeId)).toEqual(["after-restart"]);
  });

  it("preserves a non-empty replacement set across restart and stops at the rebuilt command boundary", async () => {
    const store = new InMemorySimulationEventStore();
    const loop = await AuthoritativeSimLoop.create({
      store, stream: { id: "resume-replacement", seed: 1, initialTime: simTimeMs(0) }
    });
    const transport = new PlanRevisionTransport({ loop, shipPositionAt: position });
    await loop.applyPlanRevision({ nodes: [node("old", 3_000)] }, position);
    await transport.issue({ nodes: [node("replacement", 4_000)] });

    const resumed = await AuthoritativeSimLoop.resume(store, "resume-replacement");
    await resumed.advance(999, position);
    expect(resumed.state.time).toBe(simTimeMs(999));
    expect(resumed.state.ship?.flightPlan.nodes.map(({ nodeId }) => nodeId)).toEqual(["old"]);
    await resumed.advance(1, position);
    expect(resumed.state.ship?.flightPlan.nodes.map(({ nodeId }) => nodeId)).toEqual(["replacement"]);
    expect((await resumed.persistedStream()).events.find(({ event }) => event.type === "commandIssued")?.event)
      .toMatchObject({ replacedNodeIds: ["old"] });
  });

  it("records an arrival-time refusal after restart when the replaced burn fired in transit", async () => {
    const store = new InMemorySimulationEventStore();
    const loop = await AuthoritativeSimLoop.create({
      store, stream: { id: "resume-refusal", seed: 1, initialTime: simTimeMs(0) }
    });
    const transport = new PlanRevisionTransport({
      loop, shipPositionAt: () => ({ x: SPEED_OF_LIGHT_METERS_PER_SECOND * 2, y: 0, z: 0 })
    });
    await loop.applyPlanRevision({ nodes: [node("old", 1_000)] }, position);
    await transport.issue({ nodes: [node("replacement", 3_000)] });

    const resumed = await AuthoritativeSimLoop.resume(store, "resume-refusal");
    await resumed.advance(2_000, position);
    expect(resumed.state.ship?.executedBurns.map(({ node: burn }) => burn.nodeId)).toEqual(["old"]);
    expect((await resumed.persistedStream()).events.at(-1)?.event).toMatchObject({
      type: "planRevisionRefused", reason: "executed-burn-conflict"
    });
  });

  it("queues issue behind an in-flight advance and timestamps it with post-tick sim time", async () => {
    const backingStore = new InMemorySimulationEventStore();
    let appendStarted: (() => void) | undefined;
    const appendBlocked = new Promise<void>((resolve) => { appendStarted = resolve; });
    let releaseAppend: (() => void) | undefined;
    const appendReleased = new Promise<void>((resolve) => { releaseAppend = resolve; });
    let blockNextAppend = true;
    const store: SimulationEventStore = {
      createStream: (stream) => backingStore.createStream(stream),
      append: async (...args) => {
        if (blockNextAppend) {
          blockNextAppend = false;
          appendStarted?.();
          await appendReleased;
        }
        return backingStore.append(...args);
      },
      readStream: (streamId) => backingStore.readStream(streamId)
    };
    const loop = await AuthoritativeSimLoop.create({
      store, stream: { id: "issue-during-advance", seed: 1, initialTime: simTimeMs(0) }
    });
    const transport = new PlanRevisionTransport({ loop, shipPositionAt: position });
    const tick = loop.advance(1_000, position);
    await appendBlocked;
    const issued = transport.issue({ nodes: [node("post-tick", 3_000)] });
    releaseAppend?.();
    await tick;

    await expect(issued).resolves.toEqual({ issuedAtMs: simTimeMs(1_000), arrivalAtMs: simTimeMs(2_000) });
  });

  it("never mutates an executed burn across reachable inbound revision sequences", async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.integer({ min: 1, max: 100 }), { minLength: 1, maxLength: 12 }),
      async (durations) => {
        const store = new InMemorySimulationEventStore();
        const loop = await AuthoritativeSimLoop.create({
          store, stream: { id: `immutability-${durations.join("-")}`, seed: 1, initialTime: simTimeMs(0) }
        });
        const transport = new PlanRevisionTransport({ loop, shipPositionAt: position });
        await loop.applyPlanRevision({ nodes: [node("executed", 1)] }, position);
        await loop.advance(1, position);
        const history = loop.state.ship?.executedBurns.map(({ node: executedNode, startedAtMs }) => ({ executedNode, startedAtMs }));
        for (const [index, duration] of durations.entries()) {
          await transport.issue({
            nodes: [{ ...node(`pending-${index}`, 10_000 + index), burn: { burnDurationMs: burnDurationMs(duration) } }]
          });
          await loop.advance(1_000, position);
          const currentHistory = loop.state.ship?.executedBurns
            .map(({ node: executedNode, startedAtMs }) => ({ executedNode, startedAtMs }));
          expect(currentHistory?.slice(0, history?.length)).toEqual(history);
        }
      }
    ), { seed: 0x1aa117, numRuns: 100 });
  });
});
