#!/bin/bash
# Launch Veyra Flintledger (Forge seat) on a bead, in an isolated worktree, with event emission.
# Usage: fort/scripts/forge.sh <bead-id> [model]   (model defaults to gpt-5.6-terra per ladder)
# Encodes the hard-won headless-codex recipe: stdin MUST be </dev/null, worktree MUST be trusted.
set -euo pipefail
bead="$1"; model="${2:-gpt-5.6-terra}"
root="/home/justin/dev/longburn"
emit="$root/fort/scripts/emit.sh"
suffix="${bead##*-}"
wt="/home/justin/dev/longburn-worktrees/$suffix"

title=$(bd show "$bead" 2>/dev/null | head -2 | tail -1 || echo "$bead")
bd update "$bead" --claim -a veyra >/dev/null 2>&1 || true
"$emit" bead.claimed "Veyra claims $bead" -a veyra -s forge -t "$bead"

if [ ! -d "$wt" ]; then
  git -C "$root" worktree add "$wt" -b "bead/$suffix" >/dev/null
fi

"$emit" session.start "Veyra begins work on $bead ($model)" -a veyra -s forge -t "$bead" -p "{\"model\":\"$model\"}"
desc=$(bd show "$bead" 2>/dev/null || echo "See bead $bead")
set +e
(cd "$wt" && codex exec --sandbox workspace-write \
  -c "projects.\"$wt\".trust_level=\"trusted\"" \
  -m "$model" \
  "You are Orin Slowfire (they/them), holder of the Forge of Farlantern, the Longburn fort. Read AGENTS.md, fort/charter.md, fort/remember.md, fort/seats/forge.md in this directory, then implement this bead and drive verifiers green. Do not merge, push, or touch .env*/deploy scripts. Commit path-scoped with message starting '$bead: '. Report what you did, verification results, and surprises.

BEAD:
$desc" </dev/null 2>&1) | tee "/tmp/forge-$suffix.log" | tail -30
rc=${PIPESTATUS[0]}
set -e
"$emit" session.end "Veyra's session on $bead ended (exit $rc)" -a veyra -s forge -t "$bead" -p "{\"exit\":$rc,\"log\":\"/tmp/forge-$suffix.log\"}"
echo "--- forge.sh: session ended (exit $rc). Worktree: $wt  Log: /tmp/forge-$suffix.log"
echo "--- Next: harness verifies (build+test in $wt), Warden reviews, then merge."
