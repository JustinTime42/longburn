import { describe, expect, it } from "vitest";

import { simTimeMs } from "../sim/clock.js";
import { InMemorySimulationEventStore } from "../sim/event-store.js";
import { AuthoritativeSimLoop } from "../sim/loop.js";
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
