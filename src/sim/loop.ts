import { simTimeMs, type SimTimeMs } from "./clock.js";
import type { PositionMeters } from "./causality.js";
import type { PersistedSimulationStream, SimulationEventStore, SimulationStream, StreamSequenceConflict, StoredSimEvent } from "./event-store.js";
import { assertPlanRevisionRefusalReason, type FlightPlan, type PlanRevisionRefusalReason, type SimEvent, type SimState, SimEventReducer, validateFlightPlanRevision } from "./event-log.js";

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
      await this.#advanceDueBurns(eventPosition);
      const remaining = this.#remainingToNextBurnBoundary();
      const step = remaining === undefined ? targetTime - this.#reducer.time : Math.min(targetTime - this.#reducer.time, remaining);
      const event: SimEvent = { type: "clockAdvanced", elapsedMs: step };
      await this.#append({ event, eventTime: simTimeMs(this.#reducer.time + step), eventPosition: eventPosition() });
      this.#reducer.apply(event);
    }
    await this.#advanceDueBurns(eventPosition);
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

  async #advanceDueBurns(eventPosition: () => PositionMeters): Promise<void> {
    while (this.#remainingToNextBurnBoundary() === 0) {
      const ship = this.#reducer.state.ship!;
      const active = ship.executedBurns.at(-1);
      const event: SimEvent = active !== undefined && active.endedAtMs === undefined
        ? { type: "burnEnded", nodeId: active.node.nodeId }
        : { type: "burnStarted", node: ship.flightPlan.nodes[0]! };
      await this.#append({ event, eventTime: this.#reducer.time, eventPosition: eventPosition() });
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
