import type { NotificationMessage } from "../host/notification-transport.js";

export interface BrowserPushEvent {
  readonly data: { json(): unknown } | null;
  waitUntil(work: Promise<void>): void;
}

export interface BrowserPushWorker {
  addEventListener(type: "push", listener: (event: BrowserPushEvent) => void): void;
  showNotification(title: string, options: { readonly body: string; readonly data: Readonly<Record<string, unknown>> }): Promise<void>;
}

const messageFrom = (value: unknown): NotificationMessage | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const { title, body, data } = value as Partial<NotificationMessage>;
  return typeof title === "string" && typeof body === "string" && typeof data === "object" && data !== null
    ? { title, body, data }
    : undefined;
};

/** Attaches the worker-side half of web push without giving it sim or queue access. */
export const installPushNotificationHandler = (worker: BrowserPushWorker): void => {
  worker.addEventListener("push", (event) => {
    const message = event.data === null ? undefined : messageFrom(event.data.json());
    if (message !== undefined) event.waitUntil(worker.showNotification(message.title, { body: message.body, data: message.data }));
  });
};
