import { describe, expect, it } from "vitest";

import { utDaysSinceJ2000, type HeliocentricState, type UtDaysSinceJ2000 } from "./ephemerides.js";
import { rankPorkchopCells, searchEarthMarsPorkchop, type PorkchopCell } from "./window-search.js";

// Gregorian midnight UTC expressed as UT days after J2000.0; no host-clock API is involved.
const utcDay = (year: number, month: number, day: number): UtDaysSinceJ2000 => {
  const adjustedYear = month <= 2 ? year - 1 : year;
  const adjustedMonth = month <= 2 ? month + 12 : month;
  const julianDay = Math.floor(365.25 * (adjustedYear + 4716)) + Math.floor(30.6001 * (adjustedMonth + 1)) + day + Math.floor(adjustedYear / 400) - Math.floor(adjustedYear / 100) + 2 - 1_524.5;
  return utDaysSinceJ2000(julianDay - 2_451_545);
};

const validCell = (cells: readonly PorkchopCell[], departure: UtDaysSinceJ2000, arrival: UtDaysSinceJ2000) => {
  const cell = cells.find((candidate) => candidate.departureUtDays === departure && candidate.arrivalUtDays === arrival);
  expect(cell).toBeDefined();
  expect(cell?.kind).toBe("valid");
  if (cell?.kind !== "valid") throw new Error("Expected a valid porkchop cell.");
  return cell;
};

const nasaWindow = (departure: UtDaysSinceJ2000, arrival: UtDaysSinceJ2000) => searchEarthMarsPorkchop({
  departureStartUtDays: departure,
  departureSpanDays: 0,
  departureStepDays: 1,
  minimumTimeOfFlightDays: arrival - departure,
  maximumTimeOfFlightDays: arrival - departure,
  timeOfFlightStepDays: 1
});

describe("Earth-to-Mars porkchop window search", () => {
  it("reproduces NASA handbook Type II reference cells within the committed independent-tool band", () => {
    const cases = [
      { departure: utcDay(2026, 10, 31), arrival: utcDay(2027, 8, 19), c3: 9.144, arrivalVInfinity: 2.729 },
      { departure: utcDay(2028, 12, 2), arrival: utcDay(2029, 10, 16), c3: 8.928, arrivalVInfinity: 3.261 },
      { departure: utcDay(2033, 4, 28), arrival: utcDay(2034, 1, 27), c3: 7.781, arrivalVInfinity: 4.377 }
    ];
    for (const fixture of cases) {
      const cell = validCell(nasaWindow(fixture.departure, fixture.arrival).cells, fixture.departure, fixture.arrival);
      expect(cell.c3Km2PerSecond2).toBeCloseTo(fixture.c3, 0);
      expect(Math.abs(cell.c3Km2PerSecond2 - fixture.c3)).toBeLessThanOrEqual(1.5);
      expect(cell.arrivalVInfinityKmPerSecond).toBeCloseTo(fixture.arrivalVInfinity, 0);
    }
  });

  it("uses each body's velocity at its own epoch and ranks by well-added total delta-v", () => {
    const departure = utcDay(2028, 12, 2);
    const arrival = utcDay(2029, 10, 16);
    const grid = nasaWindow(departure, arrival);
    const cell = validCell(grid.cells, departure, arrival);
    expect(cell.departureWellDeltaVKmPerSecond).toBeCloseTo(3.622, 2);
    expect(cell.arrivalWellDeltaVKmPerSecond).toBeCloseTo(2.403, 2);
    expect(cell.totalDeltaVKmPerSecond).toBeCloseTo(cell.departureWellDeltaVKmPerSecond + cell.arrivalWellDeltaVKmPerSecond, 12);
    expect(rankPorkchopCells(grid.cells)).toEqual([cell]);
  });

  it("finds 2035 Type I below the Type II opportunity despite Mars eccentricity", () => {
    const cells = rankPorkchopCells(searchEarthMarsPorkchop({
      departureStartUtDays: utcDay(2035, 2, 15), departureSpanDays: 160, departureStepDays: 1,
      minimumTimeOfFlightDays: 100, maximumTimeOfFlightDays: 450, timeOfFlightStepDays: 1
    }).cells);
    const typeI = cells.filter((cell) => cell.timeOfFlightDays < 250)[0];
    const typeII = cells.filter((cell) => cell.timeOfFlightDays >= 250)[0];
    expect(typeI).toBeDefined();
    expect(typeII).toBeDefined();
    if (typeI === undefined || typeII === undefined) throw new Error("Expected both transfer families.");
    expect(typeI.c3Km2PerSecond2).toBeLessThan(typeII.c3Km2PerSecond2);
    expect(typeI.c3Km2PerSecond2).toBeCloseTo(10.19, 0);
  });

  it("preserves synodic phase closure and marks the 180-degree singularity invalid", () => {
    const circularStates = (utDays: UtDaysSinceJ2000): Readonly<{ earth: HeliocentricState; mars: HeliocentricState }> => {
      const earthAngle = (utDays * 2 * Math.PI) / 365.256;
      const marsAngle = (utDays * 2 * Math.PI) / 686.97 + (44.34 * Math.PI) / 180;
      const earthRadius = 149_597_870.7;
      const marsRadius = 227_939_200;
      const earthSpeed = (2 * Math.PI * earthRadius) / (365.256 * 86_400);
      const marsSpeed = (2 * Math.PI * marsRadius) / (686.97 * 86_400);
      return {
        earth: { positionKm: { x: earthRadius * Math.cos(earthAngle), y: earthRadius * Math.sin(earthAngle), z: 0 }, velocityKmPerSecond: { x: -earthSpeed * Math.sin(earthAngle), y: earthSpeed * Math.cos(earthAngle), z: 0 } },
        mars: { positionKm: { x: marsRadius * Math.cos(marsAngle), y: marsRadius * Math.sin(marsAngle), z: 0 }, velocityKmPerSecond: { x: -marsSpeed * Math.sin(marsAngle), y: marsSpeed * Math.cos(marsAngle), z: 0 } }
      };
    };
    const departure = utcDay(2026, 10, 31);
    const first = validCell(searchEarthMarsPorkchop({ departureStartUtDays: departure, departureSpanDays: 0, departureStepDays: 1, minimumTimeOfFlightDays: 258.87, maximumTimeOfFlightDays: 258.87, timeOfFlightStepDays: 1, statesAt: circularStates }).cells, departure, (departure + 258.87) as UtDaysSinceJ2000);
    const secondDeparture = (departure + 779.94) as UtDaysSinceJ2000;
    const second = validCell(searchEarthMarsPorkchop({ departureStartUtDays: secondDeparture, departureSpanDays: 0, departureStepDays: 1, minimumTimeOfFlightDays: 258.87, maximumTimeOfFlightDays: 258.87, timeOfFlightStepDays: 1, statesAt: circularStates }).cells, secondDeparture, (secondDeparture + 258.87) as UtDaysSinceJ2000);
    expect(second.c3Km2PerSecond2).toBeCloseTo(first.c3Km2PerSecond2, 0);

    const singularStates = (): Readonly<{ earth: HeliocentricState; mars: HeliocentricState }> => ({
      earth: { positionKm: { x: 1, y: 0, z: 0 }, velocityKmPerSecond: { x: 0, y: 1, z: 0 } },
      mars: { positionKm: { x: -1, y: 0, z: 0 }, velocityKmPerSecond: { x: 0, y: -1, z: 0 } }
    });
    const singular = searchEarthMarsPorkchop({
      departureStartUtDays: utcDay(2026, 1, 1), departureSpanDays: 0.001, departureStepDays: 0.001,
      minimumTimeOfFlightDays: 100, maximumTimeOfFlightDays: 100, timeOfFlightStepDays: 1, statesAt: singularStates
    }).cells[0];
    expect(singular).toMatchObject({ kind: "invalid", reason: "near-180-degree-transfer" });
  });

  it("rejects non-finite results as typed invalid cells and validates minimum time of flight", () => {
    const nonFiniteVelocityStates = (): Readonly<{ earth: HeliocentricState; mars: HeliocentricState }> => ({
      earth: { positionKm: { x: 149_597_870.7, y: 0, z: 0 }, velocityKmPerSecond: { x: Number.NaN, y: 29.78, z: 0 } },
      mars: { positionKm: { x: 0, y: 227_939_200, z: 0 }, velocityKmPerSecond: { x: -24.13, y: 0, z: 0 } }
    });
    const baseInput = {
      departureStartUtDays: utcDay(2026, 1, 1), departureSpanDays: 0, departureStepDays: 1,
      minimumTimeOfFlightDays: 100, maximumTimeOfFlightDays: 100, timeOfFlightStepDays: 1
    } as const;
    const [cell] = searchEarthMarsPorkchop({ ...baseInput, statesAt: nonFiniteVelocityStates }).cells;
    expect(cell).toMatchObject({ kind: "invalid", reason: "non-finite-result" });
    if (cell === undefined) throw new Error("Expected a porkchop cell.");
    expect(rankPorkchopCells([cell])).toEqual([]);
    for (const minimumTimeOfFlightDays of [0, -1]) {
      expect(() => searchEarthMarsPorkchop({ ...baseInput, minimumTimeOfFlightDays })).toThrow("Minimum time of flight must be a positive finite number.");
    }
  });

  it("computes a 64k-cell grid with cached ephemeris states and departure-major dimensions", () => {
    const grid = searchEarthMarsPorkchop({
      departureStartUtDays: utcDay(2026, 8, 1), departureSpanDays: 159.375, departureStepDays: 0.625,
      minimumTimeOfFlightDays: 100, maximumTimeOfFlightDays: 349, timeOfFlightStepDays: 1
    });
    expect(grid.departureCount).toBe(256);
    expect(grid.timeOfFlightCount).toBe(250);
    expect(grid.cells).toHaveLength(64_000);
    expect(grid.c3DisplayCapKm2PerSecond2).toBe(50);
  });
});
