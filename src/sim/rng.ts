/** Deterministic pseudo-random stream for simulation decisions. */
export class SeededRng {
  #state: number;

  constructor(seed: number) {
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
      throw new RangeError("Seed must be an unsigned 32-bit integer.");
    }

    this.#state = seed;
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

/**
 * Folds a named random substream ID into a stable uint32 using FNV-1a over
 * UTF-16 code units. Stream IDs are protocol data: changing this changes
 * every dependent deterministic history.
 */
const fnv1a32 = (value: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193);
  }
  return hash >>> 0;
};

/** One-round splitmix32 finalizer, used only to derive independent stream seeds. */
const splitmix32 = (value: number): number => {
  let mixed = (value + 0x9e3779b9) >>> 0;
  mixed = Math.imul(mixed ^ (mixed >>> 16), 0x21f0aaad);
  mixed = Math.imul(mixed ^ (mixed >>> 15), 0x735a2d97);
  return (mixed ^ (mixed >>> 15)) >>> 0;
};

/**
 * Returns a deterministic independent stream for a named simulation concern.
 *
 * The world seed and stream name are mixed once, then mulberry32 owns draws
 * within that stream. This isolates market history from future RNG consumers.
 */
export const deriveStream = (worldSeed: number, streamId: string): SeededRng => {
  if (!Number.isSafeInteger(worldSeed) || worldSeed < 0 || worldSeed > 0xffff_ffff) {
    throw new RangeError("World seed must be an unsigned 32-bit integer.");
  }
  if (streamId.length === 0) throw new RangeError("Random substreams require a non-empty stream ID.");
  return new SeededRng(splitmix32(worldSeed ^ fnv1a32(streamId)));
};
