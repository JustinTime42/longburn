---
key: codex-launch-recipe
status: active
superseded-by: null
tier: on-demand
scope:
  seats: [mayor, forge]
  topics: [codex, launchers, dispatch]
  beads: []
provenance:
  source: "migrated from fort/remember.md:15, d194384 (inherited from Proofdelve's scars)"
  declared-by: vardis
  date: 2026-08-11
  origin: trusted
---
Codex launches from inside the worktree:
`--sandbox workspace-write -c 'projects."<worktree>".trust_level="trusted"' -m <model> "<prompt>" </dev/null`.
The stdin redirect is MANDATORY: without it `codex exec` hangs forever.
