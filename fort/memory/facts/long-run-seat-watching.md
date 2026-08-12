---
key: long-run-seat-watching
status: active
superseded-by: null
tier: core
scope:
  seats: [mayor]
  topics: [launchers, monitoring, dispatch]
  beads: [longburn-din.6.4]
provenance:
  source: "migrated from fort/remember.md:8, d194384 (pattern refined 2026-08-10; incident 2026-08-09)"
  declared-by: vardis
  date: 2026-08-11
  origin: trusted
---
Launch forge.sh and warden.sh DETACHED (`nohup ... & disown`) and arm a harness
Monitor on the pid. DO NOT use Bash run_in_background for seat launches: on
2026-08-09 four harness-tracked background launches were externally stopped
mid-run (cause never identified, no OOM evidence; the incident is on the stream
targeting din.6.4), while detached runs completed normally throughout. Never
launch a seat session under a timeout that can kill it mid-bead.
