---
key: cycle7-write-boundaries
status: active
superseded-by: null
tier: core
scope:
  seats: [all]
  topics: [seat-machinery, seat-sandbox, constitution, charter, mask]
  beads: [longburn-suti, longburn-a6a]
provenance:
  source: "migrated from fort/remember.md:31, d194384 (cycle 7 r2 correction, Warden suti finding 3, appended 2026-08-08 per standing order 7); supersedes fort/remember.md:26"
  declared-by: vardis
  date: 2026-08-11
  origin: trusted
---
All three seats launch inside a kernel mask
(`fort/scripts/lib/seat-sandbox.sh`), with secrets masked at the inode so no
path spelling reaches them. Write boundaries as of cycle 7 r2, superseding the
fact `kernel-mask-seat-boundaries` IN BOTH DIRECTIONS:
`.claude/` and `fort/profiles/` remain kernel-RO to every seat, unchanged by
cycle 7. What cycle 7 reversed is the other two: `fort/charter.md` and
`fort/seats/` are PROSE-GATED for attended seats
(Overseer approval recorded on the amendment's bead plus a `charter.amended`
event), no longer kernel-RO. `fort/scripts/` is NO LONGER Mayor-writable: it is
kernel-RO with `verify.sh` alone re-granted to the Mayor, and the Warden's
whole-tree RO bind re-masks even that. longburn-a6a splits: the fort/scripts
half is resolved, the worktree-copy residual (constitution files writable under
longburn-worktrees/*) remains open on that bead. Operational consequence of
`.git/config` being RO: `git push -u`, `git remote add` and `git config` all
fail inside the mask, while plain `git push origin main` works.
