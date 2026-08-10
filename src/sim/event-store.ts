import { simTimeMs, type SimTimeMs } from "./clock.js";
import type { PositionMeters } from "./causality.js";
import { utDaysSinceJ2000, type UtDaysSinceJ2000 } from "./ephemerides.js";
import type { SimEvent } from "./event-log.js";

/** A stream is the durable unit of replay, including its deterministic seed. */
export interface SimulationStream {
  readonly id: string;
  readonly seed: number;
  readonly initialTime: SimTimeMs;
  /**
   * The virtual-clock anchor for resolvers that project simulation time onto
   * ephemerides. Legacy streams predate this fact and cannot be resumed by a
   * resolver that depends on it.
   */
  readonly epochUtDaysSinceJ2000?: UtDaysSinceJ2000;
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
      globalPosition: this.#nextGlobalPosition
    });
    this.#nextGlobalPosition += 2;
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
  readonly epoch_ut_days_since_j2000: number | null;
}

interface EventRow extends Record<string, unknown> {
  readonly stream_sequence: number | null;
  readonly global_position: number | null;
  readonly actual_stream_sequence?: number | null;
  readonly event_time_ms: number | null;
  readonly event_position: PositionMeters | null;
  readonly event: SimEvent | null;
}

const STREAM_SEQUENCE_CONSTRAINT = "simulation_events_stream_sequence_unique";
const MAX_APPEND_ATTEMPTS = 8;

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
      "INSERT INTO simulation_streams (stream_id, seed, initial_time_ms, epoch_ut_days_since_j2000) VALUES ($1, $2, $3, $4)",
      [stream.id, stream.seed, stream.initialTime, stream.epochUtDaysSinceJ2000 ?? null]
    );
  }

  async append(
    streamId: string,
    event: Omit<StoredSimEvent, "streamSequence" | "globalPosition">,
    expectedStreamSequence?: number
  ): Promise<AppendSimEventResult> {
    for (let attempt = 1; attempt <= MAX_APPEND_ATTEMPTS; attempt += 1) {
      try {
        const result = await this.#client.query<EventRow>(
          `WITH stream AS (
             SELECT stream_id FROM simulation_streams WHERE stream_id = $1
           ), current_sequence AS (
             SELECT stream.stream_id,
                    COALESCE(MAX(event.stream_sequence), 0) AS actual_stream_sequence
             FROM stream LEFT JOIN simulation_events AS event USING (stream_id)
             GROUP BY stream.stream_id
           ), inserted AS (
             INSERT INTO simulation_events
               (stream_id, stream_sequence, event_time_ms, event_position, event)
             SELECT stream_id, actual_stream_sequence + 1, $2, $3::jsonb, $4::jsonb
             FROM current_sequence
             WHERE $5::bigint IS NULL OR $5::bigint = actual_stream_sequence
             RETURNING stream_sequence::double precision AS stream_sequence,
                       sequence::double precision AS global_position,
                       event_time_ms::double precision AS event_time_ms, event_position, event
           )
           SELECT stream_sequence, global_position,
                  current_sequence.actual_stream_sequence::double precision,
                  event_time_ms, event_position, event
           FROM inserted CROSS JOIN current_sequence
           UNION ALL
           SELECT NULL::double precision, NULL::double precision,
                  actual_stream_sequence::double precision,
                  NULL::double precision, NULL::jsonb, NULL::jsonb
           FROM current_sequence
           WHERE NOT EXISTS (SELECT 1 FROM inserted)`,
          [
            streamId,
            event.eventTime,
            JSON.stringify(event.eventPosition),
            JSON.stringify(event.event),
            expectedStreamSequence ?? null
          ]
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
      } catch (error) {
        if (!isStreamSequenceUniqueViolation(error)) throw error;
      }
    }
    throw new Error(`Could not append to simulation stream after ${MAX_APPEND_ATTEMPTS} sequence races: ${streamId}`);
  }

  async readStream(streamId: string): Promise<PersistedSimulationStream> {
    const streams = await this.#client.query<StreamRow>(
      `SELECT stream_id, seed::double precision AS seed,
              initial_time_ms::double precision AS initial_time_ms,
              epoch_ut_days_since_j2000
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
              NULL::double precision AS actual_stream_sequence,
              event_time_ms::double precision AS event_time_ms, event_position, event
       FROM simulation_events WHERE stream_id = $1 ORDER BY stream_sequence ASC`,
      [streamId]
    );
    return {
      id: stream.stream_id,
      seed: stream.seed,
      initialTime: simTimeMs(stream.initial_time_ms),
      ...(stream.epoch_ut_days_since_j2000 === null
        ? {}
        : { epochUtDaysSinceJ2000: utDaysSinceJ2000(stream.epoch_ut_days_since_j2000) }),
      events: events.rows.map(deserializeStoredEvent)
    };
  }
}

const deserializeStoredEvent = (row: EventRow): StoredSimEvent => ({
  streamSequence: validatedSequence(row.stream_sequence ?? 0),
  globalPosition: validatedSequence(row.global_position ?? 0),
  eventTime: simTimeMs(requiredEventField(row.event_time_ms, "event_time_ms")),
  eventPosition: clonePosition(requiredEventField(row.event_position, "event_position")),
  event: cloneEvent(requiredEventField(row.event, "event"))
});

const requiredEventField = <Value>(value: Value | null, field: string): Value => {
  if (value === null) {
    throw new Error(`Persisted event is missing ${field}.`);
  }
  return value;
};

const isStreamSequenceUniqueViolation = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { readonly code?: unknown; readonly constraint?: unknown };
  return candidate.code === "23505" && candidate.constraint === STREAM_SEQUENCE_CONSTRAINT;
};

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
