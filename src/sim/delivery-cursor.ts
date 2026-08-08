/**
 * Durable acknowledgement watermark for one observer's light-lagged stream.
 * It records only acknowledged messages; a crash between transport and this
 * write intentionally redelivers the stable message id.
 */
export interface DeliveryCursor {
  readonly observerId: string;
  readonly globalPosition: number;
  readonly messageId: string;
}

export interface DeliveryCursorStore {
  read(observerId: string): Promise<DeliveryCursor | undefined>;
  advance(cursor: DeliveryCursor): Promise<void>;
}

const validCursor = (cursor: DeliveryCursor): void => {
  if (cursor.observerId.length === 0 || cursor.messageId.length === 0 ||
    !Number.isSafeInteger(cursor.globalPosition) || cursor.globalPosition < 1) {
    throw new RangeError("Delivery cursors require a non-empty observer/message ID and positive global position.");
  }
};

const copyCursor = (cursor: DeliveryCursor): DeliveryCursor => ({ ...cursor });

/** Deterministic reference store used by scheduler tests and replay fixtures. */
export class InMemoryDeliveryCursorStore implements DeliveryCursorStore {
  readonly #cursors = new Map<string, DeliveryCursor>();

  async read(observerId: string): Promise<DeliveryCursor | undefined> {
    const cursor = this.#cursors.get(observerId);
    return cursor === undefined ? undefined : copyCursor(cursor);
  }

  async advance(cursor: DeliveryCursor): Promise<void> {
    validCursor(cursor);
    const previous = this.#cursors.get(cursor.observerId);
    if (previous !== undefined && cursor.globalPosition <= previous.globalPosition) {
      throw new RangeError("Delivery cursor positions must advance monotonically.");
    }
    this.#cursors.set(cursor.observerId, copyCursor(cursor));
  }
}

export interface PostgresCursorQueryClient {
  query<Row extends Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[]
  ): Promise<{ readonly rows: readonly Row[] }>;
}

interface CursorRow extends Record<string, unknown> {
  readonly observer_id: string;
  readonly global_position: number;
  readonly message_id: string;
}

/** PostgreSQL leg; migrations are applied by deployment/CI, never the sim. */
export class PostgresDeliveryCursorStore implements DeliveryCursorStore {
  readonly #client: PostgresCursorQueryClient;

  constructor(client: PostgresCursorQueryClient) {
    this.#client = client;
  }

  async read(observerId: string): Promise<DeliveryCursor | undefined> {
    const result = await this.#client.query<CursorRow>(
      "SELECT observer_id, global_position::double precision AS global_position, message_id FROM delivery_cursors WHERE observer_id = $1",
      [observerId]
    );
    const row = result.rows[0];
    return row === undefined ? undefined : deserializeCursor(row);
  }

  async advance(cursor: DeliveryCursor): Promise<void> {
    validCursor(cursor);
    const result = await this.#client.query<CursorRow>(
      `INSERT INTO delivery_cursors (observer_id, global_position, message_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (observer_id) DO UPDATE
         SET global_position = EXCLUDED.global_position, message_id = EXCLUDED.message_id
       WHERE delivery_cursors.global_position < EXCLUDED.global_position
       RETURNING observer_id, global_position::double precision AS global_position, message_id`,
      [cursor.observerId, cursor.globalPosition, cursor.messageId]
    );
    const advanced = result.rows[0];
    if (advanced === undefined) throw new RangeError("Delivery cursor positions must advance monotonically.");
    const persisted = deserializeCursor(advanced);
    if (persisted.observerId !== cursor.observerId || persisted.globalPosition !== cursor.globalPosition || persisted.messageId !== cursor.messageId) {
      throw new Error("Delivery cursor persistence returned mismatched acknowledgement.");
    }
  }
}

const deserializeCursor = (row: CursorRow): DeliveryCursor => {
  const cursor = { observerId: row.observer_id, globalPosition: row.global_position, messageId: row.message_id };
  validCursor(cursor);
  return cursor;
};
