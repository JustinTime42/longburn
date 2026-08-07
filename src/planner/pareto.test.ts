import { describe, expect, it } from "vitest";

import { TIER0_SHIP } from "../sim/mass-cargo.js";
import { simTimeMs } from "../sim/clock.js";
import { utDaysSinceJ2000, type HeliocentricState } from "../sim/ephemerides.js";
import type { PorkchopCell } from "../sim/window-search.js";
import { assembleParetoLandscape, TIER0_MARS_CAPTURE_TARGET, tier0TrajectoryPlanner, type ProjectedShipState } from "./pareto.js";

const departure = utDaysSinceJ2000(10_000);
const state: HeliocentricState = { positionKm: { x: 149_597_870.7, y: 0, z: 0 }, velocityKmPerSecond: { x: 0, y: 29.78, z: 0 } };
const target: HeliocentricState = { positionKm: { x: 227_939_200, y: 1_000_000, z: 0 }, velocityKmPerSecond: { x: -24.13, y: 0, z: 0 } };
const cell = (departureUtDays: number, timeOfFlightDays: number, c3 = 1, arrivalVInfinity = 1) => ({
  kind: "valid" as const, departureUtDays: utDaysSinceJ2000(departureUtDays), arrivalUtDays: utDaysSinceJ2000(departureUtDays + timeOfFlightDays), timeOfFlightDays,
  c3Km2PerSecond2: c3, arrivalVInfinityKmPerSecond: arrivalVInfinity, departureWellDeltaVKmPerSecond: 0.1, arrivalWellDeltaVKmPerSecond: 0.1, totalDeltaVKmPerSecond: 0.2
});
const input = (cells: readonly PorkchopCell[], ship = TIER0_SHIP, arrivalCaptureTarget = TIER0_MARS_CAPTURE_TARGET) => ({
  cells, ship, arrivalCaptureTarget,
  ephemerides: { statesAt: (epoch: number) => ({ earth: state, mars: { ...target, positionKm: { ...target.positionKm, y: target.positionKm.y + epoch } } }) }
});

describe("planner Pareto landscape", () => {
  it("returns only within-window nondominated 2-D points and retains later windows", () => {
    const landscape = assembleParetoLandscape(input([
      cell(departure, 100, 1), cell(departure, 200, 1), cell(departure, 200, 9),
      cell(departure + 10, 200, 1)
    ]));
    expect(landscape.windows).toHaveLength(2);
    expect(landscape.windows[0]?.points.map((point) => point.timeOfFlightDays)).toEqual([100, 200]);
    expect(landscape.windows[1]?.points.map((point) => point.timeOfFlightDays)).toEqual([200]);
  });

  it("defines arrivalTime as the absolute departure-plus-duration epoch and exposes derived readouts", () => {
    const [window] = assembleParetoLandscape(input([cell(departure, 200)])).windows;
    const [point] = window?.points ?? [];
    expect(point?.arrivalTime).toBe(departure + 200);
    expect(point?.cargoFraction).toBeGreaterThan(0);
    expect(point?.quotedDutyCycle).toBeGreaterThan(0);
  });

  it("keeps nonviable and infeasible candidates as typed walls, never extrapolated points", () => {
    const nonviableShip = { ...TIER0_SHIP, exhaustVelocityKmPerSecond: 1, structuralMassFraction: 0.9 };
    const nonviable = assembleParetoLandscape(input([cell(departure, 200)], nonviableShip));
    expect(nonviable.windows[0]?.points).toEqual([]);
    expect(nonviable.windows[0]?.walls[0]).toMatchObject({ kind: "nonviable", reason: "cargo-exhausted" });
    const infeasibleShip = { ...TIER0_SHIP, accelerationKmPerSecond2: 1e-8 };
    const infeasible = assembleParetoLandscape(input([cell(departure, 100)], infeasibleShip));
    expect(infeasible.windows[0]?.points).toEqual([]);
    expect(infeasible.windows[0]?.walls[0]?.kind).toBe("infeasible");
  });

  it("makes capture orbit explicit and applies it to the assembled total", () => {
    const candidate = cell(departure, 200, 1, 3);
    const defaultPoint = assembleParetoLandscape(input([candidate])).windows[0]?.points[0];
    const highOrbitPoint = assembleParetoLandscape(input([candidate], TIER0_SHIP, { ...TIER0_MARS_CAPTURE_TARGET, parkingRadiusKm: TIER0_MARS_CAPTURE_TARGET.parkingRadiusKm + 1_000 })).windows[0]?.points[0];
    expect(defaultPoint?.totalDeltaVKmPerSecond).not.toBeCloseTo(highOrbitPoint?.totalDeltaVKmPerSecond ?? 0, 12);
  });

  it("keeps the 2028 tier-3 fixture near its 6.03 km/s patched-conic cost", () => {
    const tier3Fixture = {
      ...cell(departure, 318, 8.928, 3.261),
      // NASA fixture and the corresponding 200 km LEO well term, km/s.
      departureWellDeltaVKmPerSecond: 3.622
    };
    const point = assembleParetoLandscape(input([tier3Fixture])).windows[0]?.points[0];
    // kappa is effectively one for this Tier-0 torch, so this proves that the
    // heliocentric v-infinity terms are not re-added after the two well burns.
    expect(point?.totalDeltaVKmPerSecond).toBeCloseTo(6.03, 1);
  });

  it("retains invalid cells and preserves their typed reason", () => {
    const invalid = {
      kind: "invalid" as const,
      departureUtDays: utDaysSinceJ2000(departure),
      arrivalUtDays: utDaysSinceJ2000(departure + 100),
      timeOfFlightDays: 100,
      reason: "near-180-degree-transfer" as const
    };
    const [window] = assembleParetoLandscape(input([invalid])).windows;
    expect(window?.points).toEqual([]);
    expect(window?.walls).toMatchObject([{ kind: "invalid", reason: "near-180-degree-transfer" }]);
  });

  it("passes the selected current propagated state to its cell source", () => {
    const current: ProjectedShipState = {
      atMs: simTimeMs(0), positionKm: { x: 1, y: 2, z: 3 }, velocityKmPerSecond: { x: 4, y: 5, z: 6 }
    };
    let received: ProjectedShipState | undefined;
    const result = tier0TrajectoryPlanner.planFromProjectedState({
      ...input([]),
      origin: current,
      worldEpochUtDaysSinceJ2000: departure,
      cellSource: { cellsFrom: (origin) => { received = origin; return [cell(departure, 200)]; } }
    });

    expect(received).toBe(current);
    expect(result.origin).toBe(current);
    expect(result.landscape.windows[0]?.points).toHaveLength(1);
  });

  it("uses a future projected origin to construct the advisory landscape", () => {
    const afterOutboundNode: ProjectedShipState = {
      atMs: simTimeMs(86_400_000),
      positionKm: { x: 150_000_000, y: 20_000, z: -10_000 },
      velocityKmPerSecond: { x: 1, y: 29, z: 0 }
    };
    const result = tier0TrajectoryPlanner.planFromProjectedState({
      ...input([]),
      origin: afterOutboundNode,
      worldEpochUtDaysSinceJ2000: departure,
      cellSource: {
        cellsFrom: (origin) => {
          expect(origin.atMs).toBe(simTimeMs(86_400_000));
          return [cell(departure + 1, 200)];
        }
      }
    });

    expect(result.origin).toBe(afterOutboundNode);
    expect(result.landscape.windows.map(({ departureUtDays }) => departureUtDays)).toEqual([departure + 1]);
  });

  it("uses a projected non-Earth origin in continuum feasibility", () => {
    const earthAnchored = assembleParetoLandscape(input([cell(departure, 200)])).windows[0]?.points[0];
    const origin: ProjectedShipState = {
      atMs: simTimeMs(0),
      positionKm: { x: 120_000_000, y: 40_000_000, z: 10_000_000 },
      velocityKmPerSecond: { x: -8, y: 24, z: 2 }
    };
    const projected = tier0TrajectoryPlanner.planFromProjectedState({
      ...input([]),
      origin,
      worldEpochUtDaysSinceJ2000: departure,
      cellSource: { cellsFrom: () => [cell(departure, 200)] }
    }).landscape.windows[0]?.points[0];

    expect(projected?.quotedDutyCycle).not.toBeCloseTo(earthAnchored?.quotedDutyCycle ?? 0, 12);
  });

  it("rejects candidate cells before the selected projected origin", () => {
    const origin: ProjectedShipState = { atMs: simTimeMs(86_400_000), ...state };
    expect(() => tier0TrajectoryPlanner.planFromProjectedState({
      ...input([]),
      origin,
      worldEpochUtDaysSinceJ2000: departure,
      cellSource: { cellsFrom: () => [cell(departure, 200)] }
    })).toThrow(new RangeError("Projected-state planner cells must depart at or after the selected origin."));
  });
});
