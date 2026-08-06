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
# Usage:  build_mask <seat-type> <repo-root> [extra-ro-path ...]
#   seat-type: "codex" (Forge) or "claude" (Mayor, Warden)
# Each seat type keeps its OWN runtime's credentials readable — masking them
# breaks the launch outright — and masks the other runtime's entirely.

# OUTPUT: sets the global array `mask` (consumers declare mask=() before sourcing).
# shellcheck disable=SC2034  # mask is consumed by the sourcing script
build_mask() {
  local seat="$1" root="$2"; shift 2
  local CODEX_AUTH_RO=0
  local extra_ro=("$@")
  local uid; uid="$(id -u)"

  local MASK_FILES=(
    "$HOME/.netrc" "$HOME/.npmrc" "$HOME/.git-credentials"
    /var/run/docker.sock /run/docker.sock "/run/user/$uid/docker.sock"
    "/run/user/$uid/podman/podman.sock"
  )
  # Secret files, by the BOTH-LISTS rule: anything added to a policy deny list
  # belongs here too. Globbed so a fort acquiring a new .env* is covered on
  # arrival rather than after the incident.
  local f x
  for x in "$root" "${extra_ro[@]}"; do
    for f in "$x"/.env* "$x"/*/.env*; do
      [ -e "$f" ] && MASK_FILES+=("$f")
    done
  done

  local MASK_DIRS=("$HOME/.ssh" "$HOME/.aws" "$HOME/.config/gh" "$HOME/.docker" "$HOME/.config/git")
  local RO_PATHS=("$root/.claude" "$root/fort/charter.md" "$root/fort/seats" "$root/fort/profiles")

  case "$seat" in
    codex)
      # KNOWN EXCEPTION: ~/.codex stays readable — Codex reads its own auth.json
      # from inside the sandbox, so masking it breaks the launch. config.toml is
      # bound read-only below, closing the disarm-the-next-launch vector while
      # leaving token refresh working. ~/.claude is masked entirely: the Forge
      # has no business with the other runtime's credentials or memory.
      MASK_DIRS+=("$HOME/.claude")
      RO_PATHS+=("$HOME/.codex/config.toml")
      ;;
    claude)
      # Mirror image. ~/.claude stays readable and writable: it holds this
      # runtime's credentials, this project's auto-memory, and the session
      # transcripts Claude Code writes as it runs. Its CONFIG is bound
      # read-only so a session cannot rewrite its own permission rules or the
      # global instructions for the next one (21f.5, applied to Claude seats).
      RO_PATHS+=("$HOME/.claude/settings.json" "$HOME/.claude/settings.local.json" \
                 "$HOME/.claude/CLAUDE.md" "$HOME/.claude/helpers")
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

  # FILESYSTEM SCOPING (cycle 5). Before this, the sandbox was "everything
  # writable except what we masked", so a seat working in one fort could still
  # rm -rf another project or wipe ~/Documents — threat #1, agent accident, and
  # the reason a blanket bash allow was indefensible. Inverted here: $HOME goes
  # read-only and write access is re-granted to exactly what a seat legitimately
  # writes. Same inversion that beat the deny-glob spelling problem: enumerate
  # the grants, never the prohibitions. Reads across $HOME stay open by decision
  # (Overseer, 2026-08-04): cross-fort reads are worth more than the
  # exfiltration-path reduction, since civ-digest and the Herald both need them.
  local RW_PATHS=("$root" "$root-worktrees" "$HOME/.claude" "${TMPDIR:-}" /tmp
                  "$HOME/.npm" "$HOME/.nuget" "$HOME/.cache" "$HOME/.bun"
                  "$HOME/.local/share/pnpm" "$HOME/.local/state")
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
  # masks and per-dir tmpfs masks go LAST.
  local p
  for p in "${RO_PATHS[@]}" "${extra_ro[@]}"; do [ -e "$p" ] && mask+=(--ro-bind "$p" "$p"); done
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
  [ -e "$HOME/.ssh/known_hosts" ] && mask+=(--ro-bind "$HOME/.ssh/known_hosts" "$HOME/.ssh/known_hosts")

  # Git hooks under .beads run on the HOST, unsandboxed, on the next commit or
  # push in the main checkout — a writable .beads is a host RCE escape. CLASS
  # fix, not one path: there are at least two such directories (.beads/hooks and
  # dolt's git-remote-cache repo.git/hooks), so every one is caught by finding
  # them rather than naming them.
  local h
  while IFS= read -r h; do mask+=(--ro-bind "$h" "$h"); done \
    < <(find "$root/.beads" -type d -name hooks 2>/dev/null)
  for f in "${MASK_FILES[@]}"; do [ -e "$f" ] && mask+=(--ro-bind /dev/null "$f"); done
  local d
  for d in "${MASK_DIRS[@]}"; do [ -d "$d" ] && mask+=(--tmpfs "$d"); done

}

# Environment is an ALLOW-LIST, not a deny-list: enumerated unsets leave AWS_*,
# GIT_SSH_COMMAND, and anything sourced from a secrets file in the launching
# shell. Failure mode when a name is missing is loud (the CLI cannot auth or the
# terminal misbehaves), never silently insecure.
# NOTE: SSH_AUTH_SOCK is passed through deliberately. ~/.ssh is masked, so key
# FILES are unreadable, but agent-held identities still sign — the session can
# use a key it can never read. Load keys with `ssh-add` for agent-based push.
mask_env() {
  local seat="$1" v
  local common=(HOME USER LOGNAME SHELL TERM COLORTERM TERM_PROGRAM LANG LC_ALL
                PATH TMPDIR XDG_RUNTIME_DIR SSH_AUTH_SOCK GIT_PAGER PAGER)
  local codex_only=(CODEX_HOME OPENAI_API_KEY OPENAI_BASE_URL RUST_LOG NUGET_PACKAGES
                    DOTNET_CLI_TELEMETRY_OPTOUT DOTNET_NOLOGO npm_config_cache)
  local claude_only=(ANTHROPIC_API_KEY CLAUDE_CONFIG_DIR npm_config_cache)
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
