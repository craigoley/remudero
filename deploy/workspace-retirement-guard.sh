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
rmd_retirement_git() {
  local repo="$1" top
  shift
  top=$(cd -P -- "$repo" 2>/dev/null && pwd -P) || return 128
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
# message instead of guessing where a path containing spaces ends.
rmd_decision_record() {
  local file="$1" message="$2" code=other action=info encoded
  case "$message" in
    KEEP*|SKIP*) action=keep ;;
    WOULD-*|DRYRUN*) action=planned ;;
    REMOVE*|PRUNE*|ARCHIVE*) action=remove ;;
  esac
  case "$message" in
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
  encoded=${message//%/%25}; encoded=${encoded//$'\t'/%09}; encoded=${encoded//$'\n'/%0A}; encoded=${encoded//$'\r'/%0D}
  printf '%s\t%s\t%s\t%s\t%s\n' "$RMD_DECISION_PASS_ID" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$action" "$code" "$encoded" >> "$file"
}
rmd_decision_summary() {
  awk -F '\t' -v pass="$RMD_DECISION_PASS_ID" '$1 == pass && $3 == "keep" { n[$4]++ } END { for (k in n) printf "retirement skips: %s=%d\n", k, n[k] }' "$1" 2>/dev/null | sort
}

