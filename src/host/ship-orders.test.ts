import { describe, expect, it } from "vitest";

import { simTimeMs } from "../sim/clock.js";
import { InMemorySimulationEventStore } from "../sim/event-store.js";
import { AuthoritativeSimLoop } from "../sim/loop.js";
import { RETARGET_WINDOW_MILLISECONDS, ShipOrderRestController } from "./ship-orders.js";

const origin = { x: 0, y: 0, z: 0 };

describe("ship order REST command", () => {
  it("plans once, commits only quantized burns, and schedules both mid-flight decisions", async () => {
    const store = new InMemorySimulationEventStore();
    const simulation = await AuthoritativeSimLoop.create({
      store,
      stream: { id: "ship-order", seed: 1, initialTime: simTimeMs(1_000) }
    });
    let plannerCalls = 0;
    const controller = new ShipOrderRestController(simulation, {
      plan: () => {
        plannerCalls += 1;
        return {
          accelerationBurn: { burnDurationSeconds: 1.2345 },
          coastDurationSeconds: 30_000,
          decelerationBurn: { burnDurationSeconds: 2.3456 }
        };
      }
    });

    const response = await controller.postCommit({
      method: "POST",
      path: "/ship-orders",
      body: {
        orderId: "order-1",
        destinationId: "mars",
        plan: undefined,
        arrivalProfileFuelCost: { burnDurationSeconds: 4.5678 }
      },
      eventPosition: origin
    });

    expect(plannerCalls).toBe(1);
    expect(response).toEqual({
      status: 201,
      order: {
        orderId: "order-1",
        destinationId: "mars",
        accelerationBurn: { burnDurationMs: 1_235 },
        coastDurationMs: 30_000_000,
        decelerationBurn: { burnDurationMs: 2_346 }
      },
      scheduledDecisions: [
        { kind: "retarget", opensAtMs: 1_000, closesAtMs: 1_000 + RETARGET_WINDOW_MILLISECONDS },
        {
          kind: "arrivalProfile",
          opensAtMs: 30_002_235,
          closesAtMs: 30_004_581,
          fuelCostBurn: { burnDurationMs: 4_568 }
        }
      ]
    });
    const persisted = await simulation.persistedStream();
    expect(persisted.events.map(({ event }) => event.type)).toEqual([
      "shipOrderCommitted", "shipDecisionWindowScheduled", "shipDecisionWindowScheduled"
    ]);
    expect(JSON.stringify(persisted)).not.toContain("1.2345");
  });

  it("replays state-machine transitions at exact phase boundaries, including zero coast and impulsive burns", async () => {
    const store = new InMemorySimulationEventStore();
    const simulation = await AuthoritativeSimLoop.create({
      store,
      stream: { id: "phases", seed: 1, initialTime: simTimeMs(0) }
    });
    const controller = new ShipOrderRestController(simulation, {
      plan: () => ({
        accelerationBurn: { burnDurationSeconds: 0 },
        coastDurationSeconds: 0,
        decelerationBurn: { burnDurationSeconds: 0 }
      })
    });

    await controller.postCommit({
      method: "POST", path: "/ship-orders",
      body: { orderId: "impulse", destinationId: "mars", plan: undefined, arrivalProfileFuelCost: { burnDurationSeconds: 0 } },
      eventPosition: origin
    });

    expect(simulation.state.ship?.phase).toBe("arrived");
    expect((await simulation.persistedStream()).events.map(({ event }) => event.type)).toEqual([
      "shipOrderCommitted", "shipDecisionWindowScheduled", "shipDecisionWindowScheduled",
      "shipPhaseChanged", "shipPhaseChanged", "shipPhaseChanged", "shipPhaseChanged"
    ]);
  });

  it("records each nonzero phase boundary at its scheduled simulation time", async () => {
    const store = new InMemorySimulationEventStore();
    const simulation = await AuthoritativeSimLoop.create({
      store,
      stream: { id: "phase-times", seed: 1, initialTime: simTimeMs(0) }
    });
    const controller = new ShipOrderRestController(simulation, {
      plan: () => ({
        accelerationBurn: { burnDurationSeconds: 0.002 }, coastDurationSeconds: 0.003, decelerationBurn: { burnDurationSeconds: 0.004 }
      })
    });
    await controller.postCommit({
      method: "POST", path: "/ship-orders",
      body: { orderId: "timed", destinationId: "mars", plan: undefined, arrivalProfileFuelCost: { burnDurationSeconds: 0 } },
      eventPosition: origin
    });
    await simulation.advance(9, origin);

    expect((await simulation.persistedStream()).events.map(({ event, eventTime }) => [event.type, eventTime])).toEqual([
      ["shipOrderCommitted", 0], ["shipDecisionWindowScheduled", 0], ["shipDecisionWindowScheduled", 0],
      ["clockAdvanced", 2], ["shipPhaseChanged", 2], ["clockAdvanced", 5], ["shipPhaseChanged", 5],
      ["shipPhaseChanged", 5], ["clockAdvanced", 9], ["shipPhaseChanged", 9]
    ]);
  });

  it("does not invoke a planner while replaying a committed order", async () => {
    const store = new InMemorySimulationEventStore();
    const simulation = await AuthoritativeSimLoop.create({
      store,
      stream: { id: "replay", seed: 1, initialTime: simTimeMs(0) }
    });
    const controller = new ShipOrderRestController(simulation, {
      plan: () => ({
        accelerationBurn: { burnDurationSeconds: 0.001 }, coastDurationSeconds: 0, decelerationBurn: { burnDurationSeconds: 0.001 }
      })
    });
    await controller.postCommit({
      method: "POST", path: "/ship-orders",
      body: { orderId: "replay-order", destinationId: "mars", plan: undefined, arrivalProfileFuelCost: { burnDurationSeconds: 0 } },
      eventPosition: origin
    });
    await simulation.advance(2, origin);

    const resumed = await AuthoritativeSimLoop.resume(store, "replay");
    expect(resumed.state).toEqual(simulation.state);
  });
});
