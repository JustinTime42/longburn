import type { WebPushSubscription } from "../host/notification-transport.js";

export interface BrowserPushSubscription {
  readonly endpoint: string;
  getKey(name: "p256dh" | "auth"): ArrayBuffer | null;
}

export interface BrowserPushManager {
  getSubscription(): Promise<BrowserPushSubscription | null>;
  subscribe(options: { readonly userVisibleOnly: true; readonly applicationServerKey: Uint8Array }): Promise<BrowserPushSubscription>;
}

export interface BrowserServiceWorkerRegistration {
  readonly pushManager: BrowserPushManager;
}

export interface BrowserServiceWorkers {
  register(scriptUrl: string): Promise<BrowserServiceWorkerRegistration>;
}

export interface RegisterPushOptions {
  readonly serviceWorkers: BrowserServiceWorkers;
  readonly serviceWorkerUrl: string;
  readonly vapidPublicKey: string;
  readonly storeSubscription: (subscription: WebPushSubscription) => Promise<void>;
}

const base64UrlBytes = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new RangeError("VAPID public key must be unpadded base64url.");
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const decoded = atob(base64.padEnd(base64.length + ((4 - base64.length % 4) % 4), "="));
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
};

const encoded = (key: ArrayBuffer | null, name: string): string => {
  if (key === null) throw new RangeError(`Push subscription is missing ${name}.`);
  let binary = "";
  for (const byte of new Uint8Array(key)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

/** Registers the T0 service worker and persists a browser's push capability. */
export const registerWebPush = async ({ serviceWorkers, serviceWorkerUrl, vapidPublicKey, storeSubscription }: RegisterPushOptions): Promise<WebPushSubscription> => {
  if (serviceWorkerUrl.length === 0) throw new RangeError("Service-worker URL must be non-empty.");
  const registration = await serviceWorkers.register(serviceWorkerUrl);
  const subscription = await registration.pushManager.getSubscription()
    ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlBytes(vapidPublicKey) });
  const normalized = { endpoint: subscription.endpoint, p256dh: encoded(subscription.getKey("p256dh"), "p256dh"), auth: encoded(subscription.getKey("auth"), "auth") };
  await storeSubscription(normalized);
  return normalized;
};
