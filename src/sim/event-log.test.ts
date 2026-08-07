import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { replaySegment, type SimEvent } from "./event-log.js";
import { simTimeMs } from "./clock.js";
import { burnDurationMs } from "./mass-cargo.js";

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
  it("replays the recorded golden segment to its literal state", () => {
    const events: readonly SimEvent[] = [
      { type: "clockAdvanced", elapsedMs: 120 },
      { type: "randomValueRequested", upperExclusive: 100 },
      { type: "clockAdvanced", elapsedMs: 380 },
      { type: "randomValueRequested", upperExclusive: 1_000_000 },
      { type: "clockAdvanced", elapsedMs: 5_000 },
      { type: "randomValueRequested", upperExclusive: 17 }
    ];

    expect(replaySegment(0x1234_5678, events)).toEqual({
      time: 5_500,
      randomValues: [10, 941_276, 15]
    });
  });

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

  it("reduces an atomic ship commitment and every phase-change branch", () => {
    const events: readonly SimEvent[] = [
      {
        type: "shipOrderCommitted",
        order: {
          orderId: "order-1", destinationId: "mars",
          departureAtMs: simTimeMs(2),
          accelerationBurn: { burnDurationMs: burnDurationMs(1) }, coastDurationMs: 2, decelerationBurn: { burnDurationMs: burnDurationMs(3) }
        },
        decisions: [
          { kind: "retarget", opensAtMs: simTimeMs(2), closesAtMs: simTimeMs(8) },
          { kind: "arrivalProfile", opensAtMs: simTimeMs(5), closesAtMs: simTimeMs(8), fuelCostBurn: { burnDurationMs: burnDurationMs(1) } }
        ]
      },
      { type: "clockAdvanced", elapsedMs: 2 }, { type: "shipPhaseChanged", phase: "accelBurn" },
      { type: "clockAdvanced", elapsedMs: 1 }, { type: "shipPhaseChanged", phase: "coast" },
      { type: "clockAdvanced", elapsedMs: 2 }, { type: "shipPhaseChanged", phase: "flip" },
      { type: "shipPhaseChanged", phase: "decelBurn" },
      { type: "clockAdvanced", elapsedMs: 3 }, { type: "shipPhaseChanged", phase: "arrived" }
    ];

    expect(replaySegment(1, events)).toMatchObject({
      time: 8,
      ship: {
        phase: "arrived",
        scheduledDecisions: [
          { kind: "retarget", opensAtMs: 2, closesAtMs: 8 },
          { kind: "arrivalProfile", opensAtMs: 5, closesAtMs: 8, fuelCostBurn: { burnDurationMs: 1 } }
        ]
      }
    });
  });

  it("rejects invalid committed orders and scheduled decisions in the shared reducer", () => {
    const order = {
      orderId: "order-1", destinationId: "mars",
      departureAtMs: simTimeMs(0),
      accelerationBurn: { burnDurationMs: burnDurationMs(1) }, coastDurationMs: 0, decelerationBurn: { burnDurationMs: burnDurationMs(0) }
    };
    expect(() => replaySegment(1, [{ type: "shipOrderCommitted", order: { ...order, orderId: "" }, decisions: [] }]))
      .toThrow("Committed ship orders require non-empty order and destination IDs.");
    expect(() => replaySegment(1, [{ type: "shipOrderCommitted", order: { ...order, coastDurationMs: -1 }, decisions: [] }]))
      .toThrow("Committed ship durations must be non-negative safe integer milliseconds.");
    expect(() => replaySegment(1, [{
      type: "shipOrderCommitted", order,
      decisions: [{ kind: "retarget", opensAtMs: simTimeMs(4), closesAtMs: simTimeMs(3) }]
    }])).toThrow("Scheduled ship decision times must be ordered non-negative integer milliseconds.");
    expect(() => replaySegment(1, [{ type: "shipPhaseChanged", phase: "coast" }]))
      .toThrow("Cannot change phase without a committed ship order.");
  });
});
