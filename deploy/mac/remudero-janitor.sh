#!/bin/bash
# remudero-janitor — reclaim disk from disposable Remudero checkouts.
#
# WHAT IT DOES: removes regenerable `node_modules` and `coverage` trees from
# idle disposable scratch checkouts. It discovers nested Remudero checkouts
# and checkouts in explicit scratch namespaces on macOS and Linux. A linked
# worktree is retired only after 6 hours of inactivity, with clean Git state
# and no running process, cwd, or open-file use. Its current HEAD must be
# published by fresh remote evidence, including detached PR tips. Standalone
# clones retain their object stores until cross-account lending is proven safe;
# their old regenerable caches can still be cleaned.
#
# Also removes inactive non-Git scratch directories in the account's explicit
# Remudero/rmd-work and Mac operator-worktree roots (and Craig's /private/tmp).
# Every descendant must be
# idle for six hours; unversioned source/reports and persistent data are retained.
#
# WHAT IT NEVER DOES: it never removes unpushed commits or uncommitted source, never
# follows an artifact symlink, and never touches protected, dirty, or open
# trees. Worktree deletion uses Git; branch refs are retained. A standalone
# clone's object store, marked data and unversioned source/reports stay protected.
# The one exception is the opt-in preserve-then-retire phase (preserve-retire.py):
# it retires such a checkout only after saving and verifying a copy of that work.
#
# Why this exists: src/lib/tmp.ts's sweepStaleTempDirs() roots at os.tmpdir()
# (/var/folders/... on macOS) and so structurally cannot see the disposable
# checkouts that accumulate under /private/tmp or /tmp. See docs in the recon
# report. Azure's maintained janitor uses the same publication guard.

set -uo pipefail

# macOS cron commonly supplies only /usr/bin:/bin. Keep the caller's tool
# precedence, but include the system sbin directories so lsof is available
# to every account's safety probes just as it is under launchd and SSH.
export PATH="${PATH:-/usr/bin:/bin}:/usr/sbin:/sbin"

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P) || exit 2
GUARD_DIR="$SCRIPT_DIR"
[ -f "$GUARD_DIR/workspace-retirement-guard.sh" ] || GUARD_DIR="$SCRIPT_DIR/.."
if [ ! -f "$GUARD_DIR/workspace-retirement-guard.sh" ] || [ ! -f "$GUARD_DIR/dependency-seed-guard.sh" ]; then
  printf 'REFUSE: janitor safety helpers unavailable\n' >&2; exit 2
fi
# shellcheck source=deploy/workspace-retirement-guard.sh
source "$GUARD_DIR/workspace-retirement-guard.sh"
# shellcheck source=deploy/dependency-seed-guard.sh
source "$GUARD_DIR/dependency-seed-guard.sh"

# Never allow the hourly launchd run and an emergency/manual run to race each
# other. A race doubles lsof/du work and can make two cleaners inspect the same
# artifact before either removes it.
LOCK_DIR="${REMUDERO_JANITOR_LOCK_DIR:-$HOME/.cache/remudero-janitor.lock}"
if [ ! -d "$(dirname "$LOCK_DIR")" ]; then
  mkdir -p "$(dirname "$LOCK_DIR")" 2>/dev/null || exit 0
fi
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null || true' EXIT

AGE_HOURS="${REMUDERO_JANITOR_AGE_HOURS:-6}"
AGE_EXPLICIT=0
[ -n "${REMUDERO_JANITOR_AGE_HOURS:-}" ] && AGE_EXPLICIT=1
WORKTREE_AGE_HOURS="${REMUDERO_JANITOR_WORKTREE_AGE_HOURS:-6}"
MINIMUM_AGE_HOURS=6
MIN_FREE_GIB="${REMUDERO_JANITOR_MIN_FREE_GIB:-20}"
APPLY=0
LOG="${REMUDERO_JANITOR_LOG:-$HOME/Library/Logs/remudero/janitor.log}"

for a in "$@"; do
  case "$a" in
    --apply) APPLY=1 ;;
    --dry-run) APPLY=0 ;;
    --age-hours=*) AGE_HOURS="${a#*=}"; AGE_EXPLICIT=1 ;;
    -h|--help) sed -n '2,20p' "$0"; exit 0 ;;
  esac
done

for age_value in "$AGE_HOURS" "$WORKTREE_AGE_HOURS"; do
  case "$age_value" in ''|*[!0-9]*) printf 'invalid age threshold: %s\n' "$age_value" >&2; exit 2 ;; esac
done
if [ "$AGE_HOURS" -lt "$MINIMUM_AGE_HOURS" ] || [ "$WORKTREE_AGE_HOURS" -lt "$MINIMUM_AGE_HOURS" ]; then
  printf 'age thresholds must be at least %sh\n' "$MINIMUM_AGE_HOURS" >&2
  exit 2
fi

# Derive all account/repository paths from the account running the script.
# Azure runs this as craigoleyagent with HOME=/home/craigoleyagent; macOS runs
# it as craigoley with HOME=/Users/craigoley.
OS_NAME="$(uname -s)"
USER_HOME="${REMUDERO_JANITOR_ACCOUNT_HOME:-${HOME:?HOME must be set}}"
USER_HOME=$(cd "$USER_HOME" && pwd -P) || exit 2
RUN_USER="$(id -un)"
DEFAULT_TMP="${TMPDIR:-/tmp}"

# Roots to scan, and the temp-dir name prefixes rmd owns.
SCAN_ROOTS=("$DEFAULT_TMP" "/tmp" "/private/tmp")
if [ -n "${REMUDERO_JANITOR_SCAN_ROOTS:-}" ]; then
  IFS=: read -r -a SCAN_ROOTS < <(printf '%s\n' "$REMUDERO_JANITOR_SCAN_ROOTS")
fi
# These are the disposable scratch-root namespaces produced by rmd and its
# operator tooling. Do not broaden this to arbitrary /private/tmp entries.
PREFIXES=("rmd-" "remudero-" "codex-" "smart-router-")
ARTIFACTS=("node_modules" "coverage")

# Resolve aliases such as macOS /tmp -> /private/tmp once. Scanning both names
# doubled every recursive artifact/liveness check and could make linked Git
# worktree paths fail exact registration matching.
SCAN_ROOTS_UNIQUE=()
SCAN_ROOTS_UNIQUE_COUNT=0
for scan_root in "${SCAN_ROOTS[@]}"; do
  [ -d "$scan_root" ] || continue
  canonical_root=$(cd "$scan_root" 2>/dev/null && pwd -P) || continue
  root_seen=0
  for existing_root in "${SCAN_ROOTS_UNIQUE[@]+"${SCAN_ROOTS_UNIQUE[@]}"}"; do
    [ "$existing_root" = "$canonical_root" ] && root_seen=1 && break
  done
  if [ "$root_seen" = "0" ]; then
    SCAN_ROOTS_UNIQUE+=("$canonical_root")
    SCAN_ROOTS_UNIQUE_COUNT=$((SCAN_ROOTS_UNIQUE_COUNT+1))
  fi
done
if [ "$SCAN_ROOTS_UNIQUE_COUNT" -gt 0 ]; then
  SCAN_ROOTS=("${SCAN_ROOTS_UNIQUE[@]}")
fi

# These are generated coverage roots, not checkout roots. The leading-dot
# root under /private/tmp was the largest leak observed on 2026-09-21 and was
# invisible to the prefix loop below. Keep this list explicit; never sweep
# arbitrary /private/tmp directories.
SPECIAL_ARTIFACT_ROOTS=(
  "/private/tmp/.remudero-coverage"
  "/private/tmp/.rmd-coverage"
  "$DEFAULT_TMP/.remudero-coverage"
  "$DEFAULT_TMP/.rmd-coverage"
  "/tmp/.remudero-coverage"
  "/tmp/.rmd-coverage"
)
if [ "$OS_NAME" = "Darwin" ]; then
  SPECIAL_ARTIFACT_ROOTS+=(
    "$USER_HOME/Remudero/.remudero-coverage"
    "$USER_HOME/Remudero/.rmd-coverage"
    "$USER_HOME/Developer/.remudero-coverage"
    "$USER_HOME/Developer/.rmd-coverage"
    # The task preflight runner also stores generated coverage in this
    # repository-neutral work root; keep only these named generated roots in scope.
    "$USER_HOME/rmd-work/.remudero-coverage"
    "$USER_HOME/rmd-work/.rmd-coverage"
  )
fi

# NEVER touch these — canonical installs, persistent state, and fleet clone
# roots that live worktrees or containers may symlink/mount into. Discover the
# paths from this account rather than assuming /Users or /home layout.
PROTECTED=()
for p in \
  "$USER_HOME/Remudero/remudero" \
  "$USER_HOME/Remudero/remudero-console" \
  "$USER_HOME/Remudero/remudero-site" \
  "$USER_HOME/rmd-state2" \
  "$USER_HOME/Remudero/state"; do
  [ -e "$p" ] && PROTECTED+=("$p")
done
if [ -d "$USER_HOME/Remudero/repos" ]; then
  # Protect actual repository roots under the persistent `repos/` namespace.
  # Do not protect every direct child of ~/Remudero: those include disposable
  # task worktrees and were the reason the old reaper never reached them.
  while IFS= read -r p; do PROTECTED+=("$p"); done < <(find "$USER_HOME/Remudero/repos" -mindepth 2 -maxdepth 2 -type d -name .git -prune -exec dirname {} \; 2>/dev/null)
fi

# Account-owned retained checkout roots. Remudero task worktrees and CI/session
# checkouts are nested at varying depths (`worktrees/<id>`, `.session-scratch/*/repo`,
# `<run>/repo`). Discover Git markers recursively, but prune generated dependencies
# and Git metadata. Developer is an additional Mac-only allowlist.
RETAINED_CHECKOUTS=()
SCAN_FAILURES=()
SCRATCH_CHECKOUT_ROOTS=()
CHECKOUT_SCAN_ROOTS=("$USER_HOME/Remudero" "$USER_HOME/rmd-work")
if [ "$OS_NAME" = "Darwin" ]; then
  # Codex work artifacts can contain disposable Git checkouts too. Scan only
  # those repositories, then apply the same ignored-artifact, 6-hour,
  # process/cwd/open-file guards as every other retained checkout.
  codex_artifacts="$USER_HOME/.codex/work-artifacts"
  [ -d "$codex_artifacts" ] && [ ! -L "$codex_artifacts" ] && CHECKOUT_SCAN_ROOTS+=("$codex_artifacts")
  # The task preflight runner also leaves disposable checkout dependencies in
  # rmd-work. Scan repos there, but only clean their generated artifacts under
  # the same activity, Git-marker, owner, process, cwd, and open-file gates.
  rmd_work="$USER_HOME/rmd-work"
  [ -d "$rmd_work" ] && [ ! -L "$rmd_work" ] && CHECKOUT_SCAN_ROOTS+=("$rmd_work")
  for candidate in "$USER_HOME/Developer/remudero" "$USER_HOME/Developer"/remudero-*; do
    [ -d "$candidate" ] && [ ! -L "$candidate" ] && CHECKOUT_SCAN_ROOTS+=("$candidate")
  done
fi
for scan_root in "${SCAN_ROOTS[@]}"; do
  for prefix in "${PREFIXES[@]}"; do
    for candidate in "$scan_root/$prefix"*; do
      [ -d "$candidate" ] && [ ! -L "$candidate" ] || continue
      CHECKOUT_SCAN_ROOTS+=("$candidate")
      SCRATCH_CHECKOUT_ROOTS+=("$candidate")
    done
  done
done
CHECKOUT_SCANNED_ROOTS=()
for scan_root in "${CHECKOUT_SCAN_ROOTS[@]}"; do
  [ -d "$scan_root" ] || continue
  scan_real=$(cd "$scan_root" 2>/dev/null && pwd -P) || continue
  root_seen=0
  for existing_root in "${CHECKOUT_SCANNED_ROOTS[@]+"${CHECKOUT_SCANNED_ROOTS[@]}"}"; do
    [ "$existing_root" != "$scan_real" ] || { root_seen=1; break; }
  done
  [ "$root_seen" = 0 ] || continue
  CHECKOUT_SCANNED_ROOTS+=("$scan_real")
  if ! markers=$(find "$scan_root" -maxdepth 8 \
    \( -name node_modules -o -path "$scan_root/lanes" -o -path "$scan_root/state" \) -prune -o \
    -name .git -print -prune 2>/dev/null); then
    SCAN_FAILURES+=("$scan_root"); continue
  fi
  while IFS= read -r marker; do
    [ "${marker##*/}" = ".git" ] || continue
    candidate="${marker%/.git}"
    [ -d "$candidate" ] && [ ! -L "$candidate" ] && [ ! -L "$marker" ] || continue
    seen=0
    for existing in "${RETAINED_CHECKOUTS[@]+"${RETAINED_CHECKOUTS[@]}"}"; do
      [ "$existing" = "$candidate" ] && seen=1 && break
    done
    [ "$seen" = "0" ] || continue
    RETAINED_CHECKOUTS+=("$candidate")
  done <<< "$markers"
done

# Whole-directory scope approved by the operator. The canonical checkout is a
# scan container, never a removal target; tracked children remain protected.
DIRECTORY_SCAN_ROOTS=("$USER_HOME/Remudero" "$USER_HOME/Remudero/lanes-wt"
  "$USER_HOME/Remudero/remudero" "$USER_HOME/rmd-work")
if [ "$OS_NAME" = "Darwin" ]; then
  # Operator tools use this account-local namespace outside Remudero/rmd-work.
  # The container is never a target; each child gets the same Git/activity guards.
  DIRECTORY_SCAN_ROOTS+=("$USER_HOME/Developer/remudero-operator-worktrees")
fi
if [ "$RUN_USER" = craigoley ]; then
  if [ -n "${REMUDERO_JANITOR_SCAN_ROOTS:-}" ]; then DIRECTORY_SCAN_ROOTS+=("${SCAN_ROOTS[@]}")
  else DIRECTORY_SCAN_ROOTS+=("/private/tmp")
  fi
fi
if [ -n "${REMUDERO_JANITOR_DIRECTORY_ROOTS:-}" ]; then
  IFS=: read -r -a DIRECTORY_SCAN_ROOTS < <(printf '%s\n' "$REMUDERO_JANITOR_DIRECTORY_ROOTS")
fi
DIRECTORY_ROOTS=()
for directory_root in "${DIRECTORY_SCAN_ROOTS[@]}"; do
  [ -d "$directory_root" ] && [ ! -L "$directory_root" ] || continue
  directory_real=$(cd "$directory_root" 2>/dev/null && pwd -P) || continue
  # Parent aliases such as macOS /var -> /private/var are legitimate;
  # final-component symlink roots were refused above. Scan the physical path.
  root_seen=0
  for existing_root in "${DIRECTORY_ROOTS[@]+"${DIRECTORY_ROOTS[@]}"}"; do
    [ "$existing_root" != "$directory_real" ] || { root_seen=1; break; }
  done
  [ "$root_seen" = 1 ] || DIRECTORY_ROOTS+=("$directory_real")
done

NOW=$(date +%s)
mkdir -p "$(dirname "$LOG")"
# Rotate the human log at 16 MiB and keep one previous generation; it grew unbounded before.
if [ -f "$LOG" ] && [ ! -L "$LOG" ] && [ "$(wc -c < "$LOG")" -gt 16777216 ]; then mv -f "$LOG" "$LOG.1"; fi
DECISION_LOG="${REMUDERO_JANITOR_DECISION_LOG:-$USER_HOME/.local/state/remudero/janitor-decisions.tsv}"
mkdir -p "$(dirname "$DECISION_LOG")" && : >> "$DECISION_LOG" || exit 2
log() {
  rmd_decision_record "$DECISION_LOG" "$*" || { printf 'REFUSE: decision log unwritable\n' >&2; exit 2; }
  printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S')" "$*" | tee -a "$LOG"
}

is_protected() {
  local p="$1" q
  for q in "${PROTECTED[@]+"${PROTECTED[@]}"}"; do [ "$p" = "$q" ] && return 0; done
  return 1
}

is_scratch_checkout() {
  local p="$1" root
  for root in "${SCRATCH_CHECKOUT_ROOTS[@]+"${SCRATCH_CHECKOUT_ROOTS[@]}"}"; do
    case "$p" in "$root"|"$root"/*) return 0 ;; esac
  done
  return 1
}

# A checkout is LIVE if any running process names its path on the command line.
# This is what keeps an in-flight ci-parity/vitest run from losing its deps.
PSOUT=$(ps -axww -o pid=,command= 2>/dev/null)
# Bash 3.2 has sparse indexed arrays. Snapshot PID->command once, rather than
# running ps or reparsing the entire process list for every ancestor cwd.
index_process_commands() {
  local pid command
  PS_COMMANDS=()
  while read -r pid command; do
    case "$pid" in ''|*[!0-9]*) continue ;; esac
    PS_COMMANDS[pid]="$command"
  done <<< "$PSOUT"
}
index_process_commands
# Pure-bash substring match on purpose: a `printf | grep -q` pipeline returns
# 141 under `set -o pipefail` (grep exits on first match, printf takes SIGPIPE),
# which silently inverts this guard to always-false. No pipe, no subshell.
is_live() { case "$PSOUT" in *"$1"*) return 0 ;; *) return 1 ;; esac; }

HAS_LSOF=0
command -v lsof >/dev/null 2>&1 && HAS_LSOF=1

# Snapshot process working directories once. This catches an interactive shell
# or tool whose cwd is a checkout even when its argv omits the checkout path.
CWDOUT=""
CWD_STATUS=2
if [ "$HAS_LSOF" = "1" ]; then
  CWDOUT=$(lsof -nP -a -d cwd -Fn 2>/dev/null)
  CWD_STATUS=$?
fi
is_cwd_in() {
  local root="$1" line path cwd_pid="" relative command fresh fresh_rc fresh_pid
  [ "$HAS_LSOF" = "1" ] && [ "$CWD_STATUS" -le 1 ] || return 2
  while IFS= read -r line; do
    case "$line" in
      p*) cwd_pid=${line#p} ;;
      n*)
      path="${line#n}"
      case "$path" in "$root"|"$root"/*) return 0 ;; esac
      # A launcher cwd does not make every idle sibling active. Preserve a
      # child explicitly named by that process's relative command instead.
      case "$root" in "$path"/*)
        relative=${root#"${path%/}"/}
        case "$cwd_pid" in ''|*[!0-9]*) return 2 ;; esac
        if [ "${PS_COMMANDS[cwd_pid]+present}" = present ]; then
          command=${PS_COMMANDS[cwd_pid]}
        else
          # lsof runs after the ps snapshot. Its short-lived parent/probe can
          # appear here and already be gone, holding every sibling as unknown.
          # Only ps's empty exit-1 (no selected PID) proves that stale record
          # gone. Warnings, unreadable commands and malformed output still hold.
          fresh=$(ps -ww -p "$cwd_pid" -o pid=,command= 2>&1)
          fresh_rc=$?
          if [ "$fresh_rc" = 1 ] && [ -z "$fresh" ]; then continue; fi
          [ "$fresh_rc" = 0 ] || return 2
          case "$fresh" in *$'\n'*) return 2 ;; esac
          read -r fresh_pid command <<< "$fresh"
          [ "$fresh_pid" = "$cwd_pid" ] && [ -n "$command" ] || return 2
        fi
        case "$command" in *"$relative"*) return 0 ;; esac
        ;;
      esac
      ;;
    esac
  done < <(printf '%s\n' "$CWDOUT")
  return 1
}

artifact_mtime() {
  local values rc modified changed newest=0 stamp
  # Inspect the whole artifact, not just its root directory: changing an
  # existing nested file does not necessarily update the root directory mtime.
  # Include ctime so metadata changes also extend the retention window. Any
  # unreadable/incomplete scan fails closed in clean_artifact.
  if [ "$OS_NAME" = "Darwin" ]; then
    values=$(find "$1" -exec stat -f '%m %c' {} + 2>/dev/null)
  else
    values=$(find "$1" -exec stat -c '%Y %Z' {} + 2>/dev/null)
  fi
  rc=$?
  [ "$rc" -eq 0 ] || return 1
  while IFS=' ' read -r modified changed; do
    case "$modified" in ''|*[!0-9]*) return 1 ;; esac
    case "$changed" in ''|*[!0-9]*) return 1 ;; esac
    [ "$modified" -gt "$newest" ] && newest="$modified"
    [ "$changed" -gt "$newest" ] && newest="$changed"
  done < <(printf '%s\n' "$values")
  [ "$newest" -gt 0 ] || return 1
  printf '%s' "$newest"
}

artifact_owner() {
  if [ "$OS_NAME" = "Darwin" ]; then stat -f %Su "$1" 2>/dev/null
  else stat -c %U "$1" 2>/dev/null
  fi
}

# A command can keep a scratch root live through its cwd without naming that
# path in argv. lsof therefore guards the whole root, not just the artifact.
# Any lsof error is fail-closed: an unanswerable liveness question is never a
# deletion authorisation.
is_open() {
  local p="$1" out rc
  [ "$HAS_LSOF" = "1" ] || return 2
  # lsof writes filesystem/permission warnings to stderr even when it has no
  # matching open files. Those warnings are not evidence that the artifact is
  # open; keeping them in `out` made every agent-account sweep fail closed as
  # `SKIP unverified`. Treat stdout records as evidence and stderr separately
  # through the exit code only.
  out=$(lsof -nP +D "$p" 2>/dev/null)
  rc=$?
  [ "$rc" -gt 1 ] && return 2
  [ "$rc" -eq 1 ] && [ -n "$out" ] && return 2
  [ -n "$out" ] && return 0
  return 1
}

free_gib() {
  local mount="/"
  [ "$OS_NAME" = "Darwin" ] && mount="/System/Volumes/Data"
  df -k "$mount" 2>/dev/null | awk 'NR==2{printf "%d", $4/1024/1024}'
}

BEFORE=$(free_gib)

# Disk pressure must never shorten the user's 6-hour minimum retention window.
EMERGENCY_AGE_HOURS="${REMUDERO_JANITOR_EMERGENCY_AGE_HOURS:-6}"
case "$EMERGENCY_AGE_HOURS" in ''|*[!0-9]*) printf 'invalid emergency age threshold: %s\n' "$EMERGENCY_AGE_HOURS" >&2; exit 2 ;; esac
if [ "$EMERGENCY_AGE_HOURS" -lt "$MINIMUM_AGE_HOURS" ]; then
  printf 'emergency age threshold must be at least %sh\n' "$MINIMUM_AGE_HOURS" >&2
  exit 2
fi
if [ "$AGE_EXPLICIT" = "0" ] && [ "$BEFORE" -lt "$MIN_FREE_GIB" ]; then
  AGE_HOURS="$EMERGENCY_AGE_HOURS"
  log "EMERGENCY: ${BEFORE}GiB free < ${MIN_FREE_GIB}GiB floor — age threshold remains >=${AGE_HOURS}h"
fi

# Generated artifacts obey the same 6-hour minimum, including during pressure.
COVERAGE_AGE_HOURS="${REMUDERO_JANITOR_COVERAGE_AGE_HOURS:-6}"
if [ "$AGE_EXPLICIT" = "1" ]; then
  COVERAGE_AGE_HOURS="$AGE_HOURS"
elif [ "$BEFORE" -lt "$MIN_FREE_GIB" ]; then
  COVERAGE_AGE_HOURS="${REMUDERO_JANITOR_COVERAGE_EMERGENCY_AGE_HOURS:-6}"
fi
case "$COVERAGE_AGE_HOURS" in ''|*[!0-9]*) printf 'invalid coverage age threshold: %s\n' "$COVERAGE_AGE_HOURS" >&2; exit 2 ;; esac
if [ "$COVERAGE_AGE_HOURS" -lt "$MINIMUM_AGE_HOURS" ]; then
  printf 'coverage age threshold must be at least %sh\n' "$MINIMUM_AGE_HOURS" >&2
  exit 2
fi

log "=== janitor start: apply=$APPLY age>=${AGE_HOURS}h coverage-age>=${COVERAGE_AGE_HOURS}h free=${BEFORE}GiB ==="
log "checkout-scan: ${CHECKOUT_SCANNED_ROOTS[*]+${CHECKOUT_SCANNED_ROOTS[*]}}; Git discovery depth<=8"
for failed_root in "${SCAN_FAILURES[@]+"${SCAN_FAILURES[@]}"}"; do log "SKIP repository scan failed (unknown) $failed_root"; done

reclaimed_kb=0; removed=0; planned=0; estimated_kb=0
skipped_live=0; skipped_cwd=0; skipped_owner=0; skipped_open=0; skipped_young=0
removed_worktrees=0; planned_worktrees=0; skipped_worktrees=0
removed_link_paths=(); removed_link_targets=()

refresh_process_snapshot() {
  local rc
  PSOUT=$(ps -axww -o pid=,command= 2>/dev/null) || return 1
  index_process_commands
  [ "$HAS_LSOF" = "1" ] || return 1
  CWDOUT=$(lsof -nP -a -d cwd -Fn 2>/dev/null)
  rc=$?
  CWD_STATUS=$rc
  [ "$rc" -le 1 ]
}

artifact_index_risk() {
  local repo="$1" artifact="$2" relative tracked
  relative="${artifact#"$repo"/}"
  [ "$relative" != "$artifact" ] || { printf 'artifact path is outside its checkout'; return 0; }
  tracked=$(GIT_LITERAL_PATHSPECS=1 rmd_retirement_git "$repo" ls-files -- "$relative" 2>/dev/null) || {
    printf 'artifact Git index is unreadable'; return 0;
  }
  [ -z "$tracked" ] || { printf 'artifact contains tracked source'; return 0; }
  return 1
}

clean_artifact() {
  local artifact="$1" min_age="${2:-$AGE_HOURS}" policy="${3:-}" stamp age kb owner cwd_rc open_rc seed_reason parent found status scope activity_root="$1" artifact_repo="" index_risk
  # Dynamically scoped to log(): only reuse this candidate's existing size probe.
  local RMD_DECISION_KNOWN_BYTES=unknown
  [ -d "$artifact" ] && [ ! -L "$artifact" ] || return 0
  if [ "$policy" = residual ] && ! residual_cache_safe "$artifact"; then log "SKIP protected residual-cache $artifact"; return; fi
  # Unique test results/materialization receipts are durable even inside a
  # generated dependency tree. The bounded duplicate helper preserves them.
  if [ "${artifact##*/}" = node_modules ] && { [ -e "$artifact/.vite" ] || [ -L "$artifact/.vite" ] || [ -e "$artifact/.rmd-dependency-seed.json" ] || [ -L "$artifact/.rmd-dependency-seed.json" ]; }; then
    log "SKIP retained-dependency-evidence $artifact"; return
  fi
  if seed_reason=$(rmd_dependency_seed_risk "$artifact"); then log "SKIP protected $artifact ($seed_reason)"; return; fi
  found=$(find "$artifact" \( -name .git -o -name '*.bundle' \) -print -quit 2>/dev/null) || {
    log "SKIP content scan failed (unknown) $artifact"; return;
  }
  if [ -n "$found" ]; then log "SKIP protected repository-or-bundle $artifact"; return; fi
  parent=$(dirname "$artifact")
  while [ "$parent" != / ]; do
    [ "$policy" != residual ] || [ "$parent" != "${USER_HOME%/*}" ] || break
    if [ -e "$parent/.git" ]; then
      activity_root="$parent"
      artifact_repo="$parent"
      if index_risk=$(artifact_index_risk "$artifact_repo" "$artifact"); then
        log "SKIP protected $artifact ($index_risk)"; return
      fi
      status=$(rmd_retirement_git "$parent" status --porcelain --untracked-files=all 2>/dev/null) || {
        log "SKIP git-unverified $artifact"; return;
      }
      if [ -n "$status" ]; then log "SKIP dirty $artifact (checkout=$parent)"; return; fi
      scope="head"; [ -d "$parent/.git" ] && scope="all"
      if ! rmd_workspace_published "$parent" "$scope"; then log "SKIP $RMD_PUB_REASON $artifact (checkout=$parent)"; return; fi
      break
    fi
    parent=$(dirname "$parent")
  done
  owner=$(artifact_owner "$artifact")
  if [ "$owner" != "$RUN_USER" ]; then
    skipped_owner=$((skipped_owner+1)); log "SKIP owner=${owner:-unknown} $artifact"; return 0
  fi
  is_live "$artifact" && { skipped_live=$((skipped_live+1)); log "SKIP live      $artifact"; return 0; }
  is_cwd_in "$activity_root"
  cwd_rc=$?
  if [ "$cwd_rc" -eq 0 ]; then
    skipped_cwd=$((skipped_cwd+1)); log "SKIP cwd       $artifact"; return 0
  elif [ "$cwd_rc" -eq 2 ]; then
    skipped_open=$((skipped_open+1)); log "SKIP unverified $artifact"; return 0
  fi
  is_open "$artifact"
  open_rc=$?
  if [ "$open_rc" -eq 0 ]; then
    skipped_open=$((skipped_open+1)); log "SKIP open      $artifact"; return 0
  elif [ "$open_rc" -eq 2 ]; then
    skipped_open=$((skipped_open+1)); log "SKIP unverified $artifact"; return 0
  fi
  stamp=$(artifact_mtime "$artifact")
  case "$stamp" in ''|*[!0-9]*|0)
    skipped_open=$((skipped_open+1)); log "SKIP unverified-age $artifact"; return 0 ;;
  esac
  [ "$stamp" -gt "$NOW" ] && age=0 || age=$(( (NOW - stamp) / 3600 ))
  if [ "$age" -lt "$min_age" ]; then
    skipped_young=$((skipped_young+1)); log "SKIP young ${age}h $artifact"; return 0
  fi
  kb=$(du -sk "$artifact" 2>/dev/null | cut -f1)
  rmd_decision_known_kib "$kb" "$?"
  kb=${kb:-0}
  if [ "$APPLY" = "1" ]; then
    refresh_process_snapshot || { log "SKIP unverified process snapshot $artifact"; return; }
    is_live "$artifact" && { skipped_live=$((skipped_live+1)); log "SKIP live      $artifact"; return 0; }
    is_cwd_in "$activity_root"
    cwd_rc=$?
    if [ "$cwd_rc" -eq 0 ]; then
      skipped_cwd=$((skipped_cwd+1)); log "SKIP cwd       $artifact"; return 0
    elif [ "$cwd_rc" -eq 2 ]; then
      skipped_open=$((skipped_open+1)); log "SKIP unverified $artifact"; return 0
    fi
    is_open "$artifact"
    open_rc=$?
    if [ "$open_rc" -eq 0 ]; then
      skipped_open=$((skipped_open+1)); log "SKIP open      $artifact"; return 0
    elif [ "$open_rc" -eq 2 ]; then
      skipped_open=$((skipped_open+1)); log "SKIP unverified $artifact"; return 0
    fi
    stamp=$(artifact_mtime "$artifact") || stamp=0
    if [ "$stamp" -eq 0 ] || [ "$(( $(date +%s) - stamp ))" -lt "$((min_age * 3600))" ]; then
      log "SKIP recent-or-unverified-before-remove $artifact"; return
    fi
    # A concurrent author can add a cache-named source file after the first read.
    if [ -n "$artifact_repo" ] && index_risk=$(artifact_index_risk "$artifact_repo" "$artifact"); then
      log "SKIP changed protected $artifact ($index_risk)"; return
    fi
    # Immutable dependency snapshots may have read-only directories. Give
    # the owning account delete permission only on directories inside this
    # already-approved generated artifact. `find -P` avoids following any
    # dependency symlinks; if any directory cannot be made writable, fail
    # closed and leave the artifact in place.
    if [ "$policy" = residual ] && ! residual_cache_safe "$artifact"; then log "SKIP changed residual-cache $artifact"; return; fi
    if ! find -P "$artifact" -type d -exec chmod u+rwx {} + 2>/dev/null; then
      log "FAILED read-only-or-unverified $artifact"
      return 0
    fi
    if rm -rf -- "$artifact" 2>/dev/null; then
      reclaimed_kb=$((reclaimed_kb+kb)); removed=$((removed+1))
      log "REMOVED ${age}h $((kb/1024))M $artifact"
      [ "$policy" != residual ] || rmd_decision_record "$DECISION_LOG" "residual cache removed: $artifact" removed removed || exit 2
    else
      log "FAILED        $artifact"
    fi
  else
    estimated_kb=$((estimated_kb+kb)); planned=$((planned+1))
    log "WOULD-REMOVE ${age}h $((kb/1024))M $artifact"
  fi
}

residual_cache_safe() {
  local path="$1" parent="$1" found
  while [ "$parent" != "${USER_HOME%/*}" ] && [ "$parent" != / ]; do
    [ ! -L "$parent" ] && [ ! -e "$parent/.git" ] || return 1
    parent=${parent%/*}; [ -n "$parent" ] || parent=/
  done
  found=$(find -P "$path" -xdev \( ! -user "$RUN_USER" -o -type l -o -name .git -o -name '*.bundle' -o -name '*.lock' -o -name lock -o \( ! -type d ! -type f \) \) -print -quit 2>/dev/null) || return 1
  [ -z "$found" ]
}

npm_idle() {
  local commands
  commands=$(ps -U "$(id -u)" -ww -o command= 2>/dev/null) || return 1
  ! printf '%s\n' "$commands" | grep -E '(^|[ /])(npm|npx)([ /]|$)|/(npm|npx)-cli\.js' >/dev/null
}

prune_account_npm() {
  local root="$1" content="$2" file entries stamp kb
  [ -d "$root" ] && residual_cache_safe "$root" && npm_idle || return 0
  if ! command -v npm >/dev/null 2>&1; then
    clean_artifact "$root" "$AGE_HOURS" residual
    return
  fi
  [ -d "$content" ] || return
  entries=$(find -P "$content" -xdev -type f -print -quit 2>/dev/null) || { log "SKIP npm content scan failed $root"; return; }
  [ -n "$entries" ] || return
  while IFS= read -r -d '' file; do
    stamp=$(artifact_mtime "$file") || continue
    [ "$(( $(date +%s) - stamp ))" -ge "$((AGE_HOURS*3600))" ] || continue
    kb=$(du -xsk "$file" 2>/dev/null | cut -f1)
    case "$kb" in ''|*[!0-9]*) continue ;; esac
    refresh_process_snapshot && npm_idle && residual_cache_safe "$root" || { log "SKIP npm activity or structure unknown $root"; return; }
    is_live "$root" && return
    is_cwd_in "$root"; [ "$?" = 1 ] || return
    is_open "$root"; [ "$?" = 1 ] || return
    stamp=$(artifact_mtime "$file") || continue
    [ "$(( $(date +%s) - stamp ))" -ge "$((AGE_HOURS*3600))" ] || continue
    if [ "$APPLY" = 1 ]; then
      if rm -f -- "$file"; then
        removed=$((removed+1)); reclaimed_kb=$((reclaimed_kb+kb))
        log "REMOVED npm content $file"
        rmd_decision_record "$DECISION_LOG" "npm content removed: $file" removed removed "$((kb*1024))" || exit 2
      else log "FAILED npm content removal $file"; fi
    else log "WOULD-REMOVE npm content $file"; fi
  done < <(find -P "$content" -xdev -type f -print0 2>/dev/null)
  if [ "$APPLY" = 1 ] && npm_idle && residual_cache_safe "$root" && refresh_process_snapshot; then
    is_live "$root" && return
    is_cwd_in "$root"; [ "$?" = 1 ] || return
    is_open "$root"; [ "$?" = 1 ] || return
    [ "${root##*/}" != _cacache ] || npm cache verify --cache "$USER_HOME/.npm" >> "$LOG" 2>&1 || log "WARN npm cache verify failed $root"
  fi
}

# Retire stale local checkouts only when their Git state proves the files are
# disposable. Linked worktrees are removed through Git (never rm -rf), only
# after a clean/untracked-free check, an attached local branch (so commits stay
# reachable), a six-hour inactivity window, and process/cwd/open-file checks.
# Standalone clones additionally require their exact HEAD on origin and no
# linked worktrees; deleting a base clone while linked worktrees remain creates
# broken `.git` pointers, the orphan shape found in this account's audit.
checkout_activity_mtime() {
  local root="$1" values rc stamp newest=0
  if [ "$OS_NAME" = "Darwin" ]; then
    values=$(find "$root" -name .git -prune -o -exec stat -f '%m %c' {} + 2>/dev/null)
  else
    values=$(find "$root" -name .git -prune -o -exec stat -c '%Y %Z' {} + 2>/dev/null)
  fi
  rc=$?
  [ "$rc" -eq 0 ] || return 1
  for stamp in $values; do
    case "$stamp" in ''|*[!0-9]*) continue ;; esac
    [ "$stamp" -gt "$newest" ] && newest="$stamp"
  done
  [ "$newest" -gt 0 ] || return 1
  printf '%s' "$newest"
}

is_remudero_origin() {
  case "$1" in
    *github.com[:/]craigoley/remudero|*github.com[:/]craigoley/remudero.git|\
    *github.com[:/]craigoley/remudero-console|*github.com[:/]craigoley/remudero-console.git|\
    *github.com[:/]craigoley/remudero-site|*github.com[:/]craigoley/remudero-site.git) return 0 ;;
    *) return 1 ;;
  esac
}

# Permit only ignored regenerable dependency/coverage entries or their symlinks.
# Whole retirement independently requires publication, age and process guards.
ignored_only_dependency_symlinks() {
  local repo="$1" listing="$2" line rel tracked found
  [ -n "$listing" ] || return 0
  while IFS= read -r line; do
    case "$line" in
      "Would remove node_modules"|"Would remove node_modules/") rel="node_modules" ;;
      "Would remove coverage"|"Would remove coverage/") rel="coverage" ;;
      *) return 1 ;;
    esac
    [ -L "$repo/$rel" ] && continue
    [ -d "$repo/$rel" ] && [ -f "$repo/package.json" ] || return 1
    tracked=$(rmd_retirement_git "$repo" ls-files -- "$rel" 2>/dev/null) || return 1
    [ -z "$tracked" ] || return 1
    found=$(find "$repo/$rel" \( -name .git -o -name '*.bundle' \) -print -quit 2>/dev/null) || return 1
    [ -z "$found" ] || return 1
  done < <(printf '%s\n' "$listing")
  return 0
}

restore_dependency_symlinks() {
  local i path target
  for ((i=0; i<${#removed_link_paths[@]}; i++)); do
    path="${removed_link_paths[$i]}"
    target="${removed_link_targets[$i]}"
    if [ -d "$(dirname "$path")" ] && [ ! -e "$path" ] && [ ! -L "$path" ]; then
      ln -s "$target" "$path" 2>/dev/null || true
    fi
  done
}


worktree_registration() {
  local listing="$1" target="$2"
  printf '%s\n' "$listing" | awk -v target="$target" '
    $1 == "worktree" { inside = substr($0, 10) == target; if (inside) found = 1; next }
    inside && $1 == "locked" { locked = 1 }
    END { if (!found) print "missing"; else if (locked) print "locked"; else print "registered" }
  '
}

# Return a reason for a non-Git directory that cannot be established as scratch.
# The user's source/report preservation rule is independent of age. No name prefix
# is required for a data-only scratch directory inside these explicit scan roots.
scratch_directory_risk() {
  local path="$1" root="$2" q found parent relative tracked owner mount_text mount_line
  for q in "${DIRECTORY_ROOTS[@]+"${DIRECTORY_ROOTS[@]}"}" "${PROTECTED[@]+"${PROTECTED[@]}"}"; do
    case "$q" in "$path"|"$path"/*) printf 'protected scan container or persistent checkout'; return 0 ;; esac
  done
  case "${path##*/}" in
    .git|.remudero|.claude|.codex|.ssh|state|lanes|repos|worker-home|node_modules|claude-*|com.apple.*|launchd*|powerlog|.X*|.font-unix|.ICE-unix)
      printf 'persistent account/runtime directory'; return 0 ;;
  esac
  [ ! -e "$path/.git" ] && [ ! -L "$path/.git" ] || {
    printf 'Git workspace uses publication-aware retirement'; return 0;
  }
  if found=$(rmd_dependency_seed_risk "$path"); then printf '%s' "$found"; return 0; fi
  mount_text=$(mount 2>/dev/null) || { printf 'mount visibility unavailable'; return 0; }
  while IFS= read -r mount_line; do
    case "$mount_line" in
      *" on $path ("*|*" on $path type "*|*" on $path/"*) printf 'directory contains a mount'; return 0 ;;
    esac
  done < <(printf '%s\n' "$mount_text")
  owner=$(artifact_owner "$path")
  [ "$owner" = "$RUN_USER" ] || { printf 'foreign or unknown owner'; return 0; }
  found=$(find -P "$path" -xdev ! -user "$RUN_USER" -print -quit 2>/dev/null) || {
    printf 'ownership scan unavailable'; return 0;
  }
  [ -z "$found" ] || { printf 'contains foreign-owned content'; return 0; }
  # Preserve all repositories, including bare object lenders, archived commits,
  # state/history, dependency seeds and coordination files. Do not follow links.
  found=$(find -P "$path" -xdev \( -name .git -o -name HEAD -o -name objects -o -name '*.bundle' -o -name '*.tar' -o -name '*.tgz' -o -name '*.zip' -o -name '*.gz' \
    -o -name '.rmd-janitor-keep' -o -name 'ledger*' -o -name '*.ndjson' -o -name '*.jsonl' -o -name '*.sqlite*' -o -name '*.lock' -o -name '*.pid' \
    -o -iname '*.patch' -o -iname '*.diff' -o -iname '*.rej' -o -iname '*.orig' \
    -o -name '.env' -o -name '.env.*' -o -iname '*password*' -o -iname '*secret*' -o -iname '*token*' \
    -o -iname '*credential*' -o -iname '*keychain*' -o -name '*.pem' -o -name '*.p12' -o -name '*.pfx' \
    -o -name '*.keytab' -o -name 'id_rsa*' -o -name 'id_ed25519*' \) -print -quit 2>/dev/null) || {
    printf 'repository/state scan unavailable'; return 0;
  }
  [ -z "$found" ] || { printf 'repository, retained evidence, credentials or coordination'; return 0; }
  found=$(find -P "$path" -xdev ! -type d ! -type f -print -quit 2>/dev/null) || {
    printf 'file-type scan unavailable'; return 0;
  }
  [ -z "$found" ] || { printf 'symlink, mount boundary or special file'; return 0; }
  found=$(find -P "$path" -xdev -type f \( -perm -100 -o -perm -010 -o -perm -001 \) -print -quit 2>/dev/null) || {
    printf 'executable-source scan unavailable'; return 0;
  }
  [ -z "$found" ] || { printf 'unversioned executable or script'; return 0; }
  # Do not treat old non-Git scripts, manifests or reports as disposable data.
  found=$(find -P "$path" -xdev -type f \( -iname '*.sh' -o -iname '*.bash' -o -iname '*.zsh' \
    -o -iname '*.py' -o -iname '*.js' -o -iname '*.mjs' -o -iname '*.cjs' -o -iname '*.ts' \
    -o -iname '*.tsx' -o -iname '*.jsx' -o -iname '*.rs' -o -iname '*.go' -o -iname '*.c' \
    -o -iname '*.h' -o -iname '*.cpp' -o -iname '*.swift' -o -iname '*.rb' -o -iname '*.pl' \
    -o -iname '*.md' -o -iname '*.txt' -o -iname '*.csv' -o -iname '*.tsv' -o -iname '*.pdf' \
    -o -iname '*.docx' -o -iname '*.xlsx' -o -iname '*.html' -o -iname '*.yaml' -o -iname '*.yml' \
    -o -iname '*.toml' -o -iname '*.ini' -o -iname '*.sql' -o -iname '*.ipynb' -o -iname '*.svelte' -o -iname '*.vue' -o -iname '*.ps1' -o -iname '*.java' -o -iname '*.cs' -o \( -iname '*.json' ! -name 'coverage-[0-9]*-[0-9]*-[0-9]*.json' \) \
    -o -iname 'README*' -o -iname 'LICENSE*' -o -name Makefile -o -name Dockerfile \) -print -quit 2>/dev/null) || {
    printf 'unversioned source/report scan unavailable'; return 0;
  }
  [ -z "$found" ] || { printf 'unversioned source, manifest or report'; return 0; }
  # An ignored scratch child in a canonical repository may be cleaned, but a
  # tracked or merely untracked source child cannot. No Git state is changed.
  parent="$root"
  while [ "$parent" != / ]; do
    if [ -e "$parent/.git" ] || [ -L "$parent/.git" ]; then
      relative=${path#"$parent"/}
      tracked=$(GIT_LITERAL_PATHSPECS=1 rmd_retirement_git "$parent" ls-files -- "$relative" 2>/dev/null) || {
        printf 'enclosing Git status unavailable'; return 0;
      }
      [ -z "$tracked" ] || { printf 'tracked source directory'; return 0; }
      rmd_retirement_git "$parent" check-ignore -q -- "$relative" 2>/dev/null || {
        printf 'untracked source directory is not ignored'; return 0;
      }
      break
    fi
    parent=$(dirname "$parent")
  done
  return 1
}

scratch_directory_identity() {
  if [ "$OS_NAME" = Darwin ]; then stat -f '%d:%i' "$1" 2>/dev/null
  else stat -c '%d:%i' "$1" 2>/dev/null
  fi
}

clean_scratch_directory() {
  local path="$1" root="$2" reason stamp identity current kb cwd_rc open_rc check_phase metadata modified changed
  local RMD_DECISION_KNOWN_BYTES=unknown
  [ -d "$path" ] && [ ! -L "$path" ] || return 0
  # A recently touched root already proves the whole tree is ineligible. Avoid
  # traversing today's large job directories merely to rediscover that fact.
  if [ "$OS_NAME" = Darwin ]; then
    metadata=$(stat -f '%m %c' "$path" 2>/dev/null) || { log "SKIP scratch $path (root age unavailable)"; return; }
  else
    metadata=$(stat -c '%Y %Z' "$path" 2>/dev/null) || { log "SKIP scratch $path (root age unavailable)"; return; }
  fi
  read -r modified changed <<< "$metadata"
  case "$modified:$changed" in :*|*:|*[!0-9:]*) log "SKIP scratch $path (root age unavailable)"; return ;; esac
  if [ "$(( $(date +%s) - modified ))" -lt "$((AGE_HOURS * 3600))" ] || \
     [ "$(( $(date +%s) - changed ))" -lt "$((AGE_HOURS * 3600))" ]; then
    log "SKIP scratch $path (content or metadata touched within ${AGE_HOURS}h)"; return;
  fi
  # A Git checkout is handled exclusively by the publication-aware worktree
  # lane, not by recursive rm. A containing scratch directory is also retained.
  if reason=$(scratch_directory_risk "$path" "$root"); then
    log "SKIP scratch $path ($reason)"; return;
  fi
  identity=$(scratch_directory_identity "$path") || { log "SKIP scratch $path (identity unavailable)"; return; }
  case "$identity" in ''|:*|*:|*:*:*|*[!0-9:]*) log "SKIP scratch $path (invalid identity)"; return ;; esac
  kb=$(du -sk "$path" 2>/dev/null | cut -f1)
  rmd_decision_known_kib "$kb" "$?"
  case "$kb" in ''|*[!0-9]*) log "SKIP scratch $path (size unavailable)"; return ;; esac
  for check_phase in initial before-remove; do
    refresh_process_snapshot || { log "SKIP scratch $path (process visibility unavailable)"; return; }
    is_live "$path" && { log "SKIP scratch $path (live command)"; return; }
    is_cwd_in "$path"; cwd_rc=$?
    [ "$cwd_rc" = 1 ] || { log "SKIP scratch $path (working directory active or unknown)"; return; }
    is_open "$path"; open_rc=$?
    [ "$open_rc" = 1 ] || { log "SKIP scratch $path (open files or visibility unknown)"; return; }
    if [ "$check_phase" = before-remove ] && reason=$(scratch_directory_risk "$path" "$root"); then
      log "SKIP scratch $path ($reason)"; return;
    fi
    stamp=$(artifact_mtime "$path") || { log "SKIP scratch $path (age unavailable)"; return; }
    case "$stamp" in ''|*[!0-9]*|0) log "SKIP scratch $path (age unavailable)"; return ;; esac
    if [ "$(( $(date +%s) - stamp ))" -lt "$((AGE_HOURS * 3600))" ]; then
      log "SKIP scratch $path (content or metadata touched within ${AGE_HOURS}h)"; return;
    fi
    current=$(scratch_directory_identity "$path") || current=""
    [ "$current" = "$identity" ] || { log "SKIP scratch $path (identity changed)"; return; }
    [ "$APPLY" = 1 ] || break
  done
  if [ "$APPLY" = 1 ]; then
    if rm -rf -- "$path"; then
      removed=$((removed+1)); reclaimed_kb=$((reclaimed_kb+kb))
      log "REMOVED-SCRATCH age>=${AGE_HOURS}h $((kb/1024))M $path"
    else log "FAILED scratch directory $path"; fi
  else
    planned=$((planned+1)); estimated_kb=$((estimated_kb+kb))
    log "WOULD-REMOVE-SCRATCH age>=${AGE_HOURS}h $((kb/1024))M $path"
  fi
}

repair_alternates() {
  local repo="$1" stamp line alternate head_path
  command -v python3 >/dev/null 2>&1 || return
  alternate=$(rmd_retirement_git "$repo" rev-parse --path-format=absolute --git-path objects/info/alternates 2>/dev/null) || return
  [ -f "$alternate" ] && [ ! -L "$alternate" ] || return
  [ "$(artifact_owner "$repo")" = "$RUN_USER" ] || return
  for head_path in "$alternate" "$(rmd_retirement_git "$repo" rev-parse --path-format=absolute --git-path HEAD 2>/dev/null)"; do
    stamp=$(artifact_mtime "$head_path") || return
    [ "$(( $(date +%s) - stamp ))" -ge "$((MINIMUM_AGE_HOURS*3600))" ] || return
  done
  stamp=$(checkout_activity_mtime "$repo") || return
  [ "$(( $(date +%s) - stamp ))" -ge "$((MINIMUM_AGE_HOURS*3600))" ] || return
  refresh_process_snapshot || return
  is_live "$repo" && return
  is_cwd_in "$repo"; [ "$?" = 1 ] || return
  is_open "$repo"; [ "$?" = 1 ] || return
  while IFS= read -r line; do
    case "$line" in
      repaired:*|repair-reverted:*)
        rmd_decision_record "$DECISION_LOG" "$line" "${line%%:*}" "${line%%:*}" || exit 2 ;;
    esac
    log "$line"
  done < <(python3 -I - "$USER_HOME" "$repo" "$APPLY" "${RETAINED_CHECKOUTS[@]}" <<'PYTHON'
import os, pathlib, re, stat, subprocess, sys
home, repo, apply, *known = sys.argv[1:]
def owned(path):
    path = os.path.abspath(path)
    if not path.startswith(home + os.sep): return False
    while path != home:
        st = os.lstat(path)
        if stat.S_ISLNK(st.st_mode) or st.st_uid != os.getuid(): return False
        path = os.path.dirname(path)
    return True
def store(path):
    marker = pathlib.Path(path, '.git')
    gd = marker if marker.is_dir() else pathlib.Path(path, marker.read_text().strip().removeprefix('gitdir: '))
    gd = pathlib.Path(os.path.abspath(gd))
    if (gd / 'commondir').is_file(): gd = pathlib.Path(os.path.abspath(gd / (gd / 'commondir').read_text().strip()))
    return gd / 'objects'
def git(*args):
    return subprocess.run(['git', '-C', repo, *args], capture_output=True, timeout=30,
                          env=dict(os.environ, GIT_NO_LAZY_FETCH='1', GIT_TERMINAL_PROMPT='0', GIT_OPTIONAL_LOCKS='0'))
def repair():
    objects = store(repo)
    alt = objects / 'info/alternates'
    if not alt.is_file() or not owned(alt) or alt.stat().st_nlink != 1: return
    if git('config', '--get-regexp', r'^(extensions\.partialclone|remote\..*\.promisor)$').stdout: return
    original = alt.read_bytes()
    lines = original.decode().splitlines()
    resolved = []
    for line in lines:
        if not line or line.startswith('#'): resolved.append(line); continue
        path = pathlib.Path(os.path.abspath(objects / line))
        if not path.is_dir():
            # Use only a known account-local lender that actually has HEAD.
            head = git('rev-parse', '--verify', 'HEAD').stdout.strip().decode()
            if not re.fullmatch(r'[0-9a-f]{40,64}', head): return
            path = None
            lenders = []
            for lender in known:
                try: lenders.append(store(lender))
                except (OSError, ValueError): continue
            for namespace in ('.local/share/remudero/git-pools', 'Remudero/repos', 'Remudero', 'rmd-work'):
                root = pathlib.Path(home, namespace)
                if not root.is_dir() or not owned(root): continue
                for lender in root.iterdir():
                    if (lender / 'HEAD').is_file() and (lender / 'refs').is_dir() and (lender / 'objects').is_dir():
                        lenders.append(lender / 'objects')
            for candidate in lenders:
                if candidate == objects or not candidate.is_dir() or not owned(candidate): continue
                config = subprocess.run(['git', '--git-dir', str(candidate.parent), 'config', '--get-regexp', r'^(extensions\.partialclone|remote\..*\.promisor)$'],
                                        capture_output=True, timeout=30)
                if config.stdout or config.returncode not in (0, 1): continue
                out = subprocess.run(['git', '--git-dir', str(candidate.parent), 'cat-file', '-e', head + '^{commit}'],
                                     capture_output=True, timeout=30, env=dict(os.environ, GIT_NO_LAZY_FETCH='1', GIT_TERMINAL_PROMPT='0'))
                if out.returncode == 0: path = candidate; break
            if path is None: return
        if not owned(path): return
        resolved.append(str(path))
    replacement = ('\n'.join(resolved) + '\n').encode()
    if replacement == original: return
    if apply != '1': print('WOULD-REPAIR alternates: ' + repo); return
    backup = pathlib.Path(str(alt) + '.pre-repair')
    # Never overwrite evidence from an earlier repair or follow a backup link.
    if os.path.lexists(backup): return
    with open(backup, 'xb') as out: out.write(original)
    os.chmod(backup, 0o600)
    try:
        if alt.read_bytes() != original: raise ValueError('alternates changed before repair')
        alt.write_bytes(replacement)
        head = git('rev-parse', '--verify', 'HEAD')
        if head.returncode or head.stderr: raise ValueError('HEAD re-probe failed')
        check = git('fsck', '--connectivity-only', '--no-reflogs', head.stdout.strip().decode())
        if check.returncode or check.stderr: raise ValueError('HEAD connectivity re-probe failed')
    except (OSError, ValueError, subprocess.TimeoutExpired) as error:
        alt.write_bytes(original)
        print('repair-reverted: ' + repo + ' reason=' + str(error))
        return
    print('repaired: ' + repo + ' alternates=' + ','.join(resolved))
try:
    repair()
except (OSError, ValueError, UnicodeError, subprocess.TimeoutExpired) as error:
    print('SKIP alternates repair: ' + repo + ' reason=' + str(error))
PYTHON
  )
}
for repo in "${RETAINED_CHECKOUTS[@]+"${RETAINED_CHECKOUTS[@]}"}"; do repair_alternates "$repo"; done

# Direct children of each approved container are independently assessed. This
# reaches lanes-wt and ignored scratch beneath the canonical checkout without
# making either container itself disposable or traversing its tracked source.
for directory_root in "${DIRECTORY_ROOTS[@]+"${DIRECTORY_ROOTS[@]}"}"; do
  [ "$(artifact_owner "$directory_root")" = "$RUN_USER" ] || {
    log "SKIP scratch root $directory_root (foreign or unknown owner)"; continue;
  }
  log "scratch-directory-scan: $directory_root; all-content age>=${AGE_HOURS}h"
  for scratch in "$directory_root"/* "$directory_root"/.[!.]* "$directory_root"/..?*; do
    clean_scratch_directory "$scratch" "$directory_root"
  done
done

for repo in "${RETAINED_CHECKOUTS[@]+"${RETAINED_CHECKOUTS[@]}"}"; do
    RMD_DECISION_KNOWN_BYTES=unknown
    marker="$repo/.git"
    [ -e "$marker" ] && [ ! -L "$marker" ] || continue
    case "$repo" in
      "$USER_HOME/Remudero/repos/"*)
        # Persistent standalone clones in repos/ stay user-owned. Linked
        # worktrees there have a .git file and remain eligible by Git rules.
        [ -d "$marker" ] && continue
        ;;
    esac
    if is_protected "$repo"; then log "SKIP protected $repo"; continue; fi
    nested_source=0
    for protected_parent in "${PROTECTED[@]+"${PROTECTED[@]}"}"; do
      case "$repo" in "$protected_parent"/*)
        if [ -e "$protected_parent/.git" ]; then
          relative_path=${repo#"$protected_parent"/}
          if ! tracked_parent=$(rmd_retirement_git "$protected_parent" ls-files -- "$relative_path" 2>/dev/null); then
            log "SKIP git-unverified enclosing checkout $repo"; nested_source=1; break
          fi
          if [ -n "$tracked_parent" ]; then log "SKIP protected tracked-nested-source $repo"; nested_source=1; break; fi
        fi
        ;;
      esac
    done
    [ "$nested_source" = 1 ] && continue

    # Root mtime is a cheap first gate; then inspect source-file mtimes because
    # directory mtimes do not advance when nested files are edited.
    activity_stamp=$(checkout_activity_mtime "$repo") || {
      skipped_worktrees=$((skipped_worktrees+1)); log "SKIP unverified-activity $repo"; continue;
    }
    activity_age=$(( (NOW - activity_stamp) / 3600 ))
    if [ "$activity_age" -lt "$WORKTREE_AGE_HOURS" ]; then
      skipped_worktrees=$((skipped_worktrees+1)); log "SKIP recent-file-activity ${activity_age}h $repo"; continue
    fi
    refresh_process_snapshot || { log "SKIP unverified process snapshot $repo"; continue; }
    if seed_reason=$(rmd_dependency_seed_risk "$repo"); then log "SKIP protected $repo ($seed_reason)"; continue; fi
    owner=$(artifact_owner "$repo")
    if [ "$owner" != "$RUN_USER" ]; then
      skipped_owner=$((skipped_owner+1)); log "SKIP owner=${owner:-unknown} $repo"; continue
    fi
    if is_live "$repo"; then
      skipped_live=$((skipped_live+1)); log "SKIP live      $repo"; continue
    fi
    is_cwd_in "$repo"
    cwd_rc=$?
    if [ "$cwd_rc" -eq 0 ]; then
      skipped_cwd=$((skipped_cwd+1)); log "SKIP cwd       $repo"; continue
    elif [ "$cwd_rc" -eq 2 ]; then
      skipped_open=$((skipped_open+1)); log "SKIP unverified-cwd $repo"; continue
    fi
    is_open "$repo"
    open_rc=$?
    if [ "$open_rc" -eq 0 ]; then
      skipped_open=$((skipped_open+1)); log "SKIP open      $repo"; continue
    elif [ "$open_rc" -eq 2 ]; then
      skipped_open=$((skipped_open+1)); log "SKIP unverified-open $repo"; continue
    fi

    origin=$(rmd_retirement_git "$repo" remote get-url origin 2>/dev/null) || origin=""
    status=$(rmd_retirement_git "$repo" status --porcelain --untracked-files=all 2>/dev/null)
    status_rc=$?
    if [ "$status_rc" -ne 0 ]; then
      skipped_worktrees=$((skipped_worktrees+1)); log "SKIP git-unverified $repo"; continue
    fi
    if [ -n "$status" ]; then
      skipped_worktrees=$((skipped_worktrees+1)); log "SKIP dirty      $repo"; continue
    fi
    ignored=$(rmd_retirement_git "$repo" clean -ndx 2>/dev/null)
    ignored_rc=$?
    if [ "$ignored_rc" -ne 0 ] || ! ignored_only_dependency_symlinks "$repo" "$ignored"; then
      skipped_worktrees=$((skipped_worktrees+1)); log "SKIP ignored-or-unverified $repo"; continue
    fi

    branch=$(rmd_retirement_git "$repo" branch --show-current 2>/dev/null)
    head=$(rmd_retirement_git "$repo" rev-parse --verify HEAD 2>/dev/null)
    [ -n "$head" ] || {
      skipped_worktrees=$((skipped_worktrees+1)); log "SKIP git-unverified $repo"; continue;
    }
    head_file=$(rmd_retirement_git "$repo" rev-parse --path-format=absolute --git-path HEAD 2>/dev/null) || head_file=""
    head_stamp=$(artifact_mtime "$head_file" 2>/dev/null) || head_stamp=0
    if [ "$head_stamp" -eq 0 ] || [ "$((NOW - head_stamp))" -lt "$((WORKTREE_AGE_HOURS * 3600))" ]; then
      log "SKIP recent-or-unverified-git-head $repo"; continue
    fi
    if [ -n "$branch" ] && ! rmd_retirement_git "$repo" show-ref --verify --quiet "refs/heads/$branch"; then
      skipped_worktrees=$((skipped_worktrees+1)); log "SKIP branch-unverified $repo"; continue
    fi

    if [ -f "$marker" ]; then
      if ! rmd_workspace_published "$repo"; then
        skipped_worktrees=$((skipped_worktrees+1)); log "SKIP $RMD_PUB_REASON $repo (HEAD=$head)"; continue
      fi
      listing=$(rmd_retirement_git "$repo" worktree list --porcelain 2>/dev/null) || listing=""
      registration=$(worktree_registration "$listing" "$repo")
      if [ "$registration" != "registered" ]; then
        skipped_worktrees=$((skipped_worktrees+1)); log "SKIP worktree-$registration $repo"; continue
      fi
      common_dir=$(rmd_retirement_git "$repo" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || common_dir=""
      if [ -z "$common_dir" ] || [ ! -d "$common_dir" ]; then
        skipped_worktrees=$((skipped_worktrees+1)); log "SKIP git-unverified $repo"; continue
      fi
      common_repo=$(dirname "$common_dir")
      kb=$(du -sk "$repo" 2>/dev/null | cut -f1)
      rmd_decision_known_kib "$kb" "$?"
      kb=${kb:-0}
      if [ "$APPLY" = "1" ]; then
        refresh_process_snapshot || { log "SKIP unverified process snapshot $repo"; continue; }
        is_live "$repo" && { skipped_live=$((skipped_live+1)); log "SKIP live      $repo"; continue; }
        is_cwd_in "$repo"
        cwd_rc=$?
        if [ "$cwd_rc" -eq 0 ]; then
          skipped_cwd=$((skipped_cwd+1)); log "SKIP cwd       $repo"; continue
        elif [ "$cwd_rc" -eq 2 ]; then
          skipped_open=$((skipped_open+1)); log "SKIP unverified-cwd $repo"; continue
        fi
        is_open "$repo"
        open_rc=$?
        if [ "$open_rc" -ne 1 ]; then
          skipped_open=$((skipped_open+1)); log "SKIP open-or-unverified $repo"; continue
        fi
        latest_activity=$(checkout_activity_mtime "$repo") || latest_activity=0
        latest_age=$(( (NOW - latest_activity) / 3600 ))
        if [ "$latest_activity" -eq 0 ] || [ "$latest_age" -lt "$WORKTREE_AGE_HOURS" ]; then
          skipped_worktrees=$((skipped_worktrees+1)); log "SKIP recent-before-remove ${latest_age}h $repo"; continue
        fi
        if ! status=$(rmd_retirement_git "$repo" status --porcelain --untracked-files=all 2>/dev/null); then
          skipped_worktrees=$((skipped_worktrees+1)); log "SKIP changed-before-remove $repo"; continue
        fi
        ignored=$(rmd_retirement_git "$repo" clean -ndx 2>/dev/null)
        ignored_rc=$?
        if [ "$ignored_rc" -ne 0 ] || [ -n "$status" ] || ! ignored_only_dependency_symlinks "$repo" "$ignored"; then
          skipped_worktrees=$((skipped_worktrees+1)); log "SKIP changed-before-remove $repo"; continue
        fi
        current_head=$(rmd_retirement_git "$repo" rev-parse --verify HEAD 2>/dev/null) || current_head=""
        if [ "$current_head" != "$head" ] || ! rmd_workspace_published "$repo" head 1; then
          log "SKIP ref-changed-or-not-proven-published-before-remove $repo"; continue
        fi
        head_stamp=$(artifact_mtime "$head_file" 2>/dev/null) || head_stamp=0
        if [ "$head_stamp" -eq 0 ] || [ "$(( $(date +%s) - head_stamp ))" -lt "$((WORKTREE_AGE_HOURS * 3600))" ]; then
          log "SKIP recent-or-unverified-git-head-before-remove $repo"; continue
        fi
        removed_link_paths=()
        removed_link_targets=()
        for rel in node_modules coverage; do
          link_path="$repo/$rel"
          if [ -L "$link_path" ]; then
            link_target=$(readlink "$link_path" 2>/dev/null) || link_target=""
            if [ -z "$link_target" ] || ! rm -- "$link_path"; then
              restore_dependency_symlinks
              skipped_worktrees=$((skipped_worktrees+1)); log "SKIP symlink-changed-before-remove $repo"; continue 2
            fi
            removed_link_paths+=("$link_path")
            removed_link_targets+=("$link_target")
          fi
        done
        ignored_after=$(rmd_retirement_git "$repo" clean -ndx 2>/dev/null)
        ignored_after_rc=$?
        if [ "$ignored_after_rc" -ne 0 ] || ! ignored_only_dependency_symlinks "$repo" "$ignored_after"; then
          restore_dependency_symlinks
          skipped_worktrees=$((skipped_worktrees+1)); log "SKIP ignored-changed-before-remove $repo"; continue
        fi
        if rmd_retirement_git "$common_repo" worktree remove "$repo"; then
          removed_worktrees=$((removed_worktrees+1)); reclaimed_kb=$((reclaimed_kb+kb))
          log "REMOVED-WORKTREE ${activity_age}h $((kb/1024))M $repo (branch=$branch retained)"
        else
          restore_dependency_symlinks
          skipped_worktrees=$((skipped_worktrees+1)); log "SKIP git-remove-failed $repo"
        fi
      else
        planned_worktrees=$((planned_worktrees+1)); estimated_kb=$((estimated_kb+kb))
        log "WOULD-REMOVE-WORKTREE ${activity_age}h $((kb/1024))M $repo (branch=$branch retained)"
      fi
    elif [ -d "$marker" ]; then
      # A standalone clone owns objects possibly borrowed by other accounts.
      # Classify its Git state, but retain the object store conservatively.
      if ! is_remudero_origin "$origin"; then
        skipped_worktrees=$((skipped_worktrees+1)); log "SKIP non-remudero-origin $repo"; continue
      fi
      if [ -n "$ignored" ]; then
        skipped_worktrees=$((skipped_worktrees+1)); log "SKIP ignored-or-unverified $repo"; continue
      fi
      listing=$(rmd_retirement_git "$repo" worktree list --porcelain 2>/dev/null) || listing=""
      worktree_count=$(printf '%s\n' "$listing" | awk '$1 == "worktree" { n++ } END { print n+0 }')
      if [ "$worktree_count" -ne 1 ]; then
        skipped_worktrees=$((skipped_worktrees+1)); log "SKIP base-has-linked-worktrees $repo"; continue
      fi
      local_branches=$(rmd_retirement_git "$repo" for-each-ref --format='%(refname:short)' refs/heads 2>/dev/null)
      if [ "$local_branches" != "$branch" ]; then
        skipped_worktrees=$((skipped_worktrees+1)); log "SKIP extra-local-branches $repo"; continue
      fi
      if ! rmd_workspace_published "$repo" all; then
        skipped_worktrees=$((skipped_worktrees+1)); log "SKIP $RMD_PUB_REASON $repo"; continue
      fi
      # A full clone may lend objects through alternates, even with no Git
      # worktree registrations. Until a complete cross-account borrower
      # inventory exists, retain its object store; generated caches still age out.
      skipped_worktrees=$((skipped_worktrees+1)); log "SKIP git-lender-unverified $repo (published clone; object store retained)"
      continue
    fi
done
RMD_DECISION_KNOWN_BYTES=unknown

# Clean explicitly-owned generated roots first. This catches the hidden
# `.remudero-coverage` root that is not itself named rmd-/remudero-.
for special in "${SPECIAL_ARTIFACT_ROOTS[@]}"; do
  [ -d "$special" ] || continue
  clean_artifact "$special" "$COVERAGE_AGE_HOURS"
done

# The agent profile has a separate worker HOME below Remudero. Its npm and
# Cargo registries are regenerable caches, not project source; keep installed
# toolchains (.rustup) and executable tools (.cargo/bin) intact.
for cache in \
  "$USER_HOME/Remudero/worker-home/.npm/_cacache" \
  "$USER_HOME/Remudero/worker-home/.npm/_npx" \
  "$USER_HOME/Remudero/worker-home/.cargo/registry"; do
  [ -d "$cache" ] && [ ! -L "$cache" ] || continue
  clean_artifact "$cache" "$AGE_HOURS"
done

# Account-local test caches are separate from the persistent remudero cache.
for cache in "$USER_HOME/.cache"/remudero-*; do
  [ "$cache" != "$LOCK_DIR" ] || continue
  case "${cache##*/}" in *.lock) continue ;; esac
  [ -d "$cache" ] && [ ! -L "$cache" ] || continue
  if ! refresh_process_snapshot; then log "SKIP cache process visibility unknown $cache"; continue; fi
  case "${cache##*/}" in remudero-store-fill-*)
    log "cache rationale: $cache creator=unidentified historical/external store-fill runner; core test/the-core-fleet-fills-the-child-entry-store.test.ts uses tmpdir, not this home cache" ;;
  esac
  clean_artifact "$cache" "$AGE_HOURS" residual
done
prune_account_npm "$USER_HOME/.npm/_cacache" "$USER_HOME/.npm/_cacache/content-v2"
prune_account_npm "$USER_HOME/.npm/_npx" "$USER_HOME/.npm/_npx"

# Some task runners make immutable dependency snapshots directly under
# rmd-work. They intentionally omit .git, so checkout discovery cannot see
# them. Only prune node_modules from the two known snapshot name families
# when package manifests prove it is a Node dependency tree; preserve the
# snapshot source and manifests. Refresh process/cwd state for each candidate,
# then fail closed on any open-file or age uncertainty.

if [ "$OS_NAME" = "Darwin" ] && [ -d "$USER_HOME/rmd-work" ]; then
  for snapshot in \
    "$USER_HOME/rmd-work"/*-clone-snapshot-* \
    "$USER_HOME/rmd-work"/*-dependency-snapshot-*; do
    [ -d "$snapshot" ] && [ ! -L "$snapshot" ] || continue
    [ -f "$snapshot/package.json" ] && [ -f "$snapshot/package-lock.json" ] || continue
    artifact="$snapshot/node_modules"
    [ -d "$artifact" ] && [ ! -L "$artifact" ] || continue
    if ! refresh_process_snapshot; then
      skipped_open=$((skipped_open+1)); log "SKIP unverified snapshot $snapshot"; continue
    fi
    if is_live "$snapshot"; then
      skipped_live=$((skipped_live+1)); log "SKIP live snapshot $snapshot"; continue
    fi
    is_cwd_in "$snapshot"
    cwd_rc=$?
    if [ "$cwd_rc" -eq 0 ]; then
      skipped_cwd=$((skipped_cwd+1)); log "SKIP cwd snapshot $snapshot"; continue
    elif [ "$cwd_rc" -eq 2 ]; then
      skipped_open=$((skipped_open+1)); log "SKIP unverified snapshot $snapshot"; continue
    fi
    is_open "$snapshot"
    open_rc=$?
    if [ "$open_rc" -eq 0 ]; then
      skipped_open=$((skipped_open+1)); log "SKIP open snapshot $snapshot"; continue
    elif [ "$open_rc" -eq 2 ]; then
      skipped_open=$((skipped_open+1)); log "SKIP unverified snapshot $snapshot"; continue
    fi
    clean_artifact "$artifact" "$AGE_HOURS"
  done
fi

# The CI helper derives `$checkout/coverage` as gitignored output and
# `$parent/.remudero-coverage/<checkout>/tmp` as disposable TMPDIR. Recursively
# discovered checkout roots also include nested CI/session worktrees. Remove
# only the named regenerable artifacts here; source/history is handled below
# under stricter whole-checkout retirement gates.
for repo in "${RETAINED_CHECKOUTS[@]+"${RETAINED_CHECKOUTS[@]}"}"; do
    is_scratch_checkout "$repo" && continue # scratch artifacts are swept once below
    is_protected "$repo" && continue
    for kind in "node_modules" "coverage"; do
      artifact="$repo/$kind"
      [ -d "$artifact" ] && [ ! -L "$artifact" ] || continue
      if [ "$kind" = "node_modules" ]; then
        # `node_modules` is regenerable only in a Node checkout. Do not infer
        # ownership from the directory name alone.
        if [ ! -f "$repo/package.json" ]; then
          log "SKIP no-package-marker $artifact"; continue
        fi
        tracked=$(rmd_retirement_git "$repo" ls-files -- node_modules/ 2>/dev/null) || {
          log "SKIP git-unverified $artifact"; continue;
        }
        if [ -n "$tracked" ]; then
          log "SKIP tracked   $artifact"; continue
        fi
      else
        ignore_rule=$(rmd_retirement_git "$repo" check-ignore -v --no-index -- coverage 2>/dev/null)
        case "$ignore_rule" in
          .gitignore:*|"$repo/.gitignore:"*) ;;
          *) log "SKIP not-repo-ignored $artifact"; continue ;;
        esac
        tracked=$(rmd_retirement_git "$repo" ls-files -- coverage/ 2>/dev/null) || {
          log "SKIP git-unverified $artifact"; continue;
        }
        if [ -n "$tracked" ]; then
          log "SKIP tracked   $artifact"; continue
        fi
      fi
      if is_live "$repo"; then
        skipped_live=$((skipped_live+1)); log "SKIP live      $repo"; continue
      fi
      is_cwd_in "$repo"
      cwd_rc=$?
      if [ "$cwd_rc" -eq 0 ]; then
        skipped_cwd=$((skipped_cwd+1)); log "SKIP cwd       $repo"; continue
      elif [ "$cwd_rc" -eq 2 ]; then
        skipped_open=$((skipped_open+1)); log "SKIP unverified $repo"; continue
      fi
      clean_artifact "$artifact" "$([ "$kind" = "coverage" ] && printf '%s' "$COVERAGE_AGE_HOURS" || printf '%s' "$AGE_HOURS")"
    done
done

for root in "${SCAN_ROOTS[@]}"; do
  [ -d "$root" ] || continue
  for pref in "${PREFIXES[@]}"; do
    for d in "$root/$pref"*; do
      [ -d "$d" ] || continue
      is_protected "$d" && continue

      if is_live "$d"; then
        skipped_live=$((skipped_live+1)); log "SKIP live      $d"; continue
      fi

      is_open "$d"
      open_rc=$?
      if [ "$open_rc" -eq 0 ]; then
        skipped_open=$((skipped_open+1)); log "SKIP open      $d"; continue
      elif [ "$open_rc" -eq 2 ]; then
        skipped_open=$((skipped_open+1)); log "SKIP unverified $d"; continue
      fi

      for kind in "${ARTIFACTS[@]}"; do
        while IFS= read -r artifact; do
          clean_artifact "$artifact"
        done < <(find "$d" -type d -name "$kind" -prune -print 2>/dev/null)
      done
    done
  done
done

# Some preflight/test launchers create `/private/tmp/rmd<random>/` (no hyphen),
# with the checkout at `r/` and Node's raw V8 coverage/TMPDIR below `cov/r/tmp`.
# Match only names beginning `rmd` followed by a digit, require the Remudero
# package marker and a `node-coverage-*` child, and clean only that generated
# temp subtree after the enclosing root is idle and old enough.
if [ "$OS_NAME" = "Darwin" ]; then
  RMD_SCAN_ROOTS=("$DEFAULT_TMP" "/private/tmp")
  # An explicit scope applies to this legacy cache lane too, including fixture runs.
  [ -z "${REMUDERO_JANITOR_SCAN_ROOTS:-}" ] || RMD_SCAN_ROOTS=("${SCAN_ROOTS[@]}")
  for root in "${RMD_SCAN_ROOTS[@]}"; do
    [ -d "$root" ] || continue
    for d in "$root"/rmd[0-9]*; do
      [ -d "$d" ] && [ ! -L "$d" ] || continue
      checkout="$d/r"
      if [ ! -e "$checkout/.git" ] || [ ! -f "$checkout/package.json" ] || \
        ! grep -Eq '"name"[[:space:]]*:[[:space:]]*"remudero"' "$checkout/package.json"; then
        continue
      fi
      has_node_coverage=0
      for raw in "$d"/cov/r/tmp/node-coverage-*; do
        [ -d "$raw" ] && [ ! -L "$raw" ] && has_node_coverage=1 && break
      done
      [ "$has_node_coverage" = "1" ] || continue
      owner=$(artifact_owner "$d")
      if [ "$owner" != "$RUN_USER" ]; then
        skipped_owner=$((skipped_owner+1)); log "SKIP owner=${owner:-unknown} $d"; continue
      fi
      is_protected "$d" && continue
      if is_live "$d"; then
        skipped_live=$((skipped_live+1)); log "SKIP live      $d"; continue
      fi
      is_cwd_in "$d"
      cwd_rc=$?
      if [ "$cwd_rc" -eq 0 ]; then
        skipped_cwd=$((skipped_cwd+1)); log "SKIP cwd       $d"; continue
      elif [ "$cwd_rc" -eq 2 ]; then
        skipped_open=$((skipped_open+1)); log "SKIP unverified $d"; continue
      fi
      is_open "$d"
      open_rc=$?
      if [ "$open_rc" -eq 0 ]; then
        skipped_open=$((skipped_open+1)); log "SKIP open      $d"; continue
      elif [ "$open_rc" -eq 2 ]; then
        skipped_open=$((skipped_open+1)); log "SKIP unverified $d"; continue
      fi

      clean_artifact "$d/cov/r/tmp" "$COVERAGE_AGE_HOURS"
      for kind in "${ARTIFACTS[@]}"; do
        while IFS= read -r artifact; do
          clean_artifact "$artifact"
        done < <(find "$checkout" -type d -name "$kind" -prune -print 2>/dev/null)
      done
    done
  done
fi


# Missing worktrees can retain the only reflog of an unpublished detached
# HEAD. Do not prune their metadata merely because the directory disappeared.
# Report non-repository children rather than silently treating them as caches.
REPORT_PARENT_ROOTS=("$USER_HOME/Remudero" "$USER_HOME/Remudero/remudero" "$USER_HOME/rmd-work" "$USER_HOME/Remudero/.session-scratch")
if [ "$OS_NAME" = "Darwin" ]; then REPORT_PARENT_ROOTS+=("$USER_HOME/Developer/remudero-operator-worktrees"); fi
for parent in "${REPORT_PARENT_ROOTS[@]}"; do
  [ -d "$parent" ] && [ ! -L "$parent" ] || continue
  for child in "$parent"/* "$parent"/.[!.]*; do
    [ -d "$child" ] && [ ! -L "$child" ] || continue
    [ -e "$child/.git" ] && continue
    case "$child" in */.git|*/node_modules|*/coverage|*/.remudero-coverage|*/.rmd-coverage) continue ;; esac
    # Tracked source directories inside the operator checkout are not workspaces.
    if [ "$parent" = "$USER_HOME/Remudero/remudero" ]; then
      tracked=$(rmd_retirement_git "$parent" ls-files -- "${child##*/}" 2>/dev/null) || { log "SKIP git-unverified $child"; continue; }
      [ -n "$tracked" ] && continue
    fi
    log "SKIP unknown-directory $child (no independently verifiable Git state; data retained)"
  done
done
# Include generated caches under historical job TMPDIRs on every scheduled
# pass. The helper's cache-only mode never retires source or runtime folders.
tsx_helper="$SCRIPT_DIR/tmp-reclaim.sh"
if [ -f "$tsx_helper" ]; then
  TSX_ROOTS_SEEN=()
  for tsx_root in "${SCAN_ROOTS[@]}" "$USER_HOME/Remudero" "$USER_HOME/rmd-work"; do
    [ -d "$tsx_root" ] && [ ! -L "$tsx_root" ] || continue
    tsx_real=$(cd "$tsx_root" 2>/dev/null && pwd -P) || continue
    tsx_seen=0
    for seen in "${TSX_ROOTS_SEEN[@]+"${TSX_ROOTS_SEEN[@]}"}"; do [ "$seen" = "$tsx_real" ] && tsx_seen=1 && break; done
    [ "$tsx_seen" = 0 ] || continue
    TSX_ROOTS_SEEN+=("$tsx_real")
    tsx_mode=--dry-run; [ "$APPLY" = 1 ] && tsx_mode=--apply
    tsx_key=$(printf '%s' "$tsx_real" | cksum | awk '{print $1}')
    tsx_report="$USER_HOME/.local/state/remudero/tsx-$tsx_key-kept.txt"
    tsx_output=$(RMD_RECLAIM_ROOT="$tsx_real" RMD_RECLAIM_REPORT="$tsx_report" TMPDIR="$tsx_real/" bash "$tsx_helper" --tsx-only "$tsx_mode" 2>&1)
    tsx_status=$?
    while IFS= read -r tsx_line; do [ -z "$tsx_line" ] || log "generated-cache: $tsx_line"; done <<< "$tsx_output"
    [ "$tsx_status" = 0 ] || log "FAILED generated-cache-sweep $tsx_real (exit=$tsx_status)"
  done
else
  log "SKIP generated-cache-sweep (maintained helper missing: $tsx_helper)"
fi
# This helper owns only exact ignored duplicate packages and Turbopack caches
# below this account's artifact root. Source/Git/build outputs never retire.
cache_reference_tmpdir() {
  local account_record account_home cache_tmp
  # getconf describes the running account, not an arbitrary selected HOME.
  # Verify that relationship before substituting its implicit temp namespace.
  account_record=$(dscl . -read "/Users/$RUN_USER" NFSHomeDirectory 2>/dev/null) || return 1
  case "$account_record" in 'NFSHomeDirectory: '*) account_home=${account_record#NFSHomeDirectory: } ;; *) return 1 ;; esac
  case "$account_home" in *$'\n'*|*$'\r'*) return 1 ;; /*) ;; *) return 1 ;; esac
  account_home=$(cd "$account_home" 2>/dev/null && pwd -P) || return 1
  [ "$account_home" = "$USER_HOME" ] || return 1
  cache_tmp=$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null) || return 1
  case "$cache_tmp" in *$'\n'*|*$'\r'*) return 1 ;; /*) ;; *) return 1 ;; esac
  # A trailing slash can hide a symlink from -L. Permit native /var's parent
  # alias, but never a linked, foreign-owned or root temp directory itself.
  while [ "${cache_tmp%/}" != "$cache_tmp" ]; do cache_tmp=${cache_tmp%/}; done
  [ -n "$cache_tmp" ] && [ -d "$cache_tmp" ] && [ ! -L "$cache_tmp" ] && [ -O "$cache_tmp" ] && [ -w "$cache_tmp" ] && [ -x "$cache_tmp" ] || return 1
  cache_tmp=$(cd "$cache_tmp" 2>/dev/null && pwd -P) || return 1
  [ "$cache_tmp" != / ] && [ -d "$cache_tmp" ] && [ ! -L "$cache_tmp" ] && [ -O "$cache_tmp" ] && [ -w "$cache_tmp" ] && [ -x "$cache_tmp" ] || return 1
  printf '%s\n' "$cache_tmp"
}
if [ -f "$SCRIPT_DIR/cache-reclaim.py" ] && command -v python3 >/dev/null 2>&1; then
  cache_mode=()
  [ "$APPLY" != 1 ] || cache_mode=(--apply)
  cache_command=(python3)
  cache_scope_known=1
  # Python chooses TMPDIR, then TEMP, then TMP. An unset/empty TMPDIR with an
  # explicit fallback is not cron's all-unset default; preserve that selection.
  cache_explicit_fallback=0
  if [ -z "${TMPDIR:-}" ] && { [ -n "${TEMP:-}" ] || [ -n "${TMP:-}" ]; }; then
    cache_explicit_fallback=1
  fi
  if [ "$OS_NAME" = Darwin ] && [ "$cache_explicit_fallback" = 0 ]; then
    case "$DEFAULT_TMP" in /tmp|/tmp/|/private/tmp|/private/tmp/)
      # Cron omits TMPDIR. Match the GUI account's resolved temp root so their
      # authenticated namespace checkpoints have the same reference scope.
      # Leave explicit custom TMPDIR and every other Janitor phase unchanged.
      if cache_tmp=$(cache_reference_tmpdir); then
        cache_command=(env "TMPDIR=$cache_tmp" python3)
      else
        cache_scope_known=0
      fi
      ;;
    esac
  fi
  if [ "$cache_scope_known" = 1 ]; then
    # Stream the existing receipt: the reporter bounds JSON parsing and does not
    # inspect any filesystem targets. Retain the full original in the human log.
    "${cache_command[@]}" "$SCRIPT_DIR/cache-reclaim.py" --home "$USER_HOME" "${cache_mode[@]+"${cache_mode[@]}"}" 2>&1 | \
      tee -a "$LOG" | rmd_decision_cache_json "$DECISION_LOG"
    cache_status=("${PIPESTATUS[@]}")
    [ "${cache_status[1]}" = 0 ] || exit 2
    if [ "${cache_status[2]}" != 0 ]; then
      rmd_decision_record "$DECISION_LOG" 'generated-cache receipt unavailable or unrecognized; original output retained in human log' info cache_report_unknown || exit 2
    fi
    [ "${cache_status[0]}" = 0 ] || log "WARN generated-cache helper refused or could not verify a removal"
  else
    log "SKIP generated-cache-scope (running-account temp namespace unverified; cache pass retained)"
    rmd_decision_record "$DECISION_LOG" 'SKIP generated-cache-scope: running-account temp namespace unverified' keep cache_scope_unknown || exit 2
  fi
fi
rmd_decision_summary "$DECISION_LOG"
log "decision-report: $DECISION_LOG (six-hour guard; workspace and generated-cache decisions)"
# Optional account-private phase; never run it during a janitor dry-run.
# The maintained helper defaults OFF and has no authority to expire history.
evidence_helper="$USER_HOME/.local/bin/remudero-storage-maintenance"
if [ "$APPLY" = 1 ] && [ -x "$evidence_helper" ] && [ ! -L "$evidence_helper" ] && [ -O "$evidence_helper" ]; then
  if evidence_output=$("$evidence_helper" --scheduled 2>&1); then
    log "bounded-evidence: $evidence_output"
  else
    log "WARN bounded-evidence: $evidence_output"
  fi
fi
# Opt-in preserve-then-retire phase (JANITOR.md "Preserve-then-retire"). It saves and verifies
# the work this pass held, then retires the idle checkout. Without its owner-private config the
# helper reports "disabled" and changes nothing; a dry run only plans.
# Dependency seed generations nothing references any more; the sweeper proves idle, unreferenced
# and unopened per generation, and keeps anything it cannot prove (deploy/DEPENDENCY-SEEDS.md).
# A store written under a URL-encoded root (2026-10-22: "Application%20Support") is swept too.
seed_tool="$USER_HOME/.local/bin/remudero-dependencies"
seed_stray="$USER_HOME/Library/Application%20Support/Remudero/dependencies"
sweep_seeds() { # $1 = label, $2 = seed root ("" for the account's own root)
  local seed_output
  # --root, not RMD_DEPENDENCY_SEED_ROOT: the tool refuses an encoded root from configuration.
  if seed_output=$(if [ -n "$2" ]; then "$seed_tool" sweep --root "$2" --apply; else "$seed_tool" sweep --apply; fi 2>&1); then
    log "$1: $(printf '%s' "$seed_output" | python3 -I -c 'import json, sys
rows = json.load(sys.stdin)
print("removed=%d kept=%d" % (sum(r["action"] == "remove" for r in rows), sum(r["action"] == "keep" for r in rows)))' 2>/dev/null || echo 'sweep output unreadable')"
  else
    log "$1: sweep failed: $(printf '%s' "$seed_output" | tail -n 1)"
  fi
}
if [ "$APPLY" = 1 ] && [ -x "$seed_tool" ] && [ ! -L "$seed_tool" ] && [ -O "$seed_tool" ]; then
  sweep_seeds dependency-seeds ""
  if [ -d "$seed_stray" ] && [ ! -L "$seed_stray" ] && [ -O "$seed_stray" ] && [ -f "$seed_stray/.rmd-dependency-seed-root.json" ]; then
    sweep_seeds dependency-seeds-stray "$seed_stray"
  fi
fi

preserve_status=unavailable
preserve_retired=unknown; preserve_held=unknown; preserve_planned=unknown
preserve_confirmed=0; preserve_complete=no
if [ -f "$SCRIPT_DIR/preserve-retire.py" ] && command -v python3 >/dev/null 2>&1; then
  preserve_mode=()
  [ "$APPLY" != 1 ] || preserve_mode=(--apply)
  preserve_previous=""; preserve_last=""
  while IFS= read -r preserve_line; do
    log "$preserve_line"
    preserve_previous=$preserve_last; preserve_last=$preserve_line
  done < <(
    python3 -I "$SCRIPT_DIR/preserve-retire.py" --home "$USER_HOME" "${preserve_mode[@]+"${preserve_mode[@]}"}" 2>&1
    printf 'preserve-retire: exit %s\n' "$?")
  preserve_status=failed
  if [ "$preserve_last" = 'preserve-retire: exit 0' ]; then
    preserve_status=unverified
    # Only the successful helper's terminal summary contributes; earlier path logs can contain newlines.
    preserve_pattern='^preserve-retire: summary candidates=([0-9]{1,9}) retired=([0-9]{1,9}) held=([0-9]{1,9}) apply=([01])$'
    if [[ "$preserve_previous" =~ $preserve_pattern ]]; then
      preserve_candidates=$((10#${BASH_REMATCH[1]}))
      preserve_count=$((10#${BASH_REMATCH[2]}))
      preserve_hold_count=$((10#${BASH_REMATCH[3]}))
      preserve_apply=${BASH_REMATCH[4]}
      if [ "$preserve_apply" = "$APPLY" ] && [ "$preserve_count" -le "$preserve_candidates" ] &&
        { [ "$APPLY" = 1 ] || [ "$preserve_count" = 0 ]; }; then
        preserve_status=completed; preserve_complete=yes
        preserve_retired=$preserve_count; preserve_confirmed=$preserve_count
        preserve_held=$preserve_hold_count; preserve_planned=0
        [ "$APPLY" = 1 ] || preserve_planned=$preserve_candidates
      fi
    else
      case "$preserve_previous" in
        'preserve-retire: disabled (no config)'|'preserve-retire: disabled (config enabled=false)')
          preserve_status=disabled ;;
        'preserve-retire: skip ran within '*h)
          preserve_status=throttled ;;
      esac
      if [ "$preserve_status" = disabled ] || [ "$preserve_status" = throttled ]; then
        preserve_retired=0; preserve_planned=0; preserve_complete=yes
      fi
    fi
  fi
fi
AFTER=$(free_gib)
removed_total=$((removed+removed_worktrees+preserve_confirmed))
log "=== done: removed=$removed_total removed-complete=$preserve_complete reclaimed=$((reclaimed_kb/1024))M reclaimed-scope=legacy planned=$planned estimated=$((estimated_kb/1024))M worktrees-removed=$removed_worktrees worktrees-planned=$planned_worktrees worktrees-skipped=$skipped_worktrees preservation-status=$preserve_status preservation-retired=$preserve_retired preservation-held=$preserve_held preservation-planned=$preserve_planned live-skip=$skipped_live cwd-skip=$skipped_cwd owner-skip=$skipped_owner open-skip=$skipped_open young-skip=$skipped_young free=${BEFORE}->${AFTER}GiB ==="

# Inspect only the selected Core checkout's declared proof runners. Core can
# use node:test with tsx without declaring Vitest. Prefer an executable install
# as before; retain the first checkout as a diagnostic fallback if none works.
# This probe reads manifests and runner metadata only: never load package code,
# install dependencies, or repair a shared node_modules link.
CORE_INSTALL_ROOT=""
for candidate in "$USER_HOME/Remudero/remudero" "$USER_HOME/Remudero/repos/remudero"; do
  [ -f "$candidate/src/lib/worker.ts" ] || continue
  [ -n "$CORE_INSTALL_ROOT" ] || CORE_INSTALL_ROOT="$candidate"
  if [ -x "$candidate/node_modules/.bin/tsx" ]; then
    CORE_INSTALL_ROOT="$candidate"
    break
  fi
done
if [ -n "$CORE_INSTALL_ROOT" ]; then
  if ! command -v python3 >/dev/null 2>&1; then
    log "WARN dependency-health: check unavailable for $CORE_INSTALL_ROOT (python3 unavailable)"
  else
    # Cron has Python's existing cache-helper dependency but need not have Node on PATH.
    # Read metadata with the standard library; never load runner/package code or widen PATH.
    dependency_health=$(python3 - "$CORE_INSTALL_ROOT" 2>/dev/null <<'PYTHON'
import errno, json, os, stat, sys
root = sys.argv[1]
manifest_path = os.path.join(root, 'package.json')
def warn(message):
    print('WARN dependency-health: ' + message)
def check_runners():
    fd = None
    try:
        fd = os.open(manifest_path, os.O_RDONLY | os.O_NONBLOCK)
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError('not-regular-file')
        data = bytearray()
        while len(data) < 1024 * 1024 + 1:
            part = os.read(fd, 1024 * 1024 + 1 - len(data))
            if not part: break
            data.extend(part)
        if len(data) > 1024 * 1024: raise ValueError('size-limit')
    except (OSError, ValueError) as error:
        detail = errno.errorcode.get(error.errno, 'read-error') if isinstance(error, OSError) else str(error)
        warn(f'manifest unreadable at {manifest_path} ({detail}); runner health unknown')
        return
    finally:
        if fd is not None: os.close(fd)
    try:
        manifest = json.loads(data)
        if not isinstance(manifest, dict): raise ValueError()
        for section in ('dependencies', 'devDependencies'):
            if section in manifest and (not isinstance(manifest[section], dict) or
                    any(not isinstance(v, str) or not v.strip() for v in manifest[section].values())):
                raise ValueError()
    except (ValueError, UnicodeError):
        warn(f'manifest malformed at {manifest_path}; runner health unknown')
        return
    for name, relative, mode in (('tsx', 'node_modules/.bin/tsx', os.R_OK | os.X_OK),
                                  ('vitest', 'node_modules/vitest/vitest.mjs', os.R_OK)):
        if not any(name in manifest.get(section, {}) for section in ('dependencies', 'devDependencies')): continue
        runner = os.path.join(root, relative)
        try:
            if not stat.S_ISREG(os.stat(runner).st_mode):
                warn(f'declared {name} runner unavailable at {runner} (not a regular file)')
                continue
            if not os.access(runner, mode): raise PermissionError(errno.EACCES, 'access refused')
        except OSError as error:
            if error.errno in (errno.ENOENT, errno.ENOTDIR):
                warn(f'declared {name} runner missing at {runner}; linked proofs may fail because shared dependencies are not reinstalled')
            else:
                warn(f'declared {name} runner unreadable at {runner} ({errno.errorcode.get(error.errno, "read-error")}); runner health unknown')
check_runners()
PYTHON
    )
    dependency_health_status=$?
    if [ -n "$dependency_health" ]; then
      while IFS= read -r health_line; do log "$health_line"; done <<< "$dependency_health"
    elif [ "$dependency_health_status" != 0 ]; then
      log "WARN dependency-health: check unavailable for $CORE_INSTALL_ROOT (python3 probe failed)"
    fi
  fi
fi
if command -v python3 >/dev/null 2>&1; then
  while IFS= read -r report_line; do
    rmd_decision_record "$DECISION_LOG" "$report_line" info low-space-report || exit 2
    log "$report_line"
  done < <(python3 -I - "$USER_HOME" "$SCRIPT_DIR" "$OS_NAME" "$preserve_status" <<'PYTHON'
import importlib.util, os, pathlib, re, signal, statistics, subprocess, sys, time
sys.dont_write_bytecode = True
home, scripts, system, preserve = sys.argv[1:]
# Share the generated-cache pass's 45-second inspection ceiling; never leave du running.
deadline = time.monotonic() + 45
def run(args):
    return subprocess.run(args, capture_output=True, text=True, timeout=max(.01, deadline-time.monotonic()))
def report():
    mount = '/System/Volumes/Data' if system == 'Darwin' else '/'
    disk = run(['df', '-k', mount])
    if disk.returncode: raise ValueError('df failed')
    fields = disk.stdout.splitlines()[1].split()
    used, free = int(fields[2])*1024, int(fields[3])*1024
    samples = pathlib.Path(home, '.local/state/remudero/janitor-free-samples.tsv')
    parent = samples.parent
    while str(parent) != home:
        if parent.is_symlink() or parent.stat().st_uid != os.getuid(): raise ValueError('sample parent unverified')
        parent = parent.parent
    rows = []
    if samples.exists() or samples.is_symlink():
        if samples.is_symlink() or not samples.is_file() or samples.stat().st_uid != os.getuid(): raise ValueError('samples unverified')
        for line in samples.read_text().splitlines()[-200:]:
            parts = line.split()
            if len(parts) == 2 and all(p.isdigit() for p in parts): rows.append(tuple(map(int, parts)))
    now = int(time.time())
    rows = sorted(dict((t, b) for t, b in rows if t < now).items())[-199:] + [(now, free)]
    with open(samples, 'w') as out: out.writelines(f'{t}\t{b}\n' for t, b in rows)
    os.chmod(samples, 0o600)
    if len(rows) < 2: return
    cadence = statistics.median(b[0]-a[0] for a, b in zip(rows, rows[1:]))
    xs = [t-rows[0][0] for t, _ in rows]; ys = [b for _, b in rows]
    mx, my = statistics.mean(xs), statistics.mean(ys)
    slope = sum((x-mx)*(y-my) for x, y in zip(xs, ys))/sum((x-mx)**2 for x in xs)
    if slope >= 0: return
    passes = free / -slope / cadence
    if passes > 3: return  # W1-T4804: NEAR_PASSES=3; inside one pass is critical.
    print(f'low-space-report: begin free-bytes={free} time-to-full-passes={passes:.2f} tier={"critical" if passes <= 1 else "near"}', flush=True)
    sizes = {}
    def size(path):
        if path not in sizes:
            out = run(['du', '-xsk', '--', path])
            sizes[path] = int(out.stdout.split()[0])*1024 if out.returncode == 0 and out.stdout.split() else None
        return sizes[path]
    children = [str(p) for p in pathlib.Path(home).iterdir() if not p.is_symlink()]
    seen = 0; complete = True
    for path in children:
        value = size(path)
        if value is None: complete = False
        else: seen += value
    known = ['Remudero', 'rmd-work', '.codex/work-artifacts', 'Developer/remudero-operator-worktrees', '.npm', '.cache']
    for name in known:
        path = str(pathlib.Path(home, name))
        if os.path.isdir(path) and not os.path.islink(path): size(path)
    for path, value in sorted(sizes.items(), key=lambda item: -(item[1] or 0)):
        print(f'low-space-report: top-consumer: bytes={value if value is not None else "unknown"} {path}')
    swap = run(['sysctl', 'vm.swapusage'])
    match = re.search(r'used\s*=\s*([0-9.]+)([KMG])', swap.stdout) if swap.returncode == 0 else None
    swap_bytes = int(float(match[1])*1024**('KMG'.index(match[2])+1)) if match else None
    print(f'low-space-report: swap: bytes={swap_bytes if swap_bytes is not None else "unknown"} {swap.stdout.strip()}')
    remainder = used-seen-swap_bytes if swap_bytes is not None else 'unknown'
    print(f'low-space-report: unaccounted={remainder} used={used} seen={seen} seen-complete={complete}; other accounts and system areas this account cannot read; operator acts there')
    enabled = 'yes' if preserve in ('completed', 'throttled') else 'no' if preserve == 'disabled' else 'unknown'
    print(f'low-space-report: preserve-retire state={preserve} enabled={enabled}', flush=True)
    if preserve == 'disabled':
        # Reuse the installed helper's selection and lender closure, read-only.
        # No config, preserve directory, stamp, archive or worktree is written.
        spec = importlib.util.spec_from_file_location('preserve_retire', os.path.join(scripts, 'preserve-retire.py'))
        helper = importlib.util.module_from_spec(spec); spec.loader.exec_module(helper)
        original_run = helper.run
        helper.run = lambda cmd, **kw: original_run(cmd, **dict(kw, timeout=min(kw.get('timeout', 600), max(.01, deadline-time.monotonic()))))
        cfg = dict(helper.DEFAULTS)
        # A helper older than glob roots has no expand_roots; its roots are plain folders.
        expand = getattr(helper, 'expand_roots', lambda h, roots: [os.path.join(h, r) for r in roots])
        cfg['roots'] = expand(home, cfg['roots'])
        cfg['preserve_root'] = os.path.join(home, cfg['preserve_root'])
        repos = helper.discover(cfg, helper.protected_paths(home, cfg)); keep = {}
        snap = helper.process_snapshot()
        for repo in repos:
            helper.resolve_git(repo)
            why = repo.hold or ('foreign-owner' if os.lstat(repo.path).st_uid != os.getuid() else '')
            if not why: why = 'process-unknown' if snap is None else helper.recent_path(repo, now-cfg['idle_hours']*3600) or helper.in_use(repo.path, snap)
            if not why and repo.gitdir and os.path.exists(os.path.join(repo.gitdir, 'locked')): why = 'locked'
            if why: keep[repo.path] = why
        private = helper.home_private(home)
        borrowers = helper.borrower_census(home, min(cfg['census_seconds'], max(.01, deadline-time.monotonic()))) if private else {}
        helper.keep_closure(repos, keep, borrowers or {}, private and borrowers is not None)
        candidates = [r.path for r in repos if r.path not in keep]
        # Disjoint candidates avoid double-counting nested checkouts.
        outer = [p for p in candidates if not any(p.startswith(q+'/') for q in candidates if p != q)]
        values = [size(p) for p in outer]
        total = sum(values) if all(v is not None for v in values) else 'unknown'
        print(f'low-space-report: preserve-retire: disabled; dry-run defaults count={len(candidates)} bytes={total}; estimate before preservation checks, opt-in unchanged')
    print('low-space-report: end', flush=True)
def expired(signum, frame): raise TimeoutError('inspection budget exhausted')
signal.signal(signal.SIGALRM, expired); signal.alarm(45)
try:
    report()
except (OSError, ValueError, IndexError, subprocess.TimeoutExpired, TimeoutError) as error:
    print(f'low-space-report: unavailable/incomplete reason={error}; consumer/reclaim quantities unknown', flush=True)
finally:
    signal.alarm(0)
PYTHON
  )
fi
exit 0
