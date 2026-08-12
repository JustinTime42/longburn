---
key: kernel-mask-seat-boundaries
status: superseded
superseded-by: cycle7-write-boundaries
tier: on-demand
scope:
  seats: [all]
  topics: [seat-machinery, seat-sandbox, constitution, mask]
  beads: [longburn-a6a, longburn-6vc]
provenance:
  source: "migrated from fort/remember.md:26, d194384 (cycle 5 boundaries; the bullet declared itself 'Superseded in part' by the cycle 7 r2 correction at remember.md:31)"
  declared-by: vardis
  date: 2026-08-11
  origin: trusted
---
SUPERSEDED. Recorded as written, because standing order 7 discards nothing and
because a reader who finds this claim elsewhere needs to learn where truth
went. Current truth is the fact `cycle7-write-boundaries`.

As written: "All three seats now launch inside a kernel mask
(`fort/scripts/lib/seat-sandbox.sh`): secrets masked at the inode, so no path
spelling reaches them; `.claude/`, `fort/charter.md`, `fort/seats/`,
`fort/profiles/` and the global Claude config are READ-ONLY to every seat. The
mechanical constitution gate is complete for Forge and Warden but NOT for the
Mayor: `fort/scripts/` and worktree constitution copies are still
Mayor-writable (longburn-a6a, the repair bead). Until a6a lands, Mayor-side
constitution changes go through prose + Warden review + Overseer approval,
which is what 6vc actually followed (Overseer confirmed 2026-08-06: approved by
Justin, applied by a Mayor session)."

What reversed: charter and seat files are no longer kernel-RO to attended
seats, and `fort/scripts/` is no longer Mayor-writable. The a6a status split is
in the superseding fact.
