import { describe, expect, it } from "vitest";

import { InMemoryDeliveryCursorStore, PostgresDeliveryCursorStore, type PostgresCursorQueryClient } from "./delivery-cursor.js";

const cursor = (globalPosition: number, messageId = `message-${globalPosition}`) => ({ observerId: "hq-player", globalPosition, messageId });

const assertCursorContract = (makeStore: () => import("./delivery-cursor.js").DeliveryCursorStore): void => {
  it("starts empty, persists copies, and rejects non-monotone acknowledgements", async () => {
    const store = makeStore();
    expect(await store.read("hq-player")).toBeUndefined();
    await store.advance(cursor(10));
    const observed = await store.read("hq-player");
    expect(observed).toEqual(cursor(10));
    if (observed === undefined) throw new Error("Expected persisted cursor.");
    (observed as { messageId: string }).messageId = "mutated";
    expect(await store.read("hq-player")).toEqual(cursor(10));
    await expect(store.advance(cursor(10))).rejects.toThrow("monotonically");
    await expect(store.advance(cursor(9))).rejects.toThrow("monotonically");
    await store.advance(cursor(14));
    expect(await store.read("hq-player")).toEqual(cursor(14));
  });
};

describe("InMemoryDeliveryCursorStore", () => {
  assertCursorContract(() => new InMemoryDeliveryCursorStore());
});

describe("PostgresDeliveryCursorStore", () => {
  assertCursorContract(() => {
    const rows = new Map<string, { observer_id: string; global_position: number; message_id: string }>();
    const client: PostgresCursorQueryClient = {
      query: <Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
        const observerId = values?.[0] as string;
        if (sql.startsWith("SELECT")) {
          const row = rows.get(observerId);
          return Promise.resolve({ rows: (row === undefined ? [] : [row]) as unknown as readonly Row[] });
        }
        const globalPosition = values?.[1] as number;
        const messageId = values?.[2] as string;
        const previous = rows.get(observerId);
        if (previous !== undefined && previous.global_position >= globalPosition) return Promise.resolve({ rows: [] });
        const row = { observer_id: observerId, global_position: globalPosition, message_id: messageId };
        rows.set(observerId, row);
        return Promise.resolve({ rows: [row] as unknown as readonly Row[] });
      }
    };
    return new PostgresDeliveryCursorStore(client);
  });

  it("uses a compare-and-advance upsert and rejects stale acknowledgement", async () => {
    const calls: { sql: string; values: readonly unknown[] | undefined }[] = [];
    const client: PostgresCursorQueryClient = {
      query: <Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
        calls.push({ sql, values });
        if (sql.startsWith("SELECT")) return Promise.resolve({ rows: [] as readonly Row[] });
        const rows = calls.length === 1
          ? [{ observer_id: "hq-player", global_position: 10, message_id: "message-10" }]
          : [];
        return Promise.resolve({ rows: rows as unknown as readonly Row[] });
      }
    };
    const store = new PostgresDeliveryCursorStore(client);
    await store.advance(cursor(10));
    await expect(store.advance(cursor(10))).rejects.toThrow("monotonically");
    expect(calls[0]?.sql).toContain("ON CONFLICT (observer_id) DO UPDATE");
    expect(calls[0]?.sql).toContain("global_position < EXCLUDED.global_position");
    expect(calls[0]?.values).toEqual(["hq-player", 10, "message-10"]);
  });
});
