import { describe, expect, it } from "vitest";

import { utDaysSinceJ2000, type HeliocentricState, type UtDaysSinceJ2000 } from "./ephemerides.js";
import { solveLambertIzzo } from "./lambert.js";
import { rankPorkchopCells, searchEarthMarsPorkchop, SUN_GRAVITATIONAL_PARAMETER_KM3_PER_SECOND2, type PorkchopCell } from "./window-search.js";

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

const circularStatesAtPhase = (referenceUtDays: UtDaysSinceJ2000) => (utDays: UtDaysSinceJ2000): Readonly<{ earth: HeliocentricState; mars: HeliocentricState }> => {
  const earthPeriodDays = 365.256;
  const marsPeriodDays = 686.97;
  const elapsedDays = utDays - referenceUtDays;
  const earthAngle = (elapsedDays * 2 * Math.PI) / earthPeriodDays;
  const marsAngle = (elapsedDays * 2 * Math.PI) / marsPeriodDays + (44.34 * Math.PI) / 180;
  const earthRadius = 149_597_870.7;
  const marsRadius = 227_939_200;
  const earthSpeed = (2 * Math.PI * earthRadius) / (earthPeriodDays * 86_400);
  const marsSpeed = (2 * Math.PI * marsRadius) / (marsPeriodDays * 86_400);
  return {
    earth: { positionKm: { x: earthRadius * Math.cos(earthAngle), y: earthRadius * Math.sin(earthAngle), z: 0 }, velocityKmPerSecond: { x: -earthSpeed * Math.sin(earthAngle), y: earthSpeed * Math.cos(earthAngle), z: 0 } },
    mars: { positionKm: { x: marsRadius * Math.cos(marsAngle), y: marsRadius * Math.sin(marsAngle), z: 0 }, velocityKmPerSecond: { x: -marsSpeed * Math.sin(marsAngle), y: marsSpeed * Math.cos(marsAngle), z: 0 } }
  };
};

const CIRCULAR_EARTH_MARS_SYNODIC_PERIOD_DAYS = 1 / (1 / 365.256 - 1 / 686.97);
const vectorDifferenceMagnitude = (left: { readonly x: number; readonly y: number; readonly z: number }, right: { readonly x: number; readonly y: number; readonly z: number }): number => Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);

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

  it("uses each body's velocity at its own epoch and rejects the 2028 C3 ranking trap by total delta-v", () => {
    const typeIIDeparture = utcDay(2028, 12, 2);
    const typeIIArrival = utcDay(2029, 10, 16);
    const typeIDeparture = utcDay(2028, 12, 10);
    const typeIArrival = utcDay(2029, 7, 20);
    const typeII = validCell(nasaWindow(typeIIDeparture, typeIIArrival).cells, typeIIDeparture, typeIIArrival);
    const typeI = validCell(nasaWindow(typeIDeparture, typeIArrival).cells, typeIDeparture, typeIArrival);
    expect(typeII.c3Km2PerSecond2).toBeCloseTo(8.928, 0);
    expect(typeI.c3Km2PerSecond2).toBeCloseTo(9.048, 0);
    expect(typeII.arrivalVInfinityKmPerSecond).toBeCloseTo(3.261, 0);
    expect(typeI.arrivalVInfinityKmPerSecond).toBeCloseTo(4.892, 0);
    expect(typeII.departureWellDeltaVKmPerSecond).toBeCloseTo(3.622, 2);
    expect(typeII.arrivalWellDeltaVKmPerSecond).toBeCloseTo(2.403, 2);
    expect(typeII.totalDeltaVKmPerSecond).toBeCloseTo(typeII.departureWellDeltaVKmPerSecond + typeII.arrivalWellDeltaVKmPerSecond, 12);
    expect(Math.abs(typeII.c3Km2PerSecond2 - typeI.c3Km2PerSecond2)).toBeLessThanOrEqual(0.5);
    expect(Math.abs(typeII.totalDeltaVKmPerSecond - typeI.totalDeltaVKmPerSecond)).toBeGreaterThanOrEqual(0.9);
  });

  it("finds the 2028 global total-delta-v optimum within the handbook's 14-day departure band", () => {
    const handbookDeparture = utcDay(2028, 12, 2);
    const ranked = rankPorkchopCells(searchEarthMarsPorkchop({
      departureStartUtDays: utcDay(2028, 10, 1),
      departureSpanDays: 160,
      departureStepDays: 1,
      minimumTimeOfFlightDays: 100,
      maximumTimeOfFlightDays: 450,
      timeOfFlightStepDays: 1
    }).cells);
    expect(ranked).not.toHaveLength(0);
    const [optimum] = ranked;
    if (optimum === undefined) throw new Error("Expected a ranked porkchop optimum.");
    expect(Math.abs(optimum.departureUtDays - handbookDeparture)).toBeLessThanOrEqual(14);
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

  it("pins the circular Hohmann values, closes synodically to 1e-6, and marks the 180-degree singularity invalid", () => {
    const departure = utcDay(2026, 10, 31);
    const circularStates = circularStatesAtPhase(departure);
    const hohmannTimeOfFlightDays = 258.87;
    const hohmannDeparture = circularStates(departure).earth;
    const hohmannArrival = circularStates((departure + hohmannTimeOfFlightDays) as UtDaysSinceJ2000).mars;
    const hohmann = solveLambertIzzo(SUN_GRAVITATIONAL_PARAMETER_KM3_PER_SECOND2, hohmannDeparture.positionKm, hohmannArrival.positionKm, hohmannTimeOfFlightDays * 86_400);
    expect(vectorDifferenceMagnitude(hohmann.departureVelocityKmPerSecond, hohmannDeparture.velocityKmPerSecond) ** 2).toBeCloseTo(8.671, 3);
    expect(vectorDifferenceMagnitude(hohmann.arrivalVelocityKmPerSecond, hohmannArrival.velocityKmPerSecond)).toBeCloseTo(2.649, 3);

    // Keep this adjacent to, but outside, the planner's deliberate 180° guard.
    const closureTimeOfFlightDays = 258.7;
    const first = validCell(searchEarthMarsPorkchop({ departureStartUtDays: departure, departureSpanDays: 0, departureStepDays: 1, minimumTimeOfFlightDays: closureTimeOfFlightDays, maximumTimeOfFlightDays: closureTimeOfFlightDays, timeOfFlightStepDays: 1, statesAt: circularStates }).cells, departure, (departure + closureTimeOfFlightDays) as UtDaysSinceJ2000);
    expect(first.c3Km2PerSecond2).toBeCloseTo(8.671, 1);
    expect(first.arrivalVInfinityKmPerSecond).toBeCloseTo(2.649, 1);
    const secondDeparture = (departure + CIRCULAR_EARTH_MARS_SYNODIC_PERIOD_DAYS) as UtDaysSinceJ2000;
    const second = validCell(searchEarthMarsPorkchop({ departureStartUtDays: secondDeparture, departureSpanDays: 0, departureStepDays: 1, minimumTimeOfFlightDays: closureTimeOfFlightDays, maximumTimeOfFlightDays: closureTimeOfFlightDays, timeOfFlightStepDays: 1, statesAt: circularStates }).cells, secondDeparture, (secondDeparture + closureTimeOfFlightDays) as UtDaysSinceJ2000);
    expect(second.c3Km2PerSecond2).toBeCloseTo(first.c3Km2PerSecond2, 6);
    expect(Math.abs(CIRCULAR_EARTH_MARS_SYNODIC_PERIOD_DAYS - 779.94)).toBeLessThanOrEqual(0.02);

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

  it("finds the 2026 NASA-span total-delta-v optimum within the handbook's 14-day departure band", () => {
    const handbookDeparture = utcDay(2026, 10, 31);
    const ranked = rankPorkchopCells(searchEarthMarsPorkchop({
      departureStartUtDays: utcDay(2026, 9, 1),
      departureSpanDays: 160,
      departureStepDays: 1,
      minimumTimeOfFlightDays: 100,
      maximumTimeOfFlightDays: 450,
      timeOfFlightStepDays: 1
    }).cells);
    expect(ranked).not.toHaveLength(0);
    const [optimum] = ranked;
    if (optimum === undefined) throw new Error("Expected a ranked porkchop optimum.");
    expect(Math.abs(optimum.departureUtDays - handbookDeparture)).toBeLessThanOrEqual(14);
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
