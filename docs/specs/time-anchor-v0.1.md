# Persistent Time Anchor v0.1

Status: **APPROVED by the Overseer 2026-08-10 (session 15)** — §2's
genesis-facts ruling decided earlier the same day (longburn-9j0 notes); the
mechanism sections (§3–§6) approved as drafted, same session. Implementation
dispatches against this document. Bead: longburn-9j0 (blocks din.11). Origin: Warden r6g r1 f4
(their highest-priority follow-up before din.11) + Warden 4khr f6 (the
genesis-facts one-way door).

## 1. The problem

Per standing order 10 the sim takes time as an input and never reads the wall
clock. `HostTickDriver.start()` baselines its wall-clock reference to *now*,
so downtime — a crash, a deploy, a stop/start — simply does not elapse in the
sim. Sim time falls permanently behind wall time by the total stopped
duration. For a persistent 1:1 world with multi-week irreversible transits
this is a product break: "arrival March 3" silently becomes March 4 after a
day of accumulated outages, and the 1:1 promise drifts without bound or
record.

The fix is an absolute anchor: a durable genesis fact tying one wall-clock
instant to sim time zero, from which the correct sim time is *derived* at
every resume, so downtime is always made up and drift is structurally
impossible.

## 2. Stream genesis facts — all REQUIRED (Overseer ruling 2026-08-10)

Every simulation stream carries three genesis facts, set at stream creation,
immutable for the stream's life, `NOT NULL` in the store and required in the
type:

| Fact | Type | Meaning |
|---|---|---|
| `epochUtDaysSinceJ2000` | number (4khr's field, tightened) | where the world sits in the real solar system's calendar |
| `anchorWallClockMs` | integer, Unix epoch ms (UTC) | the wall instant corresponding to sim time 0 |
| `rateK` | positive safe integer | sim ms per wall ms; **1 pinned at world birth for production** (Overseer 2026-08-08: k is config for tests/playtests only, uniform-or-nothing — never per-domain) |

Ruling applied here (Warden 4khr f6, decided before world birth while free):
the optional-epoch legacy branch, nullable column, and fail-closed path that
4khr carried are **deleted**. The migration that adds `anchor_wall_clock_ms`
and `rate_k` tightens `epoch_ut_days_since_j2000` to `NOT NULL` in the same
step. No durable world data exists; after genesis this choice is fixed, which
is why it is made now. A stream that cannot supply all three facts is refused
at creation with a typed error — there is no legacy read path.

## 3. Derived sim time, never accumulated

The authoritative relation, exact integer arithmetic end to end:

```
simTimeTargetMs(wallMs) = (wallMs − anchorWallClockMs) × rateK
```

- Only the **host layer** (the tick driver) evaluates `wallMs`. The sim core
  remains wall-clock-free; SO 10/11 are untouched. The anchor turns SO 10's
  discipline into the repair: because the sim takes time as an input, catch-up
  is just normal ticking handed larger inputs.
- The driver **never re-baselines**. On every start it computes
  `deficit = simTimeTargetMs(now) − persistedSimTimeMs` and advances through
  the deficit with the normal fixed-step tick path — same step size, same
  code, same event ordering as live operation. There is no separate
  "catch-up mode" in the sim; only the host's pacing differs (as fast as it
  can, instead of paced to wall time).
- **Monotonicity guard:** if the target ever computes *behind* persisted sim
  time (host clock stepped backwards — NTP correction, operator error), the
  driver holds sim time still, emits an `incident` event with both readings,
  and resumes advancing only when the target passes persisted time. Sim time
  never rewinds; a rewound host clock is an incident, not an instruction.

## 4. Catch-up semantics

1. **Catch-up completes before command intake opens.** At T0 scale a
   multi-day deficit replays in seconds; serving commands against a
   still-catching-up world would let a player act on a sim instant that is
   about to be overtaken. One process, one gate: closed until
   `persistedSimTimeMs ≥ simTimeTargetMs(now) − one step`.
2. **Everything due during downtime happens during catch-up, in order, at its
   correct sim time.** Scheduled burns execute (irreversibly — pillar 2 does
   not pause for outages); market steps advance; in-flight plan revisions
   arrive and are validated at arrival; light-lagged reports come due. Log
   order arbitration is unchanged — these are ordinary ticks.
3. **Notifications are late but honest.** Earliest-permissible instants are
   sim facts and do not move. Wall-clock delivery happens after catch-up on
   the normal delivery pass; copy already names the event instant and the lag
   (notification-surface §2), so a late delivery reads as exactly what it is.
   No due wake is dropped (the no-skip guarantee is about existence).
4. **No re-anchoring, ever.** Amending the anchor to "forgive" downtime is
   forbidden for a production world — it would rewrite where every in-flight
   transit sits against the real calendar. Downtime is always made up; the
   1:1 promise holds globally or the incident is on the record.

## 5. Determinism obligation

The central property, stated as a test: **an interrupted run produces the
identical event log as an uninterrupted run** given the same stream genesis
facts and the same command arrivals. Stop/start is invisible in the log —
timing of host restarts may never leak into sim state (that would be a wall
clock reaching the sim by the side door).

## 6. Out of scope (filed, not built — SO 13/15)

- Serving reads during catch-up behind a consistency fence (matters at
  multi-player scale; T0 is one player and a seconds-long deficit).
- Bounded catch-up / load-shedding for very large deficits.
- Fractional or per-domain rates (uniform-or-nothing is a ruling, and no
  observed need exists for k < 1).

## 7. Test obligations

1. Restart after simulated downtime resumes to the derived target, not to a
   re-baselined now (the r6g gap, pinned).
2. A burn falling due mid-downtime executes exactly once, at its committed
   sim time, with correct event timestamps, and its notification delivers
   after restart with honest instants.
3. The §5 log-equivalence property: interrupted ≡ uninterrupted, fixed seed,
   same commands.
4. A k≠1 test world advances at exactly k sim-ms per wall-ms (integer pin,
   no float rate arithmetic).
5. Stream creation without any of the three genesis facts is refused with the
   typed error; the store rejects NULL at the column level (both layers
   asserted).
6. Host-clock regression: target behind persisted time holds sim time still
   and emits the incident (§3 guard).
