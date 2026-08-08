# Emitted-State Catalog v0.1 — what the T0 player may see, and when

Status: Mayor draft under the Overseer-approved din.5 decomposition (2026-08-07/08).
The two pre-settled decisions below (stored-position rule, idempotent delivery) were
approved with the decomposition; the catalog's product-visible calls (§2.5, §2.6) are
flagged in the Mayor's report for cheap veto before din.5.1 merges.
Author: Vardis Slowfathom (Mayor). Bead: longburn-din.5.1.
Governing texts: causality-invariant-design.md (the invariant, the harness, fail-closed),
flight-plan-model-v0.1.md §7 (planning never lagged; reports return at c),
authoritative-worldline-v0.1.md (positions, arrival), GDD §4.5/§6, standing order 12.
Interface-shape guidance, not implementation: the Forge owns the code.

## 1. The envelope (every outbound message, no exceptions)

```
EmittedMessage {
  messageId          // unique, stable across redelivery (idempotence key)
  observerId         // the observer this message is addressed to, as data
                     // (added 2026-08-08 per Warden din.5.1 f5 / gw1 f5: E2's
                     // per-observer cursor needs identity as a field, never
                     // parsed out of messageId)
  class              // one of §2's classes
  payload            // class-specific, validated
  eventTimeMs        // sim time of the underlying event (youngest, if aggregate)
  eventPosition      // STORED position from the event record — never re-queried
  emissionTimeMs     // sim time the gate released it
  observerPosition   // observer worldline at emissionTimeMs
  stalenessMs        // emissionTimeMs - eventTimeMs, server-computed
}
```

- **Stored-position rule (settled, Warden 1ls r2 f6):** `eventPosition` is copied from the
  persisted event, never recomputed from a resolver. At `arrivalRecorded` the stored
  terminal position and the body resolver legitimately disagree by up to 3.3 light-seconds;
  re-querying would understate the light cone there.
- **Youngest-event rule:** an aggregate's provenance is its youngest constituent event.
- **Staleness is server truth:** the client renders `stalenessMs`, never computes it.
- **Delivery is idempotent (settled, 3n9 f3):** `messageId` + a per-observer monotone
  emission cursor; retries re-enter the gate and re-validate, so a duplicate can only
  leave at a legal tick. No three-state result; `sent:false` plus redelivery is the model.
- Per-observer ordering: monotone by `emissionTimeMs`; ties break by log order.

## 2. The catalog

| # | Class | Source events | Lag |
|---|-------|--------------|-----|
| 2.1 | Ship report | burnStarted, burnEnded, arrivalRecorded, departureRecorded | c from stored event position to observer |
| 2.2 | Command outcome report | planRevisionApplied, planRevisionRefused | c from the ship (the outcome happens at arrival) back to observer |
| 2.3 | Command echo | commandIssued | none — the event happens AT the observer's HQ (staleness 0) |
| 2.4 | Market event | din.6's market events | c from the market's host body (reserved; din.6 fills in) |
| 2.5 | Sim clock | current sim time at HQ | none — observer-local context, no remote information |
| 2.6 | (not emitted) Body ephemerides | — | client-computed public math |
| 2.7 | (not emitted) Live ship position | — | does not exist for the player, by design |

- **2.2** is the flight-plan spec's ruling made mechanical: validity is judged at the ship
  at arrival; the applied/refused notice travels back at c. The player learns their
  revision's fate one light-round-trip after issuing, never sooner.
- **2.3**: issuing a command is something the player did at HQ; echoing it is staleness 0.
  The echo is the client's authority for "what I have asked for."
- **2.6 — stated so nobody "lags" the planets:** planetary positions are deterministic
  public math (the shared ephemerides model); they carry no event information. The client
  computes them locally. Lagging them would be gamey noise, not physics (pillar 1).
- **2.7 — the honest gap:** the server NEVER emits a ship position fresher than light
  allows, and it does not emit periodic position telemetry at all in T0. What the player
  sees of "where is my ship" is: the last received report (2.1/2.2) plus the client's own
  advisory projection from the plan echo (2.3) — the planner's projection is paper, drawn
  client-side, labeled advisory. This IS the product experience of light-lag (GDD: lag on
  ALL displayed info) — the map shows where your ship was, and where the paper says it
  should be, never where it is.
- **The plan itself is never lagged** (permanent ruling, flight-plan-model §7.3): the
  client's plan view derives from 2.3 echoes plus 2.2 outcomes, all locally held. The
  server emits no separate "plan state" channel; there is nothing lagged to emit.

## 3. Gate obligations (unchanged from causality-invariant-design.md, restated as scope)

Every class above exits through the one `CausalEmissionGate` choke point (E3 makes that
structural). The gate asserts the invariant on every message against the exact solve,
schedules at `ceil`, fails closed with incident + counter on violation, malformed
provenance, or computation error. All times sim times. Conservative direction only.

## 3a. Failure-reason taxonomy (added 2026-08-08, Warden cav f3)

The gate's `EmissionFailureReason` members, which din.5.2/din.5.3 branch on. Every
failure fails closed (nothing sent) and records an incident; the reason classifies, it
never excuses.

| Reason | Meaning |
|---|---|
| `invalid-provenance` | A time failed validation (non-negative safe-integer sim ms) before comparison — includes NaN and malformed decodes |
| `invalid-position` | A position was non-finite or otherwise unusable, wherever sampled (event, arrival iterates, or emission time — Warden cav f1) |
| `light-cone-failure` | The arrival-time solve failed to converge inside its hard iteration cap. (A solve that *errors* on a non-finite arrival sample reports `invalid-position` — the bad sample is the cause; clarified 2026-08-08, Warden w35 f4, so the two rows no longer claim the same event) |
| `early-emission` | The invariant itself would be violated: emission before the earliest legal tick |
| `invalid-envelope` | The EmittedMessage failed schema validation (bad payload, empty observerId, reserved class) |
| `transport-failure` | The transport layer reported failure after the gate released the message; the message may already be on the wire — retries re-enter the gate and are legal duplicates (idempotent delivery, §1) |

One gate-level test per member is the required bar (longburn-w35) — this set is
control-flow input, not just log vocabulary.

## 4. Out of scope (fence, SO 13)

Multi-observer topology (T2+), out-of-band channel defenses (§4.5 analysis), relativistic
corrections, market payload design (din.6), notification transport (din.7 — din.7.1
consumes 2.1/2.2/2.4 arrival instants), client rendering of staleness (din.8).
