import type { PositionMeters } from "../sim/causality.js";

/** The narrow simulation boundary needed by the wall-clock host. */
export interface AdvancingSimulation {
  advance(elapsedMs: number, eventPosition: PositionMeters): Promise<unknown>;
}

/** Wall time is deliberately injected so host scheduling is testable. */
export type WallClock = () => number;

/** Minimal timer boundary; the simulation core never receives either dependency. */
export interface TickScheduler {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface HostTickDriverOptions {
  readonly simulation: AdvancingSimulation;
  readonly eventPosition: () => PositionMeters;
  readonly intervalMs: number;
  readonly wallClock?: WallClock;
  readonly scheduler?: TickScheduler;
  readonly onError?: (error: unknown) => void;
}

const systemWallClock: WallClock = () => Date.now();

const systemScheduler: TickScheduler = {
  setInterval: (callback, intervalMs) => setInterval(callback, intervalMs),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>)
};

/**
 * Host half of the authoritative continuous loop. It reads wall time only at
 * this boundary, converts it to elapsed milliseconds, and supplies that input
 * to the deterministic simulation.
 */
export class HostTickDriver {
  readonly #simulation: AdvancingSimulation;
  readonly #eventPosition: () => PositionMeters;
  readonly #intervalMs: number;
  readonly #wallClock: WallClock;
  readonly #scheduler: TickScheduler;
  readonly #onError: (error: unknown) => void;
  #lastWallClockMs: number | undefined;
  #timer: unknown;
  #advancing = false;

  constructor({ simulation, eventPosition, intervalMs, wallClock = systemWallClock, scheduler = systemScheduler, onError = () => {} }: HostTickDriverOptions) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw new RangeError("Tick interval must be a positive safe integer in milliseconds.");
    }

    this.#simulation = simulation;
    this.#eventPosition = eventPosition;
    this.#intervalMs = intervalMs;
    this.#wallClock = wallClock;
    this.#scheduler = scheduler;
    this.#onError = onError;
  }

  get running(): boolean {
    return this.#timer !== undefined;
  }

  start(): void {
    if (this.running) return;

    this.#lastWallClockMs = this.#readWallClock();
    this.#timer = this.#scheduler.setInterval(() => {
      void this.tick().catch((error: unknown) => this.#onError(error));
    }, this.#intervalMs);
  }

  stop(): void {
    if (!this.running) return;

    this.#scheduler.clearInterval(this.#timer);
    this.#timer = undefined;
    this.#lastWallClockMs = undefined;
  }

  /** Advance once. Concurrent timer firings coalesce into the following tick. */
  async tick(): Promise<void> {
    if (!this.running || this.#advancing) return;

    const wallClockMs = this.#readWallClock();
    const previousWallClockMs = this.#lastWallClockMs;
    if (previousWallClockMs === undefined) {
      throw new Error("Tick driver has no initial wall-clock reading.");
    }
    if (wallClockMs < previousWallClockMs) {
      throw new RangeError("Wall clock moved backwards while the tick driver was running.");
    }

    const elapsedMs = wallClockMs - previousWallClockMs;
    this.#advancing = true;
    try {
      await this.#simulation.advance(elapsedMs, this.#eventPosition());
      this.#lastWallClockMs = wallClockMs;
    } finally {
      this.#advancing = false;
    }
  }

  #readWallClock(): number {
    const value = this.#wallClock();
    if (!Number.isSafeInteger(value)) {
      throw new RangeError("Wall clock must return a safe integer number of milliseconds.");
    }
    return value;
  }
}
