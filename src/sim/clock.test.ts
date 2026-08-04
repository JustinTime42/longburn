import { describe, expect, it } from "vitest";

import { SimClock, simTimeMs } from "./clock.js";

describe("SimClock", () => {
  it("pins production to 1:1", () => {
    const clock = SimClock.production(simTimeMs(120));

    expect(clock.advance(45)).toBe(165);
  });

});
