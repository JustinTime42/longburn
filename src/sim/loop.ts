import { simTimeMs, type SimTimeMs } from "./clock.js";
import type { PositionMeters } from "./causality.js";
import type { PersistedSimulationStream, SimulationEventStore, SimulationStream, StreamSequenceConflict, StoredSimEvent } from "./event-store.js";
import { assertPlanRevisionRefusalReason, type FlightPlan, type PlanRevisionRefusalReason, PlanRevisionValidationError, type SimEvent, type SimState, SimEventReducer, validateFlightPlanRevision } from "./event-log.js";

export interface AuthoritativeSimLoopOptions { readonly stream: SimulationStream; readonly store: SimulationEventStore; }

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
  #streamSequence = 0;
  #writer: Promise<void> = Promise.resolve();
  #inboundPlanRevisions: {
    readonly commandId: string;
    readonly flightPlan: FlightPlan;
    readonly arrivalAtMs: SimTimeMs;
    readonly arrivalPosition: PositionMeters;
    /** Pending nodes this wholesale replacement was issued to replace. */
    readonly replacedNodeIds: ReadonlySet<string>;
  }[] = [];

  private constructor({ stream, store }: AuthoritativeSimLoopOptions) {
    this.#reducer = new SimEventReducer(stream.seed, stream.initialTime);
    this.#store = store;
    this.#streamId = stream.id;
  }

  static async create(options: AuthoritativeSimLoopOptions): Promise<AuthoritativeSimLoop> {
    await options.store.createStream(options.stream);
    return new AuthoritativeSimLoop(options);
  }

  static async resume(store: SimulationEventStore, streamId: string): Promise<AuthoritativeSimLoop> {
    const persisted = await store.readStream(streamId);
    const loop = new AuthoritativeSimLoop({ stream: persisted, store });
    for (const record of persisted.events) {
      loop.#assertRecordTime(record);
      loop.#reducer.apply(record.event);
    }
    const pending = new Map<string, Extract<SimEvent, { readonly type: "commandIssued" }>>();
    for (const { event } of persisted.events) {
      if (event.type === "commandIssued") pending.set(event.commandId, event);
      if ((event.type === "planRevisionApplied" || event.type === "planRevisionRefused") && event.commandId !== undefined) {
        pending.delete(event.commandId);
      }
    }
    loop.#inboundPlanRevisions = [...pending.values()].map((command) => ({
      commandId: command.commandId,
      flightPlan: command.flightPlan,
      arrivalAtMs: command.arrivalAtMs,
      arrivalPosition: command.arrivalPosition,
      replacedNodeIds: new Set(command.replacedNodeIds)
    })).sort((left, right) => left.arrivalAtMs - right.arrivalAtMs);
    loop.#streamSequence = persisted.events.length;
    return loop;
  }

  get state(): SimState { return this.#reducer.state; }

  async advance(elapsedMs: number, eventPosition: () => PositionMeters): Promise<SimTimeMs> {
    return this.#serialize(() => this.#advance(elapsedMs, eventPosition));
  }

  async applyPlanRevision(flightPlan: FlightPlan, eventPosition: () => PositionMeters): Promise<void> {
    return this.#serialize(async () => {
      const validatedPlan = validateFlightPlanRevision(flightPlan, this.#reducer.time, this.#reducer.state.ship?.executedBurns ?? []);
      const event: SimEvent = { type: "planRevisionApplied", flightPlan: validatedPlan };
      await this.#append({ event, eventTime: this.#reducer.time, eventPosition: eventPosition() });
      this.#reducer.apply(event);
      await this.#advanceDueBurns(eventPosition);
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
      const arrivalAtMs = simTimeMs(arrivalTimeForIssue(issuedAtMs));
      if (arrivalAtMs < issuedAtMs) throw new RangeError("Inbound plan-revision arrival cannot precede its issue time.");
      const commandId = `command-${this.#streamSequence + 1}`;
      const replacedNodeIds = this.#reducer.state.ship?.flightPlan.nodes.map(({ nodeId }) => nodeId) ?? [];
      const arrivalPosition = arrivalPositionAt(arrivalAtMs);
      const command: SimEvent = {
        type: "commandIssued", commandId, issuedAtMs, arrivalAtMs,
        hqPosition, arrivalPosition, replacedNodeIds, flightPlan
      };
      await this.#append({ event: command, eventTime: issuedAtMs, eventPosition: hqPosition });
      this.#reducer.apply(command);
      this.#inboundPlanRevisions.push({
        commandId, flightPlan, arrivalAtMs, arrivalPosition, replacedNodeIds: new Set(replacedNodeIds)
      });
      this.#inboundPlanRevisions.sort((left, right) => left.arrivalAtMs - right.arrivalAtMs);
      await this.#advanceDueWork(arrivalPositionAt);
      return { issuedAtMs, arrivalAtMs };
    });
  }

  /** Records an arrival-time refusal without changing the paper plan. */
  async refusePlanRevision(flightPlan: FlightPlan, reason: PlanRevisionRefusalReason, eventPosition: () => PositionMeters): Promise<void> {
    return this.#serialize(async () => {
      const event: SimEvent = { type: "planRevisionRefused", flightPlan, reason: assertPlanRevisionRefusalReason(reason) };
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
      await this.#append({ event, eventTime: simTimeMs(this.#reducer.time + step), eventPosition: eventPosition() });
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
    const revision = this.#inboundPlanRevisions[0];
    const revisionBoundary = revision === undefined ? undefined : revision.arrivalAtMs - this.#reducer.time;
    if (revisionBoundary !== undefined && revisionBoundary < 0) {
      throw new Error("Inbound plan-revision boundary is behind the authoritative simulation time.");
    }
    if (burnBoundary === undefined) return revisionBoundary;
    if (revisionBoundary === undefined) return burnBoundary;
    return Math.min(burnBoundary, revisionBoundary);
  }

  /** Burns win equal timestamps: only a revision that arrived before a burn can supersede it. */
  async #advanceDueWork(eventPositionAt: (time: SimTimeMs) => PositionMeters): Promise<void> {
    await this.#advanceDueBurns(eventPositionAt);
    while (this.#inboundPlanRevisions[0]?.arrivalAtMs === this.#reducer.time) {
      const revision = this.#inboundPlanRevisions.shift()!;
      try {
        const validatedPlan = validateFlightPlanRevision(
          revision.flightPlan, this.#reducer.time, this.#reducer.state.ship?.executedBurns ?? [], [...revision.replacedNodeIds]
        );
        const event: SimEvent = { type: "planRevisionApplied", commandId: revision.commandId, replacedNodeIds: [...revision.replacedNodeIds], flightPlan: validatedPlan };
        await this.#append({ event, eventTime: this.#reducer.time, eventPosition: eventPositionAt(this.#reducer.time) });
        this.#reducer.apply(event);
      } catch (error: unknown) {
        if (!(error instanceof PlanRevisionValidationError)) throw error;
        // Arrival-time validation is authoritative. Refusals preserve opaque command payloads for disputes.
        const event: SimEvent = { type: "planRevisionRefused", commandId: revision.commandId, flightPlan: revision.flightPlan, reason: error.reason };
        await this.#append({ event, eventTime: this.#reducer.time, eventPosition: eventPositionAt(this.#reducer.time) });
        this.#reducer.apply(event);
      }
      await this.#advanceDueBurns(eventPositionAt);
    }
  }

  async #advanceDueBurns(eventPositionAt: (time: SimTimeMs) => PositionMeters): Promise<void> {
    while (this.#remainingToNextBurnBoundary() === 0) {
      const ship = this.#reducer.state.ship!;
      const active = ship.executedBurns.at(-1);
      const event: SimEvent = active !== undefined && active.endedAtMs === undefined
        ? { type: "burnEnded", nodeId: active.node.nodeId }
        : { type: "burnStarted", node: ship.flightPlan.nodes[0]! };
      await this.#append({ event, eventTime: this.#reducer.time, eventPosition: eventPositionAt(this.#reducer.time) });
      this.#reducer.apply(event);
    }
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

  #assertRecordTime(record: StoredSimEvent): void {
    const expected = record.event.type === "clockAdvanced" ? simTimeMs(this.#reducer.time + record.event.elapsedMs) : this.#reducer.time;
    if (record.eventTime !== expected) throw new RangeError("Persisted event time does not match the authoritative clock.");
  }
}
