import type { NotificationMoment } from "../sim/notification-derivation.js";
import { defaultNotificationPreferences, deliveredRecord, deliveryDisposition, type NotificationInstrumentation, type NotificationPreferenceStore } from "./notification-product.js";

/** The persisted browser capability, normalized away from browser-only types. */
export interface WebPushSubscription {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

/** VAPID material is injected by the host from its deny-listed secret source. */
export interface VapidConfiguration {
  readonly subject: string;
  readonly publicKey: string;
  readonly privateKey: string;
}

/** G4 owns copy; G3 transports the same rendered content on either channel. */
export interface NotificationMessage {
  readonly title: string;
  readonly body: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/** Production adapters own provider-specific HTTP/SMTP clients and credentials. */
export interface WebPushGateway {
  deliver(request: {
    readonly subscription: WebPushSubscription;
    readonly vapid: VapidConfiguration;
    readonly idempotencyKey: string;
    readonly message: NotificationMessage;
  }): Promise<WebPushDeliveryResult>;
}

/**
 * Provider adapters must classify a permanently revoked endpoint separately
 * from a retryable provider failure, so the queue can prune only the former.
 */
export type WebPushDeliveryResult =
  | { readonly delivered: true }
  | { readonly delivered: false; readonly failure: "retryable" | "terminal" };

export interface EmailGateway {
  deliver(request: {
    readonly recipient: string;
    readonly idempotencyKey: string;
    readonly message: NotificationMessage;
  }): Promise<{ readonly delivered: boolean }>;
}

export interface InAppGateway {
  deliver(request: { readonly idempotencyKey: string; readonly message: NotificationMessage }): Promise<{ readonly delivered: boolean }>;
}

/** Preference selection is G4 work; this T0 resolver supplies registered routes. */
export interface NotificationRouteStore {
  pushSubscriptionsFor(observerId: string): Promise<readonly WebPushSubscription[]>;
  removePushSubscription(endpoint: string): Promise<void>;
  emailAddressFor(observerId: string): Promise<string | undefined>;
}

/** Minimal SQL boundary, keeping subscription persistence package-independent. */
export interface PostgresNotificationRouteClient {
  query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<{ readonly rows: readonly Row[] }>;
}

interface PushSubscriptionRow extends Record<string, unknown> {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

/** Durable storage for browser push capabilities; email ownership is host policy. */
export class PostgresPushSubscriptionStore {
  readonly #client: PostgresNotificationRouteClient;

  constructor(client: PostgresNotificationRouteClient) { this.#client = client; }

  async store(observerId: string, subscription: WebPushSubscription): Promise<void> {
    nonEmpty(observerId, "Notification observer ID");
    assertSubscription(subscription);
    await this.#client.query(
      `INSERT INTO notification_push_subscriptions (observer_id, endpoint, p256dh, auth)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE SET observer_id = EXCLUDED.observer_id,
         p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
      [observerId, subscription.endpoint, subscription.p256dh, subscription.auth]
    );
  }

  async pushSubscriptionsFor(observerId: string): Promise<readonly WebPushSubscription[]> {
    nonEmpty(observerId, "Notification observer ID");
    const result = await this.#client.query<PushSubscriptionRow>(
      `SELECT endpoint, p256dh, auth FROM notification_push_subscriptions
       WHERE observer_id = $1 ORDER BY endpoint`, [observerId]
    );
    return result.rows.map((row) => {
      const subscription = { endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth };
      assertSubscription(subscription);
      return subscription;
    });
  }

  async removePushSubscription(endpoint: string): Promise<void> {
    nonEmpty(endpoint, "Push subscription endpoint");
    await this.#client.query("DELETE FROM notification_push_subscriptions WHERE endpoint = $1", [endpoint]);
  }
}

export interface NotificationTransportOptions {
  readonly observerId: string;
  readonly routes: NotificationRouteStore;
  readonly vapid: VapidConfiguration;
  readonly push: WebPushGateway;
  readonly email: EmailGateway;
  readonly render: (notification: NotificationMoment) => NotificationMessage;
  /** Optional while older host composition is migrated to G4's product surface. */
  readonly preferences?: NotificationPreferenceStore;
  readonly instrumentation?: NotificationInstrumentation;
  readonly inApp?: InAppGateway;
}

const nonEmpty = (value: string, label: string): string => {
  if (value.length === 0) throw new RangeError(`${label} must be non-empty.`);
  return value;
};

const validVapid = (vapid: VapidConfiguration): void => {
  nonEmpty(vapid.subject, "VAPID subject");
  nonEmpty(vapid.publicKey, "VAPID public key");
  nonEmpty(vapid.privateKey, "VAPID private key");
};

const assertSubscription = (subscription: WebPushSubscription): void => {
  nonEmpty(subscription.endpoint, "Push subscription endpoint");
  nonEmpty(subscription.p256dh, "Push subscription p256dh key");
  nonEmpty(subscription.auth, "Push subscription auth key");
};

/**
 * G3's intentionally timing-free queue adapter. Push is primary whenever a
 * browser has registered a subscription. A push default with no subscription,
 * or only terminally dead subscriptions, falls back to in-app, never email,
 * so an unchosen channel stays unchosen.
 * A stable queue ID is passed unchanged to either provider for retry safety.
 */
export class NotificationTransport {
  readonly #observerId: string;
  readonly #routes: NotificationRouteStore;
  readonly #vapid: VapidConfiguration;
  readonly #push: WebPushGateway;
  readonly #email: EmailGateway;
  readonly #render: NotificationTransportOptions["render"];
  readonly #preferences: NotificationPreferenceStore | undefined;
  readonly #instrumentation: NotificationInstrumentation | undefined;
  readonly #inApp: InAppGateway | undefined;

  constructor({ observerId, routes, vapid, push, email, render, preferences, instrumentation, inApp }: NotificationTransportOptions) {
    this.#observerId = nonEmpty(observerId, "Notification observer ID");
    validVapid(vapid);
    this.#routes = routes;
    this.#vapid = vapid;
    this.#push = push;
    this.#email = email;
    this.#render = render;
    this.#preferences = preferences;
    this.#instrumentation = instrumentation;
    this.#inApp = inApp;
  }

  async deliver(notification: NotificationMoment, wallClockMs: number = 0): Promise<{ readonly delivered: boolean }> {
    nonEmpty(notification.id, "Notification ID");
    const preferences = this.#preferences === undefined ? defaultNotificationPreferences() : await this.#preferences.preferencesFor(this.#observerId);
    const disposition = deliveryDisposition(notification, preferences, wallClockMs);
    if (disposition.kind === "defer-quiet-hours" || disposition.kind === "digest") return { delivered: false };
    if (disposition.kind === "off") return { delivered: true };
    // The queue-owned stable ID is the only identity the push-click path may
    // report. Renderers provide display data, but cannot omit or replace it.
    const rendered = this.#render(notification);
    const message: NotificationMessage = {
      ...rendered,
      data: { ...rendered.data, notificationId: notification.id }
    };
    let outcome: { readonly delivered: boolean };
    let deliveredChannel = disposition.channel;
    if (disposition.channel === "in-app") {
      outcome = this.#inApp === undefined ? { delivered: false } : await this.#inApp.deliver({ idempotencyKey: notification.id, message });
    } else if (disposition.channel === "push") {
      const subscriptions = await this.#routes.pushSubscriptionsFor(this.#observerId);
      if (subscriptions.length === 0) {
        deliveredChannel = "in-app";
        outcome = this.#inApp === undefined ? { delivered: false } : await this.#inApp.deliver({ idempotencyKey: notification.id, message });
      } else {
        let delivered = false;
        let terminalFailures = 0;
        for (const subscription of subscriptions) {
          const pushOutcome = await this.#push.deliver({ subscription, vapid: this.#vapid, idempotencyKey: notification.id, message });
          if (!pushOutcome.delivered && pushOutcome.failure === "terminal") {
            await this.#routes.removePushSubscription(subscription.endpoint);
            terminalFailures += 1;
          }
          // One device waking is sufficient. Keep trying the remaining routes
          // to prune stale endpoints without changing that delivery outcome.
          delivered ||= pushOutcome.delivered;
        }
        if (terminalFailures === subscriptions.length) {
          deliveredChannel = "in-app";
          outcome = this.#inApp === undefined ? { delivered: false } : await this.#inApp.deliver({ idempotencyKey: notification.id, message });
        } else {
          outcome = { delivered };
        }
      }
    } else {
      const recipient = await this.#routes.emailAddressFor(this.#observerId);
      outcome = recipient === undefined ? { delivered: false } : await this.#email.deliver({ recipient, idempotencyKey: notification.id, message });
    }
    if (outcome.delivered && this.#instrumentation !== undefined) await this.#instrumentation.record(deliveredRecord(notification, deliveredChannel, wallClockMs));
    return outcome;
  }
}
