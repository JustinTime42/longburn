import type { SimTimeMs } from "../sim/clock.js";
import type { NotificationMoment } from "../sim/notification-derivation.js";

/** Maps host-wall time through the durable 1:1 world anchor (longburn-9j0). */
export interface WallClockToSimTime {
  simTimeAt(wallClockMs: number): SimTimeMs;
}

export interface QueuedNotification {
  readonly notification: NotificationMoment;
  readonly attempts: number;
  readonly deliveredAtWallClockMs: number | undefined;
}

/**
 * Durable queue boundary. `enqueue` is keyed by G1's stable notification ID;
 * delivered rows intentionally remain retained until din.11 decides retention
 * and compaction policy.
 */
export interface NotificationQueueStore {
  /** First-write-wins for immutable report notifications. */
  enqueue(notification: NotificationMoment): Promise<void>;
  /**
   * Reconciles the complete current set of planner-local last-revision
   * warnings. Pending rows may move; delivered rows remain immutable records.
   */
  reconcilePendingLastRevisionWarnings(warnings: readonly NotificationMoment[]): Promise<void>;
  dueAtOrBefore(nowMs: SimTimeMs): Promise<readonly QueuedNotification[]>;
  recordAttempt(id: string): Promise<void>;
  markDelivered(id: string, deliveredAtWallClockMs: number): Promise<void>;
}

const validWallClockMs = (value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError("Wall-clock milliseconds must be a non-negative safe integer.");
};

const copy = (item: QueuedNotification): QueuedNotification => ({ ...item, notification: { ...item.notification } });

/** Deterministic reference queue for host tests and replay fixtures. */
export class InMemoryNotificationQueueStore implements NotificationQueueStore {
  readonly #items = new Map<string, QueuedNotification>();

  async enqueue(notification: NotificationMoment): Promise<void> {
    if (notification.id.length === 0) throw new RangeError("Notifications require a non-empty stable ID.");
    if (!this.#items.has(notification.id)) this.#items.set(notification.id, { notification: { ...notification }, attempts: 0, deliveredAtWallClockMs: undefined });
  }

  async reconcilePendingLastRevisionWarnings(warnings: readonly NotificationMoment[]): Promise<void> {
    const warningIds = new Set(warnings.map((warning) => {
      this.#assertLastRevisionWarning(warning);
      return warning.id;
    }));
    for (const warning of warnings) {
      const existing = this.#items.get(warning.id);
      if (existing?.deliveredAtWallClockMs === undefined) {
        this.#items.set(warning.id, { notification: { ...warning }, attempts: existing?.attempts ?? 0, deliveredAtWallClockMs: undefined });
      }
    }
    for (const [id, item] of this.#items) {
      if (id.startsWith(LAST_REVISION_ID_PREFIX) && item.deliveredAtWallClockMs === undefined && !warningIds.has(id)) this.#items.delete(id);
    }
  }

  async dueAtOrBefore(nowMs: SimTimeMs): Promise<readonly QueuedNotification[]> {
    return [...this.#items.values()]
      .filter((item) => item.deliveredAtWallClockMs === undefined && item.notification.deliverAtMs <= nowMs)
      .sort((left, right) => left.notification.deliverAtMs - right.notification.deliverAtMs || left.notification.id.localeCompare(right.notification.id))
      .map(copy);
  }

  async recordAttempt(id: string): Promise<void> {
    const item = this.#required(id);
    if (item.deliveredAtWallClockMs !== undefined) throw new RangeError("Cannot retry a delivered notification.");
    this.#items.set(id, { ...item, attempts: item.attempts + 1 });
  }

  async markDelivered(id: string, deliveredAtWallClockMs: number): Promise<void> {
    validWallClockMs(deliveredAtWallClockMs);
    const item = this.#required(id);
    if (item.deliveredAtWallClockMs !== undefined) return;
    this.#items.set(id, { ...item, deliveredAtWallClockMs });
  }

  #required(id: string): QueuedNotification {
    const item = this.#items.get(id);
    if (item === undefined) throw new RangeError("Unknown notification ID.");
    return item;
  }

  #assertLastRevisionWarning(notification: NotificationMoment): void {
    if (notification.kind !== "lastRevisionInstant" || !notification.id.startsWith(LAST_REVISION_ID_PREFIX)) {
      throw new RangeError("Only last-revision warnings can be reconciled.");
    }
  }
}

const LAST_REVISION_ID_PREFIX = "notification:last-revision:";

interface NotificationQueueRow extends Record<string, unknown> {
  readonly notification_id: string;
  readonly deliver_at_sim_ms: number;
  readonly notification: NotificationMoment;
  readonly attempts: number;
  readonly delivered_at_wall_clock_ms: number | null;
}

/** Minimal query boundary, keeping the production adapter independent of a DB package. */
export interface PostgresNotificationQueueClient {
  query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly Row[] }>;
}

/** PostgreSQL durable queue. Migration application remains deployment/CI work. */
export class PostgresNotificationQueueStore implements NotificationQueueStore {
  readonly #client: PostgresNotificationQueueClient;

  constructor(client: PostgresNotificationQueueClient) { this.#client = client; }

  async enqueue(notification: NotificationMoment): Promise<void> {
    if (notification.id.length === 0) throw new RangeError("Notifications require a non-empty stable ID.");
    await this.#client.query(
      `INSERT INTO notification_queue (notification_id, deliver_at_sim_ms, notification)
       VALUES ($1, $2, $3::jsonb) ON CONFLICT (notification_id) DO NOTHING`,
      [notification.id, notification.deliverAtMs, JSON.stringify(notification)]
    );
  }

  async reconcilePendingLastRevisionWarnings(warnings: readonly NotificationMoment[]): Promise<void> {
    for (const warning of warnings) {
      assertLastRevisionWarning(warning);
      await this.#client.query(
        `INSERT INTO notification_queue (notification_id, deliver_at_sim_ms, notification)
         VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (notification_id) DO UPDATE
           SET deliver_at_sim_ms = EXCLUDED.deliver_at_sim_ms, notification = EXCLUDED.notification
         WHERE notification_queue.delivered_at_wall_clock_ms IS NULL`,
        [warning.id, warning.deliverAtMs, JSON.stringify(warning)]
      );
    }
    await this.#client.query(
      `DELETE FROM notification_queue
        WHERE notification_id LIKE $1 AND delivered_at_wall_clock_ms IS NULL
          AND notification_id <> ALL($2::text[])`,
      [`${LAST_REVISION_ID_PREFIX}%`, warnings.map((warning) => warning.id)]
    );
  }

  async dueAtOrBefore(nowMs: SimTimeMs): Promise<readonly QueuedNotification[]> {
    const result = await this.#client.query<NotificationQueueRow>(
      `SELECT notification_id, deliver_at_sim_ms::double precision AS deliver_at_sim_ms,
              notification, attempts::double precision AS attempts,
              delivered_at_wall_clock_ms::double precision AS delivered_at_wall_clock_ms
         FROM notification_queue
        WHERE delivered_at_wall_clock_ms IS NULL AND deliver_at_sim_ms <= $1
        ORDER BY deliver_at_sim_ms, notification_id`, [nowMs]
    );
    return result.rows.map(deserialize);
  }

  async recordAttempt(id: string): Promise<void> {
    const result = await this.#client.query<{ readonly notification_id: string }>(
      "UPDATE notification_queue SET attempts = attempts + 1 WHERE notification_id = $1 AND delivered_at_wall_clock_ms IS NULL RETURNING notification_id", [id]
    );
    if (result.rows.length === 0) throw new RangeError("Notification is unknown or already delivered.");
  }

  async markDelivered(id: string, deliveredAtWallClockMs: number): Promise<void> {
    validWallClockMs(deliveredAtWallClockMs);
    await this.#client.query(
      "UPDATE notification_queue SET delivered_at_wall_clock_ms = $2 WHERE notification_id = $1 AND delivered_at_wall_clock_ms IS NULL", [id, deliveredAtWallClockMs]
    );
  }
}

const deserialize = (row: NotificationQueueRow): QueuedNotification => {
  if (row.notification_id.length === 0 || !Number.isSafeInteger(row.deliver_at_sim_ms) ||
    !Number.isSafeInteger(row.attempts) || row.attempts < 0 || row.notification.id !== row.notification_id ||
    row.notification.deliverAtMs !== row.deliver_at_sim_ms) throw new RangeError("Persisted notification queue row is invalid.");
  if (row.delivered_at_wall_clock_ms !== null) validWallClockMs(row.delivered_at_wall_clock_ms);
  return { notification: { ...row.notification }, attempts: row.attempts, deliveredAtWallClockMs: row.delivered_at_wall_clock_ms ?? undefined };
};

const assertLastRevisionWarning = (notification: NotificationMoment): void => {
  if (notification.kind !== "lastRevisionInstant" || !notification.id.startsWith(LAST_REVISION_ID_PREFIX)) {
    throw new RangeError("Only last-revision warnings can be reconciled.");
  }
};

export interface NotificationQueueOptions {
  readonly store: NotificationQueueStore;
  readonly wallClockToSimTime: WallClockToSimTime;
  /** A transport adapter receives only G1-derived, causally lawful moments. */
  readonly deliver: (notification: NotificationMoment) => Promise<{ readonly delivered: boolean }>;
}

export interface NotificationQueueRunResult {
  readonly nowMs: SimTimeMs;
  readonly delivered: readonly string[];
  readonly retrying: readonly string[];
}

/**
 * Host-side retry worker. Callers serialize `run` for one queue; a process
 * crash after send and before acknowledgement deliberately retries the same
 * stable ID, which the transport must use as its idempotency key.
 */
export class NotificationQueue {
  readonly #store: NotificationQueueStore;
  readonly #wallClockToSimTime: WallClockToSimTime;
  readonly #deliver: NotificationQueueOptions["deliver"];

  constructor({ store, wallClockToSimTime, deliver }: NotificationQueueOptions) {
    this.#store = store;
    this.#wallClockToSimTime = wallClockToSimTime;
    this.#deliver = deliver;
  }

  async enqueue(notifications: readonly NotificationMoment[]): Promise<void> {
    for (const notification of notifications) {
      if (notification.id.startsWith(LAST_REVISION_ID_PREFIX)) {
        throw new RangeError("Last-revision warnings must be reconciled, not enqueued.");
      }
    }
    for (const notification of notifications) await this.#store.enqueue(notification);
  }

  async run(wallClockMs: number): Promise<NotificationQueueRunResult> {
    validWallClockMs(wallClockMs);
    const nowMs = this.#wallClockToSimTime.simTimeAt(wallClockMs);
    const delivered: string[] = [];
    const retrying: string[] = [];
    for (const item of await this.#store.dueAtOrBefore(nowMs)) {
      await this.#store.recordAttempt(item.notification.id);
      const result = await this.#deliver(item.notification);
      if (result.delivered) {
        await this.#store.markDelivered(item.notification.id, wallClockMs);
        delivered.push(item.notification.id);
      } else {
        retrying.push(item.notification.id);
      }
    }
    return { nowMs, delivered, retrying };
  }
}
