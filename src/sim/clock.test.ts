import { describe, expect, it } from "vitest";

import { SimClock, simTimeMs } from "./clock.js";

describe("SimClock", () => {
  it("pins the production multiplier to 1:1", () => {
    const clock = SimClock.production(simTimeMs(120));

    expect(clock.multiplier).toBe(1);
    expect(clock.advance(45)).toBe(165);
  });

  it("lets tests advance virtual time independently of wall time", () => {
    const clock = SimClock.testing(simTimeMs(0), 40_000);

    expect(clock.advance(1)).toBe(40_000);
  });
});
