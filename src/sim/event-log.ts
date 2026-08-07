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
  | {
    readonly type: "shipOrderCommitted";
    readonly order: CommittedShipOrder;
    /** Decision windows are part of the single irreversible commitment. */
    readonly decisions: readonly ScheduledShipDecision[];
  }
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

/** The sole reducer for both durable replay and the live authoritative loop. */
export class SimEventReducer {
  readonly #clock: SimClock;
  readonly #rng: SeededRng;
  readonly #randomValues: number[] = [];
  #ship: ShipState | undefined;

  constructor(seed: number, initialTime: SimTimeMs = simTimeMs(0)) {
    this.#clock = SimClock.production(initialTime);
    this.#rng = new SeededRng(seed);
  }

  get time(): SimTimeMs { return this.#clock.now; }

  get state(): SimState {
    return this.#ship === undefined
      ? { time: this.#clock.now, randomValues: [...this.#randomValues] }
      : { time: this.#clock.now, randomValues: [...this.#randomValues], ship: this.#ship };
  }

  apply(event: SimEvent): void {
    switch (event.type) {
      case "clockAdvanced":
        this.#clock.advance(event.elapsedMs);
        break;
      case "randomValueRequested":
        this.#randomValues.push(this.#rng.nextInt(event.upperExclusive));
        break;
      case "shipOrderCommitted":
        if (this.#ship !== undefined) throw new Error("A ship order is already committed.");
        this.#ship = {
          order: assertOrder(event.order),
          phase: "accelBurn",
          phaseStartedAtMs: this.#clock.now,
          scheduledDecisions: event.decisions.map(assertDecision)
        };
        break;
      case "shipPhaseChanged":
        if (this.#ship === undefined) throw new Error("Cannot change phase without a committed ship order.");
        this.#ship = { ...this.#ship, phase: event.phase, phaseStartedAtMs: this.#clock.now };
        break;
    }
  }
}

/** Rebuild a segment from its append-only event log and its recorded RNG seed. */
export const replaySegment = (
  seed: number,
  events: readonly SimEvent[],
  initialTime: SimTimeMs = simTimeMs(0)
): SimState => {
  const reducer = new SimEventReducer(seed, initialTime);
  for (const event of events) {
    reducer.apply(event);
  }

  return reducer.state;
};

/** Replays an event-store stream from its persisted seed and append-only order. */
export const replayPersistedSegment = (
  stream: {
    readonly seed: number;
    readonly initialTime: SimTimeMs;
    readonly events: readonly { readonly event: SimEvent }[];
  }
): SimState => replaySegment(stream.seed, stream.events.map(({ event }) => event), stream.initialTime);
