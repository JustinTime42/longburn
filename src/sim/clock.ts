/** A millisecond timestamp in the simulation's virtual timeline. */
export type SimTimeMs = number & { readonly __simTimeMs: unique symbol };

export const simTimeMs = (value: number): SimTimeMs => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Simulation time must be a non-negative safe integer in milliseconds.");
  }

  return value as SimTimeMs;
};

/**
 * The only clock available to the simulation. Callers supply elapsed time;
 * this class never consults a wall clock.
 */
export class SimClock {
  #now: SimTimeMs;

  private constructor(initialTime: SimTimeMs) {
    this.#now = initialTime;
  }

  /** Production is deliberately fixed to the product's 1:1 clock. */
  static production(initialTime: SimTimeMs = simTimeMs(0)): SimClock {
    return new SimClock(initialTime);
  }

  /** Tests can advance this virtual clock by any explicit elapsed duration. */
  static testing(initialTime: SimTimeMs = simTimeMs(0)): SimClock {
    return new SimClock(initialTime);
  }

  get now(): SimTimeMs {
    return this.#now;
  }

  advance(elapsedMs: number): SimTimeMs {
    if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0) {
      throw new RangeError("Elapsed time must be a non-negative safe integer in milliseconds.");
    }

    const next = this.#now + elapsedMs;
    if (!Number.isSafeInteger(next)) {
      throw new RangeError("Simulation time overflowed its safe integer range.");
    }

    this.#now = simTimeMs(next);
    return this.#now;
  }
}
