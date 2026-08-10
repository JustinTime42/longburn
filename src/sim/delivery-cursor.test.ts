import { describe, expect, it } from "vitest";

import { hasAcknowledged, InMemoryDeliveryCursorStore, PostgresDeliveryCursorStore, type PostgresCursorQueryClient, type PostgresCursorSession } from "./delivery-cursor.js";

const acknowledgement = (deliverySequence: number, messageId = `message-${deliverySequence}`, sourceGlobalPosition = deliverySequence) => ({ deliverySequence, messageId, sourceGlobalPosition });

const assertCursorContract = (makeStore: () => import("./delivery-cursor.js").DeliveryCursorStore): void => {
  it("starts empty, preserves sparse delivered messages, and compacts a contiguous prefix", async () => {
    const store = makeStore();
    expect(await store.read("hq-player")).toBeUndefined();
    await store.acknowledge("hq-player", acknowledgement(3));
    expect(await store.read("hq-player")).toEqual({ observerId: "hq-player", lowWatermark: 0, acknowledgedThroughPosition: 3, delivered: [acknowledgement(3)] });
    await store.acknowledge("hq-player", acknowledgement(1));
    expect(await store.read("hq-player")).toEqual({ observerId: "hq-player", lowWatermark: 1, acknowledgedThroughPosition: 3, delivered: [acknowledgement(3)] });
    await store.acknowledge("hq-player", acknowledgement(2));
    const compacted = await store.read("hq-player");
    expect(compacted).toEqual({ observerId: "hq-player", lowWatermark: 3, acknowledgedThroughPosition: 3, delivered: [] });
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
  readonly transactions: { committed: boolean }[];
} => {
  type StoredAcknowledgement = { readonly deliverySequence: number; readonly messageId: string; readonly sourceGlobalPosition: number };
  type StoredCursor = { readonly lowWatermark: number; readonly acknowledgedThroughPosition: number };
  type State = { cursors: Map<string, StoredCursor>; acknowledgements: Map<string, StoredAcknowledgement[]> };
  const copyState = (state: State): State => ({
    cursors: new Map(state.cursors),
    acknowledgements: new Map([...state.acknowledgements].map(([observerId, acknowledgements]) => [observerId, acknowledgements.map((acknowledgement) => ({ ...acknowledgement }))]))
  });
  let committed: State = { cursors: new Map(), acknowledgements: new Map() };
  let transaction: State | undefined;
  const calls: { sql: string; values: readonly unknown[] | undefined }[] = [];
  const transactions: { committed: boolean }[] = [];
  const result = <Row extends Record<string, unknown>>(rows: readonly Record<string, unknown>[]): { readonly rows: readonly Row[] } => ({
    rows: rows as readonly Row[]
  });
  const state = (): State => transaction ?? committed;
  const cursorRows = (observerId: string): Record<string, unknown>[] => {
    const cursor = state().cursors.get(observerId);
    if (cursor === undefined) return [];
    const acknowledgements = state().acknowledgements.get(observerId) ?? [];
    return acknowledgements.length === 0
      ? [{ observer_id: observerId, low_watermark: cursor.lowWatermark, acknowledged_through_position: cursor.acknowledgedThroughPosition, delivery_sequence: null, message_id: null, source_global_position: null }]
      : acknowledgements.sort((a, b) => a.deliverySequence - b.deliverySequence).map((acknowledgement) => ({
        observer_id: observerId,
        low_watermark: cursor.lowWatermark,
        acknowledged_through_position: cursor.acknowledgedThroughPosition,
        delivery_sequence: acknowledgement.deliverySequence,
        message_id: acknowledgement.messageId,
        source_global_position: acknowledgement.sourceGlobalPosition
      }));
  };
  const query: PostgresCursorSession["query"] = async <Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
      calls.push({ sql, values });
      const observerId = values?.[0];
      if (typeof observerId !== "string") throw new Error("Expected observer ID.");
      if (sql.includes("INSERT INTO delivery_acknowledgements")) {
        const deliverySequence = values?.[1];
        const messageId = values?.[2];
        const sourceGlobalPosition = values?.[3];
        if (typeof deliverySequence !== "number" || typeof messageId !== "string" || typeof sourceGlobalPosition !== "number") throw new Error("Expected acknowledgement values.");
        const acknowledgements = state().acknowledgements.get(observerId) ?? [];
        if (acknowledgements.some((acknowledgement) => acknowledgement.deliverySequence === deliverySequence || acknowledgement.messageId === messageId)) {
          return result<Row>([]);
        }
        state().acknowledgements.set(observerId, [...acknowledgements, { deliverySequence, messageId, sourceGlobalPosition }]);
        return result<Row>([{ observer_id: observerId }]);
      }
      if (sql.includes("INSERT INTO delivery_cursors")) {
        state().cursors.set(observerId, state().cursors.get(observerId) ?? { lowWatermark: 0, acknowledgedThroughPosition: 0 });
        return result<Row>([]);
      }
      if (sql.startsWith("UPDATE delivery_cursors")) {
        const lowWatermark = values?.[1];
        const acknowledgedThroughPosition = values?.[2];
        if (typeof lowWatermark !== "number" || typeof acknowledgedThroughPosition !== "number") throw new Error("Expected cursor watermarks.");
        const cursor = state().cursors.get(observerId);
        if (cursor === undefined) throw new Error("Expected cursor before update.");
        state().cursors.set(observerId, { lowWatermark, acknowledgedThroughPosition: Math.max(cursor.acknowledgedThroughPosition, acknowledgedThroughPosition) });
        return result<Row>([]);
      }
      if (sql.startsWith("DELETE FROM delivery_acknowledgements")) {
        const lowWatermark = values?.[1];
        if (typeof lowWatermark !== "number") throw new Error("Expected low watermark.");
        state().acknowledgements.set(observerId, (state().acknowledgements.get(observerId) ?? []).filter(
          (acknowledgement) => acknowledgement.deliverySequence > lowWatermark
        ));
        return result<Row>([]);
      }
      if (sql.includes("FROM delivery_cursors")) return result<Row>(cursorRows(observerId));
      throw new Error(`Unexpected SQL: ${sql}`);
  };
  const client: PostgresCursorQueryClient = {
    query,
    async withTransaction<Result>(callback: (session: PostgresCursorSession) => Promise<Result>): Promise<Result> {
      if (transaction !== undefined) throw new Error("Nested cursor transactions are unsupported.");
      transaction = copyState(committed);
      const record = { committed: false };
      transactions.push(record);
      try {
        const value = await callback({ query });
        committed = transaction;
        record.committed = true;
        return value;
      } finally {
        transaction = undefined;
      }
    }
  };
  return { client, calls, transactions };
};

describe("PostgresDeliveryCursorStore", () => {
  assertCursorContract(() => new PostgresDeliveryCursorStore(postgresCursorDouble().client));

  it("retains the highest immutable source position across sparse acknowledgements", async () => {
    const store = new PostgresDeliveryCursorStore(postgresCursorDouble().client);
    await store.acknowledge("hq-player", acknowledgement(3, "message-3", 30));
    await store.acknowledge("hq-player", acknowledgement(1, "message-1", 10));
    await expect(store.acknowledge("hq-player", acknowledgement(2, "message-2", 20))).resolves.toMatchObject({
      lowWatermark: 3, acknowledgedThroughPosition: 30, delivered: []
    });
  });

  it("acknowledges through one transaction-bound session and rolls back duplicates", async () => {
    const database = postgresCursorDouble();
    const store = new PostgresDeliveryCursorStore(database.client);
    await store.acknowledge("hq-player", acknowledgement(1));
    await expect(store.acknowledge("hq-player", acknowledgement(1))).rejects.toThrow("already acknowledged");
    expect(database.calls.some(({ sql }) => sql.includes("FOR UPDATE OF c"))).toBe(true);
    expect(database.calls.some(({ sql }) => sql.startsWith("DELETE FROM delivery_acknowledgements"))).toBe(true);
    expect(database.transactions).toEqual([{ committed: true }, { committed: false }]);
    expect(database.calls.some(({ sql }) => sql.includes("WITH RECURSIVE"))).toBe(false);
  });
});
