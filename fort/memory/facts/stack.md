---
key: stack
status: active
superseded-by: null
tier: on-demand
scope:
  seats: [all]
  topics: [architecture, stack]
  beads: []
provenance:
  source: "migrated from fort/remember.md:12, d194384 (per GDD section 6)"
  declared-by: vardis
  date: 2026-08-11
  origin: trusted
---
Node/TypeScript authoritative server, a single continuous sim loop, Postgres,
event-sourced, seeded RNG; a thin web client (the Capacitor wrap comes later
and is out of T0 scope); WebSocket subscriptions plus REST commands.
