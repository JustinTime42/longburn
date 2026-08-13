#!/bin/bash
# Shared kernel-mask builder for seat launchers. Source this, call build_mask,
# then run: bwrap "${mask[@]}" -- <your command>
#
# MODE IS 0644 AND THAT IS THE DECISION, NOT AN OVERSIGHT (fortkit-n3bk finding
# 7, decided by the E8 sitting 2026-08-13). This file is SOURCED, never executed:
# no caller invokes it as a program, so the executable bit would grant a way to
# run it that nothing needs. All three forts' copies measured -rw-r--r-- on
# 2026-08-13, so there is no single-file mode change to explain and the gate-1
# escalation class the finding invoked does not apply. The shebang is kept for
# editors and ShellCheck, which is why it looks executable and is not.
#
# WHY THIS EXISTS (Proofdelve 21f.3/21f.5/21f.8, civilization cycle 4):
# Permission rules in both harnesses match the TEXT of a command, so a deny
# rule binds a SPELLING, not a file — measured six-for-six against obfuscated
# path forms (.e"n"v, .[e]nv, .??v all reach the same inode, none bind a rule).
# bwrap masks the inode. Every spelling of a masked path, including ones nobody
# has thought of, reads empty. That is why the kernel layer is the boundary and
# the deny lists are convenience.
#
# A masked FILE reads as EMPTY-AND-SUCCESSFUL, not as an error; on SELinux hosts
# the /dev/null bind may instead yield EACCES. Probes must assert byte counts and
# accept either outcome — never trust an "access denied" narration from a model.
#
# Usage:  build_mask <seat-type> <repo-root> [--env-root <path>] [--rw-tree <path>]
#                    [--mask-file <path>] [--mask-ssh-auth-sock] [extra-ro-path ...]
#   seat-type: "codex" (Forge) or "claude" (Mayor, Warden)
#   --rw-tree: a SECOND writable checkout (a worktree). Grants it AND applies
#              every enforcement carve-out to it. See fortkit-1q9 below.
#   --mask-file: a caller-specific path to mask to /dev/null, joining MASK_FILES
#              so it is bound in the correct pass. For deltas the shared list
#              cannot know — Proofdelve's deploy scripts, which its charter gate 3
#              keeps out of every agent's hands, in both the root and the worktree
#              copy. An extra-ro-path would leave such a file READABLE; this makes
#              it read empty. Added by fortkit-52vf.10 for the forge.sh port,
#              deliberately as a parameter rather than a second copy of the logic.
#              TAKES A FILE, AND SILENTLY IGNORES A DIRECTORY (Warden finding 7
#              on fortkit-52vf.10): the bind site tests [ -e ] && [ ! -d ],
#              correctly — MASK_FILES also carries sockets, and `--ro-bind
#              /dev/null <dir>` ABORTS BWRAP so no seat launches anywhere — but
#              a caller passing a directory therefore gets no mask AND no
#              output. That is the same silent-gap class this file discloses at
#              length for the secret sweep below; pass directories as
#              extra-ro-paths, or add them to MASK_DIRS.
# Each seat type keeps its OWN runtime's credentials readable — masking them
# breaks the launch outright — and masks the other runtime's entirely.

# OUTPUT: sets the global array `mask` (consumers declare mask=() before sourcing).
# shellcheck disable=SC2034  # mask is consumed by the sourcing script
build_mask() {
  local seat="$1" root="$2"; shift 2
  local CODEX_DIR_RW=0
  local mask_ssh_auth_sock=0
  local extra_ro=() env_roots=("$root") rw_trees=("$root") mask_files_extra=()
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --env-root)
        [ "$#" -ge 2 ] || { echo "build_mask: --env-root requires a path" >&2; return 2; }
        env_roots+=("$2")
        shift 2
        ;;
      --rw-tree)
        # fortkit-1q9. A declared tree is BOTH granted and protected: it joins
        # RW_PATHS, every RO carve-out below is computed for it, and its secrets
        # are swept like the root's. Declaring one also NARROWS the caller —
        # see the $root-worktrees grant at RW_PATHS.
        [ "$#" -ge 2 ] || { echo "build_mask: --rw-tree requires a path" >&2; return 2; }
        rw_trees+=("$2")
        env_roots+=("$2")
        shift 2
        ;;
      --mask-file)
        [ "$#" -ge 2 ] || { echo "build_mask: --mask-file requires a path" >&2; return 2; }
        mask_files_extra+=("$2")
        shift 2
        ;;
      --mask-ssh-auth-sock)
        mask_ssh_auth_sock=1
        shift
        ;;
      *)
        extra_ro+=("$1")
        shift
        ;;
    esac
  done
  local uid; uid="$(id -u)"

  local MASK_FILES=(
    "$HOME/.netrc" "$HOME/.npmrc" "$HOME/.git-credentials"
    /var/run/docker.sock /run/docker.sock "/run/user/$uid/docker.sock"
    "/run/user/$uid/podman/podman.sock"
  )
  # Secret files, by the BOTH-LISTS rule: anything added to a policy deny list
  # belongs here too.
  #
  # fortkit-2kub: masking by ENUMERATED SPELLING, and the spelling list is the
  # whole defect. The mask bound one path per secret; an editor's swap or backup
  # file is a DIFFERENT path holding the same buffer. Observed 2026-08-11 18:25
  # in the Proofdelve tree: ..env.staging.local.kate-swp, 768 bytes, readable —
  # it begins with TWO dots, so `.env*` never matched it. Ruled in scope by the
  # Overseer under threat 1 (agent accident), not the human-adversary exemption.
  # One pattern per line so each spelling is greppable and a new editor is a
  # one-line addition.
  #
  # TWO RESIDUALS, STATED RATHER THAN GLOSSED:
  #  1. THESE GLOBS EXPAND AT LAUNCH. A residue file created after the mask is
  #     built is NOT masked for that session's lifetime. (The comment here used
  #     to claim a fort acquiring a new .env* was covered "on arrival"; that is
  #     true only of the next launch, and it overstated the guarantee.)
  #  2. Enumeration cannot be complete against an editor nobody has enumerated.
  #     The complementary controls are fortkit-ks3t (gitignore every residue
  #     spelling) and not opening .env* in an editor inside a fort checkout.
  local SECRET_GLOBS=(
    '.env*'        # canonical
    '..env*'       # Kate swap for a dotfile: ..env.staging.local.kate-swp
    '.#*env*'      # Emacs lock file
    '#*env*#'      # Emacs autosave
    '.*env*.sw?'   # vim swap for a dotfile: ..env.staging.local.swp, .envrc.swp
    '*env*~'       # editor backup copies
  )
  local f x g
  for x in "${env_roots[@]}" "${extra_ro[@]}"; do
    for g in "${SECRET_GLOBS[@]}"; do
      # shellcheck disable=SC2231  # $g MUST expand as a glob; that is the point
      for f in "$x"/$g "$x"/*/$g; do
        # [ -f ], NOT [ -e ] (fortkit-faka finding 5, Warden Ilva Trueglass).
        # Two of the six spellings above — *env*~ and #*env*# — do NOT begin
        # with a dot, so they match ordinary names. A DIRECTORY called
        # environments~ satisfied [ -e ] and joined MASK_FILES, and
        # `--ro-bind /dev/null <directory>` ABORTS BWRAP: the failure mode was
        # NO SEAT LAUNCHES ANYWHERE, arriving through the 2kub fix rather than
        # through the mask it was fixing. Latent when found — no such path
        # existed in any fort — and one character class to close. A secret is a
        # regular file, and -f follows symlinks, so a symlinked secret is still
        # swept.
        # DISCLOSED RESIDUAL (fortkit-n3bk finding 6, E8 2026-08-13): -f trades
        # a loud abort for a SILENT GAP in one case. A DIRECTORY whose name
        # matches a secret glob is now skipped instead of aborting the launch —
        # which is the right trade, because the abort took down every seat in
        # the civilization — but it is then simply UNMASKED, and no line of
        # output says so. A directory called `environments~` or `.env.d` holding
        # secret files is therefore readable inside every mask. Not closed here:
        # the honest fix is to descend into such a directory and sweep its files,
        # which changes what a launch costs and belongs in its own sitting with
        # its own measurement. Recorded so the next reader finds the limit stated
        # rather than inferring the case was handled.
        [ -f "$f" ] && MASK_FILES+=("$f")
      done
    done
  done
  if [ "$mask_ssh_auth_sock" = "1" ]; then
    MASK_FILES+=("${SSH_AUTH_SOCK:-/nonexistent}")
  fi
  # Caller-declared masks (--mask-file). Joined here so they ride the same
  # existence-guarded bind pass as every other MASK_FILES entry, and are
  # therefore placed LAST per the ordering invariant — a caller appending its
  # own --ro-bind after build_mask returns would get that ordering by luck.
  MASK_FILES+=("${mask_files_extra[@]}")

  local MASK_DIRS=("$HOME/.ssh" "$HOME/.aws" "$HOME/.config/gh" "$HOME/.docker" "$HOME/.config/git")
  # Cycle 7 (Overseer edict 2026-08-08, longburn-suti / fortkit-i4y): charter
  # and seat files moved OUT of the kernel mask to a prose gate — charter prose
  # binds a session only through its own reading of it, and amendments now ride
  # a bead with the Overseer's approval and a charter.amended event, with drift
  # made visible by events-in-git and routine push. The ENFORCEMENT layer
  # tightens instead: write access follows execution context. fort/scripts
  # executes on the HOST (launchers, emit.sh in its launcher role), so a seat
  # that can edit it is editing code that runs unmasked at the next launch;
  # verify.sh alone is re-granted writable below. .git/config and .git/hooks
  # are host-executed the same way — hooks fire unmasked on the Overseer's next
  # commit, and core.hooksPath repoints them (fortkit-cqc, same class as the
  # .beads hooks below).
  #
  # fortkit-1q9: these are computed PER WRITABLE TREE, not once for $root.
  # RW_PATHS grants more than one checkout, and until this every cycle-7
  # protection applied to exactly one of them — so a seat could obtain a
  # writable copy of the whole enforcement layer one directory sideways, edit a
  # launcher there, and let the Mayor's ordinary merge carry it to $root.
  # RESIDUAL, DELIBERATE: a tree created AFTER the mask is built cannot be
  # carved (same launch-time truth as the secret globs above), which is why the
  # answer is declared trees plus a narrowed $root-worktrees grant rather than
  # iterating whatever worktrees happen to exist.
  local RO_PATHS=() t hostpath
  for t in "${rw_trees[@]}"; do
    RO_PATHS+=("$t/.claude" "$t/fort/profiles" "$t/.git/config" "$t/.git/hooks")
    # Host-executed civilization surface. Guarded on the covenant, not bare
    # existence (Warden suti finding 6): an ordinary fort growing a bin/ of its
    # own must not find it silently read-only — only the capital, which hosts
    # bin/regent and the civ launchers, carries this surface.
    # ($t/.git/config is a no-op in a worktree, where .git is a FILE; the real
    # per-worktree config is $root/.git/worktrees/<n>/config.worktree and it
    # cannot be bound read-only because git must write the index beside it —
    # fortkit-8cq. The hook vector itself is closed: a worktree uses the main
    # .git/hooks, which IS bound above.)
    if [ -e "$t/civ/covenant.md" ]; then
      for hostpath in "$t/bin" "$t/civ/scripts" "$t/civ/profiles"; do
        [ -e "$hostpath" ] && RO_PATHS+=("$hostpath")
      done
    fi
  done

  case "$seat" in
    codex)
      # KNOWN EXCEPTION: ~/.codex stays reachable AND writable as a live
      # directory bind — Codex reads its own auth.json from inside the sandbox
      # and rotates the token by rename, so an RO bind breaks refresh the same
      # way it did for the Mayor's dispatch lane (longburn-1p9): auth.json is
      # deliberately writable under the live directory bind, for both seat
      # types. config.toml is bound read-only below, closing the
      # disarm-the-next-launch vector while leaving rotation working.
      # ~/.claude is masked entirely: the Forge has no business with the other
      # runtime's credentials or memory.
      CODEX_DIR_RW=1
      MASK_DIRS+=("$HOME/.claude")
      RO_PATHS+=("$HOME/.codex/config.toml")
      # The unattended seat gets no ssh signing path: the agent socket is
      # masked at the inode and its env var is claude-only in mask_env — the
      # Forge never pushes (lane rule 5), and here that is mechanical, not
      # prose (parity with the inline forge.sh mask this branch replaced,
      # longburn-kyl).
      [ -n "${SSH_AUTH_SOCK:-}" ] && MASK_FILES+=("$SSH_AUTH_SOCK")
      # The cycle-7 prose gate on charter and seats applies to ATTENDED seats
      # only — an unattended seat cannot ask first, so a prose gate on it
      # guards nothing (cycle 6 ruling). The Forge keeps the mechanical lock.
      # Live since longburn-kyl: forge.sh sources this branch (the inline mask
      # is retired; capital-side consolidation is fortkit-6jf).
      # THE WRINKLE SHAPE B WOULD OTHERWISE OPEN, closed here. With the
      # verifier's implementation living in repo scripts/, it sits inside $root,
      # which is read-write to the Forge apart from these carve-outs — so
      # without this line the unattended seat could edit the verifier that
      # judges its own work. Cycle 7's stated intent is the opposite: "verifier
      # changes are Mayor work; the Forge's and the Warden's masks keep it
      # read-only." The Warden needs nothing extra, because she passes her whole
      # checkout as extra_ro and gets it for free.
      # skills/ joins them (fortkit-4n8c): the installed ~/.claude/skills entries
      # are now SYMLINKS to this directory, so its contents are session-executed
      # instruction loaded by every seat and by the unmasked Regent. For attended
      # seats it is prose-gated exactly as charter.md and fort/seats are — prose
      # that binds only through a session's own reading of it, with drift visible
      # in git. The unattended seat cannot ask first, so it keeps the mechanical
      # lock (cycle 6 ruling).
      for t in "${rw_trees[@]}"; do
        RO_PATHS+=("$t/fort/charter.md" "$t/fort/seats" "$t/scripts/verify-impl.sh" "$t/skills")
      done
      ;;
    claude)
      # Mirror image. ~/.claude stays readable and writable: it holds this
      # runtime's credentials, this project's auto-memory, and the session
      # transcripts Claude Code writes as it runs. Its CONFIG is bound
      # read-only so a session cannot rewrite its own permission rules or the
      # global instructions for the next one (21f.5, applied to Claude seats).
      RO_PATHS+=("$HOME/.claude/settings.json" "$HOME/.claude/settings.local.json" \
                 "$HOME/.claude/CLAUDE.md" "$HOME/.claude/helpers")
      # fortkit-5sk, Overseer ruling 2026-08-12: the GLOBAL instruction surface
      # is session-executed context that runs at the NEXT launch, including the
      # unmasked Regent's — so a masked seat that writes it controls code
      # running outside the mask. Cycle 7 closed this class for the fort's own
      # config and missed the global one.
      #   civilization.json  the settlement registry every civ tool reads
      #   skills/            INSTALLED COPIES of fortkit/skills, executed as
      #                      instructions. Ruled read-only knowing it strands
      #                      the hand-copy install lane a masked Mayor used on
      #                      2026-08-12; installing a skill is now an unmasked
      #                      act until fortkit-4n8c symlinks these to the repo.
      #   commands/ plugins/ slash commands and plugin payloads, both executed
      # SECOND STRANDED LANE, disclosed here because the skills one was and this
      # one was not (fortkit-faka finding 4): bin/fort-init writes the settlement
      # registry at ${FORT_REGISTRY:-$HOME/.claude/civilization.json}, and that
      # path is now kernel-RO — FOUNDING A SETTLEMENT FROM INSIDE A MASKED SEAT
      # FAILS EROFS. Founding is already Overseer or Regent work, so the decision
      # stands; the gap was in its record, and that kind of gap costs someone an
      # afternoon. Pass FORT_REGISTRY at a writable path to found a throwaway
      # fort for testing, which is what the factory's own verification does.
      # NOT MASKED, deliberately: ~/.claude/teams. It is harness session state,
      # not an instruction surface — Claude Code writes teams/session-<id>/
      # config.json at EVERY session start, so a read-only bind there would
      # break every masked launch. Do not "complete" this list with it.
      RO_PATHS+=("$HOME/.claude/civilization.json" "$HOME/.claude/skills" \
                 "$HOME/.claude/commands" "$HOME/.claude/plugins")
      # DISPATCH EXCEPTION, redesigned (longburn-1p9, measured 2026-08-05;
      # unified across the civilization 2026-08-13 by fortkit-52vf.10 with the
      # Overseer present): the Mayor launches the Forge, and a child codex
      # inherits this mount namespace, so ~/.codex must be reachable and auth
      # must be able to ROTATE. The old design (tmpfs over ~/.codex + auth.json
      # re-bound RO as a FILE) pinned the auth.json inode: codex rotates the
      # token by rename, so rotation failed at write, the refresh token was
      # reused and revoked server-side, and a host-side `codex login` stayed
      # invisible to running sessions — both seat lanes died until session
      # restart. Fix: bind the real DIRECTORY read-write (name lookups resolve
      # live, so rename rotation and host re-login both work), keep config.toml
      # read-only (the injection vector, 21f.5), and mask transcripts/history.
      # Reading the token remains the same accepted exposure as before: a
      # session that can already spend it gains little by seeing it. Revisit if
      # Codex gains fd/env auth.
      #
      # THE COST, STATED RATHER THAN IMPLIED (Overseer's rider, 2026-08-13).
      # ~/.codex is not only credentials and transcripts. It also holds
      # SESSION-EXECUTED INSTRUCTION for the Codex runtime — AGENTS.md, skills/,
      # plugins/, rules/, memories/ — which is the same class of surface
      # fortkit-5sk kernel-locked for the Claude runtime (~/.claude/skills,
      # commands, plugins, civilization.json). A live rw bind hands an attended
      # Mayor or Warden write access to all of it, and what it writes there is
      # loaded as instruction by the NEXT codex launch, outside that seat's mask.
      # That is a real widening of the attended-seat boundary and it is accepted
      # deliberately here, not overlooked.
      #   • For the CODEX seat the policy layer still covers it — but NOT by
      #     the mechanism this comment used to name. It named a deny profile
      #     in forge.sh, covering the codex home, as what enforces this — and
      #     that profile exists in ONE fort. Re-measured 2026-08-13 (finding 1
      #     fortkit-52vf.10, fortkit-52vf.10.1): only Proofdelve's forge.sh has
      #     such a table; the capital's and the factory's contain the word
      #     `deny` zero times, and Farlantern's once, about Landlock rather
      #     than a table. A SHARED COMMENT TRUE IN ONE FORT AND FALSE IN
      #     ANOTHER IS THE DRIFT CLASS THIS FILE EXISTS TO CLOSE, so what is
      #     named here is the mechanism that actually holds in ALL FOUR copies:
      #     every forge.sh runs `codex exec --sandbox workspace-write`, whose
      #     writable roots are the explicit --add-dir grants, and ~/.codex is
      #     not among them — so codex's own command executor refuses the
      #     model's shell there ("rejected by the command executor", measured
      #     in all three forts, 2026-08-13). Proofdelve's deny profile is an
      #     ADDITIONAL layer in that one fort, not the load-bearing one; and
      #     Landlock DOES enforce write denials where a profile is in play
      #     (only read-deny is the upstream TODO, openai/codex#11316).
      #     So the Forge is denied at policy and permitted at kernel; the Mayor
      #     and Warden are permitted at both.
      #   • DO NOT "FIX" THIS BY RO-BINDING skills/ OR plugins/. The Overseer
      #     ruled it out on 2026-08-13: codex appears to mutate both at startup,
      #     so a read-only bind there is a launch-abort risk of exactly the
      #     ~/.claude/teams shape (harness state that looks like an instruction
      #     surface). It is filed as fortkit-elh9 — the codex twin of
      #     fortkit-5sk, and, unlike 5sk, one an RO bind cannot fix. Leave it.
      CODEX_DIR_RW=1
      RO_PATHS+=("$HOME/.codex/config.toml")
      # CONSEQUENCE, WRITTEN DOWN BECAUSE IT WAS NOWHERE (Warden finding 6 on
      # fortkit-52vf.10): a Forge DISPATCHED BY A MAYOR inherits these masks
      # recursively, so that codex session's rollouts, log and history.jsonl
      # land in the MAYOR's tmpfs and are LOST when her session ends. This is
      # not a regression — the previous full tmpfs over ~/.codex lost them too
      # — and it is not a launch failure (measured: fortkit-m0wm ran to exit
      # 0). It is simply invisible, and a seat looking for a missing rollout
      # would otherwise spend a session finding out why.
      # These three are asserted by neither probe-cycle7.sh nor
      # scripts/mask-harness.sh; that gap is fortkit-52vf.10.1's finding 6 and
      # is deferred to fortkit-wtps with the rename assertion, NOT closed here.
      MASK_DIRS+=("$HOME/.codex/sessions" "$HOME/.codex/log")
      MASK_FILES+=("$HOME/.codex/history.jsonl")
      ;;
    *) echo "build_mask: unknown seat type '$seat' (expected codex|claude)" >&2; return 2 ;;
  esac

  # fortkit-6ovg and fortkit-x9ou — SHAPE B (Overseer ruling 2026-08-12,
  # reversing Shape A of the previous day). THE VERIFIER MOVED OUT INSTEAD OF
  # BEING CARVED OUT. fort/scripts is one whole-directory read-only bind for
  # every seat type, and fort/scripts/verify.sh is a shim that execs
  # scripts/verify-impl.sh, which lives where mutability is already sanctioned.
  #
  # THE HISTORY MATTERS, because two shapes were tried and both failures were
  # about the same confusion between a FILE and a LOCATION:
  #  • Cycle 7 bound this directory read-only and re-bound verify.sh read-WRITE
  #    inside it. Measured in all three forts by all three Mayors: `test -w`
  #    returns TRUE and an O_APPEND open works, while Edit, `sed -i`, `git
  #    checkout` and `git merge` all fail — each of them rewrites a file by
  #    creating or unlinking a SIBLING, and the directory was read-only. The
  #    error names a temp path rather than verify.sh, which is why it cost three
  #    forts a cycle to see.
  #  • Shape A inverted it: writable directory, every entry bound read-only
  #    individually, verify.sh left unbound. The edits worked and each FILE was
  #    immutable (a read-only bind is a mount point; the kernel refuses to
  #    unlink or rename over one, EBUSY). Both premises it was approved on then
  #    failed inside a day:
  #      - "the new-file hole is bounded to the MAYOR, an attended seat that
  #        asks first" — FALSE. Every build_mask claude caller that does not
  #        pass its own checkout as extra_ro holds it, which includes
  #        civ/scripts/herald.sh — AND THE HERALD RUNS UNATTENDED, headless, on
  #        a daily 05:00 timer, with Bash, Write and Edit (fortkit-vkq8).
  #      - "the hole only lets a seat ADD files, and nothing there is
  #        auto-executed" — FALSE. The harness measured `A4b fort/scripts DIR
  #        not renamable :: unlink=NO rename=YES`. With the directory itself
  #        unlocked, a seat could rename it aside and put its own fort/scripts
  #        in its place; ~/.local/bin/mayor then exec'd that path ON THE HOST,
  #        UNMASKED. Per-file mounts protect the FILES and not the LOCATION
  #        (fortkit-x9ou).
  #
  # Shape B has neither problem and needs no accepted residual: the directory is
  # a mount point again, so it refuses rename, and nothing new can be created
  # inside it. The cost is one level of indirection, paid once, in a shim that
  # says so at the top of itself.
  for t in "${rw_trees[@]}"; do RO_PATHS+=("$t/fort/scripts"); done

  # FILESYSTEM SCOPING (cycle 5). Before this, the sandbox was "everything
  # writable except what we masked", so a seat working in one fort could still
  # rm -rf another project or wipe ~/Documents — threat #1, agent accident, and
  # the reason a blanket bash allow was indefensible. Inverted here: $HOME goes
  # read-only and write access is re-granted to exactly what a seat legitimately
  # writes. Same inversion that beat the deny-glob spelling problem: enumerate
  # the grants, never the prohibitions. Reads across $HOME stay open by decision
  # (Overseer, 2026-08-04): cross-fort reads are worth more than the
  # exfiltration-path reduction, since civ-digest and the Herald both need them.
  local RW_PATHS=("${rw_trees[@]}" "$HOME/.claude" "${TMPDIR:-}" /tmp
                  "$HOME/.npm" "$HOME/.nuget" "$HOME/.cache" "$HOME/.bun"
                  "$HOME/.local/share/pnpm" "$HOME/.local/state")
  # fortkit-1q9. $root-worktrees is granted WHOLESALE only to a caller that
  # declared no tree of its own — the Mayor, who creates worktrees when she
  # dispatches the Forge from inside her own mask. A caller that names its
  # worktree gets that one and nothing else, so the Forge stops being able to
  # write every OTHER bead's worktree.
  # THE MAYOR'S RESIDUAL IS OPEN AND KNOWN: she can still `git worktree add` and
  # obtain a writable enforcement layer in the new tree. No launch-time mask can
  # close that. It closes when fortkit-52vf.6 (E5) makes forge.sh refuse to
  # launch in-mask, after which her grant can go too. Tracked on fortkit-1q9.
  [ "${#rw_trees[@]}" -eq 1 ] && RW_PATHS+=("$root-worktrees")
  mask=(--bind / / --dev /dev --die-with-parent --ro-bind "$HOME" "$HOME")
  local w
  for w in "${RW_PATHS[@]}"; do [ -n "$w" ] && [ -e "$w" ] && mask+=(--bind "$w" "$w"); done
  # ~/.codex as a live rw DIRECTORY bind for claude seats (see the dispatch
  # exception above): placed with the rw grants so the later config.toml RO
  # bind and transcript masks stack over it per the ordering invariant.
  [ "${CODEX_DIR_RW:-0}" = "1" ] && [ -d "$HOME/.codex" ] && mask+=(--bind "$HOME/.codex" "$HOME/.codex")
  # ORDERING INVARIANT (ForgeOs-01l): bwrap mounts stack, so any bind placed
  # after a mask mounts the real content back OVER it. The warden passes the
  # whole candidate tree as extra_ro; when that bind followed the file masks it
  # resurfaced every masked secret beneath it (measured: host run
  # 2026-08-04T202453, mask-spelling:warden 4/4 FAIL). Subtree binds — ro
  # paths, extra_ro, hooks dirs — therefore go HERE, and the per-file dev-null
  # masks and per-dir tmpfs masks go LAST. One exception, surfacing a single
  # file back over a directory tmpfs and therefore placed after the masks: the
  # ~/.ssh/known_hosts re-bind.
  local p
  for p in "${RO_PATHS[@]}"; do [ -e "$p" ] && mask+=(--ro-bind "$p" "$p"); done
  for p in "${extra_ro[@]}"; do [ -e "$p" ] && mask+=(--ro-bind "$p" "$p"); done
  # SSH inside a user namespace (cycle 6). bwrap's userns maps root-owned files
  # to 'nobody', and OpenSSH refuses any config owned by neither root nor the
  # invoking user, so it aborts before authenticating: "Bad owner or permissions
  # on /etc/ssh/ssh_config.d/...". That cost more than convenience — a seat that
  # cannot fetch cannot verify ahead/behind against the real remote, and standing
  # order 11 requires committed/pushed/deployed to be separately VERIFIED rather
  # than estimated. Fix: a user-owned ssh_config, written per launch, shadowing
  # /etc/ssh inside the sandbox.
  # ~/.ssh stays masked: keys are never readable here. An agent-held identity
  # signs instead, so a seat uses a key it cannot read (`ssh-add`, or
  # AddKeysToAgent yes in ~/.ssh/config).
  local fort_ssh="${TMPDIR:-/tmp}/fort-ssh-$$"
  mkdir -p "$fort_ssh"
  {
    printf '# Generated per launch by seat-sandbox.sh — user-owned so ssh accepts it.\n'
    printf 'Host *\n'
    printf '  StrictHostKeyChecking accept-new\n'
    printf '  UserKnownHostsFile %s/.ssh/known_hosts\n' "$HOME"
  } > "$fort_ssh/ssh_config"
  chmod 600 "$fort_ssh/ssh_config"
  mask+=(--tmpfs /etc/ssh --ro-bind "$fort_ssh/ssh_config" /etc/ssh/ssh_config)

  # Git hooks under .beads run on the HOST, unsandboxed, on the next commit or
  # push in the main checkout — a writable .beads is a host RCE escape. CLASS
  # fix, not one path: there are at least two such directories (.beads/hooks and
  # dolt's git-remote-cache repo.git/hooks), so every one is caught by finding
  # them rather than naming them.
  # fortkit-faka finding 3 (Warden Ilva Trueglass, E2 review): PER DECLARED
  # TREE, not root-scoped. Everything above moved to the rw_trees form in 1q9
  # and this did not, while calling itself a CLASS fix — and .beads/hooks/* is
  # TRACKED, so every worktree materialises its own writable copy of the five
  # hook scripts. Direct execution was already closed (core.hooksPath is an
  # absolute path into the main checkout, which is bound below), so the live
  # path was the same one 1q9 describes for launchers: a Forge edits its
  # worktree copy, commits path-scoped, and an ordinary merge carries it to
  # $root where it runs unmasked on the next commit or push. Non-blocking
  # because that path is Warden-reviewed; fixed because "every one is caught by
  # finding them rather than naming them" was not true of the trees.
  local h
  for t in "${rw_trees[@]}"; do
    while IFS= read -r h; do mask+=(--ro-bind "$h" "$h"); done \
      < <(find "$t/.beads" -type d -name hooks 2>/dev/null)
  done
  # BELT FOR THE SAME DEFECT — and deliberately NOT [ -f ] here. MASK_FILES also
  # carries SOCKETS: the docker and podman sockets always, and SSH_AUTH_SOCK
  # under --mask-ssh-auth-sock. [ -f ] is FALSE for a socket, so using it here
  # would silently stop masking the docker socket, which is the one entry in
  # this list that is a host-escape rather than a secret. The property that
  # actually matters at the bind site is "exists and is not a directory".
  for f in "${MASK_FILES[@]}"; do [ -e "$f" ] && [ ! -d "$f" ] && mask+=(--ro-bind /dev/null "$f"); done
  local d
  for d in "${MASK_DIRS[@]}"; do [ -d "$d" ] && mask+=(--tmpfs "$d"); done

  # SECOND EXCEPTION to the ordering invariant (ForgeOs-q6m, backported here
  # 2026-08-12 by the E2 four-way diff — this copy had the bind but placed it
  # BEFORE the MASK_DIRS loop, which buried it under the ~/.ssh tmpfs, so it had
  # never had any effect): known_hosts is surfaced back over that tmpfs so
  # host-key PINNING survives inside the mask — otherwise every launch does
  # fresh TOFU against a known_hosts that dies with the tmpfs. Keys remain
  # unreadable: only this one file is re-bound, read-only.
  [ -e "$HOME/.ssh/known_hosts" ] && mask+=(--ro-bind "$HOME/.ssh/known_hosts" "$HOME/.ssh/known_hosts")
  # A false final test must not become build_mask's return value (ForgeOs-vzn
  # class): under a `set -e` caller that aborts the launcher before the session
  # starts. Backported here 2026-08-12 by the E2 four-way diff.
  return 0
}

# Environment is an ALLOW-LIST, not a deny-list: enumerated unsets leave AWS_*,
# GIT_SSH_COMMAND, and anything sourced from a secrets file in the launching
# shell. Failure mode when a name is missing is loud (the CLI cannot auth or the
# terminal misbehaves), never silently insecure.
# NOTE: SSH_AUTH_SOCK is passed through deliberately — for claude seats only.
# ~/.ssh is masked, so key FILES are unreadable, but agent-held identities
# still sign — an attended session can use a key it can never read (`ssh-add`
# for agent-based push). The codex seat gets neither the env var nor the
# socket (masked in build_mask): the unattended Forge never pushes.
# WHY THE NAME AND NOT JUST THE SOCKET (measured 2026-08-13, fortkit-52vf.10,
# when Proofdelve's Forge was ported onto this lib and briefly got the name):
# masking the socket alone is sufficient at the KERNEL — `ssh-add -l` returns
# "Connection refused" — and insufficient in the RECORD. Proofdelve's smoke
# probe asserts SSH_AUTH_SOCK is UNSET, its seat read a set variable as a live
# agent and a boundary failure, and it refused the remaining nine probes rather
# than risk a real push. A boundary that is closed but looks open costs
# measurement. This fort had it right first; the other two now match.
mask_env() {
  local seat="$1" v
  local common=(HOME USER LOGNAME SHELL TERM COLORTERM TERM_PROGRAM LANG LC_ALL
                PATH TMPDIR XDG_RUNTIME_DIR GIT_PAGER PAGER)
  local codex_only=(CODEX_HOME OPENAI_API_KEY OPENAI_BASE_URL RUST_LOG NUGET_PACKAGES
                    DOTNET_CLI_TELEMETRY_OPTOUT DOTNET_NOLOGO npm_config_cache)
  local claude_only=(ANTHROPIC_API_KEY CLAUDE_CONFIG_DIR npm_config_cache SSH_AUTH_SOCK)
  mask+=(--clearenv)
  for v in "${common[@]}"; do [ -n "${!v:-}" ] && mask+=(--setenv "$v" "${!v}"); done
  case "$seat" in
    codex)  for v in "${codex_only[@]}";  do [ -n "${!v:-}" ] && mask+=(--setenv "$v" "${!v}"); done ;;
    claude) for v in "${claude_only[@]}"; do [ -n "${!v:-}" ] && mask+=(--setenv "$v" "${!v}"); done ;;
  esac
  # An empty final [ -n ] test must not become mask_env's return value: under a
  # set -e caller that aborts the launcher before the session starts (ForgeOs-vzn).
  return 0
}

require_bwrap() {
  command -v bwrap >/dev/null 2>&1 && return 0
  echo "seat-sandbox: REFUSED — bwrap not found. The kernel mask layer is the boundary;" >&2
  echo "               permission rules alone bind spellings, not files (21f.8)." >&2
  return 78
}
