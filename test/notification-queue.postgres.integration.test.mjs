import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { simTimeMs } from "../src/sim/clock.js";
import { PostgresNotificationQueueStore } from "../src/host/notification-queue.js";
import { PostgresNotificationInstrumentation, PostgresNotificationPreferenceStore, defaultNotificationPreferences } from "../src/host/notification-product.js";
import { PostgresPushSubscriptionStore } from "../src/host/notification-transport.js";

const databaseUrl = globalThis.process?.env.LONGBURN_TEST_DATABASE_URL;
const integrationDescribe = databaseUrl === undefined || databaseUrl.length === 0 ? describe.skip : describe;
const FIELD_SEPARATOR = "|";

const psqlArray = (values) => `{${values.map((value) => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`).join(",")}}`;

/**
 * The adapter owns its SQL and has no mandated PostgreSQL dependency. This
 * deliberately small real-psql client exercises that SQL against the CI DB.
 */
const psqlClient = {
  async query(sql, values = []) {
    const parameterizedSql = sql.replace(/\$(\d+)/g, (_match, index) => `:'p${index}'`);
    const variables = values.flatMap((value, index) => ["-v", `p${index + 1}=${Array.isArray(value) ? psqlArray(value) : String(value)}`]);
    const result = spawnSync("psql", [
      "--no-psqlrc", "--quiet", "--tuples-only", "--no-align", `--field-separator=${FIELD_SEPARATOR}`,
      "-v", "ON_ERROR_STOP=1", "--dbname", databaseUrl, ...variables
    ], { input: `${parameterizedSql.trimEnd()};\n`, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`psql query failed: ${result.stderr.trim() || "unknown error"}`);
    const lines = result.stdout.trimEnd();
    if (lines.length === 0) return { rows: [] };
    if (sql.includes("FROM notification_queue")) {
      return {
        rows: lines.split("\n").map((line) => {
          const [notification_id, deliver_at_sim_ms, notification, attempts, delivered_at_wall_clock_ms] = line.split(FIELD_SEPARATOR);
          return {
            notification_id,
            deliver_at_sim_ms: Number(deliver_at_sim_ms),
            notification: JSON.parse(notification),
            attempts: Number(attempts),
            delivered_at_wall_clock_ms: delivered_at_wall_clock_ms === "" ? null : Number(delivered_at_wall_clock_ms)
          };
        })
      };
    }
    if (sql.includes("RETURNING notification_id")) return { rows: lines.split("\n").map((notification_id) => ({ notification_id })) };
    if (sql.includes("AS notification_queue_present")) return { rows: [{ notification_queue_present: lines === "t" }] };
    if (sql.includes("AS notification_schema_present")) return { rows: [{ notification_schema_present: lines === "t" }] };
    if (sql.includes("FROM notification_push_subscriptions")) {
      return { rows: lines.split("\n").map((line) => {
        const [endpoint, p256dh, auth] = line.split(FIELD_SEPARATOR);
        return { endpoint, p256dh, auth };
      }) };
    }
    if (sql.includes("FROM notification_preferences")) {
      return { rows: lines.split("\n").map((preferences) => ({ preferences: JSON.parse(preferences) })) };
    }
    if (sql.includes("FROM notification_instrumentation")) {
      return { rows: lines.split("\n").map((line) => {
        const [record_type, notification_id, trigger_class, channel, underlying_event_time_ms, earliest_permissible_instant_ms, wall_clock_ms] = line.split(FIELD_SEPARATOR);
        return {
          record_type, notification_id, trigger_class, channel,
          underlying_event_time_ms: Number(underlying_event_time_ms),
          earliest_permissible_instant_ms: Number(earliest_permissible_instant_ms),
          wall_clock_ms: Number(wall_clock_ms)
        };
      }) };
    }
    throw new Error("psql test client cannot deserialize an unrecognized query shape.");
  }
};

const warning = (nodeId, executeAtMs, deliverAtMs) => ({
  id: `notification:last-revision:${nodeId}:${executeAtMs}`,
  kind: "lastRevisionInstant",
  nodeId,
  deliverAtMs: simTimeMs(deliverAtMs)
});

integrationDescribe(
  "PostgresNotificationQueueStore integration (requires LONGBURN_TEST_DATABASE_URL; intentionally skipped in the Forge sandbox)",
  () => {
    it("exercises migration 0005 and immutable plus reconcilable notification SQL paths", async () => {
      await expect(psqlClient.query("SELECT to_regclass('public.notification_queue') IS NOT NULL AS notification_queue_present"))
        .resolves.toEqual({ rows: [{ notification_queue_present: true }] });

      const store = new PostgresNotificationQueueStore(psqlClient);
      const suffix = randomUUID();
      const report = {
        id: `notification:stream:sol/event:${suffix}/kind:arrival`, kind: "arrival", destination: "mars",
        deliverAtMs: simTimeMs(3_000), sourceGlobalPosition: 1, eventTimeMs: simTimeMs(2_000)
      };
      const later = warning(`later-${suffix}`, 5_000, 4_000);
      const earlier = warning(`earlier-${suffix}`, 3_000, 2_000);

      await store.enqueue(report);
      await store.enqueue({ ...report, deliverAtMs: simTimeMs(1_000) });
      await store.reconcilePendingLastRevisionWarnings([later, earlier]);
      await expect(store.dueAtOrBefore(simTimeMs(4_000))).resolves.toMatchObject([
        { notification: { id: earlier.id }, attempts: 0 },
        { notification: { id: report.id, deliverAtMs: simTimeMs(3_000) }, attempts: 0 },
        { notification: { id: later.id }, attempts: 0 }
      ]);

      await store.recordAttempt(earlier.id);
      await store.markDelivered(earlier.id, 12_345);
      await store.reconcilePendingLastRevisionWarnings([{ ...later, deliverAtMs: simTimeMs(1_000) }]);
      await expect(store.dueAtOrBefore(simTimeMs(4_000))).resolves.toMatchObject([
        { notification: { id: later.id, deliverAtMs: simTimeMs(1_000) } },
        { notification: { id: report.id, deliverAtMs: simTimeMs(3_000) } }
      ]);
      await store.markDelivered(later.id, 12_346);
      await expect(store.dueAtOrBefore(simTimeMs(4_000))).resolves.toMatchObject([
        { notification: { id: report.id } }
      ]);
    });

    it("exercises migrations 0006 through 0008 against Postgres", async () => {
      await expect(psqlClient.query(`
        SELECT (
          to_regclass('public.notification_push_subscriptions') IS NOT NULL
          AND to_regclass('public.notification_instrumentation') IS NOT NULL
          AND to_regclass('public.notification_preferences') IS NOT NULL
        ) AS notification_schema_present
      `)).resolves.toEqual({ rows: [{ notification_schema_present: true }] });

      const suffix = randomUUID();
      const observerId = `observer-${suffix}`;
      const otherObserverId = `other-observer-${suffix}`;
      const first = { endpoint: `https://push.example/${suffix}/a`, p256dh: "first-key", auth: "first-auth" };
      const second = { endpoint: `https://push.example/${suffix}/b`, p256dh: "second-key", auth: "second-auth" };
      const subscriptions = new PostgresPushSubscriptionStore(psqlClient);

      await subscriptions.store(otherObserverId, first);
      await subscriptions.store(observerId, second);
      await subscriptions.store(observerId, { ...first, p256dh: "replaced-key", auth: "replaced-auth" });
      await expect(subscriptions.pushSubscriptionsFor(observerId)).resolves.toEqual([
        { ...first, p256dh: "replaced-key", auth: "replaced-auth" }, second
      ]);
      await expect(subscriptions.pushSubscriptionsFor(otherObserverId)).resolves.toEqual([]);

      const preferences = new PostgresNotificationPreferenceStore(psqlClient);
      const selected = {
        ...defaultNotificationPreferences(),
        channels: { ...defaultNotificationPreferences().channels, N5: "in-app", N6: "email" },
        marketDigest: "daily-digest",
        lastRevisionLeadTimesMs: [7_200_000]
      };
      await expect(preferences.preferencesFor(otherObserverId)).resolves.toEqual(defaultNotificationPreferences());
      await preferences.save(observerId, selected);
      await preferences.save(observerId, { ...selected, channels: { ...selected.channels, N5: "email" } });
      await expect(preferences.preferencesFor(observerId)).resolves.toEqual({
        ...selected, channels: { ...selected.channels, N5: "email" }
      });

      const instrumentation = new PostgresNotificationInstrumentation(psqlClient);
      const notificationId = `notification-${suffix}`;
      await instrumentation.recordOpened(notificationId, 900);
      await instrumentation.record({
        type: "notificationDelivered", notificationId, triggerClass: "N5", channel: "push",
        underlyingEventTimeMs: 500, earliestPermissibleInstantMs: 700, wallClockMs: 800
      });
      await instrumentation.record({
        type: "notificationDelivered", notificationId, triggerClass: "N5", channel: "email",
        underlyingEventTimeMs: 1, earliestPermissibleInstantMs: 2, wallClockMs: 3
      });
      await instrumentation.recordOpened(notificationId, 901);
      await instrumentation.recordOpened(notificationId, 902);
      await expect(psqlClient.query(`
        SELECT record_type, notification_id, trigger_class, channel,
          underlying_event_time_ms, earliest_permissible_instant_ms, wall_clock_ms
        FROM notification_instrumentation WHERE notification_id = $1 ORDER BY record_type
      `, [notificationId])).resolves.toEqual({ rows: [
        {
          record_type: "notificationDelivered", notification_id: notificationId, trigger_class: "N5", channel: "push",
          underlying_event_time_ms: 500, earliest_permissible_instant_ms: 700, wall_clock_ms: 800
        },
        {
          record_type: "notificationOpened", notification_id: notificationId, trigger_class: "N5", channel: "push",
          underlying_event_time_ms: 500, earliest_permissible_instant_ms: 700, wall_clock_ms: 901
        }
      ] });
    });
  }
);
