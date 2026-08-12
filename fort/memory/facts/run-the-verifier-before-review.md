---
key: run-the-verifier-before-review
status: active
superseded-by: null
tier: on-demand
scope:
  seats: [all]
  topics: [seat-machinery, verify.sh, review-flow]
  beads: []
provenance:
  source: "migrated from fort/remember.md:25, d194384 (seat machinery, added 2026-08-04); suppression rule corrected against verify.sh:9 per Warden finding 1 on longburn-wtx7, 2026-08-11"
  declared-by: vardis
  date: 2026-08-11
  origin: trusted
---
`fort/scripts/verify.sh` is fail-fast. Events are suppressed by `--no-emit` or
by a NON-EMPTY `CI` (verify.sh:9 is `[ "${CI:-}" != "" ]`), so `CI=1` suppresses
and a bare `CI=` does not. The recipe of record is `CI=1 ... --no-emit`. Run it
before asking for review. Its exit-code and test-count
discipline is in the fact `verifiers-and-exit-code-discipline`.
