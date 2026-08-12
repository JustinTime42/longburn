---
key: launcher-batch-edict-8-acceptance
status: active
superseded-by: null
tier: on-demand
scope:
  seats: [all]
  topics: [seat-machinery, launchers, edict, warden.sh, forge.sh]
  beads: [longburn-s4kg, longburn-5if, longburn-l78a, longburn-fol, longburn-5v4]
provenance:
  source: "migrated from fort/remember.md:7, d194384 (Regent edict 8, 2026-08-09, longburn-s4kg)"
  declared-by: vardis
  date: 2026-08-11
  origin: trusted
---
Regent edict 8 fixed the launcher batch: 5if (scratch and logs now under
`~/.cache/fort-scratch`, cleanup trap works, so sweeping `/tmp/warden-*` is
OBSOLETE), l78a (verdict heads survive intact in both the log and the bead
comment, so the transcript-recovery recipe is obsolete), fol (forge.sh
self-seeds worktree node_modules via `npm ci --ignore-scripts`), 5v4
(launchers refuse nested in-mask launches; the Mayor's legacy `FORT_MASKED=1`
marker is allowed through, per mid-edict amendment 1cdbe07 after the guard
briefly killed the Mayor's dispatch lane), plus f9p/fvq/kyl/8ur/qe2/wsf/j223.
Acceptance was observed on the first post-edict mill cycle (din.6.3). The
contract this edict established is recorded in the fact
`launcher-batch-contract-cycle-8`; the practices it retired are in the
superseded fact `watcher-and-verdict-capture-lessons`.
