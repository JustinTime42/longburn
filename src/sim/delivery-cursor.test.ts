import { describe, expect, it } from "vitest";

import { hasAcknowledged, InMemoryDeliveryCursorStore, PostgresDeliveryCursorStore, type PostgresCursorQueryClient } from "./delivery-cursor.js";

const acknowledgement = (globalPosition: number, messageId = `message-${globalPosition}`) => ({ globalPosition, messageId });

const assertCursorContract = (makeStore: () => import("./delivery-cursor.js").DeliveryCursorStore): void => {
  it("starts empty, preserves sparse delivered messages, and compacts a contiguous prefix", async () => {
    const store = makeStore();
    expect(await store.read("hq-player")).toBeUndefined();
    await store.acknowledge("hq-player", acknowledgement(3));
    expect(await store.read("hq-player")).toEqual({ observerId: "hq-player", lowWatermark: 0, delivered: [acknowledgement(3)] });
    await store.acknowledge("hq-player", acknowledgement(1));
    expect(await store.read("hq-player")).toEqual({ observerId: "hq-player", lowWatermark: 1, delivered: [acknowledgement(3)] });
    await store.acknowledge("hq-player", acknowledgement(2));
    const compacted = await store.read("hq-player");
    expect(compacted).toEqual({ observerId: "hq-player", lowWatermark: 3, delivered: [] });
    expect(hasAcknowledged(compacted, acknowledgement(3))).toBe(true);
    await expect(store.acknowledge("hq-player", acknowledgement(3))).rejects.toThrow("already acknowledged");
  });
};

describe("InMemoryDeliveryCursorStore", () => {
  assertCursorContract(() => new InMemoryDeliveryCursorStore());
});

const postgresCursorDouble = (): {
  readonly client: PostgresCursorQueryClient;
  readonly calls: { sql: string; values: readonly unknown[] | undefined }[];
} => {
  type StoredAcknowledgement = { readonly globalPosition: number; readonly messageId: string };
  type State = { cursors: Map<string, number>; acknowledgements: Map<string, StoredAcknowledgement[]> };
  const copyState = (state: State): State => ({
    cursors: new Map(state.cursors),
    acknowledgements: new Map([...state.acknowledgements].map(([observerId, acknowledgements]) => [observerId, acknowledgements.map((acknowledgement) => ({ ...acknowledgement }))]))
  });
  let committed: State = { cursors: new Map(), acknowledgements: new Map() };
  let transaction: State | undefined;
  const calls: { sql: string; values: readonly unknown[] | undefined }[] = [];
  const result = <Row extends Record<string, unknown>>(rows: readonly Record<string, unknown>[]): { readonly rows: readonly Row[] } => ({
    rows: rows as readonly Row[]
  });
  const state = (): State => transaction ?? committed;
  const cursorRows = (observerId: string): Record<string, unknown>[] => {
    const lowWatermark = state().cursors.get(observerId);
    if (lowWatermark === undefined) return [];
    const acknowledgements = state().acknowledgements.get(observerId) ?? [];
    return acknowledgements.length === 0
      ? [{ observer_id: observerId, low_watermark: lowWatermark, global_position: null, message_id: null }]
      : acknowledgements.sort((a, b) => a.globalPosition - b.globalPosition).map((acknowledgement) => ({
        observer_id: observerId,
        low_watermark: lowWatermark,
        global_position: acknowledgement.globalPosition,
        message_id: acknowledgement.messageId
      }));
  };
  const client: PostgresCursorQueryClient = {
    async query<Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) {
      calls.push({ sql, values });
      if (sql === "BEGIN") {
        transaction = copyState(committed);
        return result<Row>([]);
      }
      if (sql === "COMMIT") {
        if (transaction === undefined) throw new Error("COMMIT without BEGIN");
        committed = transaction;
        transaction = undefined;
        return result<Row>([]);
      }
      if (sql === "ROLLBACK") {
        transaction = undefined;
        return result<Row>([]);
      }
      const observerId = values?.[0];
      if (typeof observerId !== "string") throw new Error("Expected observer ID.");
      if (sql.includes("INSERT INTO delivery_acknowledgements")) {
        const globalPosition = values?.[1];
        const messageId = values?.[2];
        if (typeof globalPosition !== "number" || typeof messageId !== "string") throw new Error("Expected acknowledgement values.");
        const acknowledgements = state().acknowledgements.get(observerId) ?? [];
        if (acknowledgements.some((acknowledgement) => acknowledgement.globalPosition === globalPosition || acknowledgement.messageId === messageId)) {
          return result<Row>([]);
        }
        state().acknowledgements.set(observerId, [...acknowledgements, { globalPosition, messageId }]);
        return result<Row>([{ observer_id: observerId }]);
      }
      if (sql.includes("INSERT INTO delivery_cursors")) {
        state().cursors.set(observerId, state().cursors.get(observerId) ?? 0);
        return result<Row>([]);
      }
      if (sql.startsWith("UPDATE delivery_cursors")) {
        const lowWatermark = values?.[1];
        if (typeof lowWatermark !== "number") throw new Error("Expected low watermark.");
        state().cursors.set(observerId, lowWatermark);
        return result<Row>([]);
      }
      if (sql.startsWith("DELETE FROM delivery_acknowledgements")) {
        const lowWatermark = values?.[1];
        if (typeof lowWatermark !== "number") throw new Error("Expected low watermark.");
        state().acknowledgements.set(observerId, (state().acknowledgements.get(observerId) ?? []).filter(
          (acknowledgement) => acknowledgement.globalPosition > lowWatermark
        ));
        return result<Row>([]);
      }
      if (sql.includes("FROM delivery_cursors")) return result<Row>(cursorRows(observerId));
      throw new Error(`Unexpected SQL: ${sql}`);
    }
  };
  return { client, calls };
};

describe("PostgresDeliveryCursorStore", () => {
  assertCursorContract(() => new PostgresDeliveryCursorStore(postgresCursorDouble().client));

  it("acknowledges with ordinary transactional statements and rolls back duplicates", async () => {
    const database = postgresCursorDouble();
    const store = new PostgresDeliveryCursorStore(database.client);
    await store.acknowledge("hq-player", acknowledgement(1));
    await expect(store.acknowledge("hq-player", acknowledgement(1))).rejects.toThrow("already acknowledged");
    expect(database.calls.map(({ sql }) => sql)).toContain("BEGIN");
    expect(database.calls.some(({ sql }) => sql.includes("FOR UPDATE OF c"))).toBe(true);
    expect(database.calls.some(({ sql }) => sql.startsWith("DELETE FROM delivery_acknowledgements"))).toBe(true);
    expect(database.calls.filter(({ sql }) => sql === "COMMIT")).toHaveLength(1);
    expect(database.calls.filter(({ sql }) => sql === "ROLLBACK")).toHaveLength(1);
    expect(database.calls.some(({ sql }) => sql.includes("WITH RECURSIVE"))).toBe(false);
  });
});
