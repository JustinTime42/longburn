import { describe, expect, it, vi } from "vitest";

import { installPushNotificationHandler, type BrowserPushEvent } from "./push-service-worker.js";

describe("installPushNotificationHandler", () => {
  it("renders transport-provided push content without deriving new timing or copy", async () => {
    let listener: ((event: BrowserPushEvent) => void) | undefined;
    const showNotification = vi.fn(async () => undefined);
    const worker = { addEventListener: vi.fn((type, callback) => { if (type === "push") listener = callback as (event: BrowserPushEvent) => void; }), showNotification };
    installPushNotificationHandler(worker);
    const waitUntil = vi.fn(async (work: Promise<void>) => work);

    listener?.({ data: { json: () => ({ title: "LONGBURN", body: "Report received.", data: { notificationId: "notification:arrival" } }) }, waitUntil });
    expect(showNotification).toHaveBeenCalledWith("LONGBURN", { body: "Report received.", data: { notificationId: "notification:arrival" } });
    expect(waitUntil).toHaveBeenCalledTimes(1);
    await waitUntil.mock.results[0]?.value;
  });

  it("forwards a clicked stable notification ID to host-side open instrumentation", async () => {
    let click: ((event: import("./push-service-worker.js").BrowserNotificationClickEvent) => void) | undefined;
    const rawAddEventListener = vi.fn((type: string, callback: unknown) => {
      if (type === "notificationclick") click = callback as unknown as typeof click;
    });
    const addEventListener = rawAddEventListener as unknown as import("./push-service-worker.js").BrowserPushWorker["addEventListener"];
    const recordOpened = vi.fn(async () => undefined);
    installPushNotificationHandler({ addEventListener, showNotification: vi.fn(async () => undefined) }, recordOpened);
    const waitUntil = vi.fn(async (work: Promise<void>) => work);
    const close = vi.fn();
    click?.({ notification: { data: { notificationId: "notification:arrival" }, close }, waitUntil });
    expect(close).toHaveBeenCalledTimes(1);
    expect(recordOpened).toHaveBeenCalledWith("notification:arrival");
    await waitUntil.mock.results[0]?.value;
  });

  it("does not render malformed provider payloads", () => {
    let listener: ((event: BrowserPushEvent) => void) | undefined;
    const showNotification = vi.fn(async () => undefined);
    installPushNotificationHandler({ addEventListener: (type, callback) => { if (type === "push") listener = callback as (event: BrowserPushEvent) => void; }, showNotification });

    listener?.({ data: { json: () => ({ title: "LONGBURN" }) }, waitUntil: vi.fn() });
    expect(showNotification).not.toHaveBeenCalled();
  });
});
