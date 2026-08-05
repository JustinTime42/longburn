import { describe, expect, it } from "vitest";

import { type Vector3Km } from "./ephemerides.js";
import { LambertConvergenceError, LambertGeometryError, LambertNoFeasibleSolutionError, solveLambertIzzo } from "./lambert.js";
import { propagateKepler } from "./kepler.js";

const EARTH_MU = 398_600.4418;
const SUN_MU = 132_712_440_018;
const vector = (x: number, y: number, z: number): Vector3Km => ({ x, y, z });
const distance = (left: Vector3Km, right: Vector3Km): number => Math.sqrt((left.x - right.x) ** 2 + (left.y - right.y) ** 2 + (left.z - right.z) ** 2);
const expectVector = (actual: Vector3Km, expected: Vector3Km, digits = 7): void => {
  expect(actual.x).toBeCloseTo(expected.x, digits);
  expect(actual.y).toBeCloseTo(expected.y, digits);
  expect(actual.z).toBeCloseTo(expected.z, digits);
};

describe("Izzo 2015 Lambert solver", () => {
  it("reproduces Vallado 7-5 and Curtis 5.2", () => {
    const vallado = solveLambertIzzo(EARTH_MU, vector(15945.34, 0, 0), vector(12214.83899, 10249.46731, 0), 4560);
    expectVector(vallado.departureVelocityKmPerSecond, vector(2.058913354, 2.915964352, 0), 7);
    expectVector(vallado.arrivalVelocityKmPerSecond, vector(-3.451564845, 0.910314248, 0), 7);
    expect(vallado.iterations).toBe(2);

    const curtis = solveLambertIzzo(EARTH_MU, vector(5000, 10000, 2100), vector(-14600, 2500, 7000), 3600);
    expectVector(curtis.departureVelocityKmPerSecond, vector(-5.992495020, 1.925366714, 3.245638050), 7);
    expectVector(curtis.arrivalVelocityKmPerSecond, vector(-3.312458503, -4.196619008, -0.385289060), 7);
  });

  it("reproduces Battin 7.12 in AU/year units", () => {
    const solution = solveLambertIzzo(39.47692641, vector(0.159321004, 0.579266185, 0.052359607), vector(0.057594337, 0.605750797, 0.068345246), 0.010794065);
    expectVector(solution.departureVelocityKmPerSecond, vector(-9.303608004, 3.018620165, 1.536360083), 7);
    expectVector(solution.arrivalVelocityKmPerSecond, vector(-9.511186197, 1.888840064, 1.421378101), 7);
  });

  it("reproduces Der cases I and II across direction and path selections", () => {
    const r1 = vector(2249.171260, 1898.007100, 5639.599193);
    const r2 = vector(1744.495443, -4601.556054, 4043.864391);
    const der1Prograde = solveLambertIzzo(EARTH_MU, r1, r2, 1618.5);
    expectVector(der1Prograde.departureVelocityKmPerSecond, vector(-2.09572809, 3.92602196, -4.94516810), 7);
    expectVector(der1Prograde.arrivalVelocityKmPerSecond, vector(2.46309613, 0.84490197, 6.10890863), 7);
    const der1Retrograde = solveLambertIzzo(EARTH_MU, r1, r2, 1618.5, { isPrograde: false, isLowPath: false });
    expectVector(der1Retrograde.departureVelocityKmPerSecond, vector(1.94312182, -4.35300015, 4.54630439), 7);
    expectVector(der1Retrograde.arrivalVelocityKmPerSecond, vector(-2.38885563, -1.42519647, -5.95772225), 7);

    const der2r1 = vector(22592.145603, -1599.915239, -19783.950506);
    const der2r2 = vector(1922.067697, 4054.157051, -8925.727465);
    const prograde = solveLambertIzzo(EARTH_MU, der2r1, der2r2, 36000, { isLowPath: false });
    expectVector(prograde.departureVelocityKmPerSecond, vector(2.000652697, 0.387688615, -2.666947760), 7);
    expectVector(prograde.arrivalVelocityKmPerSecond, vector(-3.79246619, -1.77707641, 6.856814395), 7);
    const retrograde = solveLambertIzzo(EARTH_MU, der2r1, der2r2, 36000, { isPrograde: false, isLowPath: false });
    expectVector(retrograde.departureVelocityKmPerSecond, vector(2.96616042, -1.27577231, -0.75545632), 7);
    expectVector(retrograde.arrivalVelocityKmPerSecond, vector(5.843754547, -0.200476734, -5.486158829), 7);
  });

  it("reproduces generated multi-revolution and heliocentric M=0/1/2 fixtures", () => {
    const r1 = vector(22592.145603, -1599.915239, -19783.950506);
    const r2 = vector(1922.067697, 4054.157051, -8925.727465);
    const low = solveLambertIzzo(EARTH_MU, r1, r2, 36000, { revolutions: 1 });
    expectVector(low.departureVelocityKmPerSecond, vector(-2.457595533987, 1.169458006909, 0.431612576787), 9);
    expectVector(low.arrivalVelocityKmPerSecond, vector(-5.538413180795, 0.018222133557, 5.496410156367), 9);
    const high = solveLambertIzzo(EARTH_MU, r1, r2, 36000, { revolutions: 1, isLowPath: false });
    expectVector(high.departureVelocityKmPerSecond, vector(0.503357699103, 0.618694082428, -1.571769036827), 9);
    expectVector(high.arrivalVelocityKmPerSecond, vector(-4.183346259285, -1.132627268989, 6.133070906961), 9);
    expect(() => solveLambertIzzo(EARTH_MU, r1, r2, 36000, { revolutions: 2 })).toThrow(LambertNoFeasibleSolutionError);

    const sunR1 = vector(-1.4934e8, 1.1471e7, -1e3);
    const sunR2 = vector(1.4726e8, 1.8946e8, -6.7e5);
    expectVector(solveLambertIzzo(SUN_MU, sunR1, sunR2, 138240000).departureVelocityKmPerSecond, vector(-11.106110888232, -36.514169499882, 0.124808565709), 9);
    expectVector(solveLambertIzzo(SUN_MU, sunR1, sunR2, 138240000, { revolutions: 1 }).departureVelocityKmPerSecond, vector(25.435364206861, -27.834143902304, 0.086663793853), 9);
    expectVector(solveLambertIzzo(SUN_MU, sunR1, sunR2, 138240000, { revolutions: 1, isLowPath: false }).departureVelocityKmPerSecond, vector(-6.370687999473, -35.133840254064, 0.119011540518), 9);
    expectVector(solveLambertIzzo(SUN_MU, sunR1, sunR2, 138240000, { revolutions: 2 }).departureVelocityKmPerSecond, vector(19.176379088371, -29.004900444759, 0.092141324695), 9);
    expectVector(solveLambertIzzo(SUN_MU, sunR1, sunR2, 138240000, { revolutions: 2, isLowPath: false }).departureVelocityKmPerSecond, vector(-0.706086722919, -33.583059717486, 0.112412555410), 9);
  });

  it("round-trips well-conditioned published transfers through kepler-core", () => {
    const cases = [
      { r1: vector(15945.34, 0, 0), r2: vector(12214.83899, 10249.46731, 0), tof: 4560 },
      { r1: vector(5000, 10000, 2100), r2: vector(-14600, 2500, 7000), tof: 3600 },
      { r1: vector(2249.171260, 1898.007100, 5639.599193), r2: vector(1744.495443, -4601.556054, 4043.864391), tof: 1618.5 }
    ];
    for (const fixture of cases) {
      const solution = solveLambertIzzo(EARTH_MU, fixture.r1, fixture.r2, fixture.tof);
      const propagated = propagateKepler(EARTH_MU, { positionKm: fixture.r1, velocityKmPerSecond: solution.departureVelocityKmPerSecond }, fixture.tof);
      expect(distance(propagated.positionKm, fixture.r2)).toBeLessThan(1e-6);
    }
  });

  it("refuses degenerate chords and bounded non-convergence explicitly", () => {
    expect(() => solveLambertIzzo(EARTH_MU, vector(7000, 0, 0), vector(7000, 0, 0), 3600)).toThrow(LambertGeometryError);
    expect(() => solveLambertIzzo(EARTH_MU, vector(7000, 0, 0), vector(8000, 0, 0), 3600)).toThrow(LambertGeometryError);
    expect(() => solveLambertIzzo(EARTH_MU, vector(7000, 0, 0), vector(-8000, 0, 0), 3600)).toThrow(LambertGeometryError);
    expect(() => solveLambertIzzo(EARTH_MU, vector(5000, 10000, 2100), vector(-14600, 2500, 7000), 3600, { maxIterations: 0 })).toThrow(LambertConvergenceError);
  });
});
