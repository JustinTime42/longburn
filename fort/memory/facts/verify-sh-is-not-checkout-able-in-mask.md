---
key: verify-sh-is-not-checkout-able-in-mask
status: active
superseded-by: null
tier: core
scope:
  seats: [mayor]
  topics: [mask, git, merge, verify.sh, seat-sandbox]
  beads: [longburn-3195, longburn-a6a]
provenance:
  source: "observed 2026-08-11 during the longburn-wtx7 merge; mechanism confirmed against fort/scripts/lib/seat-sandbox.sh:58 and :163"
  declared-by: vardis
  date: 2026-08-11
  origin: trusted
---
A MASKED SEAT CANNOT GIT-CHECKOUT ANY CHANGE TO `fort/scripts/verify.sh`.
`fort/scripts/` is a read-only directory bind with verify.sh re-granted as a
read-write FILE bind on top, and git replaces files by unlinking them, which
needs write permission on the DIRECTORY. So `git switch`, `git merge`,
`git checkout -- <path>`, `reset --hard` and `stash` all fail or half-apply
across any commit that touches verify.sh, in both directions. Symptom:
"unable to unlink old 'fort/scripts/verify.sh': Read-only file system", or a
switch that silently leaves the file at the other branch's content and then
refuses every subsequent operation as a phantom local modification. FORWARD
WORKAROUND, valid only when the worktree copy already equals the target:
`git add fort/scripts/verify.sh`, switch, then `git branch -f <target> <src>`
with ancestry asserted by `merge-base --is-ancestor`. Moving verify.sh
BACKWARD has no in-mask path. The repair is longburn-3195 and it is Regent
work, since lib/seat-sandbox.sh is kernel-RO here.
