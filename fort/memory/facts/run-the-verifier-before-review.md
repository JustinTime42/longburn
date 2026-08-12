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
  source: "migrated from fort/remember.md:25, d194384 (seat machinery, added 2026-08-04)"
  declared-by: vardis
  date: 2026-08-11
  origin: trusted
---
`fort/scripts/verify.sh` is fail-fast; `--no-emit` or an empty `CI=` suppresses
its events. Run it before asking for review. Its exit-code and test-count
discipline is in the fact `verifiers-and-exit-code-discipline`.
