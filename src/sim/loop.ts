import { SimClock, simTimeMs, type SimTimeMs } from "./clock.js";
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
  type ShipState,
  type SimEvent,
  type SimState
} from "./event-log.js";
import { SeededRng } from "./rng.js";

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
  readonly #clock: SimClock;
  readonly #rng: SeededRng;
  readonly #store: SimulationEventStore;
  readonly #streamId: string;
  readonly #randomValues: number[] = [];
  #ship: ShipState | undefined;
  #streamSequence = 0;

  private constructor({ stream, store }: AuthoritativeSimLoopOptions) {
    this.#clock = SimClock.production(stream.initialTime);
    this.#rng = new SeededRng(stream.seed);
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
    return this.#ship === undefined
      ? { time: this.#clock.now, randomValues: [...this.#randomValues] }
      : { time: this.#clock.now, randomValues: [...this.#randomValues], ship: this.#ship };
  }

  /** One host tick. The stored event is durable before it mutates local state. */
  async advance(elapsedMs: number, eventPosition: PositionMeters): Promise<SimTimeMs> {
    if (!Number.isSafeInteger(elapsedMs) || elapsedMs < 0) {
      throw new RangeError("Simulation advance must be a non-negative safe integer in milliseconds.");
    }
    const targetTime = this.#clock.now + elapsedMs;
    while (this.#clock.now < targetTime) {
      await this.#advanceDueShipPhases(eventPosition);
      const remainingToTarget = targetTime - this.#clock.now;
      const remainingToPhase = this.#remainingToNextShipPhase();
      const step = remainingToPhase === undefined ? remainingToTarget : Math.min(remainingToTarget, remainingToPhase);
      const event: SimEvent = { type: "clockAdvanced", elapsedMs: step };
      await this.#append({ event, eventTime: simTimeMs(this.#clock.now + step), eventPosition });
      this.#apply(event);
      await this.#advanceDueShipPhases(eventPosition);
    }
    await this.#advanceDueShipPhases(eventPosition);
    return this.#clock.now;
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
    if (this.#ship !== undefined) throw new Error("A ship order is already committed.");
    await this.#append({ event: { type: "shipOrderCommitted", order }, eventTime: this.#clock.now, eventPosition });
    this.#apply({ type: "shipOrderCommitted", order });
    for (const decision of decisions) {
      await this.#append({ event: { type: "shipDecisionWindowScheduled", decision }, eventTime: this.#clock.now, eventPosition });
      this.#apply({ type: "shipDecisionWindowScheduled", decision });
    }
    await this.#advanceDueShipPhases(eventPosition);
  }

  /** Records each simulation RNG decision so replay never relies on host order. */
  async requestRandom(upperExclusive: number, eventPosition: PositionMeters): Promise<number> {
    const event: SimEvent = { type: "randomValueRequested", upperExclusive };
    await this.#append({ event, eventTime: this.#clock.now, eventPosition });
    this.#apply(event);
    const value = this.#randomValues.at(-1);
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
      ? simTimeMs(this.#clock.now + record.event.elapsedMs)
      : this.#clock.now;
    if (record.eventTime !== expectedTime) {
      throw new RangeError("Persisted event time does not match the authoritative clock.");
    }
  }

  #apply(event: SimEvent): void {
    switch (event.type) {
      case "clockAdvanced":
        this.#clock.advance(event.elapsedMs);
        return;
      case "randomValueRequested":
        this.#randomValues.push(this.#rng.nextInt(event.upperExclusive));
        return;
      case "shipOrderCommitted":
        if (this.#ship !== undefined) throw new Error("A ship order is already committed.");
        this.#ship = { order: event.order, phase: "accelBurn", phaseStartedAtMs: this.#clock.now, scheduledDecisions: [] };
        return;
      case "shipDecisionWindowScheduled":
        if (this.#ship === undefined) throw new Error("Cannot schedule a decision without a committed ship order.");
        this.#ship = { ...this.#ship, scheduledDecisions: [...this.#ship.scheduledDecisions, event.decision] };
        return;
      case "shipPhaseChanged":
        if (this.#ship === undefined) throw new Error("Cannot change phase without a committed ship order.");
        this.#ship = { ...this.#ship, phase: event.phase, phaseStartedAtMs: this.#clock.now };
        return;
    }
  }

  #remainingToNextShipPhase(): number | undefined {
    if (this.#ship === undefined || this.#ship.phase === "arrived") return undefined;
    const duration = this.#phaseDuration(this.#ship.phase);
    return Math.max(0, duration - (this.#clock.now - this.#ship.phaseStartedAtMs));
  }

  #phaseDuration(phase: ShipPhase): number {
    if (this.#ship === undefined) throw new Error("No committed ship order.");
    switch (phase) {
      case "accelBurn": return this.#ship.order.accelerationBurn.burnDurationMs;
      case "coast": return this.#ship.order.coastDurationMs;
      case "flip": return 0;
      case "decelBurn": return this.#ship.order.decelerationBurn.burnDurationMs;
      case "docked":
      case "arrived":
        return 0;
    }
  }

  async #advanceDueShipPhases(eventPosition: PositionMeters): Promise<void> {
    while (this.#ship !== undefined && this.#ship.phase !== "arrived" && this.#remainingToNextShipPhase() === 0) {
      const phase: Exclude<ShipPhase, "docked"> = this.#ship.phase === "accelBurn"
        ? "coast"
        : this.#ship.phase === "coast"
          ? "flip"
          : this.#ship.phase === "flip"
            ? "decelBurn"
            : "arrived";
      const event: SimEvent = { type: "shipPhaseChanged", phase };
      await this.#append({ event, eventTime: this.#clock.now, eventPosition });
      this.#apply(event);
    }
  }
}
