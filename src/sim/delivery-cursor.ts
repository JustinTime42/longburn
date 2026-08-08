/**
 * Durable acknowledgement ledger for one observer's light-lagged stream.
 * It records only acknowledged messages; a crash between transport and this
 * write intentionally redelivers the stable message id.
 */
export interface DeliveryAcknowledgement {
  readonly globalPosition: number;
  readonly messageId: string;
}

export interface DeliveryCursor {
  readonly observerId: string;
  /** Every position at or below this contiguous prefix is acknowledged. */
  readonly lowWatermark: number;
  /** Acknowledgements above the prefix, retained until their gaps close. */
  readonly delivered: readonly DeliveryAcknowledgement[];
}

export interface DeliveryCursorStore {
  read(observerId: string): Promise<DeliveryCursor | undefined>;
  acknowledge(observerId: string, acknowledgement: DeliveryAcknowledgement): Promise<DeliveryCursor>;
}

const validAcknowledgement = (acknowledgement: DeliveryAcknowledgement): void => {
  if (acknowledgement.messageId.length === 0 || !Number.isSafeInteger(acknowledgement.globalPosition) || acknowledgement.globalPosition < 1) {
    throw new RangeError("Delivery acknowledgements require a non-empty message ID and positive global position.");
  }
};

const copyCursor = (cursor: DeliveryCursor): DeliveryCursor => ({
  ...cursor,
  delivered: cursor.delivered.map((acknowledgement) => ({ ...acknowledgement }))
});

const normalize = (observerId: string, lowWatermark: number, delivered: readonly DeliveryAcknowledgement[]): DeliveryCursor => {
  if (observerId.length === 0 || !Number.isSafeInteger(lowWatermark) || lowWatermark < 0) {
    throw new RangeError("Delivery cursors require a non-empty observer ID and non-negative low watermark.");
  }
  const byPosition = new Map<number, DeliveryAcknowledgement>();
  const messageIds = new Set<string>();
  for (const acknowledgement of delivered) {
    validAcknowledgement(acknowledgement);
    if (acknowledgement.globalPosition <= lowWatermark || byPosition.has(acknowledgement.globalPosition) || messageIds.has(acknowledgement.messageId)) {
      throw new RangeError("Delivery acknowledgement ledger contains a duplicate or compacted entry.");
    }
    byPosition.set(acknowledgement.globalPosition, { ...acknowledgement });
    messageIds.add(acknowledgement.messageId);
  }
  let compactedWatermark = lowWatermark;
  while (byPosition.delete(compactedWatermark + 1)) compactedWatermark += 1;
  return { observerId, lowWatermark: compactedWatermark, delivered: [...byPosition.values()].sort((a, b) => a.globalPosition - b.globalPosition) };
};

export const hasAcknowledged = (cursor: DeliveryCursor | undefined, acknowledgement: DeliveryAcknowledgement): boolean =>
  cursor !== undefined && (acknowledgement.globalPosition <= cursor.lowWatermark ||
    cursor.delivered.some((delivered) => delivered.globalPosition === acknowledgement.globalPosition || delivered.messageId === acknowledgement.messageId));

/** Deterministic reference store used by scheduler tests and replay fixtures. */
export class InMemoryDeliveryCursorStore implements DeliveryCursorStore {
  readonly #cursors = new Map<string, DeliveryCursor>();

  async read(observerId: string): Promise<DeliveryCursor | undefined> {
    const cursor = this.#cursors.get(observerId);
    return cursor === undefined ? undefined : copyCursor(cursor);
  }

  async acknowledge(observerId: string, acknowledgement: DeliveryAcknowledgement): Promise<DeliveryCursor> {
    validAcknowledgement(acknowledgement);
    const previous = this.#cursors.get(observerId) ?? { observerId, lowWatermark: 0, delivered: [] };
    if (hasAcknowledged(previous, acknowledgement)) throw new RangeError("Delivery message is already acknowledged.");
    const cursor = normalize(observerId, previous.lowWatermark, [...previous.delivered, acknowledgement]);
    this.#cursors.set(observerId, cursor);
    return copyCursor(cursor);
  }
}

/** A query runner pinned to one PostgreSQL connection. */
export interface PostgresCursorSession {
  query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly Row[] }>;
}

/**
 * PostgreSQL boundary for the acknowledgement ledger. `withTransaction` must
 * run its callback on one dedicated database session, not a pool-wide query
 * dispatcher. It commits on success and rolls back when the callback throws.
 */
export interface PostgresCursorQueryClient extends PostgresCursorSession {
  withTransaction<Result>(callback: (session: PostgresCursorSession) => Promise<Result>): Promise<Result>;
}

interface CursorRow extends Record<string, unknown> {
  readonly observer_id: string;
  readonly low_watermark: number;
  readonly global_position: number | null;
  readonly message_id: string | null;
}

/** PostgreSQL leg; migrations are applied by deployment/CI, never the sim. */
export class PostgresDeliveryCursorStore implements DeliveryCursorStore {
  readonly #client: PostgresCursorQueryClient;

  constructor(client: PostgresCursorQueryClient) { this.#client = client; }

  async read(observerId: string): Promise<DeliveryCursor | undefined> {
    const result = await this.#client.query<CursorRow>(
      `SELECT c.observer_id, c.low_watermark::double precision AS low_watermark,
              a.global_position::double precision AS global_position, a.message_id
         FROM delivery_cursors c
         LEFT JOIN delivery_acknowledgements a ON a.observer_id = c.observer_id
        WHERE c.observer_id = $1
        ORDER BY a.global_position`, [observerId]
    );
    return result.rows.length === 0 ? undefined : deserializeCursor(result.rows);
  }

  async acknowledge(observerId: string, acknowledgement: DeliveryAcknowledgement): Promise<DeliveryCursor> {
    validAcknowledgement(acknowledgement);
    return this.#client.withTransaction(async (session) => {
      const inserted = await session.query<{ readonly observer_id: string }>(
        `INSERT INTO delivery_acknowledgements (observer_id, global_position, message_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING observer_id`,
        [observerId, acknowledgement.globalPosition, acknowledgement.messageId]
      );
      if (inserted.rows.length === 0) throw new RangeError("Delivery message is already acknowledged.");

      await session.query(
        `INSERT INTO delivery_cursors (observer_id, low_watermark)
         VALUES ($1, 0) ON CONFLICT DO NOTHING`, [observerId]
      );
      const locked = await session.query<CursorRow>(
        `SELECT c.observer_id, c.low_watermark::double precision AS low_watermark,
                a.global_position::double precision AS global_position, a.message_id
           FROM delivery_cursors c
           LEFT JOIN delivery_acknowledgements a ON a.observer_id = c.observer_id
          WHERE c.observer_id = $1
          ORDER BY a.global_position FOR UPDATE OF c`, [observerId]
      );
      const lockedCursor = locked.rows[0];
      if (lockedCursor === undefined) throw new Error("Delivery cursor lock returned no cursor.");
      if (acknowledgement.globalPosition <= lockedCursor.low_watermark) {
        throw new RangeError("Delivery message is already acknowledged.");
      }
      const beforeCompaction = deserializeCursor(locked.rows);
      await session.query(
        "UPDATE delivery_cursors SET low_watermark = $2 WHERE observer_id = $1",
        [observerId, beforeCompaction.lowWatermark]
      );
      await session.query(
        "DELETE FROM delivery_acknowledgements WHERE observer_id = $1 AND global_position <= $2",
        [observerId, beforeCompaction.lowWatermark]
      );
      const remainder = await session.query<CursorRow>(
        `SELECT c.observer_id, c.low_watermark::double precision AS low_watermark,
                a.global_position::double precision AS global_position, a.message_id
           FROM delivery_cursors c
           LEFT JOIN delivery_acknowledgements a ON a.observer_id = c.observer_id
          WHERE c.observer_id = $1
          ORDER BY a.global_position`, [observerId]
      );
      const cursor = deserializeCursor(remainder.rows);
      if (!hasAcknowledged(cursor, acknowledgement)) throw new Error("Delivery acknowledgement persistence returned mismatched acknowledgement.");
      return cursor;
    });
  }
}

const deserializeCursor = (rows: readonly CursorRow[]): DeliveryCursor => {
  const first = rows[0];
  if (first === undefined) throw new RangeError("Delivery cursor query returned no rows.");
  const delivered = rows.flatMap((row) => row.global_position === null || row.message_id === null
    ? [] : [{ globalPosition: row.global_position, messageId: row.message_id }]);
  return normalize(first.observer_id, first.low_watermark, delivered);
};
