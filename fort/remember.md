# Longburn operational facts (inject every session)

- **Working name: LONGBURN** (established 2026-08-03; repo `longburn`; GitHub org free at naming time; .io/.game/.space showed available via whois — registrar checkout still pending, human bead). Name may change; the fort is FARLANTERN, named at the Founding Moot 2026-08-03.
- **Founding spec**: `docs/specs/longburn-gdd-v0.1.md` (GDD v0.1) + `docs/specs/gdd-review-notes.md` (five review findings, incl. the virtual-clock rule and the Tier-0 fail-reading precommitment — both now standing orders 10 and 14).
- **Current tier: Tier 0** (GDD §7): one player, one ship, Earth/Moon/Mars real ephemerides, 1:1 time, commit-and-burn, light-lag on all displayed info, one fake market, notifications, 2D vector plot. Everything else is out of scope and gets filed, not built.
- **Stack (per GDD §6)**: Node/TypeScript authoritative server, single continuous sim loop, Postgres, event-sourced, seeded RNG; thin web client (Capacitor wrap later — out of T0 scope); WebSocket subscriptions + REST commands.
- **The three day-one invariants**: sim time is an input (never wall clock); determinism (seeded RNG only); causality (no info faster than c — mechanical test). See standing orders 10-12.
- **Competitor intel**: `oldlight.io` — live browser game, "slow multiplayer strategy in a shared galaxy," async persistent, dev-logging since ~June 2026. Nearly the same thesis, different execution (abstract galaxy vs real Sol physics). Required reading; study bead filed. Their existence validates the market and denies us the name Oldlight.
- **Codex launch recipe** (inherited from Proofdelve's scars): cd into the worktree, `--sandbox workspace-write -c 'projects."<worktree>".trust_level="trusted"' -m <model> "<prompt>" </dev/null` — the stdin redirect is mandatory or codex exec hangs forever.
- No verifiers exist yet (greenfield): CI-from-commit-one is a founding bead; until it lands, the harness runs checks manually and says so.
