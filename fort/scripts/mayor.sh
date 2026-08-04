#!/bin/bash
# Talk to the Mayor. Usage: fort/scripts/mayor.sh  (add an alias: alias mayor='~/dev/ForgeOs/fort/scripts/mayor.sh')
REPO="$(git -C "$(dirname "$0")" rev-parse --show-toplevel 2>/dev/null || echo /home/justin/dev/longburn)"
cd "$REPO"
fort/scripts/emit.sh session.start "The Overseer summons Marrek" -a marrek -s mayor 2>/dev/null || true
trap 'fort/scripts/emit.sh session.end "Marrek'\''s audience with the Overseer ends" -a marrek -s mayor 2>/dev/null || true' EXIT
# Kernel mask layer (civilization cycle 4). Permission rules bind a SPELLING,
# not a file (measured, Proofdelve 21f.8): .e"n"v and .??v reach the same inode
# and no deny rule binds either. bwrap masks the inode, so every spelling of a
# masked path reads empty — including spellings nobody has thought of. This is
# what lets an interactive seat run with few or no prompts and still have a
# boundary. ~/.claude stays readable (this runtime's own credentials, this
# project's auto-memory, the session transcripts); its CONFIG is read-only so a
# session cannot rewrite the rules for the next one.
#
# ESCAPE HATCH: MAYOR_NO_MASK=1 runs unmasked. Needed today only for pushing —
# ~/.ssh is masked, so key-file auth cannot work inside (agent-held identities
# still sign; run `ssh-add` if you want push from inside the mask). Every
# unmasked launch emits an event, so the record shows which sessions ran
# without a kernel boundary.
source "$REPO/fort/scripts/lib/seat-sandbox.sh"
launch=(claude --append-system-prompt "You are Vardis Slowfathom (she/her), Mayor of Farlantern, the Longburn fort — the design, triage, and decomposition seat, and the seat Justin talks to. Follow fort/seats/mayor.md exactly: session-start protocol (read fort/charter.md, fort/remember.md, latest fort/handoffs/mayor-*.md, then bd ready and bd list), the standing orders in the charter, and the consensual handoff protocol at session end. You write specs, beads, and docs — never product code. When Justin gives intent, decompose it into a bead tree and present it for approval before filing. When he asks for status, use bd and fort/handoffs/ and answer concretely.")
if [ "${MAYOR_NO_MASK:-0}" = "1" ]; then
  fort/scripts/emit.sh incident "Mayor launched UNMASKED (MAYOR_NO_MASK=1) — no kernel boundary this session" -a vardis -s mayor 2>/dev/null || true
  exec "${launch[@]}"
fi
require_bwrap || exit $?
build_mask claude "$REPO"
mask_env claude
exec bwrap "${mask[@]}" -- "${launch[@]}"
