import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { replaySegment, type SimEvent } from "./event-log.js";

const eventArbitrary = fc.oneof(
  fc.record({
    type: fc.constant<"clockAdvanced">("clockAdvanced"),
    elapsedMs: fc.integer({ min: 0, max: 10_000 })
  }),
  fc.record({
    type: fc.constant<"randomValueRequested">("randomValueRequested"),
    upperExclusive: fc.integer({ min: 1, max: 1_000_000 })
  })
);

describe("event log replay", () => {
  it("replays every generated sim segment identically from its seed and event log", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0xffff_ffff }),
        fc.array(eventArbitrary, { maxLength: 200 }),
        (seed, events) => {
          const firstReplay = replaySegment(seed, events as SimEvent[]);
          const secondReplay = replaySegment(seed, events as SimEvent[]);

          expect(secondReplay).toEqual(firstReplay);
        }
      ),
      { numRuns: 500 }
    );
  });
});
