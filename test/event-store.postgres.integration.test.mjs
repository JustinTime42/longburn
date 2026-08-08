import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { simTimeMs } from "../src/sim/clock.js";
import { PostgresDeliveryCursorStore } from "../src/sim/delivery-cursor.js";
import { PostgresSimulationEventStore } from "../src/sim/event-store.js";
import { replayPersistedSegment } from "../src/sim/event-log.js";
import { AuthoritativeSimLoop } from "../src/sim/loop.js";

const databaseUrl = globalThis.process?.env.LONGBURN_TEST_DATABASE_URL;
const integrationDescribe = databaseUrl === undefined || databaseUrl.length === 0 ? describe.skip : describe;
// Sim events are structured numeric data, so this delimiter cannot occur in a
// returned field while remaining valid for psql's one-byte separator option.
const FIELD_SEPARATOR = "|";

const sanitizePsqlError = (error) => {
  // Do not expose a database URL (which may embed credentials) in test logs.
  const stderr = error instanceof Error ? error.message.trim() : "";
  const sanitized = new Error(`psql query failed: ${stderr || "unknown error"}`);
  if (stderr.includes('duplicate key value violates unique constraint "simulation_events_stream_sequence_unique"')) {
    Object.assign(sanitized, {
      code: "23505",
      constraint: "simulation_events_stream_sequence_unique"
    });
  }
  return sanitized;
};

/**
 * The production adapter deliberately has no mandated PostgreSQL package.
 * This test client uses the host's real psql binary, never a mock or embedded
 * database, and translates the adapter's positional parameters to psql's
 * safely quoted variables.
 */
const createPsqlSession = () => {
  const child = spawn("psql", [
    "--no-psqlrc",
    "--quiet",
    "--tuples-only",
    "--no-align",
    `--field-separator=${FIELD_SEPARATOR}`,
    "-v", "ON_ERROR_STOP=1",
    "--dbname", databaseUrl
  ], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let closed = false;
  let pending;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (pending === undefined) return;
    const markerIndex = stdout.indexOf(pending.marker);
    if (markerIndex === -1) return;
    const completed = pending;
    const queryOutput = stdout.slice(0, markerIndex);
    stdout = stdout.slice(markerIndex + completed.marker.length).replace(/^\r?\n/, "");
    pending = undefined;
    completed.resolve(queryOutput);
  });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const rejectPending = (error) => {
    if (pending !== undefined) {
      pending.reject(error);
      pending = undefined;
    }
  };
  child.on("error", rejectPending);
  child.on("close", (exitCode) => {
    closed = true;
    if (exitCode !== 0) rejectPending(new Error(stderr.trim() || `psql exited with status ${exitCode}`));
  });
  const query = async (sql, values = []) => {
    const parameterizedSql = sql.replace(/\$(\d+)/g, (_match, index) => (
      values[Number(index) - 1] == null ? "NULL" : `:'p${index}'`
    ));
    const variableCommands = values.flatMap((value, index) => (
      value == null ? [] : [`\\set p${index + 1} '${String(value).replaceAll("'", "''")}'`]
    ));
    if (closed || pending !== undefined) throw new Error("psql session is unavailable for this query.");
    const marker = `__LONGBURN_PSQL_${randomUUID()}__`;
    const output = await new Promise((resolve, reject) => {
      pending = { marker, resolve, reject };
      child.stdin.write(`${variableCommands.join("\n")}\n${parameterizedSql}\n\\echo ${marker}\n`);
    });
    return { rows: deserializeRows(sql, output) };
  };
  return {
    query,
    async close() {
      if (closed) return;
      closed = true;
      child.stdin.end("\\q\n");
    }
  };
};

const psqlClient = {
  async query(sql, values = []) {
    const session = createPsqlSession();
    try {
      return await session.query(sql, values);
    } catch (error) {
      throw sanitizePsqlError(error);
    } finally {
      await session.close();
    }
  },
  async withTransaction(callback) {
    const session = createPsqlSession();
    try {
      await session.query("BEGIN");
      const result = await callback(session);
      await session.query("COMMIT");
      return result;
    } catch (error) {
      try {
        await session.query("ROLLBACK");
      } catch {
        // The original error is the useful transaction failure.
      }
      throw error;
    } finally {
      await session.close();
    }
  }
};

const deserializeRows = (sql, stdout) => {
  const lines = stdout.trimEnd();
  if (lines.length === 0 && !/\b(?:SELECT|RETURNING)\b/i.test(sql)) return [];

  let deserialize;
  if (sql.includes("RETURNING stream_sequence") || sql.includes("SELECT stream_sequence")) {
    deserialize = (fields) => {
      if (fields.length !== 6) {
        throw new Error(`Expected 6 event fields from psql, received ${fields.length}.`);
      }
      return {
        stream_sequence: fields[0] === "" ? null : Number(fields[0]),
        global_position: fields[1] === "" ? null : Number(fields[1]),
        actual_stream_sequence: fields[2] === "" ? null : Number(fields[2]),
        event_time_ms: fields[3] === "" ? null : Number(fields[3]),
        event_position: fields[4] === "" ? null : JSON.parse(fields[4]),
        event: fields[5] === "" ? null : JSON.parse(fields[5])
      };
    };
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
  } else if (sql.includes("AS delivery_cursors_present")) {
    deserialize = (fields) => ({
      delivery_cursors_present: fields[0] === "t",
      delivery_acknowledgements_present: fields[1] === "t"
    });
  } else if (sql.includes("INSERT INTO delivery_acknowledgements")) {
    deserialize = (fields) => {
      if (fields.length !== 1) {
        throw new Error(`Expected acknowledgement insert to return one field, received ${fields.length}.`);
      }
      return { observer_id: fields[0] };
    };
  } else if (sql.includes("FROM delivery_cursors")) {
    deserialize = (fields) => {
      if (fields.length !== 4) {
        throw new Error(`Expected 4 delivery cursor fields from psql, received ${fields.length}.`);
      }
      return {
        observer_id: fields[0],
        low_watermark: Number(fields[1]),
        global_position: fields[2] === "" ? null : Number(fields[2]),
        message_id: fields[3] === "" ? null : fields[3]
      };
    };
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
          EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'simulation_streams_no_update' AND NOT tgisinternal AND tgenabled = 'O') AS streams_no_update_trigger_present,
          EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'simulation_streams_no_delete' AND NOT tgisinternal AND tgenabled = 'O') AS streams_no_delete_trigger_present,
          EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'simulation_streams_no_truncate' AND NOT tgisinternal AND tgenabled = 'O') AS streams_no_truncate_trigger_present,
          EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'simulation_events_no_update' AND NOT tgisinternal AND tgenabled = 'O') AS events_no_update_trigger_present,
          EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'simulation_events_no_delete' AND NOT tgisinternal AND tgenabled = 'O') AS events_no_delete_trigger_present,
          EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'simulation_events_no_truncate' AND NOT tgisinternal AND tgenabled = 'O') AS events_no_truncate_trigger_present,
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

    it("persists acknowledgement ledgers with SQL NULL empty remainders", async () => {
      await expect(psqlClient.query(`
        SELECT
          to_regclass('public.delivery_cursors') IS NOT NULL AS delivery_cursors_present,
          to_regclass('public.delivery_acknowledgements') IS NOT NULL AS delivery_acknowledgements_present
      `)).resolves.toEqual({
        rows: [{ delivery_cursors_present: true, delivery_acknowledgements_present: true }]
      });
      const store = new PostgresDeliveryCursorStore(psqlClient);
      const observerId = `delivery-${randomUUID()}`;
      await expect(store.read(observerId)).resolves.toBeUndefined();
      await expect(store.acknowledge(observerId, { globalPosition: 3, messageId: "message-3" })).resolves.toEqual({
        observerId, lowWatermark: 0, delivered: [{ globalPosition: 3, messageId: "message-3" }]
      });
      await store.acknowledge(observerId, { globalPosition: 1, messageId: "message-1" });
      await expect(store.acknowledge(observerId, { globalPosition: 2, messageId: "message-2" })).resolves.toEqual({
        observerId, lowWatermark: 3, delivered: []
      });
      await expect(store.read(observerId)).resolves.toEqual({ observerId, lowWatermark: 3, delivered: [] });
      await expect(store.acknowledge(observerId, { globalPosition: 3, messageId: "message-3" })).rejects.toThrow("already acknowledged");
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

      const raceStreamId = `contract-race-${randomUUID()}`;
      await adapter.createStream({ id: raceStreamId, seed: 1, initialTime: simTimeMs(0) });
      const raced = await Promise.all([
        adapter.append(raceStreamId, {
          event: { type: "clockAdvanced", elapsedMs: 1 },
          eventTime: simTimeMs(1),
          eventPosition: { x: 0, y: 0, z: 0 }
        }, 0),
        adapter.append(raceStreamId, {
          event: { type: "clockAdvanced", elapsedMs: 2 },
          eventTime: simTimeMs(2),
          eventPosition: { x: 0, y: 0, z: 0 }
        }, 0)
      ]);
      expect(raced.map((result) => result.kind).sort()).toEqual(["appended", "conflict"]);
      expect(raced.find((result) => result.kind === "conflict")).toEqual({
        kind: "conflict", expectedStreamSequence: 0, actualStreamSequence: 1
      });

      await expect(adapter.append(`missing-${randomUUID()}`, {
        event: { type: "clockAdvanced", elapsedMs: 1 },
        eventTime: simTimeMs(1),
        eventPosition: { x: 0, y: 0, z: 0 }
      })).rejects.toThrow("Unknown simulation stream");
      await expect(adapter.append(`missing-${randomUUID()}`, {
        event: { type: "clockAdvanced", elapsedMs: 1 },
        eventTime: simTimeMs(1),
        eventPosition: { x: 0, y: 0, z: 0 }
      }, 0)).rejects.toThrow("Unknown simulation stream");

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
                await loop.advance(action.elapsedMs, () => ({ x: 0, y: 0, z: 0 }));
              } else {
                await loop.requestRandom(action.upperExclusive, () => ({ x: 0, y: 0, z: 0 }));
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
