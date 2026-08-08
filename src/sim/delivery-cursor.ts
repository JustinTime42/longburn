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

export interface PostgresCursorQueryClient {
  query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly Row[] }>;
}

interface CursorRow extends Record<string, unknown> {
  readonly observer_id: string;
  readonly low_watermark: number;
  readonly global_position?: number;
  readonly message_id?: string;
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
    const result = await this.#client.query<CursorRow>(
      `WITH RECURSIVE inserted AS (
         INSERT INTO delivery_acknowledgements (observer_id, global_position, message_id)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING observer_id
       ), ensured AS (
         INSERT INTO delivery_cursors (observer_id, low_watermark)
         SELECT $1, 0 WHERE EXISTS (SELECT 1 FROM inserted)
         ON CONFLICT (observer_id) DO UPDATE SET low_watermark = delivery_cursors.low_watermark
         RETURNING observer_id, low_watermark
       ), acknowledged (global_position) AS (
         SELECT global_position FROM delivery_acknowledgements WHERE observer_id = $1
         UNION ALL SELECT $2 WHERE EXISTS (SELECT 1 FROM inserted)
       ), contiguous (global_position) AS (
         SELECT e.low_watermark + 1 FROM ensured e JOIN acknowledged a ON a.global_position = e.low_watermark + 1
         UNION ALL
         SELECT c.global_position + 1 FROM contiguous c JOIN acknowledged a ON a.global_position = c.global_position + 1
       ), advanced AS (
         UPDATE delivery_cursors c
            SET low_watermark = COALESCE((SELECT MAX(global_position) FROM contiguous), c.low_watermark)
          WHERE c.observer_id = $1
            AND EXISTS (SELECT 1 FROM inserted)
         RETURNING c.observer_id, c.low_watermark
       ), compacted AS (
         DELETE FROM delivery_acknowledgements a USING advanced c
          WHERE a.observer_id = c.observer_id AND a.global_position <= c.low_watermark
       )
       SELECT c.observer_id, c.low_watermark::double precision AS low_watermark,
              a.global_position::double precision AS global_position, a.message_id
         FROM advanced c LEFT JOIN (
           SELECT observer_id, global_position, message_id FROM delivery_acknowledgements
           UNION ALL SELECT $1, $2, $3 WHERE EXISTS (SELECT 1 FROM inserted)
         ) a ON a.observer_id = c.observer_id AND a.global_position > c.low_watermark
        ORDER BY a.global_position`, [observerId, acknowledgement.globalPosition, acknowledgement.messageId]
    );
    if (result.rows.length === 0) throw new RangeError("Delivery message is already acknowledged.");
    const cursor = deserializeCursor(result.rows);
    if (!hasAcknowledged(cursor, acknowledgement)) throw new Error("Delivery acknowledgement persistence returned mismatched acknowledgement.");
    return cursor;
  }
}

const deserializeCursor = (rows: readonly CursorRow[]): DeliveryCursor => {
  const first = rows[0];
  if (first === undefined) throw new RangeError("Delivery cursor query returned no rows.");
  const delivered = rows.flatMap((row) => row.global_position === undefined || row.message_id === undefined
    ? [] : [{ globalPosition: row.global_position, messageId: row.message_id }]);
  return normalize(first.observer_id, first.low_watermark, delivered);
};
