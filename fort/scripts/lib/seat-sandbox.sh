#!/bin/bash
# Shared kernel-mask builder for seat launchers. Source this, call build_mask,
# then run: bwrap "${mask[@]}" -- <your command>
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
#                    [--mask-ssh-auth-sock] [extra-ro-path ...]
#   seat-type: "codex" (Forge) or "claude" (Mayor, Warden)
#   --rw-tree: a SECOND writable checkout (a worktree). Grants it AND applies
#              every enforcement carve-out to it. See fortkit-1q9 below.
# Each seat type keeps its OWN runtime's credentials readable — masking them
# breaks the launch outright — and masks the other runtime's entirely.

# OUTPUT: sets the global array `mask` (consumers declare mask=() before sourcing).
# shellcheck disable=SC2034  # mask is consumed by the sourcing script
build_mask() {
  local seat="$1" root="$2"; shift 2
  local CODEX_DIR_RW=0
  local mask_ssh_auth_sock=0
  local extra_ro=() env_roots=("$root") rw_trees=("$root")
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
        [ -f "$f" ] && MASK_FILES+=("$f")
      done
    done
  done
  if [ "$mask_ssh_auth_sock" = "1" ]; then
    MASK_FILES+=("${SSH_AUTH_SOCK:-/nonexistent}")
  fi

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
      for t in "${rw_trees[@]}"; do RO_PATHS+=("$t/fort/charter.md" "$t/fort/seats"); done
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
      # NOT MASKED, deliberately: ~/.claude/teams. It is harness session state,
      # not an instruction surface — Claude Code writes teams/session-<id>/
      # config.json at EVERY session start, so a read-only bind there would
      # break every masked launch. Do not "complete" this list with it.
      RO_PATHS+=("$HOME/.claude/civilization.json" "$HOME/.claude/skills" \
                 "$HOME/.claude/commands" "$HOME/.claude/plugins")
      # DISPATCH EXCEPTION, redesigned (longburn-1p9, measured 2026-08-05): the
      # Mayor launches the Forge, and a child codex inherits this mount
      # namespace, so ~/.codex must be reachable and auth must be able to
      # ROTATE. The old design (tmpfs over ~/.codex + auth.json re-bound RO as
      # a FILE) pinned the auth.json inode: codex rotates the token by rename,
      # so rotation failed at write, the refresh token was reused and revoked
      # server-side, and a host-side `codex login` stayed invisible to running
      # sessions — both seat lanes died until session restart. Fix: bind the
      # real DIRECTORY read-write (name lookups resolve live, so rename
      # rotation and host re-login both work), keep config.toml read-only (the
      # injection vector, 21f.5), and mask transcripts/history. Reading the
      # token remains the same accepted exposure as before: a session that can
      # already spend it gains little by seeing it. Revisit if Codex gains
      # fd/env auth.
      CODEX_DIR_RW=1
      RO_PATHS+=("$HOME/.codex/config.toml")
      MASK_DIRS+=("$HOME/.codex/sessions" "$HOME/.codex/log")
      MASK_FILES+=("$HOME/.codex/history.jsonl")
      ;;
    *) echo "build_mask: unknown seat type '$seat' (expected codex|claude)" >&2; return 2 ;;
  esac

  # fortkit-6ovg — THE VERIFY.SH CARVE-OUT, SHAPE A (Overseer ruling 2026-08-11:
  # "make the carve-out actually work").
  #
  # What was broken: cycle 7 bound $root/fort/scripts read-only as a DIRECTORY
  # and then bound verify.sh read-WRITE inside it. Measured in all three forts by
  # all three Mayors: `test -w` says TRUE and open-for-append works, while Edit,
  # `sed -i`, `git checkout` and `git merge` all fail — every one of them must
  # CREATE OR UNLINK A SIBLING in the directory, and the directory is read-only.
  # The error names a sibling temp path rather than verify.sh, which is why it
  # cost three forts a cycle to see.
  #
  # Shape A: the DIRECTORY is writable (it rides the $root grant) and every entry
  # in it is bound read-only INDIVIDUALLY, except verify.sh, which gets no bind at
  # all and is therefore an ordinary writable file. Sibling creation works, so the
  # ordinary edit paths work.
  # WHY THAT IS SAFER THAN IT SOUNDS: each read-only bind makes that path a MOUNT
  # POINT, and the kernel refuses to unlink or rename over a mount point (EBUSY).
  # mayor.sh, warden.sh, emit.sh and lib/ cannot be modified, deleted, or replaced
  # even with the directory writable — and neither can the directory itself.
  #
  # THE HOLE THIS OPENS, DISCLOSED RATHER THAN GLOSSED: NEW FILE CREATION inside
  # fort/scripts becomes possible. A seat could drop a script into a host-executed
  # directory. Nothing there is auto-executed and every launcher is named
  # explicitly, so this is a staging area for a later mistake rather than a direct
  # path — but it is a real widening. It is probed as an EXPECTED PASS in
  # probe-cycle7.sh (a hole nobody probes is the thing this fort keeps getting
  # bitten by) and carried in the charter's accepted residuals.
  # ITS BLAST RADIUS IS THE MAYOR ALONE: the Warden and the Researcher pass their
  # whole checkout as extra_ro, which re-masks the directory read-only below, and
  # the codex branch never takes this path at all.
  local e
  if [ "$seat" = "claude" ]; then
    for t in "${rw_trees[@]}"; do
      [ -d "$t/fort/scripts" ] || continue
      for e in "$t/fort/scripts"/* "$t/fort/scripts"/.[!.]*; do
        [ -e "$e" ] || continue
        [ "$e" = "$t/fort/scripts/verify.sh" ] && continue
        RO_PATHS+=("$e")
      done
    done
  else
    # The unattended seat keeps the whole-directory lock: it has no verify.sh
    # re-grant to preserve (it edits the verifier through a bead in its own
    # diff, never the host-executed copy) and therefore no new-file hole.
    for t in "${rw_trees[@]}"; do RO_PATHS+=("$t/fort/scripts"); done
  fi

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
  local h
  while IFS= read -r h; do mask+=(--ro-bind "$h" "$h"); done \
    < <(find "$root/.beads" -type d -name hooks 2>/dev/null)
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
