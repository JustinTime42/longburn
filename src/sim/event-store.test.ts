import { describe, expect, it } from "vitest";

import { simTimeMs } from "./clock.js";
import { utDaysSinceJ2000 } from "./ephemerides.js";
import {
  InMemorySimulationEventStore,
  PostgresSimulationEventStore,
  type AppendSimEventResult,
  type PostgresQueryClient,
  type SimulationEventStore
} from "./event-store.js";

const event = (elapsedMs: number) => ({
  event: { type: "clockAdvanced" as const, elapsedMs },
  eventTime: simTimeMs(elapsedMs),
  eventPosition: { x: 0, y: 0, z: 0 }
});

const appended = (result: AppendSimEventResult) => {
  expect(result.kind).toBe("appended");
  if (result.kind !== "appended") throw new Error("Expected an appended event.");
  return result.event;
};

/** Shared store contract; the Postgres integration suite mirrors these assertions. */
const assertSequenceContract = (makeStore: () => SimulationEventStore): void => {
  it("keeps stream sequences contiguous while global positions order all streams", async () => {
    const store = makeStore();
    await store.createStream({ id: "alpha", seed: 1, initialTime: simTimeMs(0) });
    await store.createStream({ id: "beta", seed: 2, initialTime: simTimeMs(0) });

    const firstAlpha = appended(await store.append("alpha", event(1)));
    const firstBeta = appended(await store.append("beta", event(2)));
    const secondAlpha = appended(await store.append("alpha", event(3)));

    expect([firstAlpha.streamSequence, secondAlpha.streamSequence]).toEqual([1, 2]);
    expect(firstBeta.streamSequence).toBe(1);
    expect([firstAlpha.globalPosition, firstBeta.globalPosition, secondAlpha.globalPosition]).toEqual(
      [...[firstAlpha.globalPosition, firstBeta.globalPosition, secondAlpha.globalPosition]].sort((a, b) => a - b)
    );
    expect(secondAlpha.globalPosition - firstBeta.globalPosition).toBeGreaterThan(1);
  });

  it("returns a typed conflict without appending when the expected stream sequence is stale", async () => {
    const store = makeStore();
    await store.createStream({ id: "conflict", seed: 1, initialTime: simTimeMs(0) });
    appended(await store.append("conflict", event(1), 0));

    await expect(store.append("conflict", event(2), 0)).resolves.toEqual({
      kind: "conflict", expectedStreamSequence: 0, actualStreamSequence: 1
    });
    expect((await store.readStream("conflict")).events).toHaveLength(1);
  });

  it("rejects appends and reads for unknown streams", async () => {
    const store = makeStore();

    await expect(store.append("missing", event(1))).rejects.toThrow("Unknown simulation stream: missing");
    await expect(store.append("missing", event(1), 0)).rejects.toThrow("Unknown simulation stream: missing");
    await expect(store.readStream("missing")).rejects.toThrow("Unknown simulation stream: missing");
  });
};

describe("InMemorySimulationEventStore", () => {
  assertSequenceContract(() => new InMemorySimulationEventStore());
});

describe("PostgresSimulationEventStore", () => {
  it("writes and reads the optional immutable stream epoch", async () => {
    const queries: { readonly sql: string; readonly values: readonly unknown[] | undefined }[] = [];
    const client: PostgresQueryClient = {
      query: <Row extends Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
        queries.push({ sql, values });
        if (sql.startsWith("INSERT")) return Promise.resolve({ rows: [] as readonly Row[] });
        if (sql.includes("FROM simulation_events")) return Promise.resolve({ rows: [] as readonly Row[] });
        return Promise.resolve({ rows: [{
          stream_id: "epoch", seed: 1, initial_time_ms: 0, epoch_ut_days_since_j2000: 9_496.5
        }] as unknown as readonly Row[] });
      }
    };
    const store = new PostgresSimulationEventStore(client);

    await store.createStream({ id: "epoch", seed: 1, initialTime: simTimeMs(0), epochUtDaysSinceJ2000: utDaysSinceJ2000(9_496.5) });
    await expect(store.readStream("epoch")).resolves.toMatchObject({ epochUtDaysSinceJ2000: 9_496.5 });
    expect(queries[0]).toMatchObject({ values: ["epoch", 1, 0, 9_496.5] });
  });

  it("retries its sequence constraint race and returns the typed conflict", async () => {
    let calls = 0;
    const client: PostgresQueryClient = {
      query: <Row extends Record<string, unknown>>() => {
        calls += 1;
        if (calls === 1) {
          return Promise.reject(Object.assign(new Error("duplicate stream sequence"), {
            code: "23505",
            constraint: "simulation_events_stream_sequence_unique"
          }));
        }
        const rows = [{
          stream_sequence: null,
          global_position: null,
          actual_stream_sequence: 1,
          event_time_ms: null,
          event_position: null,
          event: null
        }] as unknown as readonly Row[];
        return Promise.resolve({ rows });
      }
    };
    const store = new PostgresSimulationEventStore(client);

    await expect(store.append("race", event(1), 0)).resolves.toEqual({
      kind: "conflict", expectedStreamSequence: 0, actualStreamSequence: 1
    });
    expect(calls).toBe(2);
  });

  it("reports an unknown stream when append returns no row", async () => {
    const client: PostgresQueryClient = { query: () => Promise.resolve({ rows: [] }) };
    const store = new PostgresSimulationEventStore(client);

    await expect(store.append("missing", event(1), 0)).rejects.toThrow("Unknown simulation stream: missing");
  });
});
