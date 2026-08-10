import { describe, expect, it, vi } from "vitest";

import { installPushNotificationHandler, type BrowserPushEvent } from "./push-service-worker.js";

describe("installPushNotificationHandler", () => {
  it("renders transport-provided push content without deriving new timing or copy", async () => {
    let listener: ((event: BrowserPushEvent) => void) | undefined;
    const showNotification = vi.fn(async () => undefined);
    const worker = { addEventListener: vi.fn((_type: "push", callback: (event: BrowserPushEvent) => void) => { listener = callback; }), showNotification };
    installPushNotificationHandler(worker);
    const waitUntil = vi.fn(async (work: Promise<void>) => work);

    listener?.({ data: { json: () => ({ title: "LONGBURN", body: "Report received.", data: { notificationId: "notification:arrival" } }) }, waitUntil });
    expect(showNotification).toHaveBeenCalledWith("LONGBURN", { body: "Report received.", data: { notificationId: "notification:arrival" } });
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntil.mock.results[0]?.value;
  });

  it("does not render malformed provider payloads", () => {
    let listener: ((event: BrowserPushEvent) => void) | undefined;
    const showNotification = vi.fn(async () => undefined);
    installPushNotificationHandler({ addEventListener: (_type, callback) => { listener = callback; }, showNotification });

    listener?.({ data: { json: () => ({ title: "LONGBURN" }) }, waitUntil: vi.fn() });
    expect(showNotification).not.toHaveBeenCalled();
  });
});
