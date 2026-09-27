#!/usr/bin/env bash
# Exit 0 only when the target repo still has zero open PRs and main has not moved
# since the daemon's last positively empty admission. Any uncertainty wakes Node.
set -euo pipefail

repo="${1:?owner/repo required}"
checkout="${2:?target checkout required}"
base_sha="${3:?baseline commit required}"
state="${4:?state directory required}"
since="${5:?entry timestamp required}"
marker="${6:?entry marker required}"
engine="${7:?engine checkout required}"
[[ "$repo" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || exit 2
[[ "$base_sha" =~ ^[0-9a-f]{40}$ ]] || exit 2
[[ "$since" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.000Z$ ]] || exit 2
[[ -d "$state" && -f "$marker" ]] || exit 2
[[ -d "$engine" ]] || exit 2

run_bounded() {
  if command -v timeout >/dev/null 2>&1; then timeout 45 "$@"; else "$@"; fi
}

# Console controls and inbox replies are work even when the GitHub board is still empty.
for pattern in "$state"/KICK_REQUESTED-* "$state"/PR_ACTION_REQUESTED-*; do
  if [ -e "$pattern" ]; then exit 10; fi
done
[ ! -e "$state/DRAIN_REQUESTED" ] || exit 10
for watched in "$state/inbox-threads.jsonl" "$state/inbox-proposals.json"; do
  if [ -e "$watched" ] && [ "$watched" -nt "$marker" ]; then exit 10; fi
done

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
  'map(select(.step == "ratify.approved" and .ts > $since)) | length')" || exit 2
[ "$new_approvals" = 0 ] || exit 10

# App auth is minted inside the ordinary Node daemon, so its process-local GH_TOKEN dies
# with that process. A short-lived, no-model Node process reuses the same signer/exchange here.
# Never print the token or pass it as a process argument; gh reads it from the environment.
if [ -n "${GH_APP_ID:-}" ] && [ -n "${GH_APP_INSTALLATION_ID:-}" ] && [ -n "${GH_APP_PRIVATE_KEY_PATH:-}" ]; then
  GH_TOKEN="$(cd "$engine" && node --import tsx --input-type=module -e \
    'import {refreshInstallationToken} from "./src/lib/github-app.ts"; const r=await refreshInstallationToken(); if (!r.ok || !process.env.GH_TOKEN) process.exit(2); process.stdout.write(process.env.GH_TOKEN);')" || exit 2
  export GH_TOKEN
fi
[ -n "${GH_TOKEN:-}" ] || exit 2
prs="$(GH_TOKEN="$GH_TOKEN" run_bounded gh api "repos/$repo/pulls?state=open&per_page=1")" || exit 2
count="$(printf '%s' "$prs" | jq -er 'if type == "array" then length else error("invalid PR board") end')" || exit 2
if [ "$count" != 0 ]; then exit 10; fi

remote_line="$(run_bounded git -C "$checkout" ls-remote --heads origin refs/heads/main)" || exit 2
remote_sha="${remote_line%%[[:space:]]*}"
[[ "$remote_sha" =~ ^[0-9a-f]{40}$ ]] || exit 2
if [ "$remote_sha" != "$base_sha" ]; then exit 10; fi
exit 0
