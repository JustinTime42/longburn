import { simTimeMs, type SimTimeMs } from "./clock.js";
import type { PositionMeters } from "./causality.js";
import type { SimEvent } from "./event-log.js";

/** A stream is the durable unit of replay, including its deterministic seed. */
export interface SimulationStream {
  readonly id: string;
  readonly seed: number;
  readonly initialTime: SimTimeMs;
}

/**
 * Every persisted event retains the provenance the emission gate will need.
 * `eventPosition` is the authoritative position at `eventTime`; a later
 * transport supplies its observer position at emission time.
 */
export interface StoredSimEvent {
  readonly sequence: number;
  readonly eventTime: SimTimeMs;
  readonly eventPosition: PositionMeters;
  readonly event: SimEvent;
}

export interface PersistedSimulationStream extends SimulationStream {
  readonly events: readonly StoredSimEvent[];
}

/** Narrow persistence boundary used by the authoritative simulation. */
export interface SimulationEventStore {
  createStream(stream: SimulationStream): Promise<void>;
  append(streamId: string, event: Omit<StoredSimEvent, "sequence">): Promise<StoredSimEvent>;
  readStream(streamId: string): Promise<PersistedSimulationStream>;
}

const clonePosition = (position: PositionMeters): PositionMeters => ({ ...position });

const cloneEvent = (event: SimEvent): SimEvent => ({ ...event });

const cloneStoredEvent = (event: StoredSimEvent): StoredSimEvent => ({
  ...event,
  eventPosition: clonePosition(event.eventPosition),
  event: cloneEvent(event.event)
});

const cloneStream = (stream: PersistedSimulationStream): PersistedSimulationStream => ({
  ...stream,
  events: stream.events.map(cloneStoredEvent)
});

/** Deterministic reference implementation used by replay and property tests. */
export class InMemorySimulationEventStore implements SimulationEventStore {
  readonly #streams = new Map<string, PersistedSimulationStream>();

  async createStream(stream: SimulationStream): Promise<void> {
    if (this.#streams.has(stream.id)) {
      throw new Error(`Simulation stream already exists: ${stream.id}`);
    }
    this.#streams.set(stream.id, { ...stream, events: [] });
  }

  async append(streamId: string, event: Omit<StoredSimEvent, "sequence">): Promise<StoredSimEvent> {
    const stream = this.#streams.get(streamId);
    if (stream === undefined) {
      throw new Error(`Unknown simulation stream: ${streamId}`);
    }

    const stored = cloneStoredEvent({ ...event, sequence: stream.events.length + 1 });
    this.#streams.set(streamId, { ...stream, events: [...stream.events, stored] });
    return cloneStoredEvent(stored);
  }

  async readStream(streamId: string): Promise<PersistedSimulationStream> {
    const stream = this.#streams.get(streamId);
    if (stream === undefined) {
      throw new Error(`Unknown simulation stream: ${streamId}`);
    }
    return cloneStream(stream);
  }
}

/** Minimal structural contract, so the Postgres driver does not impose a client library. */
export interface PostgresQueryClient {
  query<Row extends Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[]
  ): Promise<{ readonly rows: readonly Row[] }>;
}

interface StreamRow extends Record<string, unknown> {
  readonly stream_id: string;
  readonly seed: number;
  readonly initial_time_ms: number;
}

interface EventRow extends Record<string, unknown> {
  readonly sequence: number;
  readonly event_time_ms: number;
  readonly event_position: PositionMeters;
  readonly event: SimEvent;
}

/**
 * PostgreSQL adapter. Migrations are deliberately applied by deployment/CI,
 * never by this simulation driver.
 */
export class PostgresSimulationEventStore implements SimulationEventStore {
  readonly #client: PostgresQueryClient;

  constructor(client: PostgresQueryClient) {
    this.#client = client;
  }

  async createStream(stream: SimulationStream): Promise<void> {
    await this.#client.query(
      "INSERT INTO simulation_streams (stream_id, seed, initial_time_ms) VALUES ($1, $2, $3)",
      [stream.id, stream.seed, stream.initialTime]
    );
  }

  async append(streamId: string, event: Omit<StoredSimEvent, "sequence">): Promise<StoredSimEvent> {
    const result = await this.#client.query<EventRow>(
      `INSERT INTO simulation_events (stream_id, event_time_ms, event_position, event)
       VALUES ($1, $2, $3::jsonb, $4::jsonb)
       RETURNING sequence::double precision AS sequence,
                 event_time_ms::double precision AS event_time_ms,
                 event_position, event`,
      [streamId, event.eventTime, JSON.stringify(event.eventPosition), JSON.stringify(event.event)]
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error("Postgres event insert returned no event.");
    }
    return deserializeStoredEvent(row);
  }

  async readStream(streamId: string): Promise<PersistedSimulationStream> {
    const streams = await this.#client.query<StreamRow>(
      `SELECT stream_id, seed::double precision AS seed,
              initial_time_ms::double precision AS initial_time_ms
       FROM simulation_streams WHERE stream_id = $1`,
      [streamId]
    );
    const stream = streams.rows[0];
    if (stream === undefined) {
      throw new Error(`Unknown simulation stream: ${streamId}`);
    }
    const events = await this.#client.query<EventRow>(
      `SELECT sequence::double precision AS sequence,
              event_time_ms::double precision AS event_time_ms, event_position, event
       FROM simulation_events WHERE stream_id = $1 ORDER BY sequence ASC`,
      [streamId]
    );
    return {
      id: stream.stream_id,
      seed: stream.seed,
      initialTime: simTimeMs(stream.initial_time_ms),
      events: events.rows.map(deserializeStoredEvent)
    };
  }
}

const deserializeStoredEvent = (row: EventRow): StoredSimEvent => ({
  sequence: validatedSequence(row.sequence),
  eventTime: simTimeMs(row.event_time_ms),
  eventPosition: clonePosition(row.event_position),
  event: cloneEvent(row.event)
});

const validatedSequence = (sequence: number): number => {
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new RangeError("Persisted event sequence must be a positive safe integer.");
  }
  return sequence;
};
