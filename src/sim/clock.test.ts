import { describe, expect, it } from "vitest";

import { SimClock, simTimeMs } from "./clock.js";

describe("SimClock", () => {
  it("pins production to 1:1", () => {
    const clock = SimClock.production(simTimeMs(120));

    expect(clock.advance(45)).toBe(165);
  });

  it("lets tests advance virtual time independently of wall time", () => {
    const clock = SimClock.testing(simTimeMs(0));

    expect(clock.advance(40_000)).toBe(40_000);
  });
});
