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
  /**
   * Per-stream logical ordering. It is contiguous and one-based for every
   * stream, and is the only key suitable for replay, gap detection, and
   * stream-local resume.
   */
  readonly streamSequence: number;
  /**
   * Globally monotone physical ordering for subscriptions. It is never a
   * contiguity contract: PostgreSQL identities may contain gaps.
   */
  readonly globalPosition: number;
  readonly eventTime: SimTimeMs;
  readonly eventPosition: PositionMeters;
  readonly event: SimEvent;
}

export interface PersistedSimulationStream extends SimulationStream {
  readonly events: readonly StoredSimEvent[];
}

export interface AppendedSimEvent {
  readonly kind: "appended";
  readonly event: StoredSimEvent;
}

/** Optimistic-concurrency mismatch; callers may retry from `actualStreamSequence`. */
export interface StreamSequenceConflict {
  readonly kind: "conflict";
  readonly expectedStreamSequence: number;
  readonly actualStreamSequence: number;
}

export type AppendSimEventResult = AppendedSimEvent | StreamSequenceConflict;

/** Narrow persistence boundary used by the authoritative simulation. */
export interface SimulationEventStore {
  createStream(stream: SimulationStream): Promise<void>;
  append(
    streamId: string,
    event: Omit<StoredSimEvent, "streamSequence" | "globalPosition">,
    expectedStreamSequence?: number
  ): Promise<AppendSimEventResult>;
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
  #nextGlobalPosition = 1;

  async createStream(stream: SimulationStream): Promise<void> {
    if (this.#streams.has(stream.id)) {
      throw new Error(`Simulation stream already exists: ${stream.id}`);
    }
    this.#streams.set(stream.id, { ...stream, events: [] });
  }

  async append(
    streamId: string,
    event: Omit<StoredSimEvent, "streamSequence" | "globalPosition">,
    expectedStreamSequence?: number
  ): Promise<AppendSimEventResult> {
    const stream = this.#streams.get(streamId);
    if (stream === undefined) {
      throw new Error(`Unknown simulation stream: ${streamId}`);
    }

    const actualStreamSequence = stream.events.length;
    if (expectedStreamSequence !== undefined && expectedStreamSequence !== actualStreamSequence) {
      return { kind: "conflict", expectedStreamSequence, actualStreamSequence };
    }

    const stored = cloneStoredEvent({
      ...event,
      streamSequence: actualStreamSequence + 1,
      globalPosition: this.#nextGlobalPosition++
    });
    this.#streams.set(streamId, { ...stream, events: [...stream.events, stored] });
    return { kind: "appended", event: cloneStoredEvent(stored) };
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
  readonly stream_sequence: number | null;
  readonly global_position: number | null;
  readonly actual_stream_sequence?: number | null;
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

  async append(
    streamId: string,
    event: Omit<StoredSimEvent, "streamSequence" | "globalPosition">,
    expectedStreamSequence?: number
  ): Promise<AppendSimEventResult> {
    const result = await this.#client.query<EventRow>(
      `WITH locked_stream AS (
         SELECT stream_id FROM simulation_streams WHERE stream_id = $1 FOR UPDATE
       ), next_sequence AS (
         SELECT COALESCE(MAX(event.stream_sequence), 0) + 1 AS stream_sequence
         FROM simulation_events AS event JOIN locked_stream USING (stream_id)
       ), inserted AS (
         INSERT INTO simulation_events (stream_id, stream_sequence, event_time_ms, event_position, event)
         SELECT locked_stream.stream_id, next_sequence.stream_sequence, $2, $3::jsonb, $4::jsonb
         FROM locked_stream CROSS JOIN next_sequence
         WHERE NULLIF($5::text, '')::bigint IS NULL
            OR NULLIF($5::text, '')::bigint = next_sequence.stream_sequence - 1
         RETURNING stream_sequence::double precision AS stream_sequence,
                   sequence::double precision AS global_position,
                   event_time_ms::double precision AS event_time_ms, event_position, event
       )
       SELECT stream_sequence, global_position, NULL::double precision AS actual_stream_sequence,
              event_time_ms, event_position, event FROM inserted
       UNION ALL
       SELECT NULL::double precision, NULL::double precision,
              (stream_sequence - 1)::double precision, NULL::double precision, NULL::jsonb, NULL::jsonb
       FROM next_sequence
       WHERE NOT EXISTS (SELECT 1 FROM inserted)`,
      [streamId, event.eventTime, JSON.stringify(event.eventPosition), JSON.stringify(event.event), expectedStreamSequence ?? null]
    );
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`Unknown simulation stream: ${streamId}`);
    }
    if (row.stream_sequence === null || row.global_position === null) {
      if (expectedStreamSequence === undefined) {
        throw new Error("Postgres event insert returned no event.");
      }
      return {
        kind: "conflict",
        expectedStreamSequence,
        actualStreamSequence: validatedNonnegativeSequence(row.actual_stream_sequence ?? -1)
      };
    }
    return { kind: "appended", event: deserializeStoredEvent(row) };
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
      `SELECT stream_sequence::double precision AS stream_sequence,
              sequence::double precision AS global_position,
              event_time_ms::double precision AS event_time_ms, event_position, event
       FROM simulation_events WHERE stream_id = $1 ORDER BY stream_sequence ASC`,
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
  streamSequence: validatedSequence(row.stream_sequence ?? 0),
  globalPosition: validatedSequence(row.global_position ?? 0),
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

const validatedNonnegativeSequence = (sequence: number): number => {
  if (!Number.isSafeInteger(sequence) || sequence < 0) {
    throw new RangeError("Persisted stream sequence must be a nonnegative safe integer.");
  }
  return sequence;
};
