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

describe("PostgresDeliveryCursorStore", () => {
  it("uses a per-message acknowledgement query and rejects a duplicate acknowledgement", async () => {
    const calls: { sql: string; values: readonly unknown[] | undefined }[] = [];
    const client: PostgresCursorQueryClient = {
      query: <Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
        calls.push({ sql, values });
        if (calls.length === 1) return Promise.resolve({ rows: [{ observer_id: "hq-player", low_watermark: 0, global_position: 3, message_id: "message-3" }] as unknown as readonly Row[] });
        return Promise.resolve({ rows: [{ observer_id: "hq-player", low_watermark: 0, global_position: 3, message_id: "message-3" }] as unknown as readonly Row[] });
      }
    };
    const store = new PostgresDeliveryCursorStore(client);
    await expect(store.acknowledge("hq-player", acknowledgement(3))).resolves.toEqual({ observerId: "hq-player", lowWatermark: 0, delivered: [acknowledgement(3)] });
    expect(calls[0]?.sql).toContain("INSERT INTO delivery_acknowledgements");
    expect(calls[0]?.sql).toContain("ON CONFLICT DO NOTHING");
    expect(calls[0]?.values).toEqual(["hq-player", 3, "message-3"]);
  });
});
