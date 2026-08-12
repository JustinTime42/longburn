---
key: watcher-and-verdict-capture-lessons
status: superseded
superseded-by: launcher-batch-contract-cycle-8
tier: on-demand
scope:
  seats: [mayor, warden]
  topics: [seat-machinery, warden.sh, monitoring, scratch]
  beads: [longburn-l78a, longburn-5if]
provenance:
  source: "migrated from fort/remember.md:29, d194384 (2026-08-08, session 13); retired by fort/remember.md:7 and :45 (Regent edict 8, cycle 8)"
  declared-by: vardis
  date: 2026-08-11
  origin: trusted
---
SUPERSEDED by the fact `launcher-batch-contract-cycle-8`. Two of its three
instructions are now wrong and one moved: scratch lives at
`~/.cache/fort-scratch` with a working cleanup trap, so the `/tmp/warden-*`
sweep is OBSOLETE; verdict capture is atomic, so the transcript-reconstruction
recipe is OBSOLETE. The Monitor lesson survives and its active carrier is the
fact `long-run-seat-watching`.

As written: "Plain background `while ps` watchers get reaped mid-session, so
use the harness Monitor tool (persistent) on the detached seat pid instead; the
seat itself is never affected. warden.sh TRUNCATES THE HEAD of long verdicts in
both the log and the bead comment (longburn-l78a, observed twice); the
VERDICT-LINE and Disposition survive, so before dispatching a Forge remediation
round, reconstruct the blocker list from those into the bead's notes so r2 has
an authoritative spec. Warden scratch dirs: sweep /tmp/warden-* after each
review (the 5if '~12G unidentified' was mostly these; 227 dirs = 11G
recovered)."
