---
key: warden-reviews-are-launched
status: active
superseded-by: null
tier: on-demand
scope:
  seats: [mayor, warden]
  topics: [seat-machinery, warden.sh, review-flow]
  beads: []
provenance:
  source: "migrated from fort/remember.md:23, d194384 (seat machinery, added 2026-08-04, backport cycles 3-4)"
  declared-by: vardis
  date: 2026-08-11
  origin: trusted
---
Warden reviews are LAUNCHED, never improvised:
`fort/scripts/warden.sh <bead-id> <ref-range> [candidate-dir] [model]`. The
seat is read-only BY CONSTRUCTION (restricted tool set, `--setting-sources ""`
plus fort/profiles/warden-settings.json, a scratch-copy cwd, zero write
permissions). The launcher records the verdict as a bead comment and emits
`review.verdict` from the transcript's VERDICT-LINE. A session dead at launch
records NOTHING and exits nonzero so failover engages. Do not review by hand in
a Mayor session: that loses fresh context, the read-only guarantee, and the
recorded verdict.
