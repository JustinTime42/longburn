---
key: worktree-sandbox-scar
status: active
superseded-by: null
tier: on-demand
scope:
  seats: [mayor, forge]
  topics: [codex, forge.sh, worktrees, sandbox]
  beads: []
provenance:
  source: "migrated from fort/remember.md:16, d194384 (2026-08-04, first Forge run)"
  declared-by: vardis
  date: 2026-08-11
  origin: trusted
---
A linked worktree's git metadata (`<main>/.git/worktrees/<name>/`), the beads
Dolt store (`<main>/.beads/`) and the event stream (`<main>/fort/events/`) all
live in the MAIN repo, outside the codex workspace-write root. Without
`-c 'sandbox_workspace_write.writable_roots=[...]'` covering those three paths,
the Forge can implement but cannot commit, claim or close beads, or emit
events. forge.sh now sets them.
