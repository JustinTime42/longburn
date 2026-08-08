import { SimClock, simTimeMs, type SimTimeMs } from "./clock.js";
import { burnDurationMs, projectPropellantForBurns, quantizedDeltaV, type QuantizedBurnParameters, type QuantizedDeltaV } from "./mass-cargo.js";
import { SeededRng } from "./rng.js";
import { assertInboundCausalityInvariant, type PositionMeters } from "./causality.js";

export type DestinationBody = "earth" | "moon" | "mars";

/** Quantized initial condition, stamped at the live command boundary once. */
export interface DepartureState {
  readonly departureAtMs: SimTimeMs;
  readonly positionMeters: PositionMeters;
  readonly velocityMmPerSecond: QuantizedDeltaV;
}

/** A live-measured docking fact. Replay consumes this record without ephemerides. */
export interface ArrivalState {
  readonly arrivedAtMs: SimTimeMs;
  readonly destination: DestinationBody;
  readonly targetPositionMeters: PositionMeters;
  readonly terminalPositionMeters: PositionMeters;
  readonly positionGapMeters: PositionMeters;
  readonly velocityGapMmPerSecond: QuantizedDeltaV;
}

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
  /** Fixed, committed heliocentric delta-v direction and magnitude. */
  readonly deltaVMmPerSecond: QuantizedDeltaV;
}

/** The complete, replaceable set of burns which have not begun firing. */
export interface FlightPlan {
  /** The body the final planned burn is intended to reach. */
  readonly destination: DestinationBody;
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
  readonly departureState?: DepartureState;
  readonly arrivalState?: ArrivalState;
  /** Ordered durable worldline boundaries, retained for time-indexed queries. */
  readonly departureStates: readonly DepartureState[];
  readonly arrivalStates: readonly ArrivalState[];
}

export type PlanRevisionRefusalReason = "executed-burn-conflict" | "invalid-plan" | "insufficient-propellant";

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
  if (reason !== "executed-burn-conflict" && reason !== "invalid-plan" && reason !== "insufficient-propellant") {
    throw new RangeError("Plan revision refusals require a known reason.");
  }
  return reason;
};

/** There is deliberately no event which removes or edits an executed burn. */
export type SimEvent =
  | { readonly type: "clockAdvanced"; readonly elapsedMs: number }
  | { readonly type: "randomValueRequested"; readonly upperExclusive: number }
  | { readonly type: "departureRecorded"; readonly departureState: DepartureState }
  | { readonly type: "arrivalRecorded"; readonly arrivalState: ArrivalState }
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
  | { readonly type: "planRevisionApplied"; readonly flightPlan: FlightPlan; readonly commandId: string; readonly replacedNodeIds?: readonly string[] }
  | { readonly type: "planRevisionRefused"; readonly flightPlan: FlightPlan; readonly reason: PlanRevisionRefusalReason; readonly commandId: string }
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
    burn: assertBurn(node.burn),
    deltaVMmPerSecond: quantizedDeltaV(node.deltaVMmPerSecond)
  };
};

const assertPlan = (plan: FlightPlan): FlightPlan => {
  const destination = plan.destination;
  if (destination !== "earth" && destination !== "moon" && destination !== "mars") {
    throw new RangeError("Flight plans require a known destination body.");
  }
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
  return { destination, nodes };
};

/**
 * Validates facts that remain meaningful for both a live append and replay.
 *
 * This deliberately excludes propellant: accepted events are historical facts,
 * and mutable ship balance configuration must never affect their replay.
 */
const validateRecordedFlightPlanRevision = (
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

/** Validates the event-sourced immutability boundary before a live append. */
export const validateFlightPlanRevision = (
  plan: FlightPlan,
  now: SimTimeMs,
  executedBurns: readonly ExecutedBurn[],
  replacedNodeIds: readonly string[] = []
): FlightPlan => {
  const flightPlan = validateRecordedFlightPlanRevision(plan, now, executedBurns, replacedNodeIds);
  const projectedPropellant = projectPropellantForBurns([
    ...executedBurns.map(({ node }) => node.burn),
    ...flightPlan.nodes.map(({ burn }) => burn)
  ]);
  if (projectedPropellant.kind === "exhausted") {
    throw new PlanRevisionValidationError(
      "insufficient-propellant",
      "A flight-plan revision exceeds the ship's remaining propellant at its projected burn nodes."
    );
  }
  return flightPlan;
};

const sameBurnNode = (left: BurnNode, right: BurnNode): boolean =>
  left.nodeId === right.nodeId
  && left.executeAtMs === right.executeAtMs
  && left.kind === right.kind
  && left.burn.burnDurationMs === right.burn.burnDurationMs
  && left.deltaVMmPerSecond.x === right.deltaVMmPerSecond.x
  && left.deltaVMmPerSecond.y === right.deltaVMmPerSecond.y
  && left.deltaVMmPerSecond.z === right.deltaVMmPerSecond.z;

const derivedPhase = (flightPlan: FlightPlan, executedBurns: readonly ExecutedBurn[]): ShipPhase => {
  const active = executedBurns.at(-1);
  if (active !== undefined && active.endedAtMs === undefined) {
    return active.node.kind === "accel" ? "accel" : active.node.kind === "decel" ? "decel" : "flip";
  }
  if (executedBurns.length === 0) return "docked";
  if (flightPlan.nodes.length === 0) return "coast";
  return executedBurns.at(-1)?.node.kind === "accel" ? "coast" : "flip";
};

/** The sole reducer for both durable replay and the live authoritative loop. */
export class SimEventReducer {
  readonly #clock: SimClock;
  readonly #rng: SeededRng;
  readonly #randomValues: number[] = [];
  #flightPlan: FlightPlan | undefined;
  #executedBurns: ExecutedBurn[] = [];
  #departureState: DepartureState | undefined;
  #arrivalState: ArrivalState | undefined;
  #departureStates: DepartureState[] = [];
  #arrivalStates: ArrivalState[] = [];

  constructor(seed: number, initialTime: SimTimeMs = simTimeMs(0)) {
    this.#clock = SimClock.production(initialTime);
    this.#rng = new SeededRng(seed);
  }

  get time(): SimTimeMs { return this.#clock.now; }

  get state(): SimState {
    if (this.#flightPlan === undefined && this.#departureState === undefined) return { time: this.#clock.now, randomValues: [...this.#randomValues] };
    const flightPlan = this.#flightPlan ?? { destination: "earth" as const, nodes: [] };
    return {
      time: this.#clock.now,
      randomValues: [...this.#randomValues],
      ship: {
        flightPlan,
        executedBurns: [...this.#executedBurns],
        phase: derivedPhase(flightPlan, this.#executedBurns),
        ...(this.#departureState === undefined ? {} : { departureState: this.#departureState }),
        ...(this.#arrivalState === undefined ? {} : { arrivalState: this.#arrivalState }),
        departureStates: [...this.#departureStates],
        arrivalStates: [...this.#arrivalStates]
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
      case "departureRecorded":
        if (event.departureState.departureAtMs !== this.#clock.now ||
          (this.#departureState !== undefined && (this.#arrivalState === undefined || this.#arrivalState.arrivedAtMs < this.#departureState.departureAtMs))) {
          throw new RangeError("A ship departure state is recorded at the current time only when initially leaving or leaving a docked body.");
        }
        this.#departureState = event.departureState;
        this.#departureStates.push(event.departureState);
        return;
      case "arrivalRecorded":
        if (event.arrivalState.arrivedAtMs !== this.#clock.now || this.#departureState === undefined ||
          (this.#arrivalState !== undefined && this.#arrivalState.arrivedAtMs >= this.#departureState.departureAtMs)) {
          throw new RangeError("A ship arrival state is recorded once for each departure at its current simulation time.");
        }
        this.#arrivalState = event.arrivalState;
        this.#arrivalStates.push(event.arrivalState);
        return;
      case "commandIssued":
        if (event.commandId.length === 0 || event.issuedAtMs !== this.#clock.now || event.arrivalAtMs < event.issuedAtMs) {
          throw new RangeError("Issued commands require a non-empty identity and a non-past arrival time.");
        }
        assertInboundCausalityInvariant(event.issuedAtMs, event.arrivalAtMs, event.hqPosition, event.arrivalPosition);
        return;
      case "planRevisionRefused":
        if (event.commandId.length === 0) throw new RangeError("Plan revision outcomes require a non-empty command ID.");
        assertPlanRevisionRefusalReason(event.reason);
        return;
      case "planRevisionApplied": {
        if (event.commandId.length === 0) throw new RangeError("Plan revision outcomes require a non-empty command ID.");
        this.#flightPlan = validateRecordedFlightPlanRevision(event.flightPlan, this.#clock.now, this.#executedBurns, event.replacedNodeIds);
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
        this.#flightPlan = { ...this.#flightPlan, nodes: this.#flightPlan.nodes.filter(({ nodeId }) => nodeId !== node.nodeId) };
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
