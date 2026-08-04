# JPL Horizons VECTORS reference fixtures

Raw API responses fetched once, offline from the game runtime, per the validation
gate in `docs/decisions/ephemerides.md`. Never a runtime dependency.

**Fetched:** 2026-08-04, by the fort harness (Forge sandbox has no network; raw
data provisioned by the harness, unmodified — the `result` payloads are exactly
as Horizons returned them).

**Endpoint:** `https://ssd.jpl.nasa.gov/api/horizons.api`

**Query parameters (identical for all four bodies except `COMMAND`):**

| Param | Value |
| --- | --- |
| `format` | `json` |
| `COMMAND` | `'10'` sun.json, `'399'` earth.json, `'301'` moon.json, `'499'` mars.json |
| `OBJ_DATA` | `'NO'` |
| `MAKE_EPHEM` | `'YES'` |
| `EPHEM_TYPE` | `'VECTORS'` |
| `CENTER` | `'500@10'` (heliocentric) |
| `REF_PLANE` | `'FRAME'` (ICRF/J2000) |
| `VEC_CORR` | `'NONE'` (geometric states; no light-time/aberration) |
| `VEC_TABLE` | `'2'` (position + velocity) |
| `TIME_TYPE` | `'TDB'` |
| `OUT_UNITS` | `'KM-S'` |
| `START_TIME` | `'2026-01-01'` |
| `STOP_TIME` | `'2027-04-30'` |
| `STEP_SIZE` | `'5 d'` |

**Contents:** 97 epochs per body, Julian date TDB (first: JD 2461041.5 =
2026-Jan-01 00:00 TDB), positions km, velocities km/s. The range spans the
Tier 0 supported epoch and includes the 2026-01 Mars solar conjunction period,
the 2027-02 Earth–Mars opposition window, and ~17 lunar anomalistic cycles;
contract tests must identify and pin the specific perigee/apogee and
conjunction sample epochs from this data (min/max |moon − earth|) rather than
hard-coding dates.

**Timescale convention (decision doc, finding 1):** fixture epochs are TDB.
The adapter accepts UT days since J2000. Tests must derive the adapter UT input
for each fixture epoch via the documented TT↔TDB≈ and UT↔TT conventions and
record both values, so each comparison names one physical instant in both
scales.
