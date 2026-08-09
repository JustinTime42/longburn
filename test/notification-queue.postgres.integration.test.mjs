import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { simTimeMs } from "../src/sim/clock.js";
import { PostgresNotificationQueueStore } from "../src/host/notification-queue.js";

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
  }
);
