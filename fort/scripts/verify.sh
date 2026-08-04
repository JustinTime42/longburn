#!/bin/bash
# Manyhalls verifier. Exit 0 only after every required quality gate passes.
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

    if [ -n "${FORT_SEAT:-}" ]; then
      fort/scripts/emit.sh "$@" -a "$actor" -s "$FORT_SEAT" || status=$?
    else
      fort/scripts/emit.sh "$@" -a "$actor" || status=$?
    fi

    if [ "$status" -ne 0 ]; then
      printf 'WARNING: failed to emit verifier event (exit %s); continuing verification.\n' "$status" >&2
    fi
  fi
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
    emit verify.fail "Verifier failed at ${step}" -p "$payload"
    exit "$status"
  fi
}

emit verify.run "Verifier started" -p '{"steps":["typecheck","lint","test","shellcheck"]}'
run_step typecheck npm run typecheck
run_step lint npm run lint
run_step test npm run test
# -x follows sourced files so fort/scripts/lib/* is linted too, not skipped.
run_step shellcheck shellcheck -x bin/fort-init fort/scripts/*.sh fort/scripts/lib/*.sh
emit verify.pass "Verifier passed" -p '{"steps":["typecheck","lint","test","shellcheck"]}'
