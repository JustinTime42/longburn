---
key: live-postgres-verification-path
status: active
superseded-by: null
tier: core
scope:
  seats: [mayor]
  topics: [postgres, verification, review, database]
  beads: [longburn-uso1, longburn-1ti]
provenance:
  source: "migrated from fort/remember.md:6, d194384 (works, 2026-08-08)"
  declared-by: vardis
  date: 2026-08-11
  origin: trusted
---
SANDBOX GREEN ALONE IS INSUFFICIENT FOR DB CODE. The Mayor RUNS THE LIVE
POSTGRES PATH PRE-REVIEW for any DB-touching bead: it caught a harness
regression (uso1 r3) that both sandbox verify and read-only review passed.
Test instance at 127.0.0.1:5433 (quadlet longburn-667, running on this host;
user longburn_test/longburn_test). Recipe: create a fresh DB via psql, apply
`db/migrations/*.sql` in order, then
`LONGBURN_TEST_DATABASE_URL=... npx vitest run test/event-store.postgres.integration.test.mjs`.
Putting this in CI is longburn-1ti.
