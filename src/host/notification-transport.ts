import type { NotificationMoment } from "../sim/notification-derivation.js";

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
  }): Promise<{ readonly delivered: boolean }>;
}

export interface EmailGateway {
  deliver(request: {
    readonly recipient: string;
    readonly idempotencyKey: string;
    readonly message: NotificationMessage;
  }): Promise<{ readonly delivered: boolean }>;
}

/** Preference selection is G4 work; this T0 resolver supplies registered routes. */
export interface NotificationRouteStore {
  pushSubscriptionsFor(observerId: string): Promise<readonly WebPushSubscription[]>;
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
}

export interface NotificationTransportOptions {
  readonly observerId: string;
  readonly routes: NotificationRouteStore;
  readonly vapid: VapidConfiguration;
  readonly push: WebPushGateway;
  readonly email: EmailGateway;
  readonly render: (notification: NotificationMoment) => NotificationMessage;
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
 * browser has registered a subscription; email is for testers who have none.
 * A stable queue ID is passed unchanged to either provider for retry safety.
 */
export class NotificationTransport {
  readonly #observerId: string;
  readonly #routes: NotificationRouteStore;
  readonly #vapid: VapidConfiguration;
  readonly #push: WebPushGateway;
  readonly #email: EmailGateway;
  readonly #render: NotificationTransportOptions["render"];

  constructor({ observerId, routes, vapid, push, email, render }: NotificationTransportOptions) {
    this.#observerId = nonEmpty(observerId, "Notification observer ID");
    validVapid(vapid);
    this.#routes = routes;
    this.#vapid = vapid;
    this.#push = push;
    this.#email = email;
    this.#render = render;
  }

  async deliver(notification: NotificationMoment): Promise<{ readonly delivered: boolean }> {
    nonEmpty(notification.id, "Notification ID");
    const message = this.#render(notification);
    const subscriptions = await this.#routes.pushSubscriptionsFor(this.#observerId);
    if (subscriptions.length > 0) {
      let delivered = false;
      for (const subscription of subscriptions) {
        const outcome = await this.#push.deliver({ subscription, vapid: this.#vapid, idempotencyKey: notification.id, message });
        delivered ||= outcome.delivered;
      }
      return { delivered };
    }

    const recipient = await this.#routes.emailAddressFor(this.#observerId);
    return recipient === undefined
      ? { delivered: false }
      : this.#email.deliver({ recipient, idempotencyKey: notification.id, message });
  }
}
