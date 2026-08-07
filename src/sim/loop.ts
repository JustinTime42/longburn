import { simTimeMs, type SimTimeMs } from "./clock.js";
import type { PositionMeters } from "./causality.js";
import {
  type PersistedSimulationStream,
  type SimulationEventStore,
  type SimulationStream,
  type StreamSequenceConflict,
  type StoredSimEvent
} from "./event-store.js";
import {
  type CommittedShipOrder,
  type ScheduledShipDecision,
  type ShipPhase,
  type SimEvent,
  type SimState,
  SimEventReducer
} from "./event-log.js";

export interface AuthoritativeSimLoopOptions {
  readonly stream: SimulationStream;
  readonly store: SimulationEventStore;
}

/** A stale loop instance attempted to append after another writer advanced its stream. */
export class AuthoritativeSimLoopConflictError extends Error {
  readonly expectedStreamSequence: number;
  readonly actualStreamSequence: number;

  constructor(conflict: StreamSequenceConflict) {
    super(
      `Authoritative simulation loop stream sequence conflict: expected ${conflict.expectedStreamSequence}, `
      + `found ${conflict.actualStreamSequence}.`
    );
    this.name = "AuthoritativeSimLoopConflictError";
    this.expectedStreamSequence = conflict.expectedStreamSequence;
    this.actualStreamSequence = conflict.actualStreamSequence;
  }
}

/**
 * The authoritative loop advances only when its host supplies elapsed sim
 * milliseconds. Host scheduling may use wall time; this sim module cannot.
 */
export class AuthoritativeSimLoop {
  readonly #reducer: SimEventReducer;
  readonly #store: SimulationEventStore;
  readonly #streamId: string;
  #streamSequence = 0;

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
      loop.#apply(record.event);
    }
    loop.#streamSequence = persisted.events.length;
    return loop;
  }

  get state(): SimState {
    return this.#reducer.state;
  }

  /** One host tick. The stored event is durable before it mutates local state. */
  async advance(elapsedMs: number, eventPosition: PositionMeters): Promise<SimTimeMs> {
    if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0) {
      throw new RangeError("Simulation advance must be a non-negative safe integer in milliseconds.");
    }
    const targetTime = this.#reducer.time + elapsedMs;
    while (this.#reducer.time < targetTime) {
      await this.#advanceDueShipPhases(eventPosition);
      const remainingToTarget = targetTime - this.#reducer.time;
      const remainingToPhase = this.#remainingToNextShipPhase();
      const step = remainingToPhase === undefined ? remainingToTarget : Math.min(remainingToTarget, remainingToPhase);
      const event: SimEvent = { type: "clockAdvanced", elapsedMs: step };
      await this.#append({ event, eventTime: simTimeMs(this.#reducer.time + step), eventPosition });
      this.#apply(event);
      await this.#advanceDueShipPhases(eventPosition);
    }
    await this.#advanceDueShipPhases(eventPosition);
    return this.#reducer.time;
  }

  /**
   * The only commitment entry point. It persists quantized input before any
   * local state changes and deliberately accepts no planner callback.
   */
  async commitShipOrder(
    order: CommittedShipOrder,
    decisions: readonly ScheduledShipDecision[],
    eventPosition: PositionMeters
  ): Promise<void> {
    if (this.#reducer.state.ship !== undefined) throw new Error("A ship order is already committed.");
    const event: SimEvent = { type: "shipOrderCommitted", order, decisions };
    await this.#append({ event, eventTime: this.#reducer.time, eventPosition });
    this.#apply(event);
    await this.#advanceDueShipPhases(eventPosition);
  }

  /** Records each simulation RNG decision so replay never relies on host order. */
  async requestRandom(upperExclusive: number, eventPosition: PositionMeters): Promise<number> {
    const event: SimEvent = { type: "randomValueRequested", upperExclusive };
    await this.#append({ event, eventTime: this.#reducer.time, eventPosition });
    this.#apply(event);
    const value = this.#reducer.state.randomValues.at(-1);
    if (value === undefined) {
      throw new Error("Random event did not produce a value.");
    }
    return value;
  }

  async persistedStream(): Promise<PersistedSimulationStream> {
    return this.#store.readStream(this.#streamId);
  }

  async #append(event: Omit<StoredSimEvent, "streamSequence" | "globalPosition">): Promise<void> {
    const result = await this.#store.append(this.#streamId, event, this.#streamSequence);
    if (result.kind === "conflict") {
      throw new AuthoritativeSimLoopConflictError(result);
    }
    this.#streamSequence = result.event.streamSequence;
  }

  #assertRecordTime(record: StoredSimEvent): void {
    const expectedTime = record.event.type === "clockAdvanced"
      ? simTimeMs(this.#reducer.time + record.event.elapsedMs)
      : this.#reducer.time;
    if (record.eventTime !== expectedTime) {
      throw new RangeError("Persisted event time does not match the authoritative clock.");
    }
  }

  #apply(event: SimEvent): void {
    this.#reducer.apply(event);
  }

  #remainingToNextShipPhase(): number | undefined {
    const ship = this.#reducer.state.ship;
    if (ship === undefined || ship.phase === "arrived") return undefined;
    const duration = this.#phaseDuration(ship.phase);
    return Math.max(0, duration - (this.#reducer.time - ship.phaseStartedAtMs));
  }

  #phaseDuration(phase: ShipPhase): number {
    const ship = this.#reducer.state.ship;
    if (ship === undefined) throw new Error("No committed ship order.");
    switch (phase) {
      case "accelBurn": return ship.order.accelerationBurn.burnDurationMs;
      case "coast": return ship.order.coastDurationMs;
      case "flip": return 0;
      case "decelBurn": return ship.order.decelerationBurn.burnDurationMs;
      case "docked":
      case "arrived":
        return 0;
    }
  }

  async #advanceDueShipPhases(eventPosition: PositionMeters): Promise<void> {
    while (this.#reducer.state.ship !== undefined && this.#reducer.state.ship.phase !== "arrived" && this.#remainingToNextShipPhase() === 0) {
      const ship = this.#reducer.state.ship;
      if (ship === undefined) throw new Error("No committed ship order.");
      const phase: Exclude<ShipPhase, "docked"> = ship.phase === "accelBurn"
        ? "coast"
        : ship.phase === "coast"
          ? "flip"
          : ship.phase === "flip"
            ? "decelBurn"
            : "arrived";
      const event: SimEvent = { type: "shipPhaseChanged", phase };
      await this.#append({ event, eventTime: this.#reducer.time, eventPosition });
      this.#apply(event);
    }
  }
}
