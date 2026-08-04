/** Deterministic pseudo-random stream for simulation decisions. */
export class SeededRng {
  #state: number;

  constructor(seed: number) {
    if (!Number.isSafeInteger(seed)) {
      throw new RangeError("Seed must be a safe integer.");
    }

    this.#state = seed >>> 0;
  }

  nextFloat(): number {
    let value = (this.#state += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  }

  nextInt(upperExclusive: number): number {
    if (!Number.isSafeInteger(upperExclusive) || upperExclusive <= 0) {
      throw new RangeError("Random integer upper bound must be a positive safe integer.");
    }

    return Math.floor(this.nextFloat() * upperExclusive);
  }
}
