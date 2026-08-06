#!/bin/bash
# Farlantern event emitter (longburn) — append-only stream for the future fortress visualizer.
# Usage: emit.sh <category> <detail> [-a actor] [-s seat] [-t target] [-p payload-json] [-T iso-timestamp]
# Works from the main checkout AND from any worktree (all append to the main repo's stream).
set -euo pipefail
category="$1"; detail="$2"; shift 2
actor="harness"; seat=""; target=""; payload="null"; ts="$(date -Is)"
while getopts "a:s:t:p:T:" opt; do
  case $opt in
    a) actor="$OPTARG";; s) seat="$OPTARG";; t) target="$OPTARG";;
    p) payload="$OPTARG";; T) ts="$OPTARG";;
    *) echo "Usage: emit.sh <category> <detail> [-a actor] [-s seat] [-t target] [-p payload-json] [-T iso-timestamp]" >&2; exit 2;;
  esac
done
# Resolve the MAIN repo root even when called from a linked worktree.
gitcommon=$(git rev-parse --git-common-dir 2>/dev/null || echo "/home/justin/dev/longburn/.git")
case "$gitcommon" in /*) :;; *) gitcommon="$(pwd)/$gitcommon";; esac
mainroot="$(cd "$(dirname "$gitcommon")" && pwd)"
dir="$mainroot/fort/events"
mkdir -p "$dir"
file="$dir/events-$(date -d "$ts" +%F 2>/dev/null || date +%F).jsonl"
line=$(jq -nc --arg ts "$ts" --arg actor "$actor" --arg seat "$seat" \
  --arg category "$category" --arg target "$target" --arg detail "$detail" \
  --argjson payload "$payload" \
  '{ts:$ts, actor:$actor, seat:(if $seat=="" then null else $seat end),
    category:$category, target:(if $target=="" then null else $target end),
    detail:$detail, payload:$payload}')
( flock -x 9; printf '%s\n' "$line" >&9 ) 9>>"$file"
