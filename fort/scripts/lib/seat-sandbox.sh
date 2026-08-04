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

build_mask() {
  local seat="$1" root="$2"; shift 2
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
  local f
  for f in "$root"/.env* "$root"/*/.env*; do
    [ -e "$f" ] && MASK_FILES+=("$f")
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
      # ~/.codex is masked entirely — a Claude seat has no business with it.
      MASK_DIRS+=("$HOME/.codex")
      RO_PATHS+=("$HOME/.claude/settings.json" "$HOME/.claude/settings.local.json" \
                 "$HOME/.claude/CLAUDE.md" "$HOME/.claude/helpers")
      ;;
    *) echo "build_mask: unknown seat type '$seat' (expected codex|claude)" >&2; return 2 ;;
  esac

  mask=(--bind / / --dev /dev --die-with-parent)
  for f in "${MASK_FILES[@]}"; do [ -e "$f" ] && mask+=(--ro-bind /dev/null "$f"); done
  local d
  for d in "${MASK_DIRS[@]}"; do [ -d "$d" ] && mask+=(--tmpfs "$d"); done
  local p
  for p in "${RO_PATHS[@]}" "${extra_ro[@]}"; do [ -e "$p" ] && mask+=(--ro-bind "$p" "$p"); done

  # Git hooks under .beads run on the HOST, unsandboxed, on the next commit or
  # push in the main checkout — a writable .beads is a host RCE escape. CLASS
  # fix, not one path: there are at least two such directories (.beads/hooks and
  # dolt's git-remote-cache repo.git/hooks), so every one is caught by finding
  # them rather than naming them.
  local h
  while IFS= read -r h; do mask+=(--ro-bind "$h" "$h"); done \
    < <(find "$root/.beads" -type d -name hooks 2>/dev/null)
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
}

require_bwrap() {
  command -v bwrap >/dev/null 2>&1 && return 0
  echo "seat-sandbox: REFUSED — bwrap not found. The kernel mask layer is the boundary;" >&2
  echo "               permission rules alone bind spellings, not files (21f.8)." >&2
  return 78
}
