import type { NotificationMessage } from "../host/notification-transport.js";

export interface BrowserPushEvent {
  readonly data: { json(): unknown } | null;
  waitUntil(work: Promise<void>): void;
}

export interface BrowserPushWorker {
  addEventListener(type: "push", listener: (event: BrowserPushEvent) => void): void;
  addEventListener(type: "notificationclick", listener: (event: BrowserNotificationClickEvent) => void): void;
  showNotification(title: string, options: { readonly body: string; readonly data: Readonly<Record<string, unknown>> }): Promise<void>;
}

export interface BrowserNotificationClickEvent {
  readonly notification: { readonly data: Readonly<Record<string, unknown>>; close(): void };
  waitUntil(work: Promise<void>): void;
}

const messageFrom = (value: unknown): NotificationMessage | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const { title, body, data } = value as Partial<NotificationMessage>;
  return typeof title === "string" && typeof body === "string" && typeof data === "object" && data !== null
    ? { title, body, data }
    : undefined;
};

/** Attaches the worker-side half of web push without giving it sim or queue access. */
/** The client shell posts this stable ID to the host's `recordOpened` hook. */
export const installPushNotificationHandler = (worker: BrowserPushWorker, recordOpened: (notificationId: string) => Promise<void> = async () => undefined): void => {
  worker.addEventListener("push", (event) => {
    const message = event.data === null ? undefined : messageFrom(event.data.json());
    if (message !== undefined) event.waitUntil(worker.showNotification(message.title, { body: message.body, data: message.data }));
  });
  worker.addEventListener("notificationclick", (event) => {
    const notificationId = event.notification.data.notificationId;
    event.notification.close();
    if (typeof notificationId === "string" && notificationId.length > 0) event.waitUntil(recordOpened(notificationId));
  });
};
