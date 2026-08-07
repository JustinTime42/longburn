import { SimClock, simTimeMs, type SimTimeMs } from "./clock.js";
import { SeededRng } from "./rng.js";
import { burnDurationMs, type QuantizedBurnParameters } from "./mass-cargo.js";

export type ShipPhase = "docked" | "accelBurn" | "coast" | "flip" | "decelBurn" | "arrived";
export type ShipDecisionKind = "retarget" | "arrivalProfile";

/**
 * The committed maneuver is replay input, not a planner result.  Durations are
 * integer milliseconds, the single quantization representation from SO 16.
 */
export interface CommittedShipOrder {
  readonly orderId: string;
  readonly destinationId: string;
  readonly accelerationBurn: QuantizedBurnParameters;
  readonly coastDurationMs: number;
  readonly decelerationBurn: QuantizedBurnParameters;
}

export interface ScheduledShipDecision {
  readonly kind: ShipDecisionKind;
  readonly opensAtMs: SimTimeMs;
  readonly closesAtMs: SimTimeMs;
  /** Arrival-profile changes consume this separately quantized additional burn. */
  readonly fuelCostBurn?: QuantizedBurnParameters;
}

export interface ShipState {
  readonly order: CommittedShipOrder;
  readonly phase: ShipPhase;
  readonly phaseStartedAtMs: SimTimeMs;
  readonly scheduledDecisions: readonly ScheduledShipDecision[];
}

export type SimEvent =
  | { readonly type: "clockAdvanced"; readonly elapsedMs: number }
  | { readonly type: "randomValueRequested"; readonly upperExclusive: number }
  | { readonly type: "shipOrderCommitted"; readonly order: CommittedShipOrder }
  | { readonly type: "shipDecisionWindowScheduled"; readonly decision: ScheduledShipDecision }
  | { readonly type: "shipPhaseChanged"; readonly phase: Exclude<ShipPhase, "docked"> };

export interface SimState {
  readonly time: SimTimeMs;
  readonly randomValues: readonly number[];
  /** Undefined until an irreversible ship order has been committed. */
  readonly ship?: ShipState;
}

const assertDuration = (duration: number): number => {
  if (!Number.isSafeInteger(duration) || duration < 0) {
    throw new RangeError("Committed ship durations must be non-negative safe integer milliseconds.");
  }
  return duration;
};

const assertBurn = (burn: QuantizedBurnParameters): QuantizedBurnParameters => ({
  burnDurationMs: burnDurationMs(burn.burnDurationMs)
});

const assertOrder = (order: CommittedShipOrder): CommittedShipOrder => {
  if (order.orderId.length === 0 || order.destinationId.length === 0) {
    throw new RangeError("Committed ship orders require non-empty order and destination IDs.");
  }
  return {
    orderId: order.orderId,
    destinationId: order.destinationId,
    accelerationBurn: assertBurn(order.accelerationBurn),
    coastDurationMs: assertDuration(order.coastDurationMs),
    decelerationBurn: assertBurn(order.decelerationBurn)
  };
};

const assertDecision = (decision: ScheduledShipDecision): ScheduledShipDecision => {
  if (!Number.isSafeInteger(decision.opensAtMs) || !Number.isSafeInteger(decision.closesAtMs) || decision.opensAtMs < 0 || decision.closesAtMs < decision.opensAtMs) {
    throw new RangeError("Scheduled ship decision times must be ordered non-negative integer milliseconds.");
  }
  return {
    ...decision,
    ...(decision.fuelCostBurn === undefined ? {} : { fuelCostBurn: assertBurn(decision.fuelCostBurn) })
  };
};

/** Rebuild a segment from its append-only event log and its recorded RNG seed. */
export const replaySegment = (
  seed: number,
  events: readonly SimEvent[],
  initialTime: SimTimeMs = simTimeMs(0)
): SimState => {
  const clock = SimClock.production(initialTime);
  const rng = new SeededRng(seed);
  const randomValues: number[] = [];
  let ship: ShipState | undefined;

  for (const event of events) {
    switch (event.type) {
      case "clockAdvanced":
        clock.advance(event.elapsedMs);
        break;
      case "randomValueRequested":
        randomValues.push(rng.nextInt(event.upperExclusive));
        break;
      case "shipOrderCommitted":
        if (ship !== undefined) throw new Error("A ship order is already committed.");
        ship = { order: assertOrder(event.order), phase: "accelBurn", phaseStartedAtMs: clock.now, scheduledDecisions: [] };
        break;
      case "shipDecisionWindowScheduled":
        if (ship === undefined) throw new Error("Cannot schedule a decision without a committed ship order.");
        ship = { ...ship, scheduledDecisions: [...ship.scheduledDecisions, assertDecision(event.decision)] };
        break;
      case "shipPhaseChanged":
        if (ship === undefined) throw new Error("Cannot change phase without a committed ship order.");
        ship = { ...ship, phase: event.phase, phaseStartedAtMs: clock.now };
        break;
    }
  }

  return ship === undefined ? { time: clock.now, randomValues } : { time: clock.now, randomValues, ship };
};

/** Replays an event-store stream from its persisted seed and append-only order. */
export const replayPersistedSegment = (
  stream: {
    readonly seed: number;
    readonly initialTime: SimTimeMs;
    readonly events: readonly { readonly event: SimEvent }[];
  }
): SimState => replaySegment(stream.seed, stream.events.map(({ event }) => event), stream.initialTime);
