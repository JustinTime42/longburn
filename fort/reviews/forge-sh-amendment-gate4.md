# Gate-4 Review: `forge.sh` Amendment

- Reviewer: Sereth Twicewalked (they/them), Warden of Farlantern
- Model: GPT-5.6 Sol failover (Opus rung session-limit failover)
- Date: 2026-08-04
- Scope: Gate 4, fort constitution (`fort/scripts/forge.sh` launcher and permission profile amendment)

## Findings

1. **The writable roots implement the recorded scar.** The Forge receives write access to the main repository's Git metadata, Beads store, and append-only event directory while product-code writes remain confined to the linked worktree. These are the three out-of-worktree locations identified in `fort/remember.md`.

2. **The full `.git` root is broad but proportionate here.** It permits changes to Git configuration and all common-repository metadata. Granting only `.git/worktrees` would not permit commits: linked-worktree commits also create objects, update refs and reflogs, and may create top-level Git lock files such as `packed-refs.lock`. A scratch probe with only `objects`, `refs`, `logs`, and `worktrees` writable completed the commit but still produced a `packed-refs.lock` permission error. Supporting normal Git behavior without a brittle list of implementation-specific paths therefore requires the common `.git` directory. This is an accepted capability of the trusted Forge seat, which is explicitly authorized to commit. The repository's configured hooks path is `.beads/hooks`, already within the separately required Beads root, so narrowing `.git` alone would not remove hook-write capability.

3. **The other behavior change is correct and bounded.** Replacing Veyra with Orin changes Beads ownership and event attribution, but it repairs Proofdelve copy drift and matches the charter's named Forge occupant. Worktree creation, branch naming, command execution, output pipeline, exit-code capture, and session lifecycle are otherwise unchanged.

4. **The headless launch invariants are preserved.** `</dev/null` remains attached to `codex exec`, and the existing per-worktree `trust_level="trusted"` override remains intact.

5. **The new permission override has no user-controlled interpolation.** Its paths derive from the launcher-owned constant `root`. Shell arguments remain quoted. The pre-existing trust override interpolates `wt`, which is derived from the caller-supplied bead suffix and is not TOML-escaped; a malformed local bead argument could make that override invalid. The model value is likewise embedded into JSON for event emission without JSON escaping. Both inputs come from the trusted local launcher operator, neither hazard is introduced or enlarged by this amendment, and neither blocks this Gate-4 approval. Input validation would be reasonable future hardening.

6. **Static syntax verification passes.** `bash -n fort/scripts/forge.sh` exits successfully.

## Verdict

**APPROVE.** The amendment resolves the linked-worktree sandbox failure, preserves the required Codex launch recipe, and makes only the separately justified Forge-seat attribution correction. The `.git` capability is security-sensitive but is the practical minimum root for reliable Git commits under this launcher.
