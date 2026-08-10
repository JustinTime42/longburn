import type { SimTimeMs } from "../sim/clock.js";
import type { NotificationMoment } from "../sim/notification-derivation.js";

/** The player-visible classes ratified in notification-surface-v0.1 §1. */
export type NotificationTriggerClass = "N1" | "N2" | "N3" | "N4" | "N5" | "N6";
export type NotificationChannel = "push" | "email" | "in-app" | "off";
export type MarketDigestMode = "immediate" | "daily-digest";

export interface QuietHours {
  /** Minutes after local midnight in the tester's selected UTC offset. */
  readonly startMinute: number;
  readonly endMinute: number;
  readonly utcOffsetMinutes: number;
}

export interface NotificationPreferences {
  readonly channels: Readonly<Record<NotificationTriggerClass, NotificationChannel>>;
  readonly marketDigest: MarketDigestMode;
  readonly quietHours?: QuietHours;
  /** N4 lead times in milliseconds, normally 12 h and 1 h. */
  readonly lastRevisionLeadTimesMs: readonly number[];
}

export const DEFAULT_LAST_REVISION_LEAD_TIMES_MS = [12 * 60 * 60 * 1_000, 60 * 60 * 1_000] as const;

export const defaultNotificationPreferences = (): NotificationPreferences => ({
  channels: { N1: "push", N2: "push", N3: "push", N4: "push", N5: "push", N6: "push" },
  marketDigest: "immediate",
  lastRevisionLeadTimesMs: [...DEFAULT_LAST_REVISION_LEAD_TIMES_MS]
});

export const triggerClassFor = (notification: NotificationMoment): NotificationTriggerClass => {
  switch (notification.kind) {
    case "transferWindowOpened": return "N1";
    case "burnExecuted": return "N2";
    case "revisionApplied":
    case "revisionRefused": return "N3";
    case "lastRevisionInstant": return "N4";
    case "arrival": return "N5";
    case "marketEventOccurred": return "N6";
  }
};

const validMinute = (minute: number): boolean => Number.isSafeInteger(minute) && minute >= 0 && minute < 24 * 60;

export const assertNotificationPreferences = (preferences: NotificationPreferences): NotificationPreferences => {
  for (const trigger of ["N1", "N2", "N3", "N4", "N5", "N6"] as const) {
    const channel = preferences.channels[trigger];
    if (channel !== "push" && channel !== "email" && channel !== "in-app" && channel !== "off") throw new RangeError(`Invalid ${trigger} notification channel.`);
  }
  if (preferences.marketDigest !== "immediate" && preferences.marketDigest !== "daily-digest") throw new RangeError("Invalid market digest mode.");
  if (preferences.lastRevisionLeadTimesMs.length === 0 || new Set(preferences.lastRevisionLeadTimesMs).size !== preferences.lastRevisionLeadTimesMs.length || preferences.lastRevisionLeadTimesMs.some((lead) => !Number.isSafeInteger(lead) || lead <= 0)) {
    throw new RangeError("Last-revision lead times must be distinct positive safe integers.");
  }
  const quiet = preferences.quietHours;
  if (quiet !== undefined && (!validMinute(quiet.startMinute) || !validMinute(quiet.endMinute) || !Number.isSafeInteger(quiet.utcOffsetMinutes) || quiet.utcOffsetMinutes < -12 * 60 || quiet.utcOffsetMinutes > 14 * 60)) {
    throw new RangeError("Quiet hours are invalid.");
  }
  return preferences;
};

export interface NotificationPreferenceStore {
  preferencesFor(observerId: string): Promise<NotificationPreferences>;
  save(observerId: string, preferences: NotificationPreferences): Promise<void>;
}

export class InMemoryNotificationPreferenceStore implements NotificationPreferenceStore {
  readonly #preferences = new Map<string, NotificationPreferences>();
  async preferencesFor(observerId: string): Promise<NotificationPreferences> {
    if (observerId.length === 0) throw new RangeError("Notification observer ID must be non-empty.");
    return this.#preferences.get(observerId) ?? defaultNotificationPreferences();
  }
  async save(observerId: string, preferences: NotificationPreferences): Promise<void> {
    if (observerId.length === 0) throw new RangeError("Notification observer ID must be non-empty.");
    this.#preferences.set(observerId, assertNotificationPreferences(preferences));
  }
}

interface PreferenceRow extends Record<string, unknown> { readonly preferences: NotificationPreferences; }
export interface PostgresNotificationPreferenceClient {
  query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly Row[] }>;
}

export class PostgresNotificationPreferenceStore implements NotificationPreferenceStore {
  readonly #client: PostgresNotificationPreferenceClient;
  constructor(client: PostgresNotificationPreferenceClient) { this.#client = client; }
  async preferencesFor(observerId: string): Promise<NotificationPreferences> {
    if (observerId.length === 0) throw new RangeError("Notification observer ID must be non-empty.");
    const result = await this.#client.query<PreferenceRow>("SELECT preferences FROM notification_preferences WHERE observer_id = $1", [observerId]);
    return result.rows.length === 0 ? defaultNotificationPreferences() : assertNotificationPreferences(result.rows[0]!.preferences);
  }
  async save(observerId: string, preferences: NotificationPreferences): Promise<void> {
    if (observerId.length === 0) throw new RangeError("Notification observer ID must be non-empty.");
    await this.#client.query(
      `INSERT INTO notification_preferences (observer_id, preferences) VALUES ($1, $2::jsonb)
       ON CONFLICT (observer_id) DO UPDATE SET preferences = EXCLUDED.preferences`,
      [observerId, JSON.stringify(assertNotificationPreferences(preferences))]
    );
  }
}

/** Wall-clock policy only. It never enters simulation code or changes causal floors. */
export const isWithinQuietHours = (quietHours: QuietHours | undefined, wallClockMs: number): boolean => {
  if (quietHours === undefined || quietHours.startMinute === quietHours.endMinute) return false;
  if (!Number.isSafeInteger(wallClockMs) || wallClockMs < 0) throw new RangeError("Wall-clock milliseconds must be a non-negative safe integer.");
  const minute = Math.floor((wallClockMs / 60_000 + quietHours.utcOffsetMinutes) % (24 * 60) + (24 * 60)) % (24 * 60);
  return quietHours.startMinute < quietHours.endMinute
    ? minute >= quietHours.startMinute && minute < quietHours.endMinute
    : minute >= quietHours.startMinute || minute < quietHours.endMinute;
};

export type NotificationDeliveryDisposition =
  | { readonly kind: "deliver"; readonly channel: Exclude<NotificationChannel, "off"> }
  | { readonly kind: "defer-quiet-hours" }
  | { readonly kind: "digest" }
  | { readonly kind: "off" };

/** Resolves player choice after the sim-derived earliest-permissible instant. */
export const deliveryDisposition = (notification: NotificationMoment, preferences: NotificationPreferences, wallClockMs: number): NotificationDeliveryDisposition => {
  assertNotificationPreferences(preferences);
  const trigger = triggerClassFor(notification);
  const channel = preferences.channels[trigger];
  if (channel === "off") return { kind: "off" };
  if (isWithinQuietHours(preferences.quietHours, wallClockMs)) return { kind: "defer-quiet-hours" };
  if (trigger === "N6" && preferences.marketDigest === "daily-digest") return { kind: "digest" };
  return { kind: "deliver", channel };
};

export interface NotificationInstrumentationRecord {
  readonly type: "notificationDelivered" | "notificationOpened";
  readonly notificationId: string;
  readonly triggerClass: NotificationTriggerClass;
  readonly channel: Exclude<NotificationChannel, "off">;
  readonly underlyingEventTimeMs: SimTimeMs;
  readonly earliestPermissibleInstantMs: SimTimeMs;
  readonly wallClockMs: number;
}

export interface NotificationInstrumentation {
  record(record: NotificationInstrumentationRecord): Promise<void>;
}

const eventTimeFor = (notification: NotificationMoment): SimTimeMs => "eventTimeMs" in notification ? notification.eventTimeMs : notification.deliverAtMs;

export const deliveredRecord = (notification: NotificationMoment, channel: Exclude<NotificationChannel, "off">, wallClockMs: number): NotificationInstrumentationRecord => ({
  type: "notificationDelivered", notificationId: notification.id, triggerClass: triggerClassFor(notification), channel,
  underlyingEventTimeMs: eventTimeFor(notification), earliestPermissibleInstantMs: notification.deliverAtMs, wallClockMs
});

/**
 * Transport-agnostic copy variables. The host supplies display formatting;
 * this layer keeps the approved words and makes the lag explicit for reports.
 */
export type NotificationCopyContext =
  | { readonly trigger: "N1"; readonly body: string; readonly relativeTime: string; readonly dateRange: string }
  | { readonly trigger: "N2"; readonly ship: string; readonly burnNumber: number; readonly totalBurns: number; readonly eventTime: string; readonly lag: string; readonly deltaV: string }
  | { readonly trigger: "N3"; readonly applied: boolean; readonly burnNumber?: number; readonly eventTime?: string; readonly lag: string; readonly reason?: string }
  | { readonly trigger: "N4"; readonly burnNumber: number; readonly instant: string; readonly countdown: string }
  | { readonly trigger: "N5"; readonly ship: string; readonly body: string; readonly eventTime: string; readonly lag: string }
  | { readonly trigger: "N6"; readonly body: string; readonly lag: string; readonly commodity: string; readonly direction: "surged" | "crashed"; readonly price: string };

export const renderNotificationCopy = (context: NotificationCopyContext): string => {
  switch (context.trigger) {
    case "N1": return `Transfer window to ${context.body} opens ${context.relativeTime}. Departure band ${context.dateRange}.`;
    case "N2": return `Report received: ${context.ship} executed burn ${context.burnNumber} of ${context.totalBurns} at ${context.eventTime} (${context.lag} ago). ${context.deltaV} committed.`;
    case "N3": return context.applied
      ? `Report received: revision to burn ${context.burnNumber} was applied at the ship at ${context.eventTime} (${context.lag} ago).`
      : `Report received: revision refused at the ship — ${context.reason}. Plan unchanged. (${context.lag} ago)`;
    case "N4": return `Last chance approaching: a revision to burn ${context.burnNumber} must leave HQ by ${context.instant} to arrive before execution. ${context.countdown} remaining.`;
    case "N5": return `Report received: ${context.ship} arrived at ${context.body} at ${context.eventTime} (${context.lag} ago).`;
    case "N6": return `Market report from ${context.body} (${context.lag} old): ${context.commodity} ${context.direction} to ${context.price} cr/ton.`;
  }
};

export const openedRecord = (notification: NotificationMoment, channel: Exclude<NotificationChannel, "off">, wallClockMs: number): NotificationInstrumentationRecord => ({
  ...deliveredRecord(notification, channel, wallClockMs), type: "notificationOpened"
});

/** Test/replay sink; production storage is intentionally package-independent. */
export class InMemoryNotificationInstrumentation implements NotificationInstrumentation {
  readonly records: NotificationInstrumentationRecord[] = [];
  async record(record: NotificationInstrumentationRecord): Promise<void> { this.records.push({ ...record }); }
}

export interface PostgresNotificationInstrumentationClient {
  query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly Row[] }>;
}

/** Durable din.10 feed, keyed so a provider retry cannot duplicate a receipt. */
export class PostgresNotificationInstrumentation implements NotificationInstrumentation {
  readonly #client: PostgresNotificationInstrumentationClient;
  constructor(client: PostgresNotificationInstrumentationClient) { this.#client = client; }
  async record(record: NotificationInstrumentationRecord): Promise<void> {
    await this.#client.query(
      `INSERT INTO notification_instrumentation (record_type, notification_id, trigger_class, channel, underlying_event_time_ms, earliest_permissible_instant_ms, wall_clock_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
      [record.type, record.notificationId, record.triggerClass, record.channel, record.underlyingEventTimeMs, record.earliestPermissibleInstantMs, record.wallClockMs]
    );
  }

  /**
   * The notification-open endpoint supplies only its stable ID and wall time.
   * The delivery receipt remains the authority for trigger, channel, and sim
   * timing, so an open cannot forge those telemetry dimensions.
   */
  async recordOpened(notificationId: string, wallClockMs: number): Promise<void> {
    if (notificationId.length === 0 || !Number.isSafeInteger(wallClockMs) || wallClockMs < 0) throw new RangeError("Notification open record is invalid.");
    await this.#client.query(
      `INSERT INTO notification_instrumentation (record_type, notification_id, trigger_class, channel, underlying_event_time_ms, earliest_permissible_instant_ms, wall_clock_ms)
       SELECT 'notificationOpened', notification_id, trigger_class, channel, underlying_event_time_ms, earliest_permissible_instant_ms, $2
         FROM notification_instrumentation WHERE record_type = 'notificationDelivered' AND notification_id = $1
       ON CONFLICT DO NOTHING`, [notificationId, wallClockMs]
    );
  }
}
