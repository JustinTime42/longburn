/**
 * Durable delivery facts for one observer's light-lagged stream. An assignment
 * is made once, before emission, and remains the message's immutable sequence.
 * Acknowledgement receipts compact; assignments do not, because a later pass
 * must look up the original fact even after its receipt has compacted.
 */
export interface DeliveryAssignment {
  readonly deliverySequence: number;
  readonly messageId: string;
  readonly sourceGlobalPosition: number;
}

export interface DeliveryCursor {
  readonly observerId: string;
  /** Every delivery sequence at or below this contiguous prefix is acknowledged. */
  readonly lowWatermark: number;
  /** Next immutable sequence to allocate for a newly projected message. */
  readonly nextDeliverySequence: number;
  /** Acknowledgement receipts above the prefix, retained until their gaps close. */
  readonly delivered: readonly DeliveryAssignment[];
}

export interface DeliveryCursorStore {
  read(observerId: string): Promise<DeliveryCursor | undefined>;
  /** Looks up or durably allocates the message's observer-local sequence. */
  assign(observerId: string, messageId: string, sourceGlobalPosition: number): Promise<DeliveryAssignment>;
  acknowledge(observerId: string, assignment: DeliveryAssignment): Promise<DeliveryCursor>;
}

const validAssignment = (assignment: DeliveryAssignment): void => {
  if (assignment.messageId.length === 0 || !Number.isSafeInteger(assignment.deliverySequence) || assignment.deliverySequence < 1 ||
    !Number.isSafeInteger(assignment.sourceGlobalPosition) || assignment.sourceGlobalPosition < 1) {
    throw new RangeError("Delivery assignments require a non-empty message ID, positive delivery sequence, and positive source global position.");
  }
};

const copyCursor = (cursor: DeliveryCursor): DeliveryCursor => ({ ...cursor, delivered: cursor.delivered.map((assignment) => ({ ...assignment })) });

const normalize = (observerId: string, lowWatermark: number, nextDeliverySequence: number, delivered: readonly DeliveryAssignment[]): DeliveryCursor => {
  if (observerId.length === 0 || !Number.isSafeInteger(lowWatermark) || lowWatermark < 0 ||
    !Number.isSafeInteger(nextDeliverySequence) || nextDeliverySequence < 1) {
    throw new RangeError("Delivery cursors require a non-empty observer ID, a non-negative watermark, and a positive next sequence.");
  }
  const bySequence = new Map<number, DeliveryAssignment>();
  for (const assignment of delivered) {
    validAssignment(assignment);
    if (assignment.deliverySequence <= lowWatermark || bySequence.has(assignment.deliverySequence)) {
      throw new RangeError("Delivery acknowledgement ledger contains a duplicate or compacted entry.");
    }
    bySequence.set(assignment.deliverySequence, { ...assignment });
  }
  let compactedWatermark = lowWatermark;
  while (bySequence.delete(compactedWatermark + 1)) compactedWatermark += 1;
  return { observerId, lowWatermark: compactedWatermark, nextDeliverySequence, delivered: [...bySequence.values()].sort((a, b) => a.deliverySequence - b.deliverySequence) };
};

export const hasAcknowledged = (cursor: DeliveryCursor | undefined, assignment: DeliveryAssignment): boolean =>
  cursor !== undefined && (assignment.deliverySequence <= cursor.lowWatermark ||
    cursor.delivered.some((delivered) => delivered.deliverySequence === assignment.deliverySequence));

/** Deterministic reference store used by scheduler tests and replay fixtures. */
export class InMemoryDeliveryCursorStore implements DeliveryCursorStore {
  readonly #cursors = new Map<string, DeliveryCursor>();
  readonly #assignments = new Map<string, DeliveryAssignment>();

  async read(observerId: string): Promise<DeliveryCursor | undefined> {
    const cursor = this.#cursors.get(observerId);
    return cursor === undefined ? undefined : copyCursor(cursor);
  }

  async assign(observerId: string, messageId: string, sourceGlobalPosition: number): Promise<DeliveryAssignment> {
    const key = `${observerId}\u0000${messageId}`;
    const existing = this.#assignments.get(key);
    if (existing !== undefined) {
      if (existing.sourceGlobalPosition !== sourceGlobalPosition) throw new RangeError("Delivery message ID is already assigned to another source position.");
      return { ...existing };
    }
    const previous = this.#cursors.get(observerId) ?? { observerId, lowWatermark: 0, nextDeliverySequence: 1, delivered: [] };
    const assignment = { deliverySequence: previous.nextDeliverySequence, messageId, sourceGlobalPosition };
    validAssignment(assignment);
    this.#assignments.set(key, assignment);
    this.#cursors.set(observerId, { ...previous, nextDeliverySequence: previous.nextDeliverySequence + 1 });
    return { ...assignment };
  }

  async acknowledge(observerId: string, assignment: DeliveryAssignment): Promise<DeliveryCursor> {
    validAssignment(assignment);
    const persisted = this.#assignments.get(`${observerId}\u0000${assignment.messageId}`);
    if (persisted === undefined || persisted.deliverySequence !== assignment.deliverySequence || persisted.sourceGlobalPosition !== assignment.sourceGlobalPosition) {
      throw new RangeError("Delivery acknowledgement requires a persisted matching assignment.");
    }
    const previous = this.#cursors.get(observerId);
    if (previous === undefined) throw new RangeError("Delivery acknowledgement requires an observer cursor.");
    if (hasAcknowledged(previous, assignment)) throw new RangeError("Delivery message is already acknowledged.");
    const cursor = normalize(observerId, previous.lowWatermark, previous.nextDeliverySequence, [...previous.delivered, assignment]);
    this.#cursors.set(observerId, cursor);
    return copyCursor(cursor);
  }
}

export interface PostgresCursorSession {
  query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly Row[] }>;
}
export interface PostgresCursorQueryClient extends PostgresCursorSession {
  withTransaction<Result>(callback: (session: PostgresCursorSession) => Promise<Result>): Promise<Result>;
}
interface CursorRow extends Record<string, unknown> {
  readonly observer_id: string; readonly low_watermark: number; readonly next_delivery_sequence: number;
  readonly delivery_sequence: number | null; readonly message_id: string | null; readonly source_global_position: number | null;
}
interface AssignmentRow extends Record<string, unknown> {
  readonly delivery_sequence: number;
  readonly message_id: string;
  readonly source_global_position: number;
}

/** PostgreSQL leg; migrations are applied by deployment/CI, never the sim. */
export class PostgresDeliveryCursorStore implements DeliveryCursorStore {
  readonly #client: PostgresCursorQueryClient;
  constructor(client: PostgresCursorQueryClient) { this.#client = client; }

  async read(observerId: string): Promise<DeliveryCursor | undefined> {
    const result = await this.#client.query<CursorRow>(cursorSelect, [observerId]);
    return result.rows.length === 0 ? undefined : deserializeCursor(result.rows);
  }

  async assign(observerId: string, messageId: string, sourceGlobalPosition: number): Promise<DeliveryAssignment> {
    if (messageId.length === 0 || !Number.isSafeInteger(sourceGlobalPosition) || sourceGlobalPosition < 1) throw new RangeError("Delivery assignments require a non-empty message ID and positive source global position.");
    return this.#client.withTransaction(async (session) => {
      await session.query("INSERT INTO delivery_cursors (observer_id) VALUES ($1) ON CONFLICT DO NOTHING", [observerId]);
      const cursor = await session.query<{ readonly next_delivery_sequence: number }>("SELECT next_delivery_sequence::double precision AS next_delivery_sequence FROM delivery_cursors WHERE observer_id = $1 FOR UPDATE", [observerId]);
      const locked = cursor.rows[0];
      if (locked === undefined) throw new Error("Delivery cursor lock returned no cursor.");
      const existing = await session.query<AssignmentRow>("SELECT delivery_sequence::double precision AS delivery_sequence, message_id, source_global_position::double precision AS source_global_position FROM delivery_assignments WHERE observer_id = $1 AND message_id = $2", [observerId, messageId]);
      const known = existing.rows[0];
      if (known !== undefined) {
        if (known.source_global_position !== sourceGlobalPosition) throw new RangeError("Delivery message ID is already assigned to another source position.");
        return { deliverySequence: known.delivery_sequence, messageId: known.message_id, sourceGlobalPosition: known.source_global_position };
      }
      const assignment = { deliverySequence: locked.next_delivery_sequence, messageId, sourceGlobalPosition };
      await session.query("INSERT INTO delivery_assignments (observer_id, delivery_sequence, message_id, source_global_position) VALUES ($1, $2, $3, $4)", [observerId, assignment.deliverySequence, assignment.messageId, assignment.sourceGlobalPosition]);
      await session.query("UPDATE delivery_cursors SET next_delivery_sequence = next_delivery_sequence + 1 WHERE observer_id = $1", [observerId]);
      return assignment;
    });
  }

  async acknowledge(observerId: string, assignment: DeliveryAssignment): Promise<DeliveryCursor> {
    validAssignment(assignment);
    return this.#client.withTransaction(async (session) => {
      const locked = await session.query<CursorRow>(`${cursorSelect} FOR UPDATE OF c`, [observerId]);
      const beforeInsert = deserializeCursor(locked.rows);
      if (hasAcknowledged(beforeInsert, assignment)) throw new RangeError("Delivery message is already acknowledged.");
      const inserted = await session.query<{ readonly observer_id: string }>("INSERT INTO delivery_acknowledgements (observer_id, delivery_sequence) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING observer_id", [observerId, assignment.deliverySequence]);
      if (inserted.rows.length === 0) throw new RangeError("Delivery message is already acknowledged.");
      const rows = await session.query<CursorRow>(cursorSelect, [observerId]);
      const before = deserializeCursor(rows.rows);
      await session.query("UPDATE delivery_cursors SET low_watermark = $2 WHERE observer_id = $1", [observerId, before.lowWatermark]);
      await session.query("DELETE FROM delivery_acknowledgements WHERE observer_id = $1 AND delivery_sequence <= $2", [observerId, before.lowWatermark]);
      const remainder = await session.query<CursorRow>(cursorSelect, [observerId]);
      return deserializeCursor(remainder.rows);
    });
  }
}

const cursorSelect = `SELECT c.observer_id, c.low_watermark::double precision AS low_watermark,
  c.next_delivery_sequence::double precision AS next_delivery_sequence,
  a.delivery_sequence::double precision AS delivery_sequence, d.message_id,
  d.source_global_position::double precision AS source_global_position
  FROM delivery_cursors c LEFT JOIN delivery_acknowledgements a ON a.observer_id = c.observer_id
  LEFT JOIN delivery_assignments d ON d.observer_id = a.observer_id AND d.delivery_sequence = a.delivery_sequence
  WHERE c.observer_id = $1 ORDER BY a.delivery_sequence`;

const deserializeCursor = (rows: readonly CursorRow[]): DeliveryCursor => {
  const first = rows[0];
  if (first === undefined) throw new RangeError("Delivery cursor query returned no rows.");
  const delivered = rows.flatMap((row) => row.delivery_sequence === null || row.message_id === null || row.source_global_position === null ? [] : [{ deliverySequence: row.delivery_sequence, messageId: row.message_id, sourceGlobalPosition: row.source_global_position }]);
  return normalize(first.observer_id, first.low_watermark, first.next_delivery_sequence, delivered);
};
