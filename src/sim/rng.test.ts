import { describe, expect, it } from "vitest";

import { SeededRng } from "./rng.js";

describe("SeededRng", () => {
  it("produces a stable sequence for a recorded seed", () => {
    const rng = new SeededRng(0x1234_5678);

    expect([rng.nextInt(100), rng.nextInt(1_000_000), rng.nextInt(17)]).toEqual([
      10,
      941_276,
      15
    ]);
  });

  it("rejects seeds outside the unsigned 32-bit range", () => {
    expect(() => new SeededRng(-1)).toThrow(RangeError);
    expect(() => new SeededRng(0x1_0000_0000)).toThrow(RangeError);
  });
});
