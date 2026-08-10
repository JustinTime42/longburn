import { describe, expect, it, vi } from "vitest";

import { simTimeMs } from "../sim/clock.js";
import { NotificationTransport, PostgresPushSubscriptionStore, type NotificationMessage, type PostgresNotificationRouteClient, type WebPushSubscription } from "./notification-transport.js";

const notification = { id: "notification:arrival", kind: "arrival" as const, destination: "mars" as const, deliverAtMs: simTimeMs(1_000), sourceGlobalPosition: 1, eventTimeMs: simTimeMs(500) };
const subscription: WebPushSubscription = { endpoint: "https://push.example.test/subscription", p256dh: "public", auth: "auth" };
const message: NotificationMessage = { title: "LONGBURN", body: "Report received.", data: { route: "/flight" } };

const buildTransport = ({ subscriptions = [] as readonly WebPushSubscription[], emailAddress }: { readonly subscriptions?: readonly WebPushSubscription[]; readonly emailAddress?: string } = {}) => {
  const routes = { pushSubscriptionsFor: vi.fn(async () => subscriptions), emailAddressFor: vi.fn(async () => emailAddress) };
  const push = { deliver: vi.fn(async () => ({ delivered: true as const })) };
  const email = { deliver: vi.fn(async () => ({ delivered: true as const })) };
  return {
    transport: new NotificationTransport({
      observerId: "tester-1", routes,
      vapid: { subject: "mailto:ops@example.test", publicKey: "public-key", privateKey: "private-key" },
      push, email, render: () => message
    }), routes, push, email
  };
};

describe("NotificationTransport", () => {
  it("uses every registered web-push subscription before considering email", async () => {
    const second = { ...subscription, endpoint: "https://push.example.test/second" };
    const { transport, routes, push, email } = buildTransport({ subscriptions: [subscription, second], emailAddress: "tester@example.test" });

    await expect(transport.deliver(notification)).resolves.toEqual({ delivered: true });
    expect(push.deliver).toHaveBeenCalledTimes(2);
    expect(push.deliver).toHaveBeenNthCalledWith(1, { subscription, vapid: { subject: "mailto:ops@example.test", publicKey: "public-key", privateKey: "private-key" }, idempotencyKey: notification.id, message });
    expect(push.deliver).toHaveBeenNthCalledWith(2, expect.objectContaining({ subscription: second, idempotencyKey: notification.id, message }));
    expect(routes.emailAddressFor).not.toHaveBeenCalled();
    expect(email.deliver).not.toHaveBeenCalled();
  });

  it("uses email only for a tester without a push subscription", async () => {
    const { transport, push, email } = buildTransport({ emailAddress: "tester@example.test" });

    await expect(transport.deliver(notification)).resolves.toEqual({ delivered: true });
    expect(push.deliver).not.toHaveBeenCalled();
    expect(email.deliver).toHaveBeenCalledWith({ recipient: "tester@example.test", idempotencyKey: notification.id, message });
  });

  it("leaves the queue retryable when the tester has no registered route", async () => {
    const { transport, push, email } = buildTransport();

    await expect(transport.deliver(notification)).resolves.toEqual({ delivered: false });
    expect(push.deliver).not.toHaveBeenCalled();
    expect(email.deliver).not.toHaveBeenCalled();
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
