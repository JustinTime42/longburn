import { SimClock, simTimeMs, type SimTimeMs } from "./clock.js";
import { burnDurationMs, type QuantizedBurnParameters } from "./mass-cargo.js";
import { SeededRng } from "./rng.js";
import type { PositionMeters } from "./causality.js";

/** A view of executed history and elapsed virtual time, never stored by an event. */
export type ShipPhase = "docked" | "accel" | "coast" | "flip" | "decel" | "arrived";
export type BurnKind = "accel" | "correction" | "decel";

/**
 * The quantized, replayable input for one scheduled engine firing. Planner
 * numerics do not cross this boundary.
 */
export interface BurnNode {
  readonly nodeId: string;
  readonly executeAtMs: SimTimeMs;
  readonly kind: BurnKind;
  readonly burn: QuantizedBurnParameters;
}

/** The complete, replaceable set of burns which have not begun firing. */
export interface FlightPlan {
  readonly nodes: readonly BurnNode[];
}

export interface ExecutedBurn {
  readonly node: BurnNode;
  readonly startedAtMs: SimTimeMs;
  readonly endedAtMs?: SimTimeMs;
}

export interface ShipState {
  readonly flightPlan: FlightPlan;
  /** Append-only burn history. A started burn is already irreversible. */
  readonly executedBurns: readonly ExecutedBurn[];
  readonly phase: ShipPhase;
}

export type PlanRevisionRefusalReason = "executed-burn-conflict" | "invalid-plan";

/** Validation failure whose reason is safe to persist in the dispute record. */
export class PlanRevisionValidationError extends Error {
  readonly reason: PlanRevisionRefusalReason;

  constructor(reason: PlanRevisionRefusalReason, message: string) {
    super(message);
    this.name = "PlanRevisionValidationError";
    this.reason = reason;
  }
}

export const assertPlanRevisionRefusalReason = (reason: PlanRevisionRefusalReason): PlanRevisionRefusalReason => {
  if (reason !== "executed-burn-conflict" && reason !== "invalid-plan") {
    throw new RangeError("Plan revision refusals require a known reason.");
  }
  return reason;
};

/** There is deliberately no event which removes or edits an executed burn. */
export type SimEvent =
  | { readonly type: "clockAdvanced"; readonly elapsedMs: number }
  | { readonly type: "randomValueRequested"; readonly upperExclusive: number }
  /** Durable record of a command while its light signal is in flight. */
  | {
    readonly type: "commandIssued";
    readonly commandId: string;
    readonly issuedAtMs: SimTimeMs;
    readonly arrivalAtMs: SimTimeMs;
    readonly hqPosition: PositionMeters;
    readonly arrivalPosition: PositionMeters;
    readonly replacedNodeIds: readonly string[];
    readonly flightPlan: FlightPlan;
  }
  | { readonly type: "planRevisionApplied"; readonly flightPlan: FlightPlan; readonly commandId?: string; readonly replacedNodeIds?: readonly string[] }
  | { readonly type: "planRevisionRefused"; readonly flightPlan: FlightPlan; readonly reason: PlanRevisionRefusalReason; readonly commandId?: string }
  | { readonly type: "burnStarted"; readonly node: BurnNode }
  | { readonly type: "burnEnded"; readonly nodeId: string };

export interface SimState {
  readonly time: SimTimeMs;
  readonly randomValues: readonly number[];
  readonly ship?: ShipState;
}

const assertBurn = (burn: QuantizedBurnParameters): QuantizedBurnParameters => ({
  burnDurationMs: burnDurationMs(burn.burnDurationMs)
});

const assertNode = (node: BurnNode): BurnNode => {
  if (node.nodeId.length === 0) throw new RangeError("Burn nodes require a non-empty node ID.");
  if (node.kind !== "accel" && node.kind !== "correction" && node.kind !== "decel") {
    throw new RangeError("Burn nodes require a known burn kind.");
  }
  return {
    nodeId: node.nodeId,
    executeAtMs: simTimeMs(node.executeAtMs),
    kind: node.kind,
    burn: assertBurn(node.burn)
  };
};

const assertPlan = (plan: FlightPlan): FlightPlan => {
  const nodes = plan.nodes.map(assertNode);
  for (let index = 1; index < nodes.length; index += 1) {
    const previous = nodes[index - 1]!;
    const next = nodes[index]!;
    if (previous.executeAtMs >= next.executeAtMs) {
      throw new RangeError("Flight-plan nodes must have strictly increasing execution times.");
    }
    if (previous.executeAtMs + previous.burn.burnDurationMs > next.executeAtMs) {
      throw new RangeError("Flight-plan burns cannot overlap.");
    }
  }
  if (new Set(nodes.map(({ nodeId }) => nodeId)).size !== nodes.length) {
    throw new RangeError("Flight-plan node IDs must be unique.");
  }
  return { nodes };
};

/** Validates the event-sourced immutability boundary before a live append. */
export const validateFlightPlanRevision = (
  plan: FlightPlan,
  now: SimTimeMs,
  executedBurns: readonly ExecutedBurn[],
  replacedNodeIds: readonly string[] = []
): FlightPlan => {
  // Arrival-time refusal precedence: issued-plan burn conflict, structure,
  // reintroduced executed burn, past burn, then overlap with an active burn.
  const executedNodeIds = new Set(executedBurns.map(({ node }) => node.nodeId));
  if (replacedNodeIds.some((nodeId) => executedNodeIds.has(nodeId))) {
    throw new PlanRevisionValidationError("executed-burn-conflict", "A plan revision arrived after a burn it would replace started.");
  }
  let flightPlan: FlightPlan;
  try {
    flightPlan = assertPlan(plan);
  } catch (error: unknown) {
    throw new PlanRevisionValidationError("invalid-plan", error instanceof Error ? error.message : "Invalid flight-plan revision.");
  }
  if (flightPlan.nodes.some(({ nodeId }) => executedNodeIds.has(nodeId))) {
    throw new PlanRevisionValidationError("executed-burn-conflict", "A flight-plan revision cannot reintroduce an executed burn.");
  }
  if (flightPlan.nodes.some(({ executeAtMs }) => executeAtMs < now)) {
    throw new PlanRevisionValidationError("invalid-plan", "A flight-plan revision cannot schedule a burn in the past.");
  }
  const activeBurn = executedBurns.at(-1);
  if (activeBurn !== undefined && activeBurn.endedAtMs === undefined) {
    const activeBurnEndsAtMs = simTimeMs(activeBurn.startedAtMs + activeBurn.node.burn.burnDurationMs);
    if (flightPlan.nodes.some(({ executeAtMs }) => executeAtMs < activeBurnEndsAtMs)) {
      throw new PlanRevisionValidationError("executed-burn-conflict", "A flight-plan revision cannot overlap a burn that is firing.");
    }
  }
  return flightPlan;
};

const sameBurnNode = (left: BurnNode, right: BurnNode): boolean =>
  left.nodeId === right.nodeId
  && left.executeAtMs === right.executeAtMs
  && left.kind === right.kind
  && left.burn.burnDurationMs === right.burn.burnDurationMs;

const derivedPhase = (flightPlan: FlightPlan, executedBurns: readonly ExecutedBurn[]): ShipPhase => {
  const active = executedBurns.at(-1);
  if (active !== undefined && active.endedAtMs === undefined) {
    return active.node.kind === "accel" ? "accel" : active.node.kind === "decel" ? "decel" : "flip";
  }
  if (executedBurns.length === 0) return "docked";
  if (flightPlan.nodes.length === 0) return "arrived";
  return executedBurns.at(-1)?.node.kind === "accel" ? "coast" : "flip";
};

/** The sole reducer for both durable replay and the live authoritative loop. */
export class SimEventReducer {
  readonly #clock: SimClock;
  readonly #rng: SeededRng;
  readonly #randomValues: number[] = [];
  #flightPlan: FlightPlan | undefined;
  #executedBurns: ExecutedBurn[] = [];

  constructor(seed: number, initialTime: SimTimeMs = simTimeMs(0)) {
    this.#clock = SimClock.production(initialTime);
    this.#rng = new SeededRng(seed);
  }

  get time(): SimTimeMs { return this.#clock.now; }

  get state(): SimState {
    if (this.#flightPlan === undefined) return { time: this.#clock.now, randomValues: [...this.#randomValues] };
    return {
      time: this.#clock.now,
      randomValues: [...this.#randomValues],
      ship: {
        flightPlan: this.#flightPlan,
        executedBurns: [...this.#executedBurns],
        phase: derivedPhase(this.#flightPlan, this.#executedBurns)
      }
    };
  }

  apply(event: SimEvent): void {
    switch (event.type) {
      case "clockAdvanced":
        this.#clock.advance(event.elapsedMs);
        return;
      case "randomValueRequested":
        this.#randomValues.push(this.#rng.nextInt(event.upperExclusive));
        return;
      case "commandIssued":
        if (event.commandId.length === 0 || event.issuedAtMs !== this.#clock.now || event.arrivalAtMs < event.issuedAtMs) {
          throw new RangeError("Issued commands require a non-empty identity and a non-past arrival time.");
        }
        return;
      case "planRevisionRefused":
        assertPlanRevisionRefusalReason(event.reason);
        return;
      case "planRevisionApplied": {
        this.#flightPlan = validateFlightPlanRevision(event.flightPlan, this.#clock.now, this.#executedBurns, event.replacedNodeIds);
        return;
      }
      case "burnStarted": {
        if (this.#flightPlan === undefined) throw new Error("Cannot start a burn without a flight plan.");
        const node = assertNode(event.node);
        if (node.executeAtMs !== this.#clock.now) throw new Error("Burns must start at their scheduled simulation time.");
        const plannedNode = this.#flightPlan.nodes.find(({ nodeId }) => nodeId === node.nodeId);
        if (plannedNode === undefined || !sameBurnNode(plannedNode, node)) {
          throw new Error("A burn must start from the pending flight plan unchanged.");
        }
        this.#flightPlan = { nodes: this.#flightPlan.nodes.filter(({ nodeId }) => nodeId !== node.nodeId) };
        this.#executedBurns = [...this.#executedBurns, { node, startedAtMs: this.#clock.now }];
        return;
      }
      case "burnEnded": {
        const active = this.#executedBurns.at(-1);
        if (active === undefined || active.endedAtMs !== undefined || active.node.nodeId !== event.nodeId) {
          throw new Error("A burn can end only once, after its matching start event.");
        }
        const expectedEnd = simTimeMs(active.startedAtMs + active.node.burn.burnDurationMs);
        if (expectedEnd !== this.#clock.now) throw new Error("Burns must end at their quantized duration boundary.");
        this.#executedBurns = [...this.#executedBurns.slice(0, -1), { ...active, endedAtMs: this.#clock.now }];
        return;
      }
    }
  }
}

export const replaySegment = (seed: number, events: readonly SimEvent[], initialTime: SimTimeMs = simTimeMs(0)): SimState => {
  const reducer = new SimEventReducer(seed, initialTime);
  for (const event of events) reducer.apply(event);
  return reducer.state;
};

export const replayPersistedSegment = (stream: {
  readonly seed: number;
  readonly initialTime: SimTimeMs;
  readonly events: readonly { readonly event: SimEvent }[];
}): SimState => replaySegment(stream.seed, stream.events.map(({ event }) => event), stream.initialTime);
