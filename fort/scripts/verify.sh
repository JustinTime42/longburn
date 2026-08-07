#!/bin/bash
# Farlantern verifier (longburn). Exit 0 only after every required quality gate passes.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
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

emit verify.run "Verifier started" -p '{"steps":["typecheck","lint","test","shellcheck"]}'
run_step typecheck npm run typecheck
run_step lint npm run lint
run_step test run_tests_capturing
# -x follows sourced files so fort/scripts/lib/* is linted too, not skipped.
run_step shellcheck shellcheck -x fort/scripts/*.sh fort/scripts/lib/*.sh
emit verify.pass "Verifier passed" -p "{\"steps\":[\"typecheck\",\"lint\",\"test\",\"shellcheck\"],\"tests\":$(observed_test_counts)}"
