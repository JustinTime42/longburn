import { describe, expect, it } from "vitest";

import { simTimeMs } from "../sim/clock.js";
import { InMemorySimulationEventStore } from "../sim/event-store.js";
import { AuthoritativeSimLoop } from "../sim/loop.js";
import { RETARGET_WINDOW_MILLISECONDS, ShipOrderCommandRefusal, ShipOrderRestController } from "./ship-orders.js";

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
        departureAtMs: simTimeMs(10_000),
        plan: undefined,
        arrivalProfileFuelCost: { burnDurationSeconds: 4.5678 }
      },
      eventPosition: () => origin
    });

    expect(plannerCalls).toBe(1);
    expect(response).toEqual({
      status: 201,
      order: {
        orderId: "order-1",
        destinationId: "mars",
        departureAtMs: 10_000,
        accelerationBurn: { burnDurationMs: 1_235 },
        coastDurationMs: 30_000_000,
        decelerationBurn: { burnDurationMs: 2_346 }
      },
      scheduledDecisions: [
        { kind: "retarget", opensAtMs: 10_000, closesAtMs: 10_000 + RETARGET_WINDOW_MILLISECONDS },
        {
          kind: "arrivalProfile",
          opensAtMs: 30_011_235,
          closesAtMs: 30_013_581,
          fuelCostBurn: { burnDurationMs: 4_568 }
        }
      ]
    });
    const persisted = await simulation.persistedStream();
    expect(persisted.events).toEqual([
      expect.objectContaining({
        event: {
          type: "shipOrderCommitted",
          order: response.order,
          decisions: response.scheduledDecisions
        }
      })
    ]);
    expect(JSON.stringify(persisted)).not.toContain("1.2345");
  });

  it("keeps a ship docked until its departure epoch, then replays exact phase boundaries", async () => {
    const store = new InMemorySimulationEventStore();
    const simulation = await AuthoritativeSimLoop.create({
      store,
      stream: { id: "phases", seed: 1, initialTime: simTimeMs(0) }
    });
    const controller = new ShipOrderRestController(simulation, {
      plan: () => ({
        accelerationBurn: { burnDurationSeconds: 0 },
        coastDurationSeconds: 0,
        decelerationBurn: { burnDurationSeconds: 0.001 }
      })
    });

    await controller.postCommit({
      method: "POST", path: "/ship-orders",
      body: { orderId: "impulse", destinationId: "mars", departureAtMs: simTimeMs(5), plan: undefined, arrivalProfileFuelCost: { burnDurationSeconds: 0 } },
      eventPosition: () => origin
    });
    expect(simulation.state.ship?.phase).toBe("docked");
    await simulation.advance(4, () => origin);
    expect(simulation.state.ship?.phase).toBe("docked");
    await simulation.advance(2, () => origin);

    expect(simulation.state.ship?.phase).toBe("arrived");
    expect((await simulation.persistedStream()).events.map(({ event }) => event.type)).toEqual([
      "shipOrderCommitted", "clockAdvanced", "clockAdvanced", "shipPhaseChanged", "shipPhaseChanged", "shipPhaseChanged", "shipPhaseChanged", "clockAdvanced", "shipPhaseChanged"
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
      body: { orderId: "timed", destinationId: "mars", departureAtMs: simTimeMs(10), plan: undefined, arrivalProfileFuelCost: { burnDurationSeconds: 0 } },
      eventPosition: () => origin
    });
    await simulation.advance(19, () => origin);

    expect((await simulation.persistedStream()).events.map(({ event, eventTime }) => [event.type, eventTime])).toEqual([
      ["shipOrderCommitted", 0],
      ["clockAdvanced", 10], ["shipPhaseChanged", 10], ["clockAdvanced", 12], ["shipPhaseChanged", 12], ["clockAdvanced", 15], ["shipPhaseChanged", 15],
      ["shipPhaseChanged", 15], ["clockAdvanced", 19], ["shipPhaseChanged", 19]
    ]);
  });

  it("refuses malformed or zero-duration commands before any event is persisted", async () => {
    const store = new InMemorySimulationEventStore();
    const simulation = await AuthoritativeSimLoop.create({
      store, stream: { id: "refusals", seed: 1, initialTime: simTimeMs(0) }
    });
    const controller = new ShipOrderRestController(simulation, {
      plan: () => ({
        accelerationBurn: { burnDurationSeconds: 0 }, coastDurationSeconds: 0, decelerationBurn: { burnDurationSeconds: 0 }
      })
    });
    const request = {
      method: "POST" as const, path: "/ship-orders" as const, eventPosition: () => origin,
      body: { orderId: "valid", destinationId: "mars", departureAtMs: simTimeMs(0), plan: undefined, arrivalProfileFuelCost: { burnDurationSeconds: 0 } }
    };

    await expect(controller.postCommit({ ...request, body: { ...request.body, orderId: "" } })).rejects.toMatchObject(
      { name: "ShipOrderCommandRefusal", code: "empty-order-id" } satisfies Partial<ShipOrderCommandRefusal>
    );
    await expect(controller.postCommit({ ...request, body: { ...request.body, destinationId: "" } })).rejects.toMatchObject(
      { name: "ShipOrderCommandRefusal", code: "empty-destination-id" } satisfies Partial<ShipOrderCommandRefusal>
    );
    await expect(controller.postCommit(request)).rejects.toMatchObject(
      { name: "ShipOrderCommandRefusal", code: "zero-total-duration" } satisfies Partial<ShipOrderCommandRefusal>
    );
    expect((await simulation.persistedStream()).events).toEqual([]);
  });

  it("refuses invalid and pre-commit departure epochs before the event store", async () => {
    const store = new InMemorySimulationEventStore();
    const simulation = await AuthoritativeSimLoop.create({
      store, stream: { id: "departure-refusals", seed: 1, initialTime: simTimeMs(10) }
    });
    let plannerCalls = 0;
    const controller = new ShipOrderRestController(simulation, {
      plan: () => {
        plannerCalls += 1;
        return { accelerationBurn: { burnDurationSeconds: 1 }, coastDurationSeconds: 0, decelerationBurn: { burnDurationSeconds: 0 } };
      }
    });
    const request = {
      method: "POST" as const, path: "/ship-orders" as const, eventPosition: () => origin,
      body: { orderId: "departure", destinationId: "mars", departureAtMs: simTimeMs(9), plan: undefined, arrivalProfileFuelCost: { burnDurationSeconds: 0 } }
    };
    await expect(controller.postCommit(request)).rejects.toMatchObject({ code: "departure-before-commit" } satisfies Partial<ShipOrderCommandRefusal>);
    await expect(controller.postCommit({ ...request, body: { ...request.body, departureAtMs: 1.5 as never } })).rejects.toMatchObject({ code: "invalid-departure-time" } satisfies Partial<ShipOrderCommandRefusal>);
    expect(plannerCalls).toBe(1);
    expect((await simulation.persistedStream()).events).toEqual([]);
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
      body: { orderId: "replay-order", destinationId: "mars", departureAtMs: simTimeMs(1), plan: undefined, arrivalProfileFuelCost: { burnDurationSeconds: 0 } },
      eventPosition: () => origin
    });
    await simulation.advance(3, () => origin);

    const resumed = await AuthoritativeSimLoop.resume(store, "replay");
    expect(resumed.state).toEqual(simulation.state);
  });
});
