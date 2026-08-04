# Ephemerides for Tier 0

**Decision date:** 2026-08-04
**Bead:** `longburn-7xl`
**Status:** accepted for implementation by `longburn-din.1`

## Decision

Use the MIT-licensed [`astronomy-engine` 2.1.19](https://github.com/cosinekitty/astronomy/blob/master/source/js/package.json) package as the Tier 0 runtime ephemeris provider. Pin its exact version in the lockfile when `longburn-din.1` implements the ephemerides module.

The module will query the library using an explicit simulation instant expressed as UTC days since J2000, never a host clock or an omitted/default time. Its adapter will return **heliocentric, J2000 EQJ Cartesian state vectors** in the sim's chosen distance and velocity units for Sun, Earth, Moon, and Mars. The adapter, rather than callers, owns unit conversion from Astronomy Engine's AU and AU/day values. `HelioState` supplies both position and velocity in that frame; it explicitly supports heliocentric vectors for the required bodies. [Astronomy Engine JavaScript reference](https://github.com/cosinekitty/astronomy/tree/master/source/js#heliostatebody-date--statevector)

The Sun state is deliberately queried rather than assumed to be zero. The library documents the heliocentric frame as non-inertial because the Sun accelerates under planetary gravity. That distinction is small for Tier 0 but keeps the provider's contract honest.

This is a Tier 0 rendering and patched-conic input source, not an n-body propagator or a navigation-grade trajectory system. The GDD says full n-body is out of scope.

## Why this choice

Astronomy Engine is authored in TypeScript, ships an ESM export and bundled type declarations, and supports both Node.js and browser consumers. It is therefore a direct fit for the authoritative TypeScript server without a native build, WebAssembly boundary, kernel loader, or runtime download. [JavaScript/TypeScript distribution](https://github.com/cosinekitty/astronomy/tree/master/source/js#astronomy-engine-javascript--typescript)

It supplies heliocentric and geocentric Cartesian vectors for the Sun, Moon, and planets, reports a compact JavaScript implementation (about 116 KB minified), and states an accuracy target of plus or minus one arcminute. Its maintainers test it against NOVAS and JPL Horizons. That is adequate to begin a patched-conic Tier 0 prototype, subject to the project-specific validation gate below. [Project accuracy and validation statement](https://github.com/cosinekitty/astronomy#overview)

Passing a numeric J2000-day value is also compatible with the fort's clock invariant: the library accepts a number of UTC days since J2000, and therefore need not construct or read the current JavaScript `Date`. [Time input contract](https://github.com/cosinekitty/astronomy/tree/master/source/js#maketimedate--astrotime)

## Validation gate for `longburn-din.1`

Before this provider is accepted, add checked-in reference fixtures generated once from JPL Horizons **VECTORS**, using these fixed settings:

- targets: Sun (`10`), Earth (`399`), Moon (`301`), Mars (`499`);
- center: Sun (`500@10`), reference plane: `FRAME` (ICRF/J2000), no light-time or aberration correction;
- dates: a documented fixed set spanning the Tier 0 supported epoch, including both lunar perigee/apogee and an Earth-Mars conjunction sample;
- output: position and velocity, preserving Horizons' source timestamp and query parameters alongside the fixtures.

Horizons documents `VECTORS` as Cartesian state-vector output intended for dynamical studies and programming, and supports state-vector output through `VEC_TABLE=2`. It is a reference-data build input only, never a runtime game dependency. [JPL Horizons API](https://ssd-api.jpl.nasa.gov/doc/horizons.html)

The contract tests must compare the adapter in the same origin, orientation, and units against those fixtures. The test must establish and document absolute position and velocity error for each body. Acceptance is contingent on errors that remain comfortably below the corresponding patched-conic sphere-of-influence scale over the Tier 0 epoch; the exact thresholds must be proposed in the implementation bead with the observed Horizons deltas, rather than invented in this spike. It must also prove byte-for-byte equal results for repeated calls with the same input. A provider failure is a test failure, not a reason to relax the fixture.

## Alternatives rejected for Tier 0

| Option | Result | Reason |
| --- | --- | --- |
| NASA SPICE kernels through a JavaScript/WASM port | Defer | NASA distributes the official toolkit for native C platforms, not JavaScript. A port adds an unproven runtime boundary and kernel lifecycle to a four-body Tier 0 problem. The compact DE440s kernel alone is 31 MB. Keep SPICE as the future escalation path if the comparison gate fails or mission-grade fidelity becomes a product need. [NAIF C toolkit platforms](https://naif.jpl.nasa.gov/naif/toolkit_C.html), [DE440s size](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/spk/planets/) |
| Direct VSOP87/Meeus implementation | Reject | It would make Longburn own difficult celestial-mechanics code, particularly lunar state vectors, and still require independent reference validation. Astronomy Engine already packages a compact truncated VSOP87-derived implementation with a TypeScript API and published validation approach. |
| Checked-in precomputed tables | Defer as fallback | Tables are deterministic and can use Horizons-quality data, but introduce an epoch range, interpolation policy, binary/data provenance, and update workflow before the spike proves they are needed. Generate them only if the selected provider misses the agreed Horizon comparison gate. |
| Calling Horizons during play | Reject | It would make the authoritative simulation network-dependent and weaken replayability. Horizons is appropriate for offline fixture generation only. |

## Upgrade path

If the validation gate fails, do not silently swap algorithms. File a new bead to choose between (1) a versioned, build-generated Horizons state-vector table with documented interpolation/error bounds and (2) a maintained SPICE/WASM integration. That bead must retain the same fixture contract and deterministic input/output boundary.
