#!/usr/bin/env bash
# Shared, read-only publication proof. Cached remote-tracking refs and task
# trailers are NOT proof that a workspace's current commits were pushed.
# Source this file; callers still own age, activity, data and lender guards.
# Bash 3.2 compatible, no fetch, no persisted publication cache.
RMD_PUB_URLS=(); RMD_PUB_ROWS=()
# RMD_PUB_REASON is the public output inspected by sourcing callers.
# shellcheck disable=SC2034
RMD_PUB_REFS=""; RMD_PUB_REASON="publication-unverified"
RMD_PUB_GRAPH_KEY=""; RMD_PUB_GRAPH=""
RMD_DECISION_PASS_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
# Git reads can otherwise hydrate promisor objects. Older Git (including the
# Azure host's 2.43) ignores GIT_NO_LAZY_FETCH, so hold partial clones there.
export GIT_NO_LAZY_FETCH=1
RMD_RETIREMENT_NO_LAZY_FETCH=0
if git --no-lazy-fetch --version >/dev/null 2>&1; then RMD_RETIREMENT_NO_LAZY_FETCH=1; fi
rmd_retirement_git() {
  local repo="$1" top partial
  shift
  top=$(cd -P -- "$repo" 2>/dev/null && pwd -P) || return 128
  if [ "$RMD_RETIREMENT_NO_LAZY_FETCH" != 1 ]; then
    partial=$(git -c safe.directory="$top" -C "$repo" config --get-regexp '^(extensions\.partialclone|remote\..*\.promisor)$' 2>/dev/null)
    # Config reads don't access objects. Any configured promisor is held,
    # including an ambiguous value, before status/cat-file can fetch as root.
    if [ -n "$partial" ]; then return 128; fi
  fi
  GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 git -c safe.directory="$top" -C "$repo" "$@"
}
rmd_publication_snapshot() {
  local repo="$1" refresh="${2:-0}" url rows i
  RMD_PUB_REASON="publication-unverified"; RMD_PUB_REFS=""
  url=$(rmd_retirement_git "$repo" remote get-url origin 2>/dev/null) || return 1
  [ -n "$url" ] || return 1
  for ((i=0; i<${#RMD_PUB_URLS[@]}; i++)); do
    if [ "$refresh" = 0 ] && [ "${RMD_PUB_URLS[$i]}" = "$url" ]; then
      RMD_PUB_REFS="${RMD_PUB_ROWS[$i]}"; return 0
    fi
  done
  # Pull-request head refs preserve exact pushed tips after a branch is
  # deleted on squash merge. An ancestor is accepted only against a freshly
  # advertised head/tag whose commit is locally readable.
  rows=$(rmd_retirement_git "$repo" -c http.lowSpeedLimit=1 -c http.lowSpeedTime=20 \
    ls-remote origin 'refs/heads/*' 'refs/tags/*' 'refs/pull/*/head' 2>/dev/null) || return 1
  [ -n "$rows" ] || return 1
  RMD_PUB_REFS="$rows"
  for ((i=0; i<${#RMD_PUB_URLS[@]}; i++)); do
    if [ "${RMD_PUB_URLS[$i]}" = "$url" ]; then RMD_PUB_ROWS[i]="$rows"; return 0; fi
  done
  RMD_PUB_URLS+=("$url"); RMD_PUB_ROWS+=("$rows")
}
rmd_commit_published() {
  local repo="$1" commit="$2" common key known graph
  RMD_PUB_REASON="publication-unverified"
  rmd_retirement_git "$repo" cat-file -e "$commit^{commit}" 2>/dev/null || return 1
  if printf '%s\n' "$RMD_PUB_REFS" | awk -v c="$commit" '$1 == c { yes=1 } END { exit !yes }'; then return 0; fi
  common=$(rmd_retirement_git "$repo" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || return 1
  key="$common|$(printf '%s\n' "$RMD_PUB_REFS" | cksum)"
  if [ "$key" != "$RMD_PUB_GRAPH_KEY" ]; then
    # Batch object reads and one graph walk avoid spawning two Git processes
    # per remote branch per workspace. Never trust an incomplete graph walk.
    known=$(printf '%s\n' "$RMD_PUB_REFS" | awk '$2 ~ /^refs\/(heads|tags)\// { print $1 "^{commit}" }' |
      rmd_retirement_git "$repo" cat-file --batch-check='%(objectname) %(objecttype)' 2>/dev/null |
      awk '$2 == "commit" { print $1 }' | sort -u) || return 1
    [ -n "$known" ] || return 1
    graph=$(printf '%s\n' "$known" | rmd_retirement_git "$repo" rev-list --stdin 2>/dev/null) || return 1
    RMD_PUB_GRAPH_KEY="$key"; RMD_PUB_GRAPH="$graph"
  fi
  if printf '%s\n' "$RMD_PUB_GRAPH" | awk -v c="$commit" '$0 == c { yes=1 } END { exit !yes }'; then return 0; fi
  RMD_PUB_REASON="not-proven-published"
  return 1
}
rmd_workspace_published() {
  local repo="$1" scope="${2:-head}" refresh="${3:-0}" head refs oid ref
  rmd_publication_snapshot "$repo" "$refresh" || return 1
  head=$(rmd_retirement_git "$repo" rev-parse --verify HEAD 2>/dev/null) || return 1
  rmd_commit_published "$repo" "$head" || return 1
  [ "$scope" = head ] && return 0
  # Standalone deletion must preserve ALL refs, including stash and tags.
  refs=$(rmd_retirement_git "$repo" for-each-ref --format='%(objectname) %(refname)' 2>/dev/null) || return 1
  while read -r oid ref; do
    [ -n "$oid" ] || continue
    case "$ref" in refs/remotes/*) continue ;; esac
    if ! rmd_commit_published "$repo" "$oid"; then
      # shellcheck disable=SC2034
      RMD_PUB_REASON="not-proven-published:$ref"; return 1
    fi
  done <<< "$refs"
  refs=$(rmd_retirement_git "$repo" reflog show --all --format=%H 2>/dev/null) || return 1
  while IFS= read -r oid; do
    [ -n "$oid" ] || continue
    if ! rmd_commit_published "$repo" "$oid"; then
      # shellcheck disable=SC2034
      RMD_PUB_REASON="not-proven-published:reflog"; return 1
    fi
  done <<< "$refs"
}

rmd_remote_outside_retirement() {
  local repo="$1" unit="$2" url target
  url=$(rmd_retirement_git "$repo" remote get-url origin 2>/dev/null) || return 1
  case "$url" in https://*|http://*|ssh://*|git://*|*@*:*) return 0 ;; esac
  url=${url#file://}
  case "$url" in /*) target="$url" ;; *) target="$repo/$url" ;; esac
  target=$(cd "$target" 2>/dev/null && pwd -P) || return 1
  unit=$(cd "$unit" 2>/dev/null && pwd -P) || return 1
  case "$target" in "$unit"|"$unit"/*) return 1 ;; esac
}

# Tab-separated receipt, with escaped controls; preserve the full human
# message instead of guessing where a path containing spaces ends. The original
# five columns stay positional; appended columns are observed bytes (or unknown)
# and their scope. Measurements are observations, not a unique skipped total.
rmd_decision_known_kib() {
  RMD_DECISION_KNOWN_BYTES=unknown
  [ "$2" = 0 ] || return 0
  case "$1" in ''|*[!0-9]*) return 0 ;; esac
  # Bound arithmetic and refuse malformed/overflowing probe output.
  [ "${#1}" -le 12 ] || return 0
  RMD_DECISION_KNOWN_BYTES=$((10#$1 * 1024))
}
rmd_decision_record() {
  local file="$1" message="$2" code=other action=info encoded decision reason
  local bytes="${5:-${RMD_DECISION_KNOWN_BYTES:-unknown}}" size_scope=unknown
  decision=${message#generated-cache: }
  case "$decision" in
    KEEP*|SKIP*) action=keep ;;
    WOULD-*|DRYRUN*) action=planned ;;
    REMOVE*|PRUNE*|ARCHIVE*) action=remove ;;
    'pruned tsx cache files='*) action=remove; code=generated_cache_eligible ;;
    'would prune tsx cache files='*) action=planned; code=generated_cache_eligible ;;
  esac
  # Only decisions have reasons. In particular, a completion message containing
  # live-skip is informational and must not look like an active-path decision.
  if [ "$action" = keep ]; then
    reason=$decision
    case "$decision" in
      'KEEP RISKY ('*)
        reason=${decision#KEEP RISKY (}; reason=${reason%%): *}
        # These helper observations deliberately combine possibilities. Retain
        # their uncertainty rather than claiming a positively observed live path.
        case "$reason" in
          *'prune incomplete'*) action=info; code=removal_unverified ;;
          *'discovery incomplete'*) code=discovery_incomplete ;;
          *unavailable*|*unverified*|*uncertain*|*unknown*) code=probe_unknown ;;
          *'owned by'*) code=other_owner ;;
          *'Git-owned'*|*'explicitly retained'*|*'dependency seed'*) code=protected ;;
          *'unrecognized or special data'*) code=unrecognized_data ;;
          *'process command'*|*'working directory'*) code=active ;;
        esac
        ;;
    esac
    if [ "$code" = other ]; then
      case "$reason" in
        *not-proven-published*|*unpublished*|*unsaved\ refs*) code=unpublished ;;
        *publication-unverified*) code=publication_unknown ;;
        *Git\ metadata*|*git-unverified*|*Git\ status\ failed*) code=git_unknown ;;
        *live*|*held\ open*|*SKIP\ open*|*SKIP\ cwd*|*Docker\ mount*|*container\ mount*) code=active ;;
        *young*|*recent*|*written\ within*) code=younger_than_guard ;;
        *dirty*|*uncommitted*) code=dirty ;;
        *ignored*) code=ignored_data ;;
        *locked*) code=locked ;;
        *lends*|*borrow*|*linked\ worktree*|*git-lender*) code=git_lender ;;
        *protected*|*dependency\ seed*) code=protected ;;
        *unknown-directory*) code=unknown_directory ;;
        *scan*failed*|*unverified*|*unknown*) code=probe_unknown ;;
        *owner=*) code=other_owner ;;
      esac
    fi
  fi
  action=${3:-$action}; code=${4:-$code}
  case "$bytes" in ''|*[!0-9]*) bytes=unknown ;; *) size_scope=${6:-path_allocated} ;; esac
  encoded=${message//%/%25}; encoded=${encoded//$'\t'/%09}; encoded=${encoded//$'\n'/%0A}; encoded=${encoded//$'\r'/%0D}
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$RMD_DECISION_PASS_ID" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$action" "$code" "$encoded" "$bytes" "$size_scope" >> "$file"
}

# Translate the helper's existing bounded JSON receipt, without reading paths
# or probing sizes. Unknown/free-form reasons stay in the escaped original row.
rmd_decision_cache_json() {
  python3 - "$1" "$RMD_DECISION_PASS_ID" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" 3<&0 <<'PY'
import json
import os
import re
import sys

limit = 16 * 1024 * 1024
with os.fdopen(3, "rb") as stream:
    raw = stream.read(limit + 1)
    if len(raw) > limit:
        # Drain existing helper output in fixed chunks so a reporting refusal
        # never interrupts the cleaner. Only the bounded prefix is parsed.
        while stream.read(65536):
            pass
try:
    if len(raw) > limit:
        raise ValueError("cache report exceeds reporting bound")
    if not raw.startswith(b"cache-reclaim: "):
        raise ValueError("missing cache receipt")
    report = json.loads(raw[len(b"cache-reclaim: "):])
    if report.get("version") != 1 or not isinstance(report.get("decisions"), list):
        raise ValueError("unrecognized cache report")
    rows = []
    # A partial or unverified removal is not a completed remove decision.
    actions = {"keep": "keep", "removed": "remove", "would-remove": "planned", "removed-unverified": "info"}
    for row in report["decisions"]:
        if not isinstance(row, dict) or row.get("action") not in actions:
            raise ValueError("unrecognized cache decision")
        reason = row.get("reason")
        if row["action"] == "removed-unverified":
            code = "cache_removal_unverified"
        elif isinstance(reason, str) and re.fullmatch(r"[a-z][a-z0-9-]{0,95}", reason):
            code = "cache_" + reason.replace("-", "_")
        elif row["action"] == "keep":
            code = "cache_probe_unknown"
        else:
            code = "generated_cache_eligible"
        size = row.get("pathAllocatedBytes")
        known = type(size) is int and 0 <= size <= 2**53 - 1
        rows.append((actions[row["action"]], code, "cache-reclaim: " + json.dumps(row, separators=(",", ":")),
                     str(size) if known else "unknown", "path_allocated" if known else "unknown"))
    inspection = report.get("inspection", {})
    if not isinstance(inspection, dict):
        raise ValueError("unrecognized inspection receipt")
    if inspection.get("mode") == "artifacts" and not all(inspection.get(k) is True for k in
            ("discoveryComplete", "candidateEvaluationComplete")):
        rows.append(("info", "cache_inspection_incomplete", "cache-reclaim inspection: " + json.dumps(inspection, separators=(",", ":")), "unknown", "unknown"))
except (ValueError, TypeError, AttributeError):
    sys.exit(1)

def escape(value):
    return value.replace("%", "%25").replace("\t", "%09").replace("\n", "%0A").replace("\r", "%0D")

with open(sys.argv[1], "a") as receipt:
    for action, code, message, size, scope in rows:
        receipt.write("\t".join((sys.argv[2], sys.argv[3], action, code, escape(message), size, scope)) + "\n")
PY
}
rmd_decision_summary() {
  awk -F '\t' -v pass="$RMD_DECISION_PASS_ID" '
    $1 == pass && $3 == "keep" {
      n[$4]++
      if ($6 ~ /^[0-9]+$/ && $7 == "path_allocated") known[$4]+=$6
      else unknown[$4]++
    }
    END { for (k in n) printf "retirement skips: %s=%d known-observed-bytes=%.0f unknown-size-decisions=%d total-bytes=unknown\n", k, n[k], known[k], unknown[k] }
  ' "$1" 2>/dev/null | sort
  printf '%s\n' 'retirement skipped bytes: unique-total=unknown (decision observations may overlap; discovery completeness not inferred)'
}

