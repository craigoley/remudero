#!/usr/bin/env bash
# Private, bounded fleet snapshot. Install with install-field-trials-refresh.sh on the fleet host.
set -euo pipefail
umask 077

REGISTRY="${RMD_INSTANCE_REGISTRY:-/home/craigoleyagent/rmd-state2/daemon-install/.remudero/daemon-instances.yaml}"
MAX_PAGES="${RMD_FIELD_TRIALS_MAX_PAGES:-12}"
case "$MAX_PAGES" in ''|*[!0-9]*) echo "field-trials-refresh: invalid page bound" >&2; exit 2;; esac
if (( MAX_PAGES < 1 || MAX_PAGES > 24 )); then echo "field-trials-refresh: page bound must be 1..24" >&2; exit 2; fi
test -r "$REGISTRY" || { echo "field-trials-refresh: instance registry unreadable" >&2; exit 2; }

state_for() {
  awk -v want="$1" '
    /^  [A-Za-z0-9_-]+:[[:space:]]*$/ { name=$1; sub(/:$/, "", name); next }
    name == want && /^    state_dir:[[:space:]]*/ {
      sub(/^    state_dir:[[:space:]]*/, ""); gsub(/^"|"$/, ""); print; exit
    }
  ' "$REGISTRY"
}
CORE="$(state_for core)"; SITE="$(state_for site)"; CONSOLE="$(state_for console)"
for dir in "$CORE" "$SITE" "$CONSOLE"; do
  case "$dir" in /*) :;; *) echo "field-trials-refresh: missing absolute state directory" >&2; exit 2;; esac
  test -d "$dir/state" || { echo "field-trials-refresh: ledger directory absent: $dir/state" >&2; exit 2; }
  if ! find "$dir/state" -maxdepth 1 -type f \( -name 'ledger.ndjson' -o -name 'ledger.*.ndjson' -o -name 'ledger.*.ndjson.gz' \) -print -quit | grep -q .; then
    echo "field-trials-refresh: no ledger form in $dir/state" >&2; exit 2
  fi
done

LOCK="$CORE/state/field-trials-refresh.lock"
exec 9>"$LOCK"
if ! flock -n 9; then echo "field-trials-refresh: another pass is active"; exit 0; fi
IMAGE="$(docker inspect remudero-daemon --format '{{.Image}}')"
test -n "$IMAGE" || { echo "field-trials-refresh: core image unavailable" >&2; exit 2; }
APP_ID="$(docker exec remudero-daemon printenv GH_APP_ID)"
INSTALLATION_ID="$(docker exec remudero-daemon printenv GH_APP_INSTALLATION_ID)"
KEY_PATH="$(docker exec remudero-daemon printenv GH_APP_PRIVATE_KEY_PATH)"
test -n "$APP_ID" && test -n "$INSTALLATION_ID" && test -n "$KEY_PATH" || {
  echo "field-trials-refresh: GitHub App credentials unavailable" >&2; exit 2;
}

CASE_MOUNT=()
CASE_ARG=()
if [[ -n "${RMD_FIELD_TRIALS_CASE_FILES:-}" ]]; then
  test -r "$RMD_FIELD_TRIALS_CASE_FILES" || { echo "field-trials-refresh: case-file snapshot unreadable" >&2; exit 2; }
  CASE_MOUNT=(--mount "type=bind,src=$RMD_FIELD_TRIALS_CASE_FILES,dst=/field-trials/cases.json,readonly")
  CASE_ARG=(--case-files /field-trials/cases.json)
fi

docker run --rm --network host --volumes-from remudero-daemon \
  --mount "type=bind,src=$SITE/state,dst=/field-trials/site,readonly" \
  --mount "type=bind,src=$CONSOLE/state,dst=/field-trials/console,readonly" \
  "${CASE_MOUNT[@]}" \
  --env "GH_APP_ID=$APP_ID" --env "GH_APP_INSTALLATION_ID=$INSTALLATION_ID" \
  --env "GH_APP_PRIVATE_KEY_PATH=$KEY_PATH" \
  --workdir /app --entrypoint /app/bin/rmd "$IMAGE" \
  field-trials \
  --source core=craigoley/remudero --source site=craigoley/remudero-site --source console=craigoley/remudero-console \
  --ledger core=/home/node/Remudero/state --ledger site=/field-trials/site --ledger console=/field-trials/console \
  --out-dir /home/node/Remudero/state/field-trials --max-pages "$MAX_PAGES" \
  "${CASE_ARG[@]}"
