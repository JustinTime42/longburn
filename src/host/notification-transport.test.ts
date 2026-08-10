import { describe, expect, it, vi } from "vitest";

import { simTimeMs } from "../sim/clock.js";
import { NotificationTransport, PostgresPushSubscriptionStore, type NotificationMessage, type PostgresNotificationRouteClient, type WebPushGateway, type WebPushSubscription } from "./notification-transport.js";
import { defaultNotificationPreferences, InMemoryNotificationPreferenceStore, PostgresNotificationInstrumentation, type PostgresNotificationInstrumentationClient } from "./notification-product.js";
import { installPushNotificationHandler, type BrowserNotificationClickEvent, type BrowserPushEvent, type BrowserPushWorker } from "../client/push-service-worker.js";

const notification = { id: "notification:arrival", kind: "arrival" as const, destination: "mars" as const, deliverAtMs: simTimeMs(1_000), sourceGlobalPosition: 1, eventTimeMs: simTimeMs(500) };
const subscription: WebPushSubscription = { endpoint: "https://push.example.test/subscription", p256dh: "public", auth: "auth" };
const message: NotificationMessage = { title: "LONGBURN", body: "Report received.", data: { route: "/flight", notificationId: "renderer-controlled" } };
const transportMessage: NotificationMessage = { ...message, data: { ...message.data, notificationId: notification.id } };

const buildTransport = ({ subscriptions = [] as readonly WebPushSubscription[], emailAddress, emailPreference = false, instrumentation }: { readonly subscriptions?: readonly WebPushSubscription[]; readonly emailAddress?: string; readonly emailPreference?: boolean; readonly instrumentation?: PostgresNotificationInstrumentation } = {}) => {
  const routes = { pushSubscriptionsFor: vi.fn(async () => subscriptions), emailAddressFor: vi.fn(async () => emailAddress) };
  const push = { deliver: vi.fn(async () => ({ delivered: true as const })) };
  const email = { deliver: vi.fn(async () => ({ delivered: true as const })) };
  const preferences = new InMemoryNotificationPreferenceStore();
  const configured = emailPreference ? preferences.save("tester-1", { ...defaultNotificationPreferences(), channels: { ...defaultNotificationPreferences().channels, N5: "email" } }) : Promise.resolve();
  return {
    transport: new NotificationTransport({
      observerId: "tester-1", routes,
      vapid: { subject: "mailto:ops@example.test", publicKey: "public-key", privateKey: "private-key" },
      push, email, render: () => message, preferences, instrumentation
    }), routes, push, email, configured
  };
};

describe("NotificationTransport", () => {
  it("uses every registered web-push subscription before considering email", async () => {
    const second = { ...subscription, endpoint: "https://push.example.test/second" };
    const { transport, routes, push, email } = buildTransport({ subscriptions: [subscription, second], emailAddress: "tester@example.test" });

    await expect(transport.deliver(notification)).resolves.toEqual({ delivered: true });
    expect(push.deliver).toHaveBeenCalledTimes(2);
    expect(push.deliver).toHaveBeenNthCalledWith(1, { subscription, vapid: { subject: "mailto:ops@example.test", publicKey: "public-key", privateKey: "private-key" }, idempotencyKey: notification.id, message: transportMessage });
    expect(push.deliver).toHaveBeenNthCalledWith(2, expect.objectContaining({ subscription: second, idempotencyKey: notification.id, message: transportMessage }));
    expect(routes.emailAddressFor).not.toHaveBeenCalled();
    expect(email.deliver).not.toHaveBeenCalled();
  });

  it("uses email only for a tester without a push subscription", async () => {
    const { transport, push, email, configured } = buildTransport({ emailAddress: "tester@example.test", emailPreference: true });
    await configured;

    await expect(transport.deliver(notification)).resolves.toEqual({ delivered: true });
    expect(push.deliver).not.toHaveBeenCalled();
    expect(email.deliver).toHaveBeenCalledWith({ recipient: "tester@example.test", idempotencyKey: notification.id, message: transportMessage });
  });

  it("leaves the queue retryable when the tester has no registered route", async () => {
    const { transport, push, email } = buildTransport();

    await expect(transport.deliver(notification)).resolves.toEqual({ delivered: false });
    expect(push.deliver).not.toHaveBeenCalled();
    expect(email.deliver).not.toHaveBeenCalled();
  });

  it("injects the queue-owned ID through push click into the durable anti-forgery open receipt", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const instrumentation = new PostgresNotificationInstrumentation({ query: query as unknown as PostgresNotificationInstrumentationClient["query"] });
    const { transport, push } = buildTransport({ subscriptions: [subscription], instrumentation });

    await expect(transport.deliver(notification, 2_000)).resolves.toEqual({ delivered: true });
    const pushCalls = (push.deliver as unknown as { readonly mock: { readonly calls: readonly (readonly [Parameters<WebPushGateway["deliver"]>[0]])[] } }).mock.calls;
    const deliveredMessage = pushCalls[0]?.[0].message;
    expect(deliveredMessage).toEqual(transportMessage);
    if (deliveredMessage === undefined) throw new Error("Expected a delivered push message.");

    let onPush: ((event: BrowserPushEvent) => void) | undefined;
    let onClick: ((event: BrowserNotificationClickEvent) => void) | undefined;
    const addEventListener = ((type: "push" | "notificationclick", listener: unknown) => {
      if (type === "push") onPush = listener as (event: BrowserPushEvent) => void;
      else onClick = listener as (event: BrowserNotificationClickEvent) => void;
    }) as BrowserPushWorker["addEventListener"];
    const showNotification = vi.fn(async () => undefined);
    installPushNotificationHandler({ addEventListener, showNotification }, (notificationId) => instrumentation.recordOpened(notificationId, 3_000));
    const pushWaitUntil = vi.fn(async (work: Promise<void>) => work);
    onPush?.({ data: { json: () => deliveredMessage }, waitUntil: pushWaitUntil });
    await pushWaitUntil.mock.results[0]?.value;

    const shownCalls = (showNotification as unknown as { readonly mock: { readonly calls: readonly (readonly [string, Parameters<BrowserPushWorker["showNotification"]>[1]])[] } }).mock.calls;
    const shownData = shownCalls[0]?.[1].data;
    expect(shownData).toEqual(transportMessage.data);
    if (shownData === undefined) throw new Error("Expected a shown push notification.");
    const close = vi.fn();
    const clickWaitUntil = vi.fn(async (work: Promise<void>) => work);
    onClick?.({ notification: { data: shownData, close }, waitUntil: clickWaitUntil });
    await clickWaitUntil.mock.results[0]?.value;

    expect(close).toHaveBeenCalledOnce();
    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining("VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING"), ["notificationDelivered", notification.id, "N5", "push", 500, 1_000, 2_000]);
    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining("SELECT 'notificationOpened', notification_id, trigger_class, channel"), [notification.id, 3_000]);
    const queryCalls = query.mock.calls as unknown as readonly (readonly [string, ReadonlyArray<unknown> | undefined])[];
    expect(queryCalls[1]?.[0]).toContain("WHERE record_type = 'notificationDelivered' AND notification_id = $1");
  });
});

describe("PostgresPushSubscriptionStore", () => {
  it("upserts a browser capability and reads an observer's ordered subscriptions", async () => {
    const query = vi.fn(async (sql: string) => sql.includes("SELECT")
      ? { rows: [{ endpoint: subscription.endpoint, p256dh: subscription.p256dh, auth: subscription.auth }] }
      : { rows: [] });
    const store = new PostgresPushSubscriptionStore({ query: query as unknown as PostgresNotificationRouteClient["query"] });

    await store.store("tester-1", subscription);
    await expect(store.pushSubscriptionsFor("tester-1")).resolves.toEqual([subscription]);
    expect(query).toHaveBeenNthCalledWith(1, expect.stringContaining("ON CONFLICT (endpoint)"), ["tester-1", subscription.endpoint, subscription.p256dh, subscription.auth]);
    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining("ORDER BY endpoint"), ["tester-1"]);
  });
});
