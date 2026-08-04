import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import { SimClock, simTimeMs } from "./clock.js";
import {
  CausalEmissionGate,
  CausalityInvariantViolation,
  assertCausalityInvariant,
  type EmittedMessage,
  type PositionMeters
} from "./causality.js";

const ORIGIN: PositionMeters = { x: 0, y: 0, z: 0 };

describe("causality invariant", () => {
  it("deliberately rejects a message emitted before its light-time", () => {
    expect(() =>
      assertCausalityInvariant({
        eventTime: simTimeMs(0),
        emissionTime: simTimeMs(1),
        eventPosition: ORIGIN,
        observerPosition: { x: 1_000_000, y: 0, z: 0 }
      })
    ).toThrow(CausalityInvariantViolation);
  });

  it("fails closed, records an incident, and never calls transport on a violation", () => {
    const send = vi.fn();
    const recordIncident = vi.fn();
    const gate = new CausalEmissionGate({ send, recordIncident });

    const result = gate.emit({
      payload: { kind: "marketQuote" },
      eventTime: simTimeMs(0),
      emissionTime: simTimeMs(1),
      eventPosition: ORIGIN,
      observerPosition: { x: 1_000_000, y: 0, z: 0 }
    });

    expect(result).toEqual({ sent: false });
    expect(send).not.toHaveBeenCalled();
    expect(recordIncident).toHaveBeenCalledOnce();
  });

  it("emits the full eligible stream with correct invariant and server staleness metadata", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0xffff_ffff }),
        fc.array(
          fc.record({
            eventTime: fc.integer({ min: 0, max: 10_000_000 }),
            x: fc.integer({ min: -2_000_000_000, max: 2_000_000_000 }),
            y: fc.integer({ min: -2_000_000_000, max: 2_000_000_000 }),
            z: fc.integer({ min: -2_000_000_000, max: 2_000_000_000 })
          }),
          { minLength: 1, maxLength: 40 }
        ),
        (seed, events) => {
          const sent: EmittedMessage<{ readonly seed: number; readonly index: number }>[] = [];
          const gate = new CausalEmissionGate<{ readonly seed: number; readonly index: number }>({
            send: (message) => sent.push(message),
            recordIncident: () => {
              throw new Error("An eligible generated message must not raise an incident.");
            }
          });

          for (const [index, event] of events.entries()) {
            const clock = SimClock.production(simTimeMs(event.eventTime));
            const observerPosition: PositionMeters = {
              x: event.x,
              y: event.y,
              z: event.z
            };
            const distance = Math.hypot(event.x, event.y, event.z);
            clock.advance(Math.ceil((distance / 299_792_458) * 1_000) + index + (seed % 2));

            const result = gate.emit({
              payload: { seed, index },
              eventTime: simTimeMs(event.eventTime),
              emissionTime: clock.now,
              eventPosition: ORIGIN,
              observerPosition
            });

            expect(result.sent).toBe(true);
          }

          expect(sent).toHaveLength(events.length);
          for (const message of sent) {
            assertCausalityInvariant(message);
            expect(message.stalenessMs).toBe(message.emissionTime - message.eventTime);
          }
        }
      ),
      { seed: 0x6ca551, numRuns: 200 }
    );
  });
});
