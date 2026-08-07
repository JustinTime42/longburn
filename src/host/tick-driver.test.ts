import { describe, expect, it } from "vitest";

import { simTimeMs } from "../sim/clock.js";
import { InMemorySimulationEventStore, type SimulationEventStore } from "../sim/event-store.js";
import { AuthoritativeSimLoop, AuthoritativeSimLoopConflictError } from "../sim/loop.js";
import { burnDurationMs } from "../sim/mass-cargo.js";
import { HostTickDriver, type TickScheduler } from "./tick-driver.js";

class FakeScheduler implements TickScheduler {
  callback: (() => void) | undefined;
  intervalMs: number | undefined;
  cleared: unknown[] = [];

  setInterval(callback: () => void, intervalMs: number): unknown {
    this.callback = callback;
    this.intervalMs = intervalMs;
    return this;
  }

  clearInterval(handle: unknown): void {
    this.cleared.push(handle);
  }
}

describe("host tick driver", () => {
  it("samples wall time at the host boundary and supplies elapsed time to AuthoritativeSimLoop", async () => {
    const store = new InMemorySimulationEventStore();
    const simulation = await AuthoritativeSimLoop.create({
      store,
      stream: { id: "host-ticks", seed: 1, initialTime: simTimeMs(0) }
    });
    const scheduler = new FakeScheduler();
    let wallClockMs = 1_000;
    const driver = new HostTickDriver({
      simulation,
      eventPosition: () => ({ x: 1, y: 2, z: 3 }),
      intervalMs: 250,
      wallClock: () => wallClockMs,
      scheduler
    });

    driver.start();
    wallClockMs = 1_325;
    await driver.tick();

    expect(scheduler.intervalMs).toBe(250);
    expect(simulation.state.time).toBe(325);
    expect((await simulation.persistedStream()).events).toEqual([
      expect.objectContaining({ event: { type: "clockAdvanced", elapsedMs: 325 }, eventPosition: { x: 1, y: 2, z: 3 } })
    ]);

    driver.stop();
    expect(scheduler.cleared).toEqual([scheduler]);
  });

  it("does not persist a no-op event when the wall clock has not advanced", async () => {
    const advances: number[] = [];
    let eventPositionCalls = 0;
    const scheduler = new FakeScheduler();
    const driver = new HostTickDriver({
      simulation: { advance: async (elapsedMs) => { advances.push(elapsedMs); } },
      eventPosition: () => {
        eventPositionCalls += 1;
        return { x: 0, y: 0, z: 0 };
      },
      intervalMs: 10,
      wallClock: () => 1_000,
      scheduler
    });

    driver.start();
    await driver.tick();

    expect(advances).toEqual([]);
    expect(eventPositionCalls).toBe(0);
  });

  it("coalesces overlapping timer callbacks and reports timer errors without an unhandled rejection", async () => {
    const scheduler = new FakeScheduler();
    let wallClockMs = 0;
    let releaseAdvance: (() => void) | undefined;
    const errors: unknown[] = [];
    const advances: number[] = [];
    const driver = new HostTickDriver({
      simulation: {
        advance: async (elapsedMs) => {
          advances.push(elapsedMs);
          await new Promise<void>((resolve) => {
            releaseAdvance = resolve;
          });
        }
      },
      eventPosition: () => ({ x: 0, y: 0, z: 0 }),
      intervalMs: 10,
      wallClock: () => wallClockMs,
      scheduler,
      onError: (error) => errors.push(error)
    });

    driver.start();
    wallClockMs = 10;
    const firstTick = driver.tick();
    wallClockMs = 20;
    const overlappingTick = driver.tick();
    expect(advances).toEqual([10]);
    releaseAdvance?.();
    await Promise.all([firstTick, overlappingTick]);

    wallClockMs = 5;
    scheduler.callback?.();
    await Promise.resolve();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(RangeError);
  });

  it("stops permanently when a stale authoritative loop reports a conflict", async () => {
    const scheduler = new FakeScheduler();
    const errors: unknown[] = [];
    let wallClockMs = 0;
    const conflict = new AuthoritativeSimLoopConflictError({
      kind: "conflict",
      expectedStreamSequence: 2,
      actualStreamSequence: 3
    });
    const driver = new HostTickDriver({
      simulation: { advance: async () => { throw conflict; } },
      eventPosition: () => ({ x: 0, y: 0, z: 0 }),
      intervalMs: 10,
      wallClock: () => wallClockMs,
      scheduler,
      onError: (error) => errors.push(error)
    });

    driver.start();
    wallClockMs = 10;
    scheduler.callback?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(errors).toEqual([conflict]);
    expect(driver.running).toBe(false);
    expect(scheduler.cleared).toEqual([scheduler]);
  });

  it("serializes a ship commitment issued while a host tick append is in flight", async () => {
    const backingStore = new InMemorySimulationEventStore();
    let resolveAppendStarted: (() => void) | undefined;
    const appendStarted = new Promise<void>((resolve) => { resolveAppendStarted = resolve; });
    let releaseFirstAppend: (() => void) | undefined;
    const firstAppendReleased = new Promise<void>((resolve) => { releaseFirstAppend = resolve; });
    let blockFirstAppend = true;
    const store: SimulationEventStore = {
      createStream: (stream) => backingStore.createStream(stream),
      append: async (...args) => {
        if (blockFirstAppend) {
          blockFirstAppend = false;
          resolveAppendStarted?.();
          await firstAppendReleased;
        }
        return backingStore.append(...args);
      },
      readStream: (streamId) => backingStore.readStream(streamId)
    };
    const simulation = await AuthoritativeSimLoop.create({
      store, stream: { id: "serialized-host-writers", seed: 1, initialTime: simTimeMs(0) }
    });
    const scheduler = new FakeScheduler();
    let wallClockMs = 0;
    const driver = new HostTickDriver({
      simulation,
      eventPosition: () => ({ x: 1, y: 2, z: 3 }),
      intervalMs: 10,
      wallClock: () => wallClockMs,
      scheduler
    });

    driver.start();
    wallClockMs = 10;
    const tick = driver.tick();
    await appendStarted;
    let commandPosition = { x: 4, y: 5, z: 6 };
    const commitment = simulation.commitShipOrder({
      orderId: "interleaved-order",
      destinationId: "mars",
      departureAtMs: simTimeMs(10),
      accelerationBurn: { burnDurationMs: burnDurationMs(1) },
      coastDurationMs: 10,
      decelerationBurn: { burnDurationMs: burnDurationMs(1) }
    }, { burnDurationMs: burnDurationMs(0) }, () => commandPosition);
    commandPosition = { x: 10, y: 11, z: 12 };
    releaseFirstAppend?.();
    const [, decisions] = await Promise.all([tick, commitment]);

    expect(driver.running).toBe(true);
    expect(simulation.state).toMatchObject({
      time: simTimeMs(10),
      ship: { order: { orderId: "interleaved-order" }, phase: "accelBurn" }
    });
    expect((await simulation.persistedStream()).events.map(({ event }) => event.type)).toEqual([
      "clockAdvanced", "shipOrderCommitted", "shipPhaseChanged"
    ]);
    expect(decisions).toEqual([
      { kind: "retarget", opensAtMs: 10, closesAtMs: 22 },
      { kind: "arrivalProfile", opensAtMs: 21, closesAtMs: 22, fuelCostBurn: { burnDurationMs: 0 } }
    ]);
    expect((await simulation.persistedStream()).events[1]).toEqual(expect.objectContaining({
      eventTime: 10,
      eventPosition: commandPosition
    }));
  });

  it("stops when another process wins the store-level stream sequence race", async () => {
    const store = new InMemorySimulationEventStore();
    const simulation = await AuthoritativeSimLoop.create({
      store, stream: { id: "external-writer-conflict", seed: 1, initialTime: simTimeMs(0) }
    });
    const externalLoop = await AuthoritativeSimLoop.resume(store, "external-writer-conflict");
    const scheduler = new FakeScheduler();
    let wallClockMs = 0;
    const driver = new HostTickDriver({
      simulation,
      eventPosition: () => ({ x: 0, y: 0, z: 0 }),
      intervalMs: 10,
      wallClock: () => wallClockMs,
      scheduler
    });

    driver.start();
    await externalLoop.advance(1, () => ({ x: 0, y: 0, z: 0 }));
    wallClockMs = 10;

    await expect(driver.tick()).rejects.toMatchObject({
      name: "AuthoritativeSimLoopConflictError",
      expectedStreamSequence: 0,
      actualStreamSequence: 1
    });
    expect(driver.running).toBe(false);
    expect(scheduler.cleared).toEqual([scheduler]);
  });

  it("rejects invalid host configuration and wall-clock values before sim advancement", async () => {
    expect(() => new HostTickDriver({
      simulation: { advance: async () => {} },
      eventPosition: () => ({ x: 0, y: 0, z: 0 }),
      intervalMs: 0
    })).toThrow("Tick interval");

    const driver = new HostTickDriver({
      simulation: { advance: async () => {} },
      eventPosition: () => ({ x: 0, y: 0, z: 0 }),
      intervalMs: 1,
      wallClock: () => 1.5,
      scheduler: new FakeScheduler()
    });
    expect(() => driver.start()).toThrow("Wall clock");
  });
});
