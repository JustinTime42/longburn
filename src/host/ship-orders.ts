/**
 * REST command boundary for the irreversible Tier-0 ship order.
 *
 * Planner arithmetic is allowed here, once, before quantization. The
 * authoritative loop receives only integer-millisecond maneuver parameters.
 */
import type { PositionMeters } from "../sim/causality.js";
import type { SimTimeMs } from "../sim/clock.js";
import {
  type CommittedShipOrder,
  type ScheduledShipDecision,
  type SimState
} from "../sim/event-log.js";
import {
  quantizeBurnParameters,
  type BurnParameters,
  type QuantizedBurnParameters
} from "../sim/mass-cargo.js";

export const RETARGET_WINDOW_MILLISECONDS = 6 * 60 * 60 * 1_000;

/** Planning-layer output. It must not be stored or replayed by the sim. */
export interface ShipOrderAdvice {
  readonly accelerationBurn: Pick<BurnParameters, "burnDurationSeconds">;
  readonly coastDurationSeconds: number;
  readonly decelerationBurn: Pick<BurnParameters, "burnDurationSeconds">;
}

/** The planner is intentionally a one-shot command dependency, never a sim dependency. */
export interface ShipOrderPlanner<TPlanInput> {
  plan(input: TPlanInput): ShipOrderAdvice;
}

export interface CommitShipOrderRequest<TPlanInput> {
  readonly orderId: string;
  readonly destinationId: string;
  readonly plan: TPlanInput;
  /** Additional fuel reserved for the scheduled arrival-profile decision. */
  readonly arrivalProfileFuelCost: Pick<BurnParameters, "burnDurationSeconds">;
}

export interface ShipOrderCommandLoop {
  readonly state: SimState;
  commitShipOrder(
    order: CommittedShipOrder,
    decisions: readonly ScheduledShipDecision[],
    eventPosition: PositionMeters
  ): Promise<void>;
}

export interface CommitShipOrderRestRequest<TPlanInput> {
  readonly method: "POST";
  readonly path: "/ship-orders";
  readonly body: CommitShipOrderRequest<TPlanInput>;
  readonly eventPosition: PositionMeters;
}

export interface CommitShipOrderRestResponse {
  readonly status: 201;
  readonly order: CommittedShipOrder;
  readonly scheduledDecisions: readonly ScheduledShipDecision[];
}

export type ShipOrderCommandRefusalCode =
  | "empty-order-id"
  | "empty-destination-id"
  | "zero-total-duration"
  | "order-already-committed";

/** A command was refused before it could enter the irreversible event log. */
export class ShipOrderCommandRefusal extends Error {
  readonly code: ShipOrderCommandRefusalCode;

  constructor(code: ShipOrderCommandRefusalCode) {
    super(`Ship order command refused: ${code}.`);
    this.name = "ShipOrderCommandRefusal";
    this.code = code;
  }
}

const quantizeDuration = (durationSeconds: number): number =>
  quantizeBurnParameters({ burnDurationSeconds: durationSeconds }).burnDurationMs;

const arrivalTime = (now: SimTimeMs, order: CommittedShipOrder): SimTimeMs => {
  const duration = order.accelerationBurn.burnDurationMs + order.coastDurationMs + order.decelerationBurn.burnDurationMs;
  if (!Number.isSafeInteger(duration) || now + duration > Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Committed ship order arrival exceeds the simulation time range.");
  }
  return (now + duration) as SimTimeMs;
};

const scheduledDecisions = (
  now: SimTimeMs,
  order: CommittedShipOrder,
  arrivalProfileFuelCost: QuantizedBurnParameters
): readonly ScheduledShipDecision[] => {
  const arrival = arrivalTime(now, order);
  const retargetClosesAt = Math.min(arrival, now + RETARGET_WINDOW_MILLISECONDS) as SimTimeMs;
  const arrivalProfileOpensAt = (now + order.accelerationBurn.burnDurationMs + order.coastDurationMs) as SimTimeMs;
  return [
    { kind: "retarget", opensAtMs: now, closesAtMs: retargetClosesAt },
    {
      kind: "arrivalProfile",
      opensAtMs: arrivalProfileOpensAt,
      closesAtMs: arrival,
      fuelCostBurn: arrivalProfileFuelCost
    }
  ];
};

/**
 * A minimal REST-shaped controller. A future HTTP adapter dispatches only its
 * POST route; the command surface intentionally contains no reversal route.
 */
export class ShipOrderRestController<TPlanInput> {
  readonly #simulation: ShipOrderCommandLoop;
  readonly #planner: ShipOrderPlanner<TPlanInput>;

  constructor(simulation: ShipOrderCommandLoop, planner: ShipOrderPlanner<TPlanInput>) {
    this.#simulation = simulation;
    this.#planner = planner;
  }

  async postCommit(request: CommitShipOrderRestRequest<TPlanInput>): Promise<CommitShipOrderRestResponse> {
    const { body } = request;
    if (body.orderId.length === 0) throw new ShipOrderCommandRefusal("empty-order-id");
    if (body.destinationId.length === 0) throw new ShipOrderCommandRefusal("empty-destination-id");
    if (this.#simulation.state.ship !== undefined) {
      throw new ShipOrderCommandRefusal("order-already-committed");
    }
    const advice = this.#planner.plan(body.plan);
    const order: CommittedShipOrder = {
      orderId: body.orderId,
      destinationId: body.destinationId,
      accelerationBurn: quantizeBurnParameters(advice.accelerationBurn),
      coastDurationMs: quantizeDuration(advice.coastDurationSeconds),
      decelerationBurn: quantizeBurnParameters(advice.decelerationBurn)
    };
    if (order.accelerationBurn.burnDurationMs + order.coastDurationMs + order.decelerationBurn.burnDurationMs === 0) {
      throw new ShipOrderCommandRefusal("zero-total-duration");
    }
    const decisions = scheduledDecisions(
      this.#simulation.state.time,
      order,
      quantizeBurnParameters(body.arrivalProfileFuelCost)
    );
    await this.#simulation.commitShipOrder(order, decisions, request.eventPosition);
    return { status: 201, order, scheduledDecisions: decisions };
  }
}
