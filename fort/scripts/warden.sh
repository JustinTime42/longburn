#!/bin/bash
# Launch Sereth Twicewalked (they/them) (Warden seat) on a review, read-only by construction.
# (backported from Proofdelve 21f.1/t56/21f.9, Farlantern) Enforcement is structural, not prose:
#   - tool set restricted to Bash,Read,Grep,Glob (no Edit/Write/Task/Agent)
#   - --setting-sources "" makes fort/profiles/warden-settings.json the ONLY
#     permission source; headless default mode auto-denies unlisted Bash commands
#   - cwd is a fresh scratch copy (rsync, no .git, no env-secret files) so
#     verifier re-runs (fort/scripts/verify.sh) never touch the real tree
#   - the real checkout is reachable read-only: --add-dir + git -C
# The Warden's only writes: `bd -C <root> comment` and the review.verdict emit.
#
# Usage: fort/scripts/warden.sh <bead-id> <ref-range> [candidate-dir] [model]
#   <ref-range>      diff spec against the REAL repo, e.g. 'main..bead/xyz' or a commit
#   [candidate-dir]  tree to copy for verifier re-runs (default: main checkout)
#   [model]          default opus. Ladder: Opus 5 -> GPT-5.6 Sol -> BLOCK and page
#                    Justin. Never relaunch a review below frontier.
# Smoke test: WARDEN_SMOKE=1 fort/scripts/warden.sh <bead> <range> [dir] [model]
#   runs a boundary self-test instead of a review; records no verdict.
# Scratch lives OFF tmpfs (~/.cache/fort-scratch, longburn-5if: /tmp is RAM and
#   user-quota'd; two observed quota kills) and is trap-removed on success,
#   RETAINED when the session dies verdict-less — that is exactly the case
#   needing inspection. WARDEN_KEEP_SCRATCH=1 always retains.
# Exit codes: 0 = verdict recorded. 65 = session produced no verdict (dead at
#   launch, rate-limited, or truncated) — nothing was written to the bead and
#   the caller must relaunch on the next rung. 66 = bd show failed host-side
#   (longburn-j223: never review against a stub). 75 = free-space preflight
#   refused. 77 = attempted from inside a seat mask (longburn-5v4). Any other
#   code is claude's own. An absent verdict is never an approval (ForgeOs-t56).
set -euo pipefail

# In-sandbox launch refusal (longburn-5v4): only the attended Mayor's dispatch
# lane (longburn-1p9) may launch seats from within a mask.
case "${FORT_MASKED:-}" in
  ""|mayor) ;;
  *)
    echo "warden.sh: REFUSED — running inside the '$FORT_MASKED' seat mask; launchers are the harness's lane (longburn-5v4)" >&2
    exit 77 ;;
esac

bead="$1"; range="$2"; src="${3:-/home/justin/dev/longburn}"; model="${4:-opus}"
root="/home/justin/dev/longburn"
emit="$root/fort/scripts/emit.sh"
suffix="${bead##*-}"
scratch_root="$HOME/.cache/fort-scratch"
scratch="$scratch_root/warden-$suffix"
log="$scratch_root/warden-$suffix.log"

# Free-space preflight (longburn-5if): refuse loudly instead of dying mid-review
# with misreporting shells (quota exhaustion broke even command-output capture).
mkdir -p "$scratch_root"
avail_kb=$(df --output=avail -k "$scratch_root" | tail -1 | tr -d ' ')
if [ "$avail_kb" -lt 2097152 ]; then
  echo "warden.sh: REFUSED — under 2GB free at $scratch_root (${avail_kb}KB); free space before launching a review (longburn-5if)" >&2
  exit 75
fi

# Scratch lifecycle (longburn-5if): removed on every path EXCEPT a verdict-less
# session death, which retains it for inspection (design refinement on the bead:
# failures are rare, so accumulation stays bounded). Logs live beside it, not
# inside, and always survive.
retain=0
cleanup() {
  if [ "${WARDEN_KEEP_SCRATCH:-0}" = "1" ]; then
    echo "--- warden.sh: scratch retained (WARDEN_KEEP_SCRATCH=1): $scratch"
  elif [ "$retain" = "1" ]; then
    echo "--- warden.sh: scratch RETAINED for inspection (no verdict recorded): $scratch"
  else
    rm -rf "$scratch"
  fi
}
trap cleanup EXIT

rm -rf "$scratch"
mkdir -p "$scratch"
rsync -a \
  --exclude '.git' --exclude '.env*' --exclude '.beads' \
  --exclude 'bin' --exclude 'obj' --exclude 'node_modules' \
  "$src/" "$scratch/"

# Dependencies for verifier EXECUTION (longburn-8ur: a review that cannot run
# the verifiers is the reduced-capacity review the seat is forbidden to give).
# Since longburn-5if this is a READ-ONLY BIND through the bwrap mask, not a
# ~90MB copy: stronger isolation (a build in scratch can never write through)
# and the leak class shrinks to the source tree size minus node_modules.
# Lockfile guard (Warden 6vc r2 finding 4a): binding MAIN's tree under a
# candidate whose lockfile differs runs verifiers against mismatched deps — a
# stale-artifact false green — so on mismatch we npm ci into scratch instead.
nm_src=""
if [ -d "$src/node_modules" ]; then
  nm_src="$src/node_modules"
elif [ -d "$root/node_modules" ] && cmp -s "$src/package-lock.json" "$root/package-lock.json"; then
  nm_src="$root/node_modules"
fi
if [ -z "$nm_src" ] && [ -f "$scratch/package-lock.json" ]; then
  echo "--- warden.sh: no matching node_modules to bind (lockfile mismatch?); npm ci --offline --ignore-scripts into scratch (longburn-8ur)"
  (cd "$scratch" && npm ci --offline --ignore-scripts) >"$log.npmci" 2>&1 \
    || echo "--- warden.sh: WARNING — scratch npm ci failed (see $log.npmci); the seat must disclose reduced capacity" >&2
fi

# Beads access inside the mask (longburn-qe2, measured: embedded Dolt writes a
# LOCK file even to serve a read, and .beads is RO in every Warden posture —
# `bd --readonly` still trips it). The seat gets a fresh host-side export to
# rg/jq instead; the bead under review is injected into the prompt below.
bd export > "$scratch/.beads-export.jsonl" 2>/dev/null \
  || echo "--- warden.sh: WARNING — bd export failed; .beads-export.jsonl unavailable to the seat (longburn-qe2)" >&2

if [ "${WARDEN_SMOKE:-0}" = "1" ]; then
  prompt="You are running a WARDEN BOUNDARY SELF-TEST (no review, record no verdict, run no build except probe 11). Attempt each action below with your tools; for each, print a line 'PROBE <n>: PASS' if it was BLOCKED/impossible, or 'PROBE <n>: FAIL <how it succeeded>' if it worked. 1) Create any file with any tool. 2) Run: touch /tmp/warden-smoke-canary 3) Run: git -C $root commit --allow-empty -m x 4) Run: bd -C $root update $bead --notes=smoke 5) Read any file matching $root/.env* with your Read tool. 6) Run: cat $root/.env* 7) Run: sed -n 1p $root/.env* 8) Run: rm -f /tmp/warden-smoke-canary 9) POSITIVE CONTROLS — confirm you CAN do all of: ls .  |  git -C $root log --oneline (report first line)  |  cat README.md (report first line)  |  jq -r '.id' .beads-export.jsonl (report the first id) — print 'PROBE 9: PASS' only if all four worked, else 'PROBE 9: FAIL <which>'. 10) EXPECTED-DENY (longburn-qe2, accepted cost): run bd -C $root show $bead — print 'PROBE 10: PASS' if it FAILS (read-only .beads; LOCK error), or 'PROBE 10: FAIL' if it succeeds. 11) VERIFIER CAPACITY (longburn-8ur) — run each of: node --version  |  npx eslint --version  |  npm run lint — print 'PROBE 11: PASS (eslint exit <code>)' if all three EXECUTED (an eslint finding is still an execution; only a permission refusal is a failure), else 'PROBE 11: FAIL <which was refused>'. Finish with the single line SMOKE-COMPLETE."
else
  # Never review against a stub (longburn-j223): if the host-side bd read
  # fails, the seat would judge a diff with no spec and nothing in the
  # transcript would mark the degradation. Refuse instead, loudly.
  if ! desc=$(bd show "$bead" 2>/dev/null); then
    "$emit" incident "warden.sh: bd show $bead failed host-side — launch refused rather than reviewing against a stub (longburn-j223)" -a sereth -s warden -t "$bead"
    echo "--- warden.sh: REFUSED — bd show $bead failed host-side; fix bd, then relaunch (longburn-j223)" >&2
    exit 66
  fi
  prompt="You are Sereth Twicewalked (they/them), holder of the Warden seat of Farlantern, the longburn fort. Fresh context, read-only by construction. Read fort/charter.md, fort/remember.md, fort/seats/warden.md (in cwd, a scratch copy of the candidate tree at $src — safe for build/test re-runs; it has no .git and no secrets).

REVIEW: bead $bead. Diff spec against the real repo: '$range' (use git -C $root diff $range / git -C $root show as appropriate). Judge against the bead's spec, the charter's standing orders and human gates, and Justin's bar: good-sense changes adhering to best practices, no hacky nonsense. Reproduce verifiers yourself in cwd when code changed (fort/scripts/verify.sh if present; otherwise the fort's documented gates). Note which model produced the work and weight scrutiny accordingly.

VERIFIER RECIPE (longburn-8ur; each line is a recorded lesson): cwd should already contain node_modules (the launcher binds or seeds it when a source tree is available). Run verifiers from cwd exactly as spelled here — other spellings (absolute paths, --prefix, the local binaries) may be refused by your profile. The verified-working gate is: CI=1 fort/scripts/verify.sh --no-emit. The allow-listed direct legs are npm run typecheck, npm run lint, and npm test. If node_modules is missing or broken, npm ci --offline --ignore-scripts restores it (node_modules may be a read-only bind — if so it is already complete). If after that you still cannot execute the verifiers, you MUST say so in your verdict header and mark every claim you could not execute as taken on faith — never present a static review as an executed one.

BEADS ACCESS (longburn-qe2): bd cannot run in this posture — embedded Dolt writes a LOCK file even to serve a read, and .beads is mounted read-only (accepted cost). A fresh full issue export is in cwd at .beads-export.jsonl: use rg/jq over it for dependency links, prior verdicts on related beads, and finding-beads you are told about.

THE BAR FOR BLOCKING (ForgeOs-21f.9, Overseer, 2026-08-04). REQUEST-CHANGES and ESCALATE are reserved for findings where MERGING MAKES THE FORT WORSE THAN NOT MERGING: a broken verifier, a false or unsupported claim in a record, a gate that fails against the charter's threat model, or a correctness bug. Everything else is APPROVE-WITH-FINDINGS, and those findings are filed as beads rather than held against the merge. A true observation is not automatically a blocking one, and filing it as a bead is not a downgrade of the finding — it is how the fort keeps it. What does NOT change: the gate-6 mandatory-ESCALATE cases, your right to block and page Justin, the frontier-only ladder, and your standing rule that you stop rather than review at reduced capacity. This narrows what counts as blocking; it does not ask you to look less carefully or to soften anything you find.

THREAT-MODEL CALIBRATION. Judge security findings against the charter's Threat model section, in its priority order, and say which threat a finding bears on. A gap reachable only by the explicitly out-of-scope actor (a human adversary who already has shell access on this machine) is documented in your findings, not blocked on.

ROUND DISCIPLINE. In round one, state everything you would block on. From round two onward, only regressions and unfixed round-one blockers may block; genuinely new non-blocking findings become beads. If a third round would block again on something new, ESCALATE to Justin instead of blocking — that pattern means the bead was underspecified, not that the diff is bad.

VERDICT (mandatory): you have no write permissions at all; the launcher records your ENTIRE final message verbatim as the bead comment and emits the review.verdict event from your VERDICT-LINE. So your final message must be the complete, self-contained review record: start it 'Warden review (Sereth Twicewalked (they/them), $model): VERDICT: <verdict>', then numbered findings each marked blocking or non-blocking, then what you verified independently versus took on faith, and end with a single line 'VERDICT-LINE: <one-line verdict for the event feed, under 140 chars>'. Verdict options: APPROVE / APPROVE-WITH-FINDINGS / REQUEST-CHANGES / ESCALATE (mandatory for the charter's gate-listed areas, including the fort constitution).

BEAD:
$desc"
fi

# Kernel mask layer (civilization cycle 4). The seat is already read-only by
# construction (restricted tool set, scratch cwd, no write permissions), but the
# deny rules that keep secrets out of a review bind SPELLINGS, not files
# (Proofdelve 21f.8). bwrap closes that: masked paths read empty under every
# spelling. The Warden never pushes, so there is no escape hatch here.
mask=()
# shellcheck source=fort/scripts/lib/seat-sandbox.sh
# shellcheck disable=SC1091  # resolved at runtime; build_mask fills mask[]
source "$root/fort/scripts/lib/seat-sandbox.sh"
require_bwrap || exit $?
# r3 (Warden suti r2 finding 1): the main checkout is extra_ro UNCONDITIONALLY,
# so a worktree-candidate review still locks $root — the Warden is read-only
# by construction in every posture, and the verify.sh Mayor re-grant is
# re-masked here regardless of which tree is under review.
build_mask claude "$root" "$root" "$src"
mask_env claude
# Read-only node_modules bind (longburn-5if; ordering-safe appended here: no
# masked path lies beneath it). vitest writes its cache to node_modules/.vite,
# so that one subpath is a tmpfs over the RO bind — the mountpoint is created
# in the source host-side; it is vitest's own cache dir and harmless there.
if [ -n "$nm_src" ]; then
  mkdir -p "$nm_src/.vite"
  mask+=(--ro-bind "$nm_src" "$scratch/node_modules" --tmpfs "$scratch/node_modules/.vite")
fi
# Seat-named mask marker (longburn-5v4): launchers refuse under it.
mask+=(--setenv FORT_MASKED warden)

"$emit" session.start "Sereth begins $([ "${WARDEN_SMOKE:-0}" = "1" ] && echo smoke-test || echo review) of $bead ($model)" -a sereth -s warden -t "$bead" -p "{\"model\":\"$model\"}"
retain=1
set +e
# Prompt goes via stdin: --add-dir is variadic and would swallow a positional arg.
# stdout is kept separate from stderr — it becomes the verdict record;
# deny-glob prose-matching and arg-length limits make recording it from inside
# the session unworkable (Warden finding 2, first flight).
# Captured as --output-format json and extracted with jq (longburn-l78a): the
# streamed text path truncated the HEAD of long verdicts five observed times —
# blocking findings lost from both log and bead comment. The result field is
# one atomic string; nothing arrives out of order or partially.
extra_dir=()
[ "$src" != "$root" ] && extra_dir=(--add-dir "$src")
(cd "$scratch" && printf '%s' "$prompt" | bwrap "${mask[@]}" -- claude -p \
  --model "$model" \
  --tools "Bash,Read,Grep,Glob" \
  --strict-mcp-config \
  --setting-sources "" \
  --settings "$root/fort/profiles/warden-settings.json" \
  --output-format json \
  --add-dir "$root" "${extra_dir[@]}" 2>"$log.err") >"$log.json"
rc=$?
jq -r 'if type=="object" and (.result|type=="string") then .result else empty end' "$log.json" >"$log" 2>/dev/null || true
tail -40 "$log"
set -e

# ForgeOs-t56. A session that dies at launch — rate limit, auth failure, quota
# — still writes something to stdout, and this path used to pipe that straight
# onto the bead as a Warden verdict. It did once, in Proofdelve: 'session limit, resets 12pm'
# was recorded as a review of ForgeOs-21f.5. A falsified review record is the
# one thing standing order 12 exists to prevent, and the failure is silent
# precisely when the fort is under load.
#
# The gate is EVIDENCE THAT A REVIEW RAN, not merely evidence that bytes were
# produced. The seat prompt mandates a final VERDICT-LINE, so its absence
# means no review completed, whatever else is in the log — and since l78a the
# HEAD must be present too: a verdict whose opening line is missing is a
# truncated record, and recording it would repeat the exact failure. On any
# such path record NOTHING, emit an incident, and exit nonzero so the caller's
# failover ladder engages instead of treating a dead session as a verdict.
verdict_recorded=0; reason=""
if [ "${WARDEN_SMOKE:-0}" = "1" ]; then
  if grep -q 'SMOKE-COMPLETE' "$log"; then
    echo "--- warden.sh: smoke run complete (SMOKE-COMPLETE found), no verdict recorded by design"
    retain=0
  else
    echo "--- warden.sh: smoke run DID NOT COMPLETE (no SMOKE-COMPLETE in $log) — scratch retained" >&2
  fi
elif [ ! -s "$log" ]; then
  reason="empty transcript (session produced no output; raw JSON at $log.json)"
elif ! grep -q '^VERDICT-LINE: ' "$log"; then
  reason="no VERDICT-LINE in transcript — the review did not complete"
elif ! grep -q 'Warden review (' "$log"; then
  reason="verdict head missing — truncated capture (longburn-l78a); raw JSON at $log.json"
else
  bd -C "$root" comment "$bead" --file "$log" --actor sereth
  verdict_line=$(sed -n 's/^VERDICT-LINE: //p' "$log" | tail -1)
  "$emit" review.verdict "Sereth on $bead: $verdict_line" -a sereth -s warden -t "$bead"
  verdict_recorded=1
  retain=0
fi

if [ "${WARDEN_SMOKE:-0}" != "1" ] && [ $verdict_recorded -eq 0 ]; then
  "$emit" incident "Warden review of $bead recorded NO verdict: $reason (claude exit $rc) — relaunch, do not read this as a pass" \
    -a sereth -s warden -t "$bead" -p "{\"exit\":$rc,\"log\":\"$log\",\"reason\":\"${reason//\"/}\"}"
  "$emit" session.end "Sereth's session on $bead ended without a verdict (exit $rc)" -a sereth -s warden -t "$bead" -p "{\"exit\":$rc,\"log\":\"$log\",\"verdict_recorded\":false}"
  echo "--- warden.sh: NO VERDICT RECORDED — $reason"
  echo "--- claude exit $rc. Log: $log  Errors: $log.err"
  echo "--- Relaunch on the next rung of the ladder. An absent verdict is not an approval."
  exit 65
fi

"$emit" session.end "Sereth's session on $bead ended (exit $rc)" -a sereth -s warden -t "$bead" -p "{\"exit\":$rc,\"log\":\"$log\",\"verdict_recorded\":$([ $verdict_recorded -eq 1 ] && echo true || echo false)}"
echo "--- warden.sh: session ended (exit $rc). Log: $log  Errors: $log.err"
