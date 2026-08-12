---
key: emission-layer-catalog
status: active
superseded-by: null
tier: on-demand
scope:
  seats: [all]
  topics: [emission, causality, catalog, transport-fence]
  beads: [longburn-din.5, longburn-kyr]
provenance:
  source: "migrated from fort/remember.md:5, d194384 (din.5, closed by the Overseer 2026-08-08)"
  declared-by: vardis
  date: 2026-08-11
  origin: trusted
---
The emission layer is governed by `docs/specs/emitted-state-catalog-v0.1.md` on
top of causality-invariant-design.md. Overseer rulings ON THE CATALOG: (1) the
delivery-guarantee split is RATIFIED, no-skip covers light-lagged classes only,
while observer-local classes (commandEcho, simClock) reconstruct via the H1
snapshot from the durable log and are never re-emitted stale; (2) watermark
ordering is VETOED, delivery is per-event arrival-time with NO cross-event
dependency at any tier ("news from the moon shouldn't wait for jupiter") and
globalPosition is a tie-breaker only; (3) ephemerides are never emitted
(client-side public math) and there is no live ship position by design, since
last report plus paper projection IS the product. Transport fence: the
fort-wide no-raw-outbound tripwire is RESTORED and stays until the AST fence
covers its surface. The kyr collision warning stands: the real ws/http adapter
WILL trip it, so widen the fence with-or-before that work and never reach for
an eslint-disable.
