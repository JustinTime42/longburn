---
key: merges-run-from-the-main-checkout
status: active
superseded-by: null
tier: core
scope:
  seats: [mayor]
  topics: [git, merge, cwd-drift, worktrees]
  beads: [longburn-ifih, longburn-ia14, longburn-5h49]
provenance:
  source: "migrated from fort/remember.md:9, d194384 (fifth cwd bite 2026-08-10; fourth 2026-08-09)"
  declared-by: vardis
  date: 2026-08-11
  origin: trusted
---
MERGES RUN FROM THE MAIN CHECKOUT, ALWAYS, in the explicit-path form
`git -C /home/justin/dev/longburn`. Fifth bite 2026-08-10: the ia14 merge
landed on bead/9hi7 after a live-Postgres `cd` into that worktree; the fourth
was 5h49 on bead/din.7.3, 2026-08-09. Both were corrected with incident pairs
on the event stream. Prose has now failed five times, so longburn-ifih files
the mechanical merge guard. Until it lands, every merge and every verify
carries its own explicit path (`git -C`, or a fresh `cd` IN THE SAME COMMAND),
and you read the vitest RUN path before trusting a verify.
