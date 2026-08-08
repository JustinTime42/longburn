import { describe, expect, it } from "vitest";

import { createTier0PlanRevisionTransport } from "../host/plan-revision-transport.js";
import { simTimeMs } from "./clock.js";
import { InMemorySimulationEventStore } from "./event-store.js";
import { utDaysSinceJ2000 } from "./ephemerides.js";
import { burnDurationMs } from "./mass-cargo.js";
import { createTier0AuthoritativeSimLoop } from "./tier0-worldline.js";
import { AuthoritativeSimLoop } from "./loop.js";

describe("Tier 0 live worldline composition", () => {
  it("stamps Earth departure and does not treat an empty mid-transit plan as arrival", async () => {
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
    expect(arrival).toBeUndefined();
    expect(loop.shipPositionAt(simTimeMs(2))).not.toEqual({ x: 0, y: 0, z: 0 });
  });

  it("snaps only after measured arrival and keeps pre-arrival queries on the transit worldline", async () => {
    const store = new InMemorySimulationEventStore();
    const dock = {
      positionMeters: { x: 149_597_870_700, y: 0, z: 0 },
      velocityMmPerSecond: { x: 0, y: 29_780_000, z: 0 }
    };
    const loop = await AuthoritativeSimLoop.create({
      store, stream: { id: "piecewise-arrival", seed: 1, initialTime: simTimeMs(0) },
      departureStateAt: (time) => ({ departureAtMs: time, ...dock }),
      destinationStateAt: () => dock
    });
    await loop.applyPlanRevision({
      destination: "earth",
      nodes: [{ nodeId: "dock", executeAtMs: simTimeMs(1), kind: "decel", burn: { burnDurationMs: burnDurationMs(1) }, deltaVMmPerSecond: { x: 0, y: 0, z: 0 } }]
    }, () => dock.positionMeters);
    await loop.advance(2, () => dock.positionMeters);

    const arrival = (await loop.persistedStream()).events.find(({ event }) => event.type === "arrivalRecorded");
    expect(arrival?.event).toMatchObject({ type: "arrivalRecorded", arrivalState: { arrivedAtMs: 2, positionGapMeters: expect.any(Object), velocityGapMmPerSecond: { x: 0, y: 0, z: 0 } } });
    expect(loop.shipPositionAt(simTimeMs(1))).not.toEqual(dock.positionMeters);
    expect(loop.shipPositionAt(simTimeMs(2))).toEqual(dock.positionMeters);

    await loop.applyPlanRevision({
      destination: "earth",
      nodes: [{ nodeId: "depart-again", executeAtMs: simTimeMs(3), kind: "accel", burn: { burnDurationMs: burnDurationMs(1) }, deltaVMmPerSecond: { x: 0, y: 0, z: 0 } }]
    }, () => dock.positionMeters);
    await loop.advance(1, () => dock.positionMeters);
    const departures = (await loop.persistedStream()).events.filter(({ event }) => event.type === "departureRecorded");
    expect(departures).toHaveLength(2);
    expect(departures[1]).toMatchObject({ eventTime: 3, event: { departureState: { departureAtMs: 3 } } });
  });
});
