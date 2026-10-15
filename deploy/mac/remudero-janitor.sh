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
# Remudero/rmd-work roots (and Craig's /private/tmp). Every descendant must be
# idle for six hours; unversioned source/reports and persistent data are retained.
#
# WHAT IT NEVER DOES: it never removes unpushed commits or uncommitted source, never
# follows an artifact symlink, and never touches protected, dirty, or open
# trees. Worktree deletion uses Git; branch refs are retained. A standalone
# clone's object store and unknown non-repository data stay protected.
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
  [ "$directory_real" = "$directory_root" ] || continue
  root_seen=0
  for existing_root in "${DIRECTORY_ROOTS[@]+"${DIRECTORY_ROOTS[@]}"}"; do
    [ "$existing_root" != "$directory_real" ] || { root_seen=1; break; }
  done
  [ "$root_seen" = 1 ] || DIRECTORY_ROOTS+=("$directory_real")
done

NOW=$(date +%s)
mkdir -p "$(dirname "$LOG")"
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
PSOUT=$(ps -axww -o command= 2>/dev/null)
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
  local root="$1" line path
  [ "$HAS_LSOF" = "1" ] && [ "$CWD_STATUS" -le 1 ] || return 2
  while IFS= read -r line; do
    case "$line" in n*)
      path="${line#n}"
      case "$path" in "$root"|"$root"/*) return 0 ;; esac
      # A process can sit in the scratch parent while a nested checkout lives
      # below it (for example, <run>/repo). Protect that artifact too. Ignore
      # only broad launcher roots whose cwd does not identify a particular job.
      case "$root" in "$path"/*)
        case "$path" in
          /|"$USER_HOME"|"$USER_HOME/Remudero"|"$USER_HOME/Remudero/remudero"|"$USER_HOME/rmd-work"|"$DEFAULT_TMP"|/tmp|/private/tmp) ;;
          *) return 0 ;;
        esac
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
log "checkout-scan: $USER_HOME/Remudero (including remudero descendants), $USER_HOME/rmd-work; Git discovery depth<=8"
for failed_root in "${SCAN_FAILURES[@]+"${SCAN_FAILURES[@]}"}"; do log "SKIP repository scan failed (unknown) $failed_root"; done

reclaimed_kb=0; removed=0; planned=0; estimated_kb=0
skipped_live=0; skipped_cwd=0; skipped_owner=0; skipped_open=0; skipped_young=0
removed_worktrees=0; planned_worktrees=0; skipped_worktrees=0
removed_link_paths=(); removed_link_targets=()

refresh_process_snapshot() {
  local rc
  PSOUT=$(ps -axww -o command= 2>/dev/null) || return 1
  [ "$HAS_LSOF" = "1" ] || return 1
  CWDOUT=$(lsof -nP -a -d cwd -Fn 2>/dev/null)
  rc=$?
  CWD_STATUS=$rc
  [ "$rc" -le 1 ]
}

clean_artifact() {
  local artifact="$1" min_age="${2:-$AGE_HOURS}" stamp age kb owner cwd_rc open_rc seed_reason parent found status scope
  [ -d "$artifact" ] && [ ! -L "$artifact" ] || return 0
  if seed_reason=$(rmd_dependency_seed_risk "$artifact"); then log "SKIP protected $artifact ($seed_reason)"; return; fi
  found=$(find "$artifact" \( -name .git -o -name '*.bundle' -o -name '*.tar' -o -name '*.tgz' -o -name '*.zip' -o -name '*.gz' \) -print -quit 2>/dev/null) || {
    log "SKIP content scan failed (unknown) $artifact"; return;
  }
  if [ -n "$found" ]; then log "SKIP protected repository-or-bundle $artifact"; return; fi
  parent=$(dirname "$artifact")
  while [ "$parent" != / ]; do
    if [ -e "$parent/.git" ]; then
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
  is_cwd_in "$artifact"
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
  kb=$(du -sk "$artifact" 2>/dev/null | cut -f1); kb=${kb:-0}
  if [ "$APPLY" = "1" ]; then
    refresh_process_snapshot || { log "SKIP unverified process snapshot $artifact"; return; }
    is_live "$artifact" && { skipped_live=$((skipped_live+1)); log "SKIP live      $artifact"; return 0; }
    is_cwd_in "$artifact"
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
    # Immutable dependency snapshots may have read-only directories. Give
    # the owning account delete permission only on directories inside this
    # already-approved generated artifact. `find -P` avoids following any
    # dependency symlinks; if any directory cannot be made writable, fail
    # closed and leave the artifact in place.
    if ! find -P "$artifact" -type d -exec chmod u+rwx {} + 2>/dev/null; then
      log "FAILED read-only-or-unverified $artifact"
      return 0
    fi
    if rm -rf -- "$artifact" 2>/dev/null; then
      reclaimed_kb=$((reclaimed_kb+kb)); removed=$((removed+1))
      log "REMOVED ${age}h $((kb/1024))M $artifact"
    else
      log "FAILED        $artifact"
    fi
  else
    estimated_kb=$((estimated_kb+kb)); planned=$((planned+1))
    log "WOULD-REMOVE ${age}h $((kb/1024))M $artifact"
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
  found=$(find -P "$path" -xdev \( -name .git -o -name HEAD -o -name objects -o -name '*.bundle' \
    -o -name '.rmd-janitor-keep' -o -name 'ledger*' -o -name '*.ndjson' -o -name '*.jsonl' -o -name '*.sqlite*' -o -name '*.lock' -o -name '*.pid' \
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
      tracked=$(rmd_retirement_git "$parent" ls-files -- "$relative" 2>/dev/null) || {
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
  case "$kb" in ''|*[!0-9]*) log "SKIP scratch $path (size unavailable)"; return ;; esac
  for check_phase in initial before-remove; do
    refresh_process_snapshot || { log "SKIP scratch $path (process visibility unavailable)"; return; }
    is_live "$path" && { log "SKIP scratch $path (live command)"; return; }
    is_cwd_in "$path"; cwd_rc=$?
    [ "$cwd_rc" = 1 ] || { log "SKIP scratch $path (working directory active or unknown)"; return; }
    is_open "$path"; open_rc=$?
    [ "$open_rc" = 1 ] || { log "SKIP scratch $path (open files or visibility unknown)"; return; }
    stamp=$(artifact_mtime "$path") || { log "SKIP scratch $path (age unavailable)"; return; }
    case "$stamp" in ''|*[!0-9]*|0) log "SKIP scratch $path (age unavailable)"; return ;; esac
    if [ "$(( $(date +%s) - stamp ))" -lt "$((AGE_HOURS * 3600))" ]; then
      log "SKIP scratch $path (content or metadata touched within ${AGE_HOURS}h)"; return;
    fi
    current=$(scratch_directory_identity "$path") || current=""
    [ "$current" = "$identity" ] || { log "SKIP scratch $path (identity changed)"; return; }
    if [ "$check_phase" = before-remove ] && reason=$(scratch_directory_risk "$path" "$root"); then
      log "SKIP scratch $path ($reason)"; return;
    fi
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
      kb=$(du -sk "$repo" 2>/dev/null | cut -f1); kb=${kb:-0}
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
for parent in "$USER_HOME/Remudero" "$USER_HOME/Remudero/remudero" "$USER_HOME/rmd-work" "$USER_HOME/Remudero/.session-scratch"; do
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
rmd_decision_summary "$DECISION_LOG"
log "decision-report: $DECISION_LOG (six-hour guard; published Git workspaces only)"

AFTER=$(free_gib)
log "=== done: removed=$removed reclaimed=$((reclaimed_kb/1024))M planned=$planned estimated=$((estimated_kb/1024))M worktrees-removed=$removed_worktrees worktrees-planned=$planned_worktrees worktrees-skipped=$skipped_worktrees live-skip=$skipped_live cwd-skip=$skipped_cwd owner-skip=$skipped_owner open-skip=$skipped_open young-skip=$skipped_young free=${BEFORE}->${AFTER}GiB ==="

# Check the actual Core install roots, not every protected satellite clone.
# worker.ts links from the target clone when present, then falls back to this
# Core install's node_modules. A console/site/gate clone without its own
# node_modules is not evidence that the fallback is missing Vitest; gate also
# uses node:test rather than Vitest. If the Core fallback itself is incomplete,
# linked worktrees will not run npm ci through that symlink and Vitest proofs
# can fail until the install root is repaired.
CORE_INSTALL_ROOT=""
for candidate in "$USER_HOME/Remudero/remudero" "$USER_HOME/Remudero/repos/remudero"; do
  if [ -f "$candidate/src/lib/worker.ts" ] && [ -x "$candidate/node_modules/.bin/tsx" ]; then
    CORE_INSTALL_ROOT="$candidate"
    break
  fi
done
if [ -n "$CORE_INSTALL_ROOT" ] && [ ! -d "$CORE_INSTALL_ROOT/node_modules/vitest" ]; then
  log "WARN root-cause: Core install root $CORE_INSTALL_ROOT/node_modules lacks vitest; linked Vitest proofs can fail because ensureDeps refuses npm ci through symlinks (src/lib/worker.ts:3537, src/lib/review.ts:1577)"
fi
if [ "$AFTER" -lt "$MIN_FREE_GIB" ]; then
  log "WARN low-space: ${AFTER}GiB free is under the ${MIN_FREE_GIB}GiB floor"
fi
exit 0
