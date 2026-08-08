import { describe, expect, it } from "vitest";

import { createTier0PlanRevisionTransport } from "../host/plan-revision-transport.js";
import { simTimeMs } from "./clock.js";
import { InMemorySimulationEventStore } from "./event-store.js";
import { utDaysSinceJ2000 } from "./ephemerides.js";
import { burnDurationMs } from "./mass-cargo.js";
import { createTier0AuthoritativeSimLoop } from "./tier0-worldline.js";

describe("Tier 0 live worldline composition", () => {
  it("stamps Earth departure, uses the loop-owned resolver, and stores arrival provenance", async () => {
    const loop = await createTier0AuthoritativeSimLoop(
      { id: "tier0-worldline", seed: 1, initialTime: simTimeMs(0) },
      new InMemorySimulationEventStore(),
      utDaysSinceJ2000(9_496.5)
    );
    const transport = createTier0PlanRevisionTransport(loop, utDaysSinceJ2000(9_496.5));

    await transport.issue({
      destination: "mars",
      nodes: [{
        nodeId: "arrival-burn", executeAtMs: simTimeMs(1), kind: "accel",
        burn: { burnDurationMs: burnDurationMs(1) }, deltaVMmPerSecond: { x: 0, y: 0, z: 0 }
      }]
    });
    await loop.advance(2, () => ({ x: 0, y: 0, z: 0 }));

    const persisted = await loop.persistedStream();
    const departure = persisted.events.find(({ event }) => event.type === "departureRecorded");
    const arrival = persisted.events.find(({ event }) => event.type === "arrivalRecorded");
    expect(departure?.event).toMatchObject({ type: "departureRecorded", departureState: { departureAtMs: 0 } });
    if (departure?.event.type !== "departureRecorded") throw new Error("Expected a stamped departure state.");
    expect(Math.hypot(departure.event.departureState.positionMeters.x,
      departure.event.departureState.positionMeters.y,
      departure.event.departureState.positionMeters.z)).toBeGreaterThan(100_000_000_000);
    expect(arrival?.event).toMatchObject({ type: "arrivalRecorded", arrivalState: { arrivedAtMs: 2, destination: "mars" } });
    expect(loop.shipPositionAt(simTimeMs(2))).toEqual(arrival?.event.type === "arrivalRecorded"
      ? arrival.event.arrivalState.targetPositionMeters
      : undefined);
  });
});
