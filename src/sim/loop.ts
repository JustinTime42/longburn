import { simTimeMs, type SimTimeMs } from "./clock.js";
import type { PositionMeters } from "./causality.js";
import type { PersistedSimulationStream, SimulationEventStore, SimulationStream, StreamSequenceConflict, StoredSimEvent } from "./event-store.js";
import { assertPlanRevisionRefusalReason, type ArrivalState, type DepartureState, type DestinationBody, type FlightPlan, type PlanRevisionRefusalReason, PlanRevisionValidationError, type SimEvent, type SimState, SimEventReducer, validateFlightPlanRevision } from "./event-log.js";
import type { QuantizedDeltaV } from "./mass-cargo.js";
import { advanceMarket, centeredIrwinHall12, TIER0_MARKET_CONFIG } from "./market.js";
import { composeCargo, reduceTradeEvent, settlement, type CargoComposition, type SellRefusalReason, type SpotDisposition, TIER0_TRADE_CONFIG } from "./trade.js";
import { deriveStream, type SeededRng } from "./rng.js";
import { shipPositionAt, shipWorldlineStateAt } from "./worldline.js";

export interface AuthoritativeSimLoopOptions {
  readonly stream: SimulationStream;
  readonly store: SimulationEventStore;
  /** Live-only boundary; its result is immediately persisted as departureRecorded. */
  readonly departureStateAt?: (time: SimTimeMs) => DepartureState;
  /** Live-only body resolver used to persist arrival and repeat-departure facts, never during replay. */
  readonly destinationStateAt?: (destination: DestinationBody, time: SimTimeMs) => TargetBodyState;
  /** Live-only host-body resolver used to stamp persisted market facts. */
  readonly marketPositionAt?: (marketBodyId: DestinationBody, time: SimTimeMs) => PositionMeters;
}

export interface TargetBodyState {
  readonly positionMeters: PositionMeters;
  readonly velocityMmPerSecond: QuantizedDeltaV;
}

export const TIER0_ARRIVAL_CAPTURE_RADIUS_METERS = 1_000_000_000;
export const TIER0_DOCKING_SPEED_MM_PER_SECOND = 100_000;

const subtractPosition = (left: PositionMeters, right: PositionMeters): PositionMeters => ({
  x: left.x - right.x, y: left.y - right.y, z: left.z - right.z
});

const subtractVelocity = (left: QuantizedDeltaV, right: QuantizedDeltaV): QuantizedDeltaV => ({
  x: left.x === right.x ? 0 : left.x - right.x,
  y: left.y === right.y ? 0 : left.y - right.y,
  z: left.z === right.z ? 0 : left.z - right.z
});

export class AuthoritativeSimLoopConflictError extends Error {
  readonly expectedStreamSequence: number;
  readonly actualStreamSequence: number;
  constructor(conflict: StreamSequenceConflict) {
    super(`Authoritative simulation loop stream sequence conflict: expected ${conflict.expectedStreamSequence}, found ${conflict.actualStreamSequence}.`);
    this.name = "AuthoritativeSimLoopConflictError";
    this.expectedStreamSequence = conflict.expectedStreamSequence;
    this.actualStreamSequence = conflict.actualStreamSequence;
  }
}

/** Deterministic writer and executor for an editable flight plan. */
export class AuthoritativeSimLoop {
  readonly #reducer: SimEventReducer;
  readonly #store: SimulationEventStore;
  readonly #streamId: string;
  readonly #departureStateAt: ((time: SimTimeMs) => DepartureState) | undefined;
  readonly #destinationStateAt: ((destination: DestinationBody, time: SimTimeMs) => TargetBodyState) | undefined;
  readonly #marketPositionAt: ((marketBodyId: DestinationBody, time: SimTimeMs) => PositionMeters) | undefined;
  readonly #marketRng: SeededRng;
  readonly #marketStartTime: SimTimeMs;
  #streamSequence = 0;
  #writer: Promise<void> = Promise.resolve();
  #inboundCommands: {
    readonly commandId: string;
    readonly commandKind: "plan-revision" | "sell-order" | "spot-disposition-revision";
    readonly arrivalAtMs: SimTimeMs;
    readonly arrivalPosition: PositionMeters;
    readonly flightPlan?: FlightPlan;
    readonly spotDisposition?: SpotDisposition;
    /** Pending nodes this wholesale replacement was issued to replace. */
    readonly replacedNodeIds: ReadonlySet<string>;
  }[] = [];

  private constructor({ stream, store, departureStateAt, destinationStateAt, marketPositionAt }: AuthoritativeSimLoopOptions) {
    this.#reducer = new SimEventReducer(stream.seed, stream.initialTime);
    this.#store = store;
    this.#streamId = stream.id;
    this.#departureStateAt = departureStateAt;
    this.#destinationStateAt = destinationStateAt;
    this.#marketPositionAt = marketPositionAt;
    this.#marketRng = deriveStream(stream.seed, `market:${TIER0_MARKET_CONFIG.commodityId}`);
    this.#marketStartTime = stream.initialTime;
  }

  static async create(options: AuthoritativeSimLoopOptions): Promise<AuthoritativeSimLoop> {
    await options.store.createStream(options.stream);
    return new AuthoritativeSimLoop(options);
  }

  static async resume(
    store: SimulationEventStore,
    streamId: string,
    liveResolvers: Pick<AuthoritativeSimLoopOptions, "departureStateAt" | "destinationStateAt" | "marketPositionAt"> = {}
  ): Promise<AuthoritativeSimLoop> {
    const persisted = await store.readStream(streamId);
    const loop = new AuthoritativeSimLoop({ stream: persisted, store, ...liveResolvers });
    for (const record of persisted.events) {
      loop.#assertRecordTime(record);
      loop.#reducer.apply(record.event);
    }
    // The persisted quote facts reconstruct state; consume the independent
    // substream only to resume the next live step at its historical offset.
    for (let step = 0; step < loop.state.market.stepIndex; step += 1) centeredIrwinHall12(loop.#marketRng);
    const pending = new Map<string, Extract<SimEvent, { readonly type: "commandIssued" }>>();
    for (const { event } of persisted.events) {
      if (event.type === "commandIssued") pending.set(event.commandId, event);
      if (event.type === "planRevisionApplied" || event.type === "planRevisionRefused") {
        pending.delete(event.commandId);
      }
      if ((event.type === "cargoSold" || event.type === "sellRefused" || event.type === "spotDispositionRevised") && event.commandId !== undefined) pending.delete(event.commandId);
    }
    loop.#inboundCommands = [...pending.values()].map((command) => {
      const base = { commandId: command.commandId, arrivalAtMs: command.arrivalAtMs, arrivalPosition: command.arrivalPosition };
      if (command.commandKind === "sell-order") return { ...base, commandKind: "sell-order" as const, replacedNodeIds: new Set<string>() };
      if (command.commandKind === "spot-disposition-revision") return { ...base, commandKind: "spot-disposition-revision" as const, spotDisposition: command.spotDisposition, replacedNodeIds: new Set<string>() };
      if (!("flightPlan" in command)) throw new Error("Persisted plan-revision command is missing its flight plan.");
      return { ...base, commandKind: "plan-revision" as const, flightPlan: command.flightPlan, replacedNodeIds: new Set<string>(command.replacedNodeIds) };
    }).sort((left, right) => left.arrivalAtMs - right.arrivalAtMs);
    loop.#streamSequence = persisted.events.length;
    return loop;
  }

  get state(): SimState { return this.#reducer.state; }

  /** The production ship resolver. It is unavailable until departure is stamped. */
  shipPositionAt(time: number): PositionMeters {
    const ship = this.#reducer.state.ship;
    const departure = [...(ship?.departureStates ?? [])].reverse().find(({ departureAtMs }) => departureAtMs <= time);
    if (departure === undefined) throw new Error("Ship position is unavailable before its departure state is recorded.");
    const arrival = [...(ship?.arrivalStates ?? [])].reverse().find(({ arrivedAtMs }) => arrivedAtMs <= time && arrivedAtMs >= departure.departureAtMs);
    if (arrival !== undefined && this.#destinationStateAt !== undefined) {
      return this.#destinationStateAt(arrival.destination, simTimeMs(time)).positionMeters;
    }
    return shipPositionAt({ departureState: departure, executedBurns: ship!.executedBurns.filter(({ startedAtMs }) => startedAtMs >= departure.departureAtMs), flightPlan: ship!.flightPlan }, time);
  }

  async advance(elapsedMs: number, eventPosition: () => PositionMeters): Promise<SimTimeMs> {
    return this.#serialize(() => this.#advance(elapsedMs, eventPosition));
  }

  async applyPlanRevision(flightPlan: FlightPlan, eventPosition: () => PositionMeters): Promise<void> {
    return this.#serialize(async () => {
      await this.#recordDepartureIfNeeded(eventPosition);
      const validatedPlan = validateFlightPlanRevision(flightPlan, this.#reducer.time, this.#reducer.state.ship?.executedBurns ?? []);
      const event: SimEvent = {
        type: "planRevisionApplied",
        // Local outcomes share the durable command-ID namespace with inbound commands.
        // Keep their origin prefix distinct: resume() removes pending commands by ID.
        commandId: `local-${this.#streamSequence + 1}`,
        flightPlan: validatedPlan
      };
      await this.#append({ event, eventTime: this.#reducer.time, eventPosition: this.#eventPositionAt(this.#reducer.time, eventPosition) });
      this.#reducer.apply(event);
      await this.#advanceDueBurns(eventPosition);
    });
  }

  /** Local HQ loading; the resulting forward rate is a persisted composition fact. */
  async composeCargo(composition: CargoComposition, eventPosition: () => PositionMeters): Promise<void> {
    return this.#serialize(async () => {
      const ship = this.#reducer.state.ship;
      // Applying a paper plan records the initial Earth departure state so its
      // live boundary is replayable, but the ship has not left HQ until a burn
      // has executed. Subsequent docked bodies must be Earth.
      const atHq = ship === undefined || (this.#isDocked(ship)
        ? ship.arrivalState?.destination === "earth"
        : ship.executedBurns.length === 0);
      if (!atHq) throw new RangeError("Cargo can be composed only while docked at HQ.");
      const lastNode = ship?.flightPlan.nodes.at(-1);
      if (lastNode === undefined) throw new RangeError("Cargo composition requires an authoritative planned arrival.");
      const plannedArrivalAtMs = simTimeMs(lastNode.executeAtMs + lastNode.burn.burnDurationMs);
      const event = composeCargo(TIER0_TRADE_CONFIG, TIER0_MARKET_CONFIG, this.#reducer.state.market, composition, plannedArrivalAtMs, this.#reducer.time);
      // Validate the exact reducer transition before durable append. A rejected
      // local action must never become an unreplayable persisted fact.
      reduceTradeEvent(this.#reducer.state.cargo, event);
      await this.#append({ event, eventTime: this.#reducer.time, eventPosition: eventPosition() });
      this.#reducer.apply(event);
    });
  }

  async scheduleInboundSellOrder(
    arrivalTimeForIssue: (issuedAtMs: SimTimeMs) => SimTimeMs,
    hqPositionAt: (issuedAtMs: SimTimeMs) => PositionMeters,
    arrivalPositionAt: (arrivalAtMs: SimTimeMs) => PositionMeters
  ): Promise<{ readonly issuedAtMs: SimTimeMs; readonly arrivalAtMs: SimTimeMs }> {
    return this.#scheduleInboundTradeCommand("sell-order", arrivalTimeForIssue, hqPositionAt, arrivalPositionAt);
  }

  async scheduleInboundSpotDispositionRevision(
    spotDisposition: SpotDisposition,
    arrivalTimeForIssue: (issuedAtMs: SimTimeMs) => SimTimeMs,
    hqPositionAt: (issuedAtMs: SimTimeMs) => PositionMeters,
    arrivalPositionAt: (arrivalAtMs: SimTimeMs) => PositionMeters
  ): Promise<{ readonly issuedAtMs: SimTimeMs; readonly arrivalAtMs: SimTimeMs }> {
    if (spotDisposition !== "manual" && spotDisposition !== "sell-on-arrival") throw new RangeError("Spot disposition requires a known value.");
    return this.#scheduleInboundTradeCommand("spot-disposition-revision", arrivalTimeForIssue, hqPositionAt, arrivalPositionAt, spotDisposition);
  }

  async #scheduleInboundTradeCommand(
    commandKind: "sell-order" | "spot-disposition-revision",
    arrivalTimeForIssue: (issuedAtMs: SimTimeMs) => SimTimeMs,
    hqPositionAt: (issuedAtMs: SimTimeMs) => PositionMeters,
    arrivalPositionAt: (arrivalAtMs: SimTimeMs) => PositionMeters,
    spotDisposition?: SpotDisposition
  ): Promise<{ readonly issuedAtMs: SimTimeMs; readonly arrivalAtMs: SimTimeMs }> {
    return this.#serialize(async () => {
      const issuedAtMs = this.#reducer.time;
      const hqPosition = hqPositionAt(issuedAtMs);
      const arrivalAtMs = simTimeMs(arrivalTimeForIssue(issuedAtMs));
      if (arrivalAtMs < issuedAtMs) throw new RangeError("Inbound trade-command arrival cannot precede its issue time.");
      const commandId = `command-${this.#streamSequence + 1}`;
      const arrivalPosition = arrivalPositionAt(arrivalAtMs);
      const command: SimEvent = { type: "commandIssued", commandId, issuedAtMs, arrivalAtMs, hqPosition, arrivalPosition, commandKind, ...(spotDisposition === undefined ? {} : { spotDisposition }) };
      this.#dryRunInboundCommand(command);
      await this.#append({ event: command, eventTime: issuedAtMs, eventPosition: hqPosition });
      this.#reducer.apply(command);
      this.#inboundCommands.push({ commandId, commandKind, arrivalAtMs, arrivalPosition, ...(spotDisposition === undefined ? {} : { spotDisposition }), replacedNodeIds: new Set() });
      this.#inboundCommands.sort((left, right) => left.arrivalAtMs - right.arrivalAtMs);
      await this.#advanceDueWork(arrivalPositionAt);
      return { issuedAtMs, arrivalAtMs };
    });
  }

  /**
   * Queues a signal for its exact causal arrival time. The issue timestamp and
   * arrival solve happen inside writer serialization; this is the authority
   * when a host tick and an inbound command are interleaved.
   */
  async scheduleInboundPlanRevision(
    flightPlan: FlightPlan,
    arrivalTimeForIssue: (issuedAtMs: SimTimeMs) => SimTimeMs,
    hqPositionAt: (issuedAtMs: SimTimeMs) => PositionMeters,
    arrivalPositionAt: (arrivalAtMs: SimTimeMs) => PositionMeters
  ): Promise<{ readonly issuedAtMs: SimTimeMs; readonly arrivalAtMs: SimTimeMs }> {
    return this.#serialize(async () => {
      const issuedAtMs = this.#reducer.time;
      const hqPosition = hqPositionAt(issuedAtMs);
      await this.#recordDepartureIfNeeded(() => hqPosition);
      const arrivalAtMs = simTimeMs(arrivalTimeForIssue(issuedAtMs));
      if (arrivalAtMs < issuedAtMs) throw new RangeError("Inbound plan-revision arrival cannot precede its issue time.");
      const commandId = `command-${this.#streamSequence + 1}`;
      const replacedNodeIds = this.#reducer.state.ship?.flightPlan.nodes.map(({ nodeId }) => nodeId) ?? [];
      const arrivalPosition = arrivalPositionAt(arrivalAtMs);
      const command: SimEvent = {
        type: "commandIssued", commandId, issuedAtMs, arrivalAtMs,
        hqPosition, arrivalPosition, replacedNodeIds, flightPlan
      };
      this.#dryRunInboundCommand(command);
      await this.#append({ event: command, eventTime: issuedAtMs, eventPosition: hqPosition });
      this.#reducer.apply(command);
      this.#inboundCommands.push({
        commandId, commandKind: "plan-revision", flightPlan, arrivalAtMs, arrivalPosition, replacedNodeIds: new Set(replacedNodeIds)
      });
      this.#inboundCommands.sort((left, right) => left.arrivalAtMs - right.arrivalAtMs);
      await this.#advanceDueWork(arrivalPositionAt);
      return { issuedAtMs, arrivalAtMs };
    });
  }

  /** Records an arrival-time refusal without changing the paper plan. */
  async refusePlanRevision(flightPlan: FlightPlan, reason: PlanRevisionRefusalReason, eventPosition: () => PositionMeters): Promise<void> {
    return this.#serialize(async () => {
      const event: SimEvent = {
        type: "planRevisionRefused",
        // Local outcomes share the durable command-ID namespace with inbound commands.
        // Keep their origin prefix distinct: resume() removes pending commands by ID.
        commandId: `local-${this.#streamSequence + 1}`,
        flightPlan,
        reason: assertPlanRevisionRefusalReason(reason)
      };
      await this.#append({ event, eventTime: this.#reducer.time, eventPosition: eventPosition() });
      this.#reducer.apply(event);
    });
  }

  async requestRandom(upperExclusive: number, eventPosition: () => PositionMeters): Promise<number> {
    return this.#serialize(async () => {
      const event: SimEvent = { type: "randomValueRequested", upperExclusive };
      await this.#append({ event, eventTime: this.#reducer.time, eventPosition: eventPosition() });
      this.#reducer.apply(event);
      const value = this.#reducer.state.randomValues.at(-1);
      if (value === undefined) throw new Error("Random event did not produce a value.");
      return value;
    });
  }

  async persistedStream(): Promise<PersistedSimulationStream> { return this.#store.readStream(this.#streamId); }

  async #advance(elapsedMs: number, eventPosition: () => PositionMeters): Promise<SimTimeMs> {
    if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0) throw new RangeError("Simulation advance must be a non-negative safe integer in milliseconds.");
    const targetTime = simTimeMs(this.#reducer.time + elapsedMs);
    while (this.#reducer.time < targetTime) {
      await this.#advanceDueWork(eventPosition);
      const remaining = this.#remainingToNextBoundary();
      const step = remaining === undefined ? targetTime - this.#reducer.time : Math.min(targetTime - this.#reducer.time, remaining);
      const event: SimEvent = { type: "clockAdvanced", elapsedMs: step };
      const eventTime = simTimeMs(this.#reducer.time + step);
      await this.#append({ event, eventTime, eventPosition: this.#eventPositionAt(eventTime, eventPosition) });
      this.#reducer.apply(event);
    }
    await this.#advanceDueWork(eventPosition);
    return this.#reducer.time;
  }

  #remainingToNextBurnBoundary(): number | undefined {
    const ship = this.#reducer.state.ship;
    if (ship === undefined) return undefined;
    const active = ship.executedBurns.at(-1);
    if (active !== undefined && active.endedAtMs === undefined) {
      const remaining = active.node.burn.burnDurationMs - (this.#reducer.time - active.startedAtMs);
      if (remaining < 0) throw new Error("Active burn boundary is behind the authoritative simulation time.");
      return remaining;
    }
    const next = ship.flightPlan.nodes[0];
    if (next === undefined) return undefined;
    const remaining = next.executeAtMs - this.#reducer.time;
    if (remaining < 0) throw new Error("Pending burn boundary is behind the authoritative simulation time.");
    return remaining;
  }

  #remainingToNextBoundary(): number | undefined {
    const burnBoundary = this.#remainingToNextBurnBoundary();
    const revision = this.#inboundCommands[0];
    const revisionBoundary = revision === undefined ? undefined : revision.arrivalAtMs - this.#reducer.time;
    if (revisionBoundary !== undefined && revisionBoundary < 0) {
      throw new Error("Inbound plan-revision boundary is behind the authoritative simulation time.");
    }
    const marketBoundary = this.#marketPositionAt === undefined ? undefined
      : this.#nextMarketStepTime() - this.#reducer.time;
    if (marketBoundary !== undefined && marketBoundary < 0) throw new Error("Market boundary is behind the authoritative simulation time.");
    const boundaries = [burnBoundary, revisionBoundary, marketBoundary].filter((boundary): boundary is number => boundary !== undefined);
    return boundaries.length === 0 ? undefined : Math.min(...boundaries);
  }

  /** Burns win equal timestamps: only a revision that arrived before a burn can supersede it. */
  async #advanceDueWork(eventPositionAt: (time: SimTimeMs) => PositionMeters): Promise<void> {
    await this.#advanceDueBurns(eventPositionAt);
    while (this.#inboundCommands[0]?.arrivalAtMs === this.#reducer.time) {
      const revision = this.#inboundCommands.shift()!;
      if (revision.commandKind !== "plan-revision") {
        await this.#executeInboundTradeCommand(revision, eventPositionAt);
        continue;
      }
      try {
        const validatedPlan = validateFlightPlanRevision(
          revision.flightPlan!, this.#reducer.time, this.#reducer.state.ship?.executedBurns ?? [], [...revision.replacedNodeIds]
        );
        const event: SimEvent = { type: "planRevisionApplied", commandId: revision.commandId, replacedNodeIds: [...revision.replacedNodeIds], flightPlan: validatedPlan };
        await this.#append({ event, eventTime: this.#reducer.time, eventPosition: this.#eventPositionAt(this.#reducer.time, eventPositionAt) });
        this.#reducer.apply(event);
      } catch (error: unknown) {
        if (!(error instanceof PlanRevisionValidationError)) throw error;
        // Arrival-time validation is authoritative. Refusals preserve opaque command payloads for disputes.
        const event: SimEvent = { type: "planRevisionRefused", commandId: revision.commandId, flightPlan: revision.flightPlan!, reason: error.reason };
        await this.#append({ event, eventTime: this.#reducer.time, eventPosition: this.#eventPositionAt(this.#reducer.time, eventPositionAt) });
        this.#reducer.apply(event);
      }
      await this.#advanceDueBurns(eventPositionAt);
    }
    await this.#advanceDueMarket();
  }

  async #executeInboundTradeCommand(command: {
    readonly commandId: string;
    readonly commandKind: "plan-revision" | "sell-order" | "spot-disposition-revision";
    readonly spotDisposition?: SpotDisposition;
  }, eventPositionAt: (time: SimTimeMs) => PositionMeters): Promise<void> {
    if (command.commandKind === "plan-revision") throw new Error("Plan revisions are not trade commands.");
    await this.#advanceDueMarket();
    const ship = this.#reducer.state.ship;
    const cargo = this.#reducer.state.cargo;
    const atMarket = ship !== undefined && this.#isDocked(ship) && ship.arrivalState?.destination === TIER0_MARKET_CONFIG.marketBodyId;
    if (command.commandKind === "spot-disposition-revision") {
      const event: SimEvent = cargo.spotTons === 0
        ? { type: "sellRefused", reason: "no-cargo", commandId: command.commandId }
        : { type: "spotDispositionRevised", spotDisposition: command.spotDisposition!, commandId: command.commandId };
      await this.#append({ event, eventTime: this.#reducer.time, eventPosition: atMarket ? this.#marketPosition() : this.#eventPositionAt(this.#reducer.time, eventPositionAt) });
      this.#reducer.apply(event);
      return;
    }
    const reason: SellRefusalReason | undefined = !atMarket ? "not-arrived-or-docked" : cargo.spotTons === 0 ? (cargo.spotSold ? "duplicate-sale" : "no-cargo") : undefined;
    const event: SimEvent = reason === undefined
      ? settlement("spot", cargo.spotTons, this.#reducer.state.market.price, command.commandId)
      : { type: "sellRefused", reason, commandId: command.commandId };
    await this.#append({ event, eventTime: this.#reducer.time, eventPosition: reason === undefined ? this.#marketPosition() : this.#eventPositionAt(this.#reducer.time, eventPositionAt) });
    this.#reducer.apply(event);
  }

  #marketPosition(): PositionMeters {
    if (this.#marketPositionAt === undefined) throw new Error("Market settlement requires the live market position resolver.");
    return this.#marketPositionAt(TIER0_MARKET_CONFIG.marketBodyId, this.#reducer.time);
  }

  async #advanceDueMarket(): Promise<void> {
    if (this.#marketPositionAt === undefined || this.#reducer.time !== this.#nextMarketStepTime()) return;
    const position = this.#marketPositionAt(TIER0_MARKET_CONFIG.marketBodyId, this.#reducer.time);
    for (const event of advanceMarket(TIER0_MARKET_CONFIG, this.#reducer.state.market, this.#marketRng)) {
      await this.#append({ event, eventTime: this.#reducer.time, eventPosition: position });
      this.#reducer.apply(event);
    }
  }

  #nextMarketStepTime(): SimTimeMs {
    return simTimeMs(this.#marketStartTime + (this.#reducer.state.market.stepIndex + 1) * TIER0_MARKET_CONFIG.marketStepMs);
  }

  async #advanceDueBurns(eventPositionAt: (time: SimTimeMs) => PositionMeters): Promise<void> {
    while (this.#remainingToNextBurnBoundary() === 0) {
      const ship = this.#reducer.state.ship!;
      const active = ship.executedBurns.at(-1);
      if ((active === undefined || active.endedAtMs !== undefined) && this.#isDocked(ship)) await this.#recordDepartureFromDock();
      const event: SimEvent = active !== undefined && active.endedAtMs === undefined
        ? { type: "burnEnded", nodeId: active.node.nodeId }
        : { type: "burnStarted", node: ship.flightPlan.nodes[0]! };
      await this.#append({ event, eventTime: this.#reducer.time, eventPosition: this.#eventPositionAt(this.#reducer.time, eventPositionAt) });
      this.#reducer.apply(event);
      if (event.type === "burnEnded") await this.#recordArrivalIfComplete(eventPositionAt);
    }
  }

  async #recordDepartureIfNeeded(fallbackPosition: () => PositionMeters): Promise<void> {
    if (this.#reducer.state.ship?.departureState !== undefined || this.#departureStateAt === undefined) return;
    const departureState = this.#departureStateAt(this.#reducer.time);
    const event: SimEvent = { type: "departureRecorded", departureState };
    await this.#append({ event, eventTime: this.#reducer.time, eventPosition: fallbackPosition() });
    this.#reducer.apply(event);
  }

  async #recordArrivalIfComplete(eventPositionAt: (time: SimTimeMs) => PositionMeters): Promise<void> {
    const ship = this.#reducer.state.ship;
    if (ship === undefined || this.#isDocked(ship) || ship.flightPlan.nodes.length !== 0 || this.#destinationStateAt === undefined) return;
    const destination = ship.flightPlan.destination;
    const terminalPositionMeters = ship.departureState === undefined ? eventPositionAt(this.#reducer.time) : this.shipPositionAt(this.#reducer.time);
    const target = this.#destinationStateAt(destination, this.#reducer.time);
    const terminalVelocity = this.#velocityAt(this.#reducer.time);
    const positionGapMeters = subtractPosition(terminalPositionMeters, target.positionMeters);
    const velocityGapMmPerSecond = subtractVelocity(terminalVelocity, target.velocityMmPerSecond);
    if (Math.hypot(positionGapMeters.x, positionGapMeters.y, positionGapMeters.z) > TIER0_ARRIVAL_CAPTURE_RADIUS_METERS ||
      Math.hypot(velocityGapMmPerSecond.x, velocityGapMmPerSecond.y, velocityGapMmPerSecond.z) > TIER0_DOCKING_SPEED_MM_PER_SECOND) return;
    const arrivalState: ArrivalState = {
      arrivedAtMs: this.#reducer.time,
      destination,
      terminalPositionMeters,
      targetPositionMeters: target.positionMeters,
      positionGapMeters,
      velocityGapMmPerSecond
    };
    const event: SimEvent = { type: "arrivalRecorded", arrivalState };
    await this.#append({ event, eventTime: this.#reducer.time, eventPosition: terminalPositionMeters });
    this.#reducer.apply(event);
    // Price updates at this exact boundary first, then standing and contractual
    // dispositions settle against the arrival-instant persisted price.
    await this.#advanceDueMarket();
    const cargo = this.#reducer.state.cargo;
    const mustSettleAtMarket = destination === TIER0_MARKET_CONFIG.marketBodyId &&
      (cargo.contractedTons > 0 || (cargo.spotTons > 0 && cargo.spotDisposition === "sell-on-arrival"));
    const marketPosition = mustSettleAtMarket ? this.#marketPosition() : undefined;
    if (destination === TIER0_MARKET_CONFIG.marketBodyId && cargo.contractedTons > 0) {
      const settled = settlement("contracted", cargo.contractedTons, cargo.contractedRatePerTon!);
      await this.#append({ event: settled, eventTime: this.#reducer.time, eventPosition: marketPosition! });
      this.#reducer.apply(settled);
    }
    if (destination === TIER0_MARKET_CONFIG.marketBodyId && cargo.spotTons > 0 && cargo.spotDisposition === "sell-on-arrival") {
      const settled = settlement("spot", cargo.spotTons, this.#reducer.state.market.price);
      await this.#append({ event: settled, eventTime: this.#reducer.time, eventPosition: marketPosition! });
      this.#reducer.apply(settled);
    }
  }

  #eventPositionAt(time: SimTimeMs, fallback: (time: SimTimeMs) => PositionMeters): PositionMeters {
    return this.#reducer.state.ship?.departureState === undefined ? fallback(time) : this.shipPositionAt(time);
  }

  #isDocked(ship: NonNullable<SimState["ship"]>): boolean {
    const arrival = ship.arrivalStates.at(-1);
    const departure = ship.departureStates.at(-1);
    return arrival !== undefined && departure !== undefined && arrival.arrivedAtMs >= departure.departureAtMs;
  }

  async #recordDepartureFromDock(): Promise<void> {
    const ship = this.#reducer.state.ship;
    if (ship === undefined || !this.#isDocked(ship) || this.#destinationStateAt === undefined) return;
    const arrival = ship.arrivalStates.at(-1)!;
    const body = this.#destinationStateAt(arrival.destination, this.#reducer.time);
    const departureState: DepartureState = { departureAtMs: this.#reducer.time, positionMeters: body.positionMeters, velocityMmPerSecond: body.velocityMmPerSecond };
    const event: SimEvent = { type: "departureRecorded", departureState };
    await this.#append({ event, eventTime: this.#reducer.time, eventPosition: body.positionMeters });
    this.#reducer.apply(event);
  }

  #velocityAt(time: SimTimeMs): QuantizedDeltaV {
    const ship = this.#reducer.state.ship;
    const departure = [...(ship?.departureStates ?? [])].reverse().find(({ departureAtMs }) => departureAtMs <= time);
    if (departure === undefined) throw new Error("Ship velocity is unavailable before its departure state is recorded.");
    const arrival = [...(ship?.arrivalStates ?? [])].reverse().find(({ arrivedAtMs }) => arrivedAtMs <= time && arrivedAtMs >= departure.departureAtMs);
    if (arrival !== undefined && this.#destinationStateAt !== undefined) return this.#destinationStateAt(arrival.destination, time).velocityMmPerSecond;
    return shipWorldlineStateAt({
      departureState: departure,
      executedBurns: ship!.executedBurns.filter(({ startedAtMs }) => startedAtMs >= departure.departureAtMs),
      flightPlan: ship!.flightPlan
    }, time).velocityMmPerSecond;
  }

  #serialize<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.#writer.then(operation);
    this.#writer = result.then(() => undefined, () => undefined);
    return result;
  }

  async #append(event: Omit<StoredSimEvent, "streamSequence" | "globalPosition">): Promise<void> {
    const result = await this.#store.append(this.#streamId, event, this.#streamSequence);
    if (result.kind === "conflict") throw new AuthoritativeSimLoopConflictError(result);
    this.#streamSequence = result.event.streamSequence;
  }

  /**
   * commandIssued validates against the reducer but does not change reducer
   * state. Run that exact transition before persistence so an invalid inbound
   * command cannot make the durable event log unreplayable.
   */
  #dryRunInboundCommand(command: Extract<SimEvent, { readonly type: "commandIssued" }>): void {
    this.#reducer.apply(command);
  }

  #assertRecordTime(record: StoredSimEvent): void {
    const expected = record.event.type === "clockAdvanced" ? simTimeMs(this.#reducer.time + record.event.elapsedMs) : this.#reducer.time;
    if (record.eventTime !== expected) throw new RangeError("Persisted event time does not match the authoritative clock.");
  }
}
