#!/bin/bash
# Farlantern verifier (longburn). Exit 0 only after every required quality gate passes.
#
# THE VERIFIER ITSELF. fort/scripts/verify.sh is a read-only shim that execs this
# file and forwards its arguments and exit status; run either, they are the same
# gate. It lives out here because fort/scripts is a whole-directory read-only
# bind in every seat mask (Shape B, fortkit-6ovg / fortkit-x9ou) and the verifier
# is the one tool in that set the fort evolves as it works.
#
# WRITE BOUNDARIES, which are the whole reason for the split:
#   Mayor    — writable. Verifier changes are Mayor work (cycle 7).
#   Forge    — READ-ONLY, by an explicit carve-out in the codex posture of
#              fort/scripts/lib/seat-sandbox.sh. Without that line this file
#              would be writable to the unattended seat, because $root is
#              read-write to it apart from the carve-outs — the wrinkle Shape B
#              would otherwise have introduced while closing a worse one.
#   Warden   — read-only for free: she passes her whole checkout as extra_ro.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

emit_events=true
if [ "${CI:-}" != "" ]; then
  emit_events=false
fi

while [ "$#" -gt 0 ]; do
  case "$1" in
    --no-emit) emit_events=false ;;
    *)
      echo "Usage: fort/scripts/verify.sh [--no-emit]" >&2
      exit 2
      ;;
  esac
  shift
done

emit() {
  if [ "$emit_events" = true ]; then
    local actor="${FORT_ACTOR:-harness}"
    local status=0
    local extra=()

    if [ -n "${FORT_SEAT:-}" ]; then
      extra+=(-s "$FORT_SEAT")
    fi
    if [ -n "${FORT_TARGET:-}" ]; then
      extra+=(-t "$FORT_TARGET")
    fi

    fort/scripts/emit.sh "$@" -a "$actor" "${extra[@]}" || status=$?

    if [ "$status" -ne 0 ]; then
      printf 'WARNING: failed to emit verifier event (exit %s); continuing verification.\n' "$status" >&2
    fi
  fi
}

# Machine-parsed test counts (longburn-gc6): the verifier reports what it OBSERVED,
# so no launcher or agent ever hand-writes a count into the event stream again.
# On any parse failure the payload carries null — an honest unknown, never a guess.
test_output_file="$(mktemp)"
trap 'rm -f "$test_output_file"' EXIT

observed_test_counts() {
  local line passed skipped
  line="$(sed 's/\x1b\[[0-9;]*m//g' "$test_output_file" | grep -E '^[[:space:]]*Tests[[:space:]]' | tail -n 1)" || true
  passed="$(printf '%s' "${line:-}" | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+')" || true
  skipped="$(printf '%s' "${line:-}" | grep -oE '[0-9]+ skipped' | grep -oE '[0-9]+')" || true
  if [ -n "${passed:-}" ]; then
    printf '{"passed":%s,"skipped":%s}' "$passed" "${skipped:-0}"
  else
    printf 'null'
  fi
}

run_tests_capturing() {
  # pipefail (set above) makes the pipeline report npm's exit, not tee's.
  npm run test 2>&1 | tee "$test_output_file"
}

run_step() {
  local step="$1"
  shift

  if "$@"; then
    return 0
  else
    local status=$?
    local payload="{\"step\":\"${step}\",\"exitCode\":${status}}"
    if [ "$status" -eq 127 ]; then
      payload="{\"step\":\"${step}\",\"exitCode\":${status},\"toolMissing\":true}"
    fi
    if [ "$step" = test ]; then
      payload="{\"step\":\"${step}\",\"exitCode\":${status},\"tests\":$(observed_test_counts)}"
    fi
    emit verify.fail "Verifier failed at ${step}" -p "$payload"
    exit "$status"
  fi
}

emit verify.run "Verifier started" -p '{"steps":["memory-lint","typecheck","lint","test","shellcheck"]}'
# memory-lint runs first and is cheap: it is the mechanical enforcement of the
# facts ledger's schema, its per-seat core budget, and the
# origin:untrusted-never-core control (fortkit docs/specs/memory.md 4.4).
# Without it, every one of those is prose.
run_step memory-lint node fort/memory/memory-lint.mjs
run_step typecheck npm run typecheck
run_step lint npm run lint
run_step test run_tests_capturing
# -x follows sourced files so fort/scripts/lib/* is linted too, not skipped.
run_step shellcheck shellcheck -x fort/scripts/*.sh fort/scripts/lib/*.sh
emit verify.pass "Verifier passed" -p "{\"steps\":[\"memory-lint\",\"typecheck\",\"lint\",\"test\",\"shellcheck\"],\"tests\":$(observed_test_counts)}"
