import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { simTimeMs } from "../src/sim/clock.js";
import { PostgresSimulationEventStore } from "../src/sim/event-store.js";
import { replayPersistedSegment } from "../src/sim/event-log.js";
import { AuthoritativeSimLoop } from "../src/sim/loop.js";

const databaseUrl = globalThis.process?.env.LONGBURN_TEST_DATABASE_URL;
const integrationDescribe = databaseUrl === undefined || databaseUrl.length === 0 ? describe.skip : describe;
// Sim events are structured numeric data, so this delimiter cannot occur in a
// returned field while remaining valid for psql's one-byte separator option.
const FIELD_SEPARATOR = "|";

const runPsql = (arguments_, sql) => new Promise((resolve, reject) => {
  const child = spawn("psql", arguments_, { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("error", reject);
  child.on("close", (exitCode) => {
    if (exitCode === 0) {
      resolve(stdout);
      return;
    }
    reject(new Error(stderr.trim() || `psql exited with status ${exitCode}`));
  });
  child.stdin.end(sql);
});

/**
 * The production adapter deliberately has no mandated PostgreSQL package.
 * This test client uses the host's real psql binary, never a mock or embedded
 * database, and translates the adapter's positional parameters to psql's
 * safely quoted variables.
 */
const psqlClient = {
  async query(sql, values = []) {
    const parameterizedSql = sql.replace(/\$(\d+)/g, (_match, index) => `:'p${index}'`);
    const variables = values.flatMap((value, index) => ["-v", `p${index + 1}=${value == null ? "" : String(value)}`]);
    let stdout;
    try {
      stdout = await runPsql([
        "--no-psqlrc",
        "--quiet",
        "--tuples-only",
        "--no-align",
        `--field-separator=${FIELD_SEPARATOR}`,
        "-v", "ON_ERROR_STOP=1",
        "--dbname", databaseUrl,
        ...variables,
        "--file=-"
      ], parameterizedSql);
    } catch (error) {
      // Do not expose a database URL (which may embed credentials) in test logs.
      const stderr = error instanceof Error ? error.message.trim() : "";
      throw new Error(`psql query failed: ${stderr || "unknown error"}`);
    }

    return { rows: deserializeRows(sql, stdout) };
  }
};

const deserializeRows = (sql, stdout) => {
  const lines = stdout.trimEnd();
  if (lines.length === 0 && !/\b(?:SELECT|RETURNING)\b/i.test(sql)) return [];

  let deserialize;
  if (sql.includes("RETURNING stream_sequence") || sql.includes("SELECT stream_sequence")) {
    deserialize = (fields) => ({
      stream_sequence: fields[0] === "" ? null : Number(fields[0]),
      global_position: fields[1] === "" ? null : Number(fields[1]),
      actual_stream_sequence: fields[2] === "" ? null : Number(fields[2]),
      event_time_ms: fields[3] === "" ? null : Number(fields[3]),
      event_position: fields[4] === "" ? null : JSON.parse(fields[4]),
      event: fields[5] === "" ? null : JSON.parse(fields[5])
    });
  } else if (sql.includes("FROM simulation_streams")) {
    deserialize = (fields) => ({
      stream_id: fields[0],
      seed: Number(fields[1]),
      initial_time_ms: Number(fields[2])
    });
  } else if (sql.includes("AS streams_present")) {
    deserialize = (fields) => ({
      streams_present: fields[0] === "t",
      events_present: fields[1] === "t",
      streams_no_update_trigger_present: fields[2] === "t",
      streams_no_delete_trigger_present: fields[3] === "t",
      streams_no_truncate_trigger_present: fields[4] === "t",
      events_no_update_trigger_present: fields[5] === "t",
      events_no_delete_trigger_present: fields[6] === "t",
      events_no_truncate_trigger_present: fields[7] === "t",
      stream_sequence_unique_present: fields[8] === "t"
    });
  } else {
    throw new Error("psql test client cannot deserialize an unrecognized query shape.");
  }

  if (lines.length === 0) return [];
  return lines.split("\n").map((line) => deserialize(line.split(FIELD_SEPARATOR)));
};

const actionArbitrary = fc.oneof(
  fc.record({ kind: fc.constant("advance"), elapsedMs: fc.integer({ min: 0, max: 10_000 }) }),
  fc.record({ kind: fc.constant("random"), upperExclusive: fc.integer({ min: 1, max: 1_000_000 }) })
);

integrationDescribe(
  "PostgresSimulationEventStore integration (requires LONGBURN_TEST_DATABASE_URL; intentionally skipped in the Forge sandbox)",
  () => {
    it("asserts the migration schema is present before exercising the adapter", async () => {
      await expect(psqlClient.query(`
        SELECT
          to_regclass('public.simulation_streams') IS NOT NULL AS streams_present,
          to_regclass('public.simulation_events') IS NOT NULL AS events_present,
          EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'simulation_streams_no_update' AND NOT tgisinternal) AS streams_no_update_trigger_present,
          EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'simulation_streams_no_delete' AND NOT tgisinternal) AS streams_no_delete_trigger_present,
          EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'simulation_streams_no_truncate' AND NOT tgisinternal) AS streams_no_truncate_trigger_present,
          EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'simulation_events_no_update' AND NOT tgisinternal) AS events_no_update_trigger_present,
          EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'simulation_events_no_delete' AND NOT tgisinternal) AS events_no_delete_trigger_present,
          EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'simulation_events_no_truncate' AND NOT tgisinternal) AS events_no_truncate_trigger_present,
          EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'simulation_events_stream_sequence_unique') AS stream_sequence_unique_present
      `)).resolves.toEqual({
        rows: [{
          streams_present: true,
          events_present: true,
          streams_no_update_trigger_present: true,
          streams_no_delete_trigger_present: true,
          streams_no_truncate_trigger_present: true,
          events_no_update_trigger_present: true,
          events_no_delete_trigger_present: true,
          events_no_truncate_trigger_present: true,
          stream_sequence_unique_present: true
        }]
      });
    });

    it("enforces the two-key sequence and optimistic-concurrency contract", async () => {
      const adapter = new PostgresSimulationEventStore(psqlClient);
      const streamId = `contract-${randomUUID()}`;
      const otherStreamId = `contract-${randomUUID()}`;
      await adapter.createStream({ id: streamId, seed: 0x1234_5678, initialTime: simTimeMs(10) });
      await adapter.createStream({ id: otherStreamId, seed: 0x1234_5678, initialTime: simTimeMs(10) });

      const first = await adapter.append(streamId, {
        event: { type: "clockAdvanced", elapsedMs: 20 },
        eventTime: simTimeMs(30),
        eventPosition: { x: 1, y: 2, z: 3 }
      }, 0);
      const other = await adapter.append(otherStreamId, {
        event: { type: "clockAdvanced", elapsedMs: 10 },
        eventTime: simTimeMs(20),
        eventPosition: { x: 7, y: 8, z: 9 }
      });
      const second = await adapter.append(streamId, {
        event: { type: "randomValueRequested", upperExclusive: 100 },
        eventTime: simTimeMs(30),
        eventPosition: { x: 4, y: 5, z: 6 }
      });

      expect(first).toMatchObject({ kind: "appended", event: { streamSequence: 1 } });
      expect(other).toMatchObject({ kind: "appended", event: { streamSequence: 1 } });
      expect(second).toMatchObject({ kind: "appended", event: { streamSequence: 2 } });
      if (first.kind !== "appended" || other.kind !== "appended" || second.kind !== "appended") {
        throw new Error("Expected contract appends to succeed.");
      }
      expect([first.event.globalPosition, other.event.globalPosition, second.event.globalPosition]).toEqual(
        [...[first.event.globalPosition, other.event.globalPosition, second.event.globalPosition]].sort((a, b) => a - b)
      );
      await expect(adapter.append(streamId, {
        event: { type: "clockAdvanced", elapsedMs: 1 },
        eventTime: simTimeMs(31),
        eventPosition: { x: 0, y: 0, z: 0 }
      }, 0)).resolves.toEqual({ kind: "conflict", expectedStreamSequence: 0, actualStreamSequence: 2 });

      const persisted = await adapter.readStream(streamId);
      expect(persisted).toMatchObject({
        id: streamId,
        seed: 0x1234_5678,
        initialTime: simTimeMs(10),
        events: [
          { event: { type: "clockAdvanced", elapsedMs: 20 }, eventTime: simTimeMs(30), eventPosition: { x: 1, y: 2, z: 3 } },
          { event: { type: "randomValueRequested", upperExclusive: 100 }, eventTime: simTimeMs(30), eventPosition: { x: 4, y: 5, z: 6 } }
        ]
      });
      expect(persisted.events.map((event) => event.streamSequence)).toEqual([1, 2]);
      expect(persisted.events[0]?.globalPosition).toBeLessThan(persisted.events[1]?.globalPosition ?? 0);

      await expect(psqlClient.query(
        "UPDATE simulation_streams SET seed = $1 WHERE stream_id = $2", [1, streamId]
      )).rejects.toThrow("append-only");
      await expect(psqlClient.query(
        "DELETE FROM simulation_events WHERE stream_id = $1", [streamId]
      )).rejects.toThrow("append-only");
      await expect(psqlClient.query("TRUNCATE simulation_events")).rejects.toThrow("append-only");
    });

    it("replays every persisted generated segment identically from its recorded seed", { timeout: 60_000 }, async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.integer({ min: 0, max: 0xffff_ffff }),
          fc.integer({ min: 1, max: 1_000_000 }),
          fc.array(actionArbitrary, { maxLength: 20 }),
          async (seed, initialTime, actions) => {
            const store = new PostgresSimulationEventStore(psqlClient);
            const streamId = `replay-${randomUUID()}`;
            const loop = await AuthoritativeSimLoop.create({
              store, stream: { id: streamId, seed, initialTime: simTimeMs(initialTime) }
            });
            for (const action of actions) {
              if (action.kind === "advance") {
                await loop.advance(action.elapsedMs, { x: 0, y: 0, z: 0 });
              } else {
                await loop.requestRandom(action.upperExclusive, { x: 0, y: 0, z: 0 });
              }
            }
            const persisted = await loop.persistedStream();
            expect(replayPersistedSegment(persisted)).toEqual(loop.state);
            expect((await AuthoritativeSimLoop.resume(store, streamId)).state).toEqual(loop.state);
          }
        ),
        { seed: 0xb0b, numRuns: 25 }
      );
    });
  }
);
