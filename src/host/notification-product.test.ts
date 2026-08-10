import { describe, expect, it } from "vitest";
import { defaultNotificationPreferences, deliveryDisposition, InMemoryNotificationInstrumentation, InMemoryNotificationPreferenceStore, isWithinQuietHours, openedRecord, PostgresNotificationInstrumentation, renderNotificationCopy } from "./notification-product.js";
import { simTimeMs } from "../sim/clock.js";

const arrival = { id: "notification:arrival", kind: "arrival" as const, destination: "mars" as const, deliverAtMs: simTimeMs(1_000), sourceGlobalPosition: 1, eventTimeMs: simTimeMs(500) };
const market = { id: "notification:market", kind: "marketEventOccurred" as const, commodityId: "ore", price: 5, eventKind: "surge" as const, referencePrice: 4, deliverAtMs: simTimeMs(1_000), sourceGlobalPosition: 1, eventTimeMs: simTimeMs(500) };

describe("notification product preferences", () => {
  it("defaults every wake-capable T0 trigger to push and N6 to immediate", () => {
    expect(defaultNotificationPreferences()).toMatchObject({ channels: { N1: "push", N2: "push", N3: "push", N4: "push", N5: "push", N6: "push" }, marketDigest: "immediate", lastRevisionLeadTimesMs: [43_200_000, 3_600_000] });
  });

  it("defers quiet-hour delivery without moving the causal floor or dropping the notification", () => {
    const preferences = { ...defaultNotificationPreferences(), quietHours: { startMinute: 22 * 60, endMinute: 7 * 60, utcOffsetMinutes: 0 } };
    expect(isWithinQuietHours(preferences.quietHours, 23 * 60 * 60 * 1_000)).toBe(true);
    expect(deliveryDisposition(arrival, preferences, 23 * 60 * 60 * 1_000)).toEqual({ kind: "defer-quiet-hours" });
    expect(deliveryDisposition(arrival, preferences, 8 * 60 * 60 * 1_000)).toEqual({ kind: "deliver", channel: "push" });
  });

  it("makes only N6 digest-eligible and preserves explicit channel choices", () => {
    const preferences = { ...defaultNotificationPreferences(), marketDigest: "daily-digest" as const, channels: { ...defaultNotificationPreferences().channels, N5: "email" as const } };
    expect(deliveryDisposition(market, preferences, 0)).toEqual({ kind: "digest" });
    expect(deliveryDisposition(arrival, preferences, 0)).toEqual({ kind: "deliver", channel: "email" });
  });

  it("stores choices per tester while a fresh tester keeps the designed defaults", async () => {
    const store = new InMemoryNotificationPreferenceStore();
    await store.save("tester-a", { ...defaultNotificationPreferences(), channels: { ...defaultNotificationPreferences().channels, N5: "in-app" } });
    await expect(store.preferencesFor("tester-a")).resolves.toMatchObject({ channels: { N5: "in-app" } });
    await expect(store.preferencesFor("tester-b")).resolves.toMatchObject({ channels: { N5: "push" } });
  });
});

describe("notification instrumentation", () => {
  it("joins opens to delivered IDs with the mandated timing fields", async () => {
    const sink = new InMemoryNotificationInstrumentation();
    await sink.record(openedRecord(arrival, "push", 2_000));
    expect(sink.records).toEqual([{ type: "notificationOpened", notificationId: "notification:arrival", triggerClass: "N5", channel: "push", underlyingEventTimeMs: 500, earliestPermissibleInstantMs: 1_000, wallClockMs: 2_000 }]);
  });

  it("uses a stable receipt insert for the telemetry feed", async () => {
    const query = async () => ({ rows: [] });
    const sink = new PostgresNotificationInstrumentation({ query });
    await expect(sink.record(openedRecord(arrival, "push", 2_000))).resolves.toBeUndefined();
    await expect(sink.recordOpened("notification:arrival", 2_001)).resolves.toBeUndefined();
  });
});

describe("notification copy", () => {
  it("renders the approved c-lagged arrival wording without urgency theater", () => {
    expect(renderNotificationCopy({ trigger: "N5", ship: "Aster", body: "Mars", eventTime: "14:00", lag: "20 minutes" }))
      .toBe("Report received: Aster arrived at Mars at 14:00 (20 minutes ago).");
  });
});
