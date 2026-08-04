import { SimClock, simTimeMs, type SimTimeMs } from "./clock.js";
import type { PositionMeters } from "./causality.js";
import {
  type PersistedSimulationStream,
  type SimulationEventStore,
  type SimulationStream,
  type StoredSimEvent
} from "./event-store.js";
import { type SimEvent, type SimState } from "./event-log.js";
import { SeededRng } from "./rng.js";

const ORIGIN: PositionMeters = { x: 0, y: 0, z: 0 };

export interface AuthoritativeSimLoopOptions {
  readonly stream: SimulationStream;
  readonly store: SimulationEventStore;
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
    return loop;
  }

  get state(): SimState {
    return { time: this.#clock.now, randomValues: [...this.#randomValues] };
  }

  /** One host tick. The stored event is durable before it mutates local state. */
  async advance(elapsedMs: number, eventPosition: PositionMeters = ORIGIN): Promise<SimTimeMs> {
    const event: SimEvent = { type: "clockAdvanced", elapsedMs };
    const eventTime = simTimeMs(this.#clock.now + elapsedMs);
    await this.#append({ event, eventTime, eventPosition });
    this.#apply(event);
    return this.#clock.now;
  }

  /** Records each simulation RNG decision so replay never relies on host order. */
  async requestRandom(upperExclusive: number, eventPosition: PositionMeters = ORIGIN): Promise<number> {
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

  async #append(event: Omit<StoredSimEvent, "sequence">): Promise<void> {
    await this.#store.append(this.#streamId, event);
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
    }
  }
}
