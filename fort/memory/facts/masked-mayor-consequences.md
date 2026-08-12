---
key: masked-mayor-consequences
status: active
superseded-by: null
tier: on-demand
scope:
  seats: [mayor]
  topics: [seat-machinery, mask, dispatch, beads]
  beads: [longburn-1p9, longburn-qe2, longburn-6vc]
provenance:
  source: "migrated from fort/remember.md:27, d194384 (1p9 smoke-verified 2026-08-06)"
  declared-by: vardis
  date: 2026-08-11
  origin: trusted
---
A masked Mayor cannot `git push` by key file (agent-held keys still sign after
`ssh-add`; otherwise push is the Overseer's lane). `MAYOR_NO_MASK=1` runs
unmasked and emits an incident event. Dispatching the Forge works: since 6vc,
`~/.codex` is a live rw DIRECTORY bind (`config.toml` RO on top,
`history.jsonl` nulled, `sessions/` and `log/` on tmpfs), and `auth.json` is
deliberately writable so Codex token rotation and host re-login survive
(longburn-1p9). One known in-mask gap: `bd` reads fail against the RO-mounted
`.beads` because Dolt writes a LOCK even to read (longburn-qe2); warden.sh
injects the bead spec from outside the mask as the mitigation.
