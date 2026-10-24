#!/usr/bin/env bash
# Exit 0 when the target is still empty and any pending engine wake is not due.
# Engine backoff comes from empty boots in this instance's ledger. Uncertainty wakes Node.
set -euo pipefail

repo="${1:?owner/repo required}"
checkout="${2:?target checkout required}"
base_sha="${3:?baseline commit required}"
state="${4:?state directory required}"
since="${5:?entry timestamp required}"
marker="${6:?entry marker required}"
engine="${7:?engine checkout required}"
mode="${8:-full}"
engine_base_sha="${9:-}"
# Runtime helpers still use arg 7; the host supervisor advances this separate checkout.
engine_observer="${10-$engine}"
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || exit 2
[[ "$base_sha" =~ ^[0-9a-f]{40}$ ]] || exit 2
[[ "$since" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.000Z$ ]] || exit 2
[[ "$mode" = full || "$mode" = pr-board ]] || exit 2
[[ -d "$state" && -f "$marker" ]] || exit 2
[[ -d "$engine" ]] || exit 2

run_bounded() {
  if command -v timeout >/dev/null 2>&1; then timeout 45 "$@"; else "$@"; fi
}

deferral_s=0
empty_wake_run=0
engine_wake() {
  local reason="$1" observed="${2:-unknown}" baseline="$engine_base_sha"
  [[ "$baseline" =~ ^[0-9a-f]{40}$ ]] || baseline=unknown
  printf '{"ts":"%s","run_id":"IDLE-ENGINE","task_id":"DAEMON","step":"daemon.idle_starved.engine_wake","lane":"daemon","reason":"%s","engine_base_sha":"%s","engine_head_sha":"%s","deferral_s":%s,"empty_wake_run":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$reason" "$baseline" "$observed" "$deferral_s" "$empty_wake_run" >> "$state/ledger.ndjson" || exit 2
  printf 'idle_starved: %s; waking the full daemon\n' "$reason" >&2
}

# The recycler waits for fresh running code. Quiet mode must therefore observe its
# installed engine, even when the runtime and target checkouts are unchanged.
# Legacy callers without a
# captured launch revision wake once to regain the ordinary freshness path.
if ! [[ "$engine_base_sha" =~ ^[0-9a-f]{40}$ ]]; then
  engine_wake engine_baseline_unavailable
  exit 2
fi
engine_head=""
if [ -z "$engine_observer" ] || ! engine_head="$(run_bounded git -C "$engine_observer" rev-parse --verify HEAD 2>/dev/null)" || ! [[ "$engine_head" =~ ^[0-9a-f]{40}$ ]]; then
  engine_wake engine_head_unavailable
  exit 2
fi

# A wake/boot/empty-entry sequence earns its measured boot time as the next delay.
# Read the rotation union in timestamp order: a boot and its entry can straddle files.
# Rotation can also leave the same row in live and archived files; count it once.
engine_history() {
  local file rc
  for file in "$state"/ledger.ndjson "$state"/ledger.*.ndjson "$state"/ledger.*.ndjson.gz; do
    [ -f "$file" ] || continue
    rc=0
    zgrep -ahE '"step"[[:space:]]*:[[:space:]]*"(daemon\.boot|dispatch\.claim|daemon\.idle_starved\.(engine_wake|engine_deferred|enter))"' "$file" || rc=$?
    [ "$rc" -le 1 ] || return 2
  done
}
now="$(date +%s)" || exit 2
engine_schedule="$(engine_history | run_bounded jq -sr --arg since "$since" --arg baseline "$engine_base_sha" --argjson now "$now" '
  def epoch:
    (sub("\\.[0-9]+Z$"; "Z") | fromdateiso8601)
    + ((capture("\\.(?<fraction>[0-9]+)Z$").fraction? // "0") | ("0." + .) | tonumber);
  reduce .[] as $row ({seen: {}, rows: []};
    ($row | tojson) as $key |
    if .seen[$key] then . else .seen[$key] = true | .rows += [$row] end
  ) | .rows | map(. + {at: (.ts | epoch)}) | sort_by(.at) |
  reduce .[] as $row (
    {deferral_s: 0, empty_wake_run: 0, armed: false, boot: null, pending: null};
    if $row.step == "daemon.idle_starved.engine_wake" then
      .armed = ($row.reason == "engine_revision_changed") | .boot = null
    elif $row.step == "daemon.boot" then
      .boot = (if .armed then $row.at else null end) | .armed = false
    elif $row.step == "dispatch.claim" then
      .deferral_s = 0 | .empty_wake_run = 0 | .boot = null | .armed = false | .pending = null
    elif $row.step == "daemon.idle_starved.enter" then
      if .boot != null and $row.at > .boot then
        .deferral_s += ($row.at - .boot) | .empty_wake_run += 1
      else . end | .boot = null | .armed = false
    elif $row.step == "daemon.idle_starved.engine_deferred"
      and $row.idle_since == $since and $row.engine_base_sha == $baseline then
      .pending = (.pending // $row)
    else . end
  ) |
  [(.deferral_s | ceil), .empty_wake_run, (.pending.deferred_at_s // $now), (.pending.engine_head_sha // "none")] | @tsv
')" || exit 2
IFS=$'\t' read -r deferral_s empty_wake_run deferred_at_s pending_head <<< "$engine_schedule"
if [ "$engine_head" != "$engine_base_sha" ] || [ "$pending_head" != none ]; then
  if [ "$deferral_s" -eq 0 ] || [ "$now" -ge "$((deferred_at_s + deferral_s))" ]; then
    engine_wake engine_revision_changed "$engine_head"
    exit 10
  fi
fi

# Console controls and inbox replies are work even when the GitHub board is still empty.
for pattern in "$state"/KICK_REQUESTED-* "$state"/PR_ACTION_REQUESTED-*; do
  if [ -e "$pattern" ]; then exit 10; fi
done
[ ! -e "$state/DRAIN_REQUESTED" ] || exit 10
watch_rc=0
run_bounded node -e '
  const fs = require("node:fs");
  const [marker, ...watched] = process.argv.slice(1);
  let baseline;
  try { baseline = fs.statSync(marker, { bigint: true }).mtimeNs; }
  catch { process.exit(2); }
  for (const path of watched) {
    try {
      if (fs.statSync(path, { bigint: true }).mtimeNs >= baseline) process.exit(10);
    } catch (error) {
      if (error.code !== "ENOENT") process.exit(2);
    }
  }
' "$marker" "$state/inbox-threads.jsonl" "$state/inbox-proposals.json" >/dev/null || watch_rc=$?
if [ "$watch_rc" -eq 10 ]; then exit 10; fi
[ "$watch_rc" -eq 0 ] || exit 2

if [ "$mode" = full ]; then
  # A human-task release is a ledger event, not a plan commit. Scan all three rotation forms;
  # only approvals after this sleep began can create newly eligible work.
  approvals=""
  for file in "$state"/ledger.ndjson "$state"/ledger.*.ndjson "$state"/ledger.*.ndjson.gz; do
    [ -f "$file" ] || continue
    rc=0
    part="$(zgrep -hF '"step":"ratify.approved"' "$file" 2>/dev/null)" || rc=$?
    [ "$rc" -le 1 ] || exit 2
    approvals+="$part"$'\n'
  done
  new_approvals="$(printf '%s' "$approvals" | jq -ser --arg since "$since" \
    'map(select(.step == "ratify.approved" and .ts >= $since)) | length')" || exit 2
  [ "$new_approvals" = 0 ] || exit 10
fi

# App auth is minted inside the ordinary Node daemon, so its process-local GH_TOKEN dies
# with that process. A short-lived, no-model Node process reuses the same signer/exchange here.
# Never print the token or pass it as a process argument; gh reads it from the environment.
if [ -n "${GH_APP_ID:-}" ] && [ -n "${GH_APP_INSTALLATION_ID:-}" ] && [ -n "${GH_APP_PRIVATE_KEY_PATH:-}" ]; then
  GH_TOKEN="$(cd "$engine" && run_bounded node --import tsx --input-type=module -e \
    'import {refreshInstallationToken} from "./src/lib/github-app.ts"; const r=await refreshInstallationToken(); if (!r.ok || !process.env.GH_TOKEN) process.exit(2); process.stdout.write(process.env.GH_TOKEN);')" || exit 2
  export GH_TOKEN
fi
[ -n "${GH_TOKEN:-}" ] || exit 2
prs="$(GH_TOKEN="$GH_TOKEN" run_bounded gh api "repos/$repo/pulls?state=open&per_page=1")" || exit 2
count="$(printf '%s' "$prs" | jq -er 'if type == "array" then length else error("invalid PR board") end')" || exit 2
if [ "$count" != 0 ]; then exit 10; fi

if [ "$mode" = full ]; then
  remote_line="$(run_bounded git -C "$checkout" ls-remote --heads origin refs/heads/main)" || exit 2
  remote_sha="${remote_line%%[[:space:]]*}"
  [[ "$remote_sha" =~ ^[0-9a-f]{40}$ ]] || exit 2
  if [ "$remote_sha" != "$base_sha" ]; then exit 10; fi
fi
if [ "$engine_head" != "$engine_base_sha" ] || [ "$pending_head" != none ]; then
  printf '{"ts":"%s","run_id":"IDLE-ENGINE","task_id":"DAEMON","step":"daemon.idle_starved.engine_deferred","lane":"daemon","engine_base_sha":"%s","engine_head_sha":"%s","deferral_s":%s,"empty_wake_run":%s,"idle_since":"%s","deferred_at_s":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "$engine_base_sha" "$engine_head" "$deferral_s" "$empty_wake_run" "$since" "$deferred_at_s" >> "$state/ledger.ndjson" || exit 2
fi
exit 0
