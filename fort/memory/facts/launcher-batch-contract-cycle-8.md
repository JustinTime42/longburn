---
key: launcher-batch-contract-cycle-8
status: active
superseded-by: null
tier: on-demand
scope:
  seats: [all]
  topics: [seat-machinery, launchers, warden.sh, forge.sh, scratch, beads]
  beads: [longburn-s4kg, longburn-5if, longburn-l78a, longburn-5v4, longburn-qe2, longburn-j223]
provenance:
  source: "migrated from fort/remember.md:45, d194384 (Regent edict, cycle 8, work order longburn-s4kg, 2026-08-08)"
  declared-by: vardis
  date: 2026-08-11
  origin: trusted
---
warden.sh and forge.sh were rebuilt in one pass and the operational contract
changed in four ways every seat should know. (1) WARDEN SCRATCH LIVES AT
`~/.cache/fort-scratch/`, NOT /tmp (5if): off-tmpfs, roughly 4MB per review
(node_modules is a read-only bwrap bind with a tmpfs over `.vite`, never a
copy), trap-removed on success, RETAINED with its path printed when a session
dies verdict-less; logs (`warden-<suffix>.log`, `.log.json`, `.log.err`) live
beside the scratch and always survive. `/tmp/warden-*` should now stay at zero
and a nonzero count is a regression. (2) VERDICTS ARE CAPTURED ATOMICALLY
(l78a): `claude -p --output-format json` then jq-extracted, and the launcher
REFUSES to record a verdict whose head (`Warden review (`) or `VERDICT-LINE` is
missing: a truncated verdict is exit 65, never a bead comment. (3) FORT_MASKED
IS SEAT-NAMED (`mayor`/`forge`/`warden`, 5v4) and all three launchers refuse at
top under `forge`/`warden`; only the Mayor's 1p9 dispatch lane passes. (4)
forge.sh SOURCES `lib/seat-sandbox.sh` (`build_mask codex`, kyl), so the Forge
gained the cycle-5 $HOME inversion and exports FORT_ACTOR/FORT_SEAT/FORT_TARGET
(f9p) and verify.pass events attribute mechanically. Also measured and
permanent: `bd --readonly` STILL WRITES THE DOLT LOCK, so no bd invocation
works against an RO `.beads`; the Warden reads a fresh `bd export` seeded at
`.beads-export.jsonl` in scratch (qe2), and probe 10 of the smoke asserts that
denial as EXPECTED (j223).
