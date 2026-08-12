---
key: verifiers-and-exit-code-discipline
status: active
superseded-by: null
tier: core
scope:
  seats: [all]
  topics: [verify.sh, ci, test-counts, cwd-drift]
  beads: [longburn-4y6, longburn-gc6]
provenance:
  source: "migrated from fort/remember.md:17, d194384 (three seats bitten by the pipe; the 40j.1 false-107 incident)"
  declared-by: vardis
  date: 2026-08-11
  origin: trusted
---
RECORD ONLY BARE-OBSERVED EXIT CODES: run `fort/scripts/verify.sh` bare when
recording its exit, because a piped invocation reports the PIPE's status, not
the script's (three seats have been bitten). CHECK THE VITEST RUN PATH in the
output before trusting any "post-merge verify from main": session cwd drifts to
worktrees and the verifier runs wherever you are (this bit the Mayor three
times, so `cd /home/justin/dev/longburn &&` first, always). NO SEAT EVER
HAND-WRITES TEST COUNTS into events: since gc6 (2026-08-07) verify.sh machine-
parses and emits observed counts itself, null on parse failure, never a guess
(the 40j.1 false-107 incident is why). The verifier's stages are typecheck,
lint, test and shellcheck; CI at `.github/workflows/verify.yml` runs three code
legs only and does not yet run the fort verifier (longburn-4y6). The cvc waiver
era ended 2026-08-06: exit 0 is the norm.
