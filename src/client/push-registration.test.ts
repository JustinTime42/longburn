import { describe, expect, it, vi } from "vitest";

import { registerWebPush } from "./push-registration.js";

const bytes = (...values: number[]): ArrayBuffer => Uint8Array.from(values).buffer;

describe("registerWebPush", () => {
  it("registers the service worker, obtains a subscription, and stores normalized keys", async () => {
    const subscription = { endpoint: "https://push.example.test/subscription", getKey: vi.fn((name: "p256dh" | "auth") => name === "p256dh" ? bytes(1, 2, 3) : bytes(4, 5, 6)) };
    const subscribe = vi.fn(async () => subscription);
    const register = vi.fn(async () => ({ pushManager: { getSubscription: vi.fn(async () => null), subscribe } }));
    const storeSubscription = vi.fn(async () => undefined);

    await expect(registerWebPush({ serviceWorkers: { register }, serviceWorkerUrl: "/push-worker.js", vapidPublicKey: "AQID", storeSubscription }))
      .resolves.toEqual({ endpoint: subscription.endpoint, p256dh: "AQID", auth: "BAUG" });
    expect(register).toHaveBeenCalledWith("/push-worker.js");
    expect(subscribe).toHaveBeenCalledWith({ userVisibleOnly: true, applicationServerKey: Uint8Array.from([1, 2, 3]) });
    expect(storeSubscription).toHaveBeenCalledWith({ endpoint: subscription.endpoint, p256dh: "AQID", auth: "BAUG" });
  });

  it("reuses an existing subscription instead of creating a second browser capability", async () => {
    const subscription = { endpoint: "https://push.example.test/existing", getKey: (name: "p256dh" | "auth") => name === "p256dh" ? bytes(1) : bytes(2) };
    const subscribe = vi.fn();
    const storeSubscription = vi.fn(async () => undefined);

    await registerWebPush({
      serviceWorkers: { register: async () => ({ pushManager: { getSubscription: async () => subscription, subscribe } }) },
      serviceWorkerUrl: "/push-worker.js", vapidPublicKey: "AQ", storeSubscription
    });
    expect(subscribe).not.toHaveBeenCalled();
    expect(storeSubscription).toHaveBeenCalledWith({ endpoint: subscription.endpoint, p256dh: "AQ", auth: "Ag" });
  });
});
