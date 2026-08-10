import { describe, expect, it } from "vitest";

import { hasAcknowledged, InMemoryDeliveryCursorStore, PostgresDeliveryCursorStore, type PostgresCursorQueryClient, type PostgresCursorSession } from "./delivery-cursor.js";

const assign = (store: import("./delivery-cursor.js").DeliveryCursorStore, sequence: number) =>
  store.assign("hq-player", `message-${sequence}`, sequence * 10);

const assertCursorContract = (makeStore: () => import("./delivery-cursor.js").DeliveryCursorStore): void => {
  it("assigns sequences durably before acknowledgement and compacts only receipts", async () => {
    const store = makeStore();
    const first = await assign(store, 1);
    const second = await assign(store, 2);
    const third = await assign(store, 3);
    expect(await store.read("hq-player")).toMatchObject({ lowWatermark: 0, nextDeliverySequence: 4 });
    await store.acknowledge("hq-player", third);
    await store.acknowledge("hq-player", first);
    expect(await store.read("hq-player")).toMatchObject({ lowWatermark: 1, delivered: [third] });
    await store.acknowledge("hq-player", second);
    expect(await store.read("hq-player")).toEqual({ observerId: "hq-player", lowWatermark: 3, nextDeliverySequence: 4, delivered: [] });
    expect(hasAcknowledged(await store.read("hq-player"), third)).toBe(true);
    expect(await store.assign("hq-player", third.messageId, third.sourceGlobalPosition)).toEqual(third);
    await expect(store.acknowledge("hq-player", third)).rejects.toThrow("already acknowledged");
  });
};

describe("InMemoryDeliveryCursorStore", () => {
  assertCursorContract(() => new InMemoryDeliveryCursorStore());

  it("rejects one message identity assigned to another source position", async () => {
    const store = new InMemoryDeliveryCursorStore();
    await store.assign("hq-player", "message", 10);
    await expect(store.assign("hq-player", "message", 20)).rejects.toThrow("another source position");
  });
});

/** A small stateful SQL double, deliberately exercising the adapter transaction shape. */
const postgresDouble = (): { client: PostgresCursorQueryClient; calls: string[] } => {
  type Assignment = { deliverySequence: number; messageId: string; sourceGlobalPosition: number };
  type State = { cursors: Map<string, { low: number; next: number }>; assignments: Map<string, Assignment[]>; acknowledgements: Map<string, number[]> };
  const copy = (state: State): State => ({ cursors: new Map(state.cursors), assignments: new Map([...state.assignments].map(([key, value]) => [key, value.map((item) => ({ ...item }))])), acknowledgements: new Map([...state.acknowledgements].map(([key, value]) => [key, [...value]])) });
  let committed: State = { cursors: new Map(), assignments: new Map(), acknowledgements: new Map() };
  let transaction: State | undefined;
  const calls: string[] = [];
  const state = (): State => transaction ?? committed;
  const rows = <Row extends Record<string, unknown>>(items: readonly Record<string, unknown>[]) => ({ rows: items as readonly Row[] });
  const cursorRows = (observerId: string) => {
    const cursor = state().cursors.get(observerId); if (cursor === undefined) return [];
    const assigned = state().assignments.get(observerId) ?? []; const acked = state().acknowledgements.get(observerId) ?? [];
    const delivered = assigned.filter((item) => acked.includes(item.deliverySequence));
    return (delivered.length === 0 ? [null] : delivered).map((item) => ({ observer_id: observerId, low_watermark: cursor.low, next_delivery_sequence: cursor.next, delivery_sequence: item?.deliverySequence ?? null, message_id: item?.messageId ?? null, source_global_position: item?.sourceGlobalPosition ?? null }));
  };
  const query: PostgresCursorSession["query"] = async <Row extends Record<string, unknown>>(sql: string, values: readonly unknown[] = []) => {
    calls.push(sql); const observerId = values[0]; if (typeof observerId !== "string") throw new Error("Expected observer ID.");
    if (sql.startsWith("INSERT INTO delivery_cursors")) { state().cursors.set(observerId, state().cursors.get(observerId) ?? { low: 0, next: 1 }); return rows<Row>([]); }
    if (sql.startsWith("SELECT next_delivery_sequence")) { const cursor = state().cursors.get(observerId); return rows<Row>(cursor === undefined ? [] : [{ next_delivery_sequence: cursor.next }]); }
    if (sql.startsWith("SELECT delivery_sequence") && sql.includes("delivery_assignments")) { const item = (state().assignments.get(observerId) ?? []).find((entry) => entry.messageId === values[1]); return rows<Row>(item === undefined ? [] : [{ delivery_sequence: item.deliverySequence, message_id: item.messageId, source_global_position: item.sourceGlobalPosition }]); }
    if (sql.startsWith("INSERT INTO delivery_assignments")) { const item = { deliverySequence: values[1] as number, messageId: values[2] as string, sourceGlobalPosition: values[3] as number }; state().assignments.set(observerId, [...(state().assignments.get(observerId) ?? []), item]); return rows<Row>([]); }
    if (sql.startsWith("UPDATE delivery_cursors SET next")) { const cursor = state().cursors.get(observerId); if (cursor === undefined) throw new Error("missing cursor"); state().cursors.set(observerId, { ...cursor, next: cursor.next + 1 }); return rows<Row>([]); }
    if (sql.startsWith("INSERT INTO delivery_acknowledgements")) { const sequence = values[1] as number; const acked = state().acknowledgements.get(observerId) ?? []; if (acked.includes(sequence)) return rows<Row>([]); state().acknowledgements.set(observerId, [...acked, sequence]); return rows<Row>([{ observer_id: observerId }]); }
    if (sql.startsWith("UPDATE delivery_cursors SET low")) { const cursor = state().cursors.get(observerId); if (cursor === undefined) throw new Error("missing cursor"); state().cursors.set(observerId, { ...cursor, low: values[1] as number }); return rows<Row>([]); }
    if (sql.startsWith("DELETE FROM delivery_acknowledgements")) { const low = values[1] as number; state().acknowledgements.set(observerId, (state().acknowledgements.get(observerId) ?? []).filter((sequence) => sequence > low)); return rows<Row>([]); }
    if (sql.includes("FROM delivery_cursors")) return rows<Row>(cursorRows(observerId));
    throw new Error(`Unexpected SQL: ${sql}`);
  };
  return { calls, client: { query, async withTransaction<Result>(callback: (session: PostgresCursorSession) => Promise<Result>) { transaction = copy(committed); try { const result = await callback({ query }); committed = transaction; return result; } finally { transaction = undefined; } } } };
};

describe("PostgresDeliveryCursorStore", () => {
  assertCursorContract(() => new PostgresDeliveryCursorStore(postgresDouble().client));

  it("allocates with a locked persisted counter and deletes compacted receipts", async () => {
    const database = postgresDouble(); const store = new PostgresDeliveryCursorStore(database.client);
    const first = await assign(store, 1); await store.acknowledge("hq-player", first);
    expect(database.calls.some((sql) => sql.includes("FOR UPDATE"))).toBe(true);
    expect(database.calls.some((sql) => sql.startsWith("DELETE FROM delivery_acknowledgements"))).toBe(true);
  });
});
