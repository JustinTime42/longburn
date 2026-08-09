#!/bin/bash
# Launch Orin Slowfire (Forge seat) on a bead, in an isolated worktree, with event emission.
# Usage: fort/scripts/forge.sh <bead-id> [model]   (model defaults to gpt-5.6-terra per ladder)
# Encodes the hard-won headless-codex recipe: stdin MUST be </dev/null, worktree MUST be trusted.
set -euo pipefail

# In-sandbox launch refusal (longburn-5v4): RO binds protect launcher CONTENT,
# not EXECUTION. The marker names the seat whose mask we are inside; only the
# attended Mayor's dispatch lane (longburn-1p9) may launch seats from within a
# mask. A Forge or Warden session reaching for a launcher is refused loudly.
case "${FORT_MASKED:-}" in
  ""|mayor) ;;
  *)
    echo "forge.sh: REFUSED — running inside the '$FORT_MASKED' seat mask; launchers are the harness's lane (longburn-5v4)" >&2
    exit 77 ;;
esac

bead="$1"; model="${2:-gpt-5.6-terra}"
root="/home/justin/dev/longburn"
emit="$root/fort/scripts/emit.sh"
suffix="${bead##*-}"
wt="/home/justin/dev/longburn-worktrees/$suffix"

bd update "$bead" --claim -a orin >/dev/null 2>&1 || true
"$emit" bead.claimed "Orin claims $bead" -a orin -s forge -t "$bead"

if [ ! -d "$wt" ]; then
  git -C "$root" worktree add "$wt" -b "bead/$suffix" >/dev/null
fi

# Seed dependencies host-side (longburn-fol, observed twice: brp f7, a0p f8).
# The sandbox refuses to execute the worktree-local esbuild postinstall, so an
# in-sandbox npm ci fails and the Forge improvises symlinks into the primary
# checkout. --ignore-scripts is the proven recipe (Mayor-side success on brp;
# same flags as the Warden's verifier recipe). A depless Forge reinvents the
# symlink hack, so a failed seed refuses the launch rather than degrading.
if [ -f "$wt/package-lock.json" ] && [ ! -d "$wt/node_modules" ]; then
  echo "--- forge.sh: seeding $wt/node_modules (npm ci --ignore-scripts; longburn-fol)"
  if ! (cd "$wt" && npm ci --ignore-scripts) >"/tmp/forge-$suffix-npmci.log" 2>&1; then
    "$emit" incident "Forge launch refused: npm ci --ignore-scripts failed in $wt (longburn-fol; log /tmp/forge-$suffix-npmci.log)" -a orin -s forge -t "$bead"
    echo "forge.sh: REFUSED — could not seed node_modules in $wt; see /tmp/forge-$suffix-npmci.log" >&2
    exit 75
  fi
fi

# ---------------------------------------------------------------------------
# Kernel mask layer — shared builder since longburn-kyl (the inline mask this
# replaces had the ordering invariant inverted and never got the cycle-5 $HOME
# inversion; Warden 6vc r2 findings 5+7). Codex's Linux sandbox does NOT
# enforce deny-read (upstream openai/codex#11316), so policy alone is not a
# boundary; bwrap masks the inode, under every path spelling.
mask=()
# shellcheck source=fort/scripts/lib/seat-sandbox.sh
# shellcheck disable=SC1091  # resolved at runtime; build_mask fills mask[]
source "$root/fort/scripts/lib/seat-sandbox.sh"
if ! require_bwrap; then
  "$emit" incident "Forge launch refused: bwrap missing, kernel mask layer unavailable" -s forge -t "$bead"
  exit 78
fi
build_mask codex "$root"
# Worktree-side binds the lib cannot know about (scoping every RW tree is the
# general fix, fortkit-1q9; until then they are appended here, and appending
# is ordering-safe because no lib-masked path lies beneath these subtrees):
#   - the worktree's constitution copies stay read-only to the unattended seat
#     (parity with the inline mask this replaced; gate 4 mechanically), and the
#     Mayor's verify.sh re-grant is re-masked — the Forge edits verify.sh only
#     via a bead in its own diff, never the host-executed main copy;
#   - worktree secrets are swept like the root's (file masks stack last).
for c in .claude fort/charter.md fort/seats fort/profiles fort/scripts; do
  [ -e "$wt/$c" ] && mask+=(--ro-bind "$wt/$c" "$wt/$c")
done
[ -e "$root/fort/scripts/verify.sh" ] && mask+=(--ro-bind "$root/fort/scripts/verify.sh" "$root/fort/scripts/verify.sh")
for envf in "$wt"/.env*; do
  [ -e "$envf" ] && mask+=(--ro-bind /dev/null "$envf")
done
mask_env codex
# Attribution as mechanism, not convention (longburn-f9p): verify.sh reads
# these when emitting, so verify.pass events attribute and target correctly
# without the session remembering to hand-type anything.
mask+=(--setenv FORT_ACTOR orin --setenv FORT_SEAT forge --setenv FORT_TARGET "$bead")
# Seat-named mask marker (longburn-5v4): launchers refuse under it (top of file).
mask+=(--setenv FORT_MASKED forge)
# ---------------------------------------------------------------------------

"$emit" session.start "Orin begins work on $bead ($model)" -a orin -s forge -t "$bead" -p "{\"model\":\"$model\"}"
desc=$(bd show "$bead" 2>/dev/null || echo "See bead $bead")
set +e
# writable_roots: a linked worktree's git metadata, the beads Dolt store, and the
# event stream all live in the MAIN repo — outside the worktree sandbox root.
# Without these, commit/bd/emit all fail (first-run scar, 2026-08-04).
(cd "$wt" && bwrap "${mask[@]}" -- codex exec --sandbox workspace-write \
  -c "projects.\"$wt\".trust_level=\"trusted\"" \
  -c "sandbox_workspace_write.writable_roots=[\"$root/.git\",\"$root/.beads\",\"$root/fort/events\"]" \
  -m "$model" \
  "You are Orin Slowfire (they/them), holder of the Forge of Farlantern, the Longburn fort. Read AGENTS.md, fort/charter.md, fort/remember.md, fort/seats/forge.md in this directory, then implement this bead and drive verifiers green.

LANE RULES (longburn-6vc; each encodes a recorded failure, not a hypothetical):
1. Plan visibly (standing order 3): your handoff must open with the plan you executed and any numbered clarifying questions. If a question is blocking, STOP without implementing and commit a handoff containing only the questions — a stopped session with good questions is a success, not a failure. A question is blocking ONLY if proceeding under either reading would produce work that must be thrown away; otherwise state the reading you chose, proceed, and flag it in the handoff.
2. Never launch a review or another seat: fort/scripts/warden.sh, forge.sh, and mayor.sh are the harness's lane — warden.sh and mayor.sh cannot authenticate inside your sandbox (Claude credentials are masked), and forge.sh refuses under the FORT_MASKED guard. (fort/scripts/verify.sh and fort/scripts/emit.sh are part of YOUR normal work — run them.) When implementation is done, commit, write your handoff, and END THE SESSION; the harness verifies and dispatches review. Do not prescribe review ranges in your handoff — the harness owns them.
3. Your handoff's Model: line must read exactly: $model — this is the launcher-supplied ladder rung, the fort's system of record for failover accounting. Never substitute a product or marketing name.
4. Commit your handoff before ending the session; an uncommitted handoff is a lost record. Name it fort/handoffs/forge-<date>-$suffix.md, and if that file already exists (an earlier round today), use a NEW file with -roundN appended — never overwrite a prior round's record (SO 7). The handoff opens with a '# Handoff: ...' title line whose timestamp is the ACTUAL writing time (unique per round, never copied from an earlier handoff), states the hash of the commit(s) you made among its verified facts, and carries an explicit 'Unrequested behavior changes:' line — 'none' if none.
5. Do not merge, push, or touch .env*/deploy scripts. Commit path-scoped with message starting '$bead: '. Never 'git add .' or 'git add -A'.
6. Record verify.sh's exit code only if observed BARE — a piped invocation (| tail, | head) reports the pipe's exit status, not the script's (three seats have filed false verifier claims off this trap).

Report what you did, verification results, and surprises.

BEAD:
$desc" </dev/null 2>&1) | tee "/tmp/forge-$suffix.log" | tail -30
rc=${PIPESTATUS[0]}
set -e
"$emit" session.end "Orin's session on $bead ended (exit $rc)" -a orin -s forge -t "$bead" -p "{\"exit\":$rc,\"log\":\"/tmp/forge-$suffix.log\"}"
echo "--- forge.sh: session ended (exit $rc). Worktree: $wt  Log: /tmp/forge-$suffix.log"
echo "--- Next: harness verifies (fort/scripts/verify.sh in $wt), Warden reviews, then merge."
