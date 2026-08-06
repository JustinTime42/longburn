import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import { simTimeMs } from "./clock.js";
import {
  CausalEmissionGate,
  CausalityInvariantViolation,
  SPEED_OF_LIGHT_METERS_PER_SECOND,
  assertCausalityInvariant,
  earliestLegalEmissionTimeMs,
  requiredArrivalTimeMs,
  type EmittedMessage,
  type PositionMeters
} from "./causality.js";

const ORIGIN: PositionMeters = { x: 0, y: 0, z: 0 };
const stationaryAt = (position: PositionMeters) => () => position;
const independentEarliestTick = (distanceMeters: number): number => Math.ceil((distanceMeters / 299_792_458) * 1_000);

/** Independent closed-form light-cone oracle for linear receiver motion. */
const independentLinearArrivalTimeMs = (
  eventTime: number,
  receiverPositionAtEvent: PositionMeters,
  velocityMetersPerSecond: PositionMeters
): number => {
  const c = 299_792_458;
  const positionSquared = receiverPositionAtEvent.x ** 2 + receiverPositionAtEvent.y ** 2 + receiverPositionAtEvent.z ** 2;
  const velocitySquared = velocityMetersPerSecond.x ** 2 + velocityMetersPerSecond.y ** 2 + velocityMetersPerSecond.z ** 2;
  const positionVelocity = receiverPositionAtEvent.x * velocityMetersPerSecond.x +
    receiverPositionAtEvent.y * velocityMetersPerSecond.y +
    receiverPositionAtEvent.z * velocityMetersPerSecond.z;
  const discriminant = (2 * positionVelocity) ** 2 - 4 * (velocitySquared - c ** 2) * positionSquared;
  const elapsedSeconds = (2 * positionSquared) / (Math.sqrt(discriminant) - 2 * positionVelocity);

  return eventTime + elapsedSeconds * 1_000;
};

const linearWorldline = (
  eventTime: number,
  receiverPositionAtEvent: PositionMeters,
  velocityMetersPerSecond: PositionMeters
) => (timeMs: number): PositionMeters => {
  const elapsedSeconds = (timeMs - eventTime) / 1_000;
  return {
    x: receiverPositionAtEvent.x + velocityMetersPerSecond.x * elapsedSeconds,
    y: receiverPositionAtEvent.y + velocityMetersPerSecond.y * elapsedSeconds,
    z: receiverPositionAtEvent.z + velocityMetersPerSecond.z * elapsedSeconds
  };
};

describe("causality invariant", () => {
  it("blocks one millisecond before the exact legal tick and admits that tick", () => {
    const distance = SPEED_OF_LIGHT_METERS_PER_SECOND;
    const earliestTick = independentEarliestTick(distance);
    const base = {
      eventTime: simTimeMs(0),
      eventPosition: ORIGIN,
      observerPositionAt: stationaryAt({ x: distance, y: 0, z: 0 })
    };

    expect(earliestLegalEmissionTimeMs({ ...base, emissionTime: simTimeMs(earliestTick) })).toBe(earliestTick);
    expect(() => assertCausalityInvariant({ ...base, emissionTime: simTimeMs(earliestTick - 1) })).toThrow(
      CausalityInvariantViolation
    );
    expect(() => assertCausalityInvariant({ ...base, emissionTime: simTimeMs(earliestTick) })).not.toThrow();
  });

  it("fails closed for malformed provenance and reporting failures", () => {
    const send = vi.fn();
    const recordIncident = vi.fn(() => { throw new Error("incident sink unavailable"); });
    const incrementCausalityFailure = vi.fn(() => { throw new Error("counter unavailable"); });
    const gate = new CausalEmissionGate({ send, recordIncident, incrementCausalityFailure });

    const result = gate.emit({
      payload: { kind: "marketQuote" },
      eventTime: Number.NaN as never,
      emissionTime: simTimeMs(1_000),
      eventPosition: ORIGIN,
      observerPositionAt: stationaryAt({ x: SPEED_OF_LIGHT_METERS_PER_SECOND, y: 0, z: 0 })
    });

    expect(result).toEqual({ sent: false, reason: "invalid-provenance" });
    expect(send).not.toHaveBeenCalled();
    expect(recordIncident).toHaveBeenCalledOnce();
    expect(incrementCausalityFailure).toHaveBeenCalledOnce();
  });

  it("fails closed and alerts when the worldline cannot converge", () => {
    const send = vi.fn();
    const recordIncident = vi.fn();
    const incrementCausalityFailure = vi.fn();
    const gate = new CausalEmissionGate({ send, recordIncident, incrementCausalityFailure });
    const result = gate.emit({
      payload: { kind: "telemetry" },
      eventTime: simTimeMs(0),
      emissionTime: simTimeMs(10_000),
      eventPosition: ORIGIN,
      observerPositionAt: (timeMs) => timeMs <= 0 ? { x: SPEED_OF_LIGHT_METERS_PER_SECOND, y: 0, z: 0 } : ORIGIN
    });

    expect(result).toEqual({ sent: false, reason: "light-cone-failure" });
    expect(send).not.toHaveBeenCalled();
    expect(recordIncident).toHaveBeenCalledWith(expect.objectContaining({ reason: "light-cone-failure" }));
    expect(incrementCausalityFailure).toHaveBeenCalledOnce();
  });

  it("uses the observer arrival worldline rather than its event-time position", () => {
    const eventPosition = ORIGIN;
    const observerPositionAt = (timeMs: number): PositionMeters => ({ x: SPEED_OF_LIGHT_METERS_PER_SECOND + timeMs * 100, y: 0, z: 0 });
    const earliest = earliestLegalEmissionTimeMs({
      eventTime: simTimeMs(0), emissionTime: simTimeMs(0), eventPosition, observerPositionAt
    });

    expect(earliest).toBeGreaterThan(1_000);
    expect(() => assertCausalityInvariant({
      eventTime: simTimeMs(0), emissionTime: simTimeMs(earliest - 1), eventPosition, observerPositionAt
    })).toThrow(CausalityInvariantViolation);
  });

  it("labels transport faults without incrementing the causality alert", () => {
    const send = vi.fn(() => { throw new Error("connection reset after write"); });
    const recordIncident = vi.fn();
    const incrementCausalityFailure = vi.fn();
    const gate = new CausalEmissionGate({ send, recordIncident, incrementCausalityFailure });
    const secretPayload = { message: "do not place this in an incident" };

    const result = gate.emit({
      payload: secretPayload,
      eventTime: simTimeMs(0),
      emissionTime: simTimeMs(1_000),
      eventPosition: ORIGIN,
      observerPositionAt: stationaryAt({ x: SPEED_OF_LIGHT_METERS_PER_SECOND, y: 0, z: 0 })
    });

    expect(result).toEqual({ sent: false, reason: "transport-failure" });
    expect(send).toHaveBeenCalledOnce();
    expect(recordIncident).toHaveBeenCalledWith({
      reason: "transport-failure",
      provenance: { eventTime: 0, emissionTime: 1_000, eventPosition: ORIGIN }
    });
    expect(recordIncident.mock.calls[0]?.[0].provenance).not.toHaveProperty("payload");
    expect(incrementCausalityFailure).not.toHaveBeenCalled();
  });

  it("independently generates both sides of the stationary light-time boundary", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20_000_000_000 }),
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.boolean(),
        (distance, eventTime, eligible) => {
          const earliestTick = eventTime + independentEarliestTick(distance);
          const emissionTime = eligible ? earliestTick : earliestTick - 1;
          const provenance = {
            eventTime: simTimeMs(eventTime),
            emissionTime: simTimeMs(emissionTime),
            eventPosition: ORIGIN,
            observerPositionAt: stationaryAt({ x: distance, y: 0, z: 0 })
          };

          if (eligible) {
            expect(() => assertCausalityInvariant(provenance)).not.toThrow();
          } else {
            expect(() => assertCausalityInvariant(provenance)).toThrow(CausalityInvariantViolation);
          }
        }
      ),
      { seed: 0x6ca551, numRuns: 400 }
    );
  });

  it("independently generates both sides of moving-receiver light-cone boundaries", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 1_000_000, max: 20_000_000_000 }),
        fc.integer({ min: -10_000_000_000, max: 10_000_000_000 }),
        fc.integer({ min: -10_000_000_000, max: 10_000_000_000 }),
        fc.integer({ min: -100_000, max: 100_000 }),
        fc.integer({ min: -100_000, max: 100_000 }),
        fc.integer({ min: -100_000, max: 100_000 }),
        (eventTime, x, y, z, velocityX, velocityY, velocityZ) => {
          const receiverPositionAtEvent = { x, y, z };
          const velocityMetersPerSecond = { x: velocityX, y: velocityY, z: velocityZ };
          const exactArrivalTimeMs = independentLinearArrivalTimeMs(
            eventTime, receiverPositionAtEvent, velocityMetersPerSecond
          );
          const earliestTick = Math.ceil(exactArrivalTimeMs);
          // Keep the exact tick clear of the solver's 0.001 ms conservative
          // margin, while retaining enough motion for stale iterations to leak.
          fc.pre(earliestTick - exactArrivalTimeMs > 0.01);
          const observerPositionAt = linearWorldline(eventTime, receiverPositionAtEvent, velocityMetersPerSecond);
          const base = {
            eventTime: simTimeMs(eventTime),
            eventPosition: ORIGIN,
            observerPositionAt
          };

          expect(requiredArrivalTimeMs({ ...base, emissionTime: simTimeMs(earliestTick) })).toBeGreaterThanOrEqual(
            exactArrivalTimeMs
          );
          expect(() => assertCausalityInvariant({ ...base, emissionTime: simTimeMs(earliestTick - 1) })).toThrow(
            CausalityInvariantViolation
          );
          expect(() => assertCausalityInvariant({ ...base, emissionTime: simTimeMs(earliestTick) })).not.toThrow();
        }
      ),
      { seed: 0x11c0de, numRuns: 800 }
    );
  });

  it("eventually emits every delayed message with authoritative staleness", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0xffff_ffff }),
        fc.array(fc.integer({ min: 0, max: 20_000_000_000 }), { minLength: 1, maxLength: 40 }),
        (seed, distances) => {
          const sent: EmittedMessage<{ readonly seed: number; readonly index: number }>[] = [];
          const recordIncident = vi.fn();
          const incrementCausalityFailure = vi.fn();
          const gate = new CausalEmissionGate<{ readonly seed: number; readonly index: number }>({
            send: (message) => sent.push(message), recordIncident, incrementCausalityFailure
          });

          for (const [index, distance] of distances.entries()) {
            const eventTime = index * 10_000;
            const earliest = eventTime + independentEarliestTick(distance);
            const event = {
              payload: { seed, index }, eventTime: simTimeMs(eventTime), eventPosition: ORIGIN,
              observerPositionAt: stationaryAt({ x: distance, y: 0, z: 0 })
            };
            expect(gate.emit({ ...event, emissionTime: simTimeMs(earliest - 1) })).toEqual({
              sent: false, reason: "early-emission"
            });
            expect(gate.emit({ ...event, emissionTime: simTimeMs(earliest) })).toEqual({ sent: true });
          }

          expect(sent).toHaveLength(distances.length);
          expect(recordIncident).toHaveBeenCalledTimes(distances.length);
          expect(incrementCausalityFailure).toHaveBeenCalledTimes(distances.length);
          for (const message of sent) {
            assertCausalityInvariant(message);
            expect(message.stalenessMs).toBe(message.emissionTime - message.eventTime);
          }
        }
      ),
      { seed: 0x1a11ce, numRuns: 200 }
    );
  });
});
