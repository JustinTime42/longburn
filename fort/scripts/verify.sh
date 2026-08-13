#!/bin/bash
# Farlantern verifier (longburn). Exit 0 only after every required quality gate passes.
#
# ENTRY POINT ONLY. The verifier itself is scripts/verify-impl.sh. This file is a
# read-only bind inside a read-only directory and no seat can edit it; the
# verifier the fort evolves lives one directory up, where the Mayor can edit it
# and the Forge cannot.
#
# WHY (fortkit-6ovg and fortkit-x9ou, SHAPE B, Overseer ruling 2026-08-12).
# Cycle 7 bound fort/scripts read-only as a DIRECTORY and re-bound verify.sh
# read-write inside it. That does not work: Edit, `sed -i`, `git checkout` and
# `git merge` all rewrite a file by creating or unlinking a SIBLING, and the
# directory was read-only — so for a whole cycle `test -w` said TRUE in three
# forts while every real edit failed on a temp path nobody was looking at.
# Shape A inverted it — writable directory, every file bound individually — and
# that made each FILE immutable while leaving the DIRECTORY movable. The harness
# measured exactly that: unlink=NO, rename=YES. A seat could rename fort/scripts
# aside, put its own directory in place, and ~/.local/bin/mayor would exec it ON
# THE HOST, UNMASKED. Per-file mounts protect the files, not the location.
# Shape B stops carving and starts MOVING: fort/scripts goes back to a
# whole-directory bind, which makes the directory a mount point that refuses
# rename, and the one file that must stay mutable leaves the locked directory.
#
# `exec` is safe HERE and is not a licence to use it in a launcher: this script
# installs no trap and does nothing after the call, so there is nothing for exec
# to discard. Every launcher with an EXIT trap must run its child and propagate
# the status instead — exec at the tail is what stopped bin/regent emitting
# edict.ended for two days (fortkit-nvk) and still stops every mayor.sh emitting
# session.end (fortkit-t9iw).
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
impl="$repo_root/scripts/verify-impl.sh"
if [ ! -x "$impl" ]; then
  printf 'verify.sh: the verifier implementation is missing or not executable: %s\n' "$impl" >&2
  printf 'verify.sh: this file is only a shim (Shape B, fortkit-6ovg). NOTHING WAS VERIFIED.\n' >&2
  exit 70
fi
exec "$impl" "$@"
