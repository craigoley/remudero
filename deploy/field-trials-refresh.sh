#!/usr/bin/env bash
# Private, bounded fleet snapshot. Install with install-field-trials-refresh.sh on the fleet host.
set -euo pipefail
umask 077

REGISTRY="${RMD_INSTANCE_REGISTRY:-/home/craigoleyagent/rmd-state2/daemon-install/.remudero/daemon-instances.yaml}"
# Eight requests per repository cover recent lists, one historical page, a deployment status and
# one three-read PR detail. The collector keeps the total bound and reports deferred evidence.
MAX_PAGES="${RMD_FIELD_TRIALS_MAX_PAGES:-24}"
case "$MAX_PAGES" in ''|*[!0-9]*) echo "field-trials-refresh: invalid page bound" >&2; exit 2;; esac
if (( MAX_PAGES < 1 || MAX_PAGES > 24 )); then echo "field-trials-refresh: page bound must be 1..24" >&2; exit 2; fi
test -r "$REGISTRY" || { echo "field-trials-refresh: instance registry unreadable" >&2; exit 2; }
if [[ -n "${RMD_FIELD_TRIALS_CASE_FILES:-}" ]]; then
  test -r "$RMD_FIELD_TRIALS_CASE_FILES" || { echo "field-trials-refresh: case-file snapshot unreadable" >&2; exit 2; }
fi

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

# The Docker process has its own umask. Tighten the exact private output tree before either
# container writes, including snapshots produced by an older image with 755/644 defaults.
PRIVATE_OUT="$CORE/state/field-trials"
mkdir -p "$PRIVATE_OUT"
# W1-T10832: the owner's consent grant is NOT committed; the operator copies it here. It is passed as
# --consent only when it is a regular, non-symlink file this user owns with no group or other bits.
# Anything else withholds the release (no-consent-receipt) and every other step still runs. The
# hardening sweep below never touches it, so the operator's own mode is what is judged.
CONSENT_NAME="field-trials-consent-v1.json"
CONSENT_HOST="${RMD_FIELD_TRIALS_CONSENT:-$PRIVATE_OUT/$CONSENT_NAME}"
CONSENT_MOUNT=(); CONSENT_ARG=(); CONSENT_EXEC_ARG=()
if [[ -e "$CONSENT_HOST" || -L "$CONSENT_HOST" ]]; then
  CONSENT_MODE="$(stat -c '%a' "$CONSENT_HOST" 2>/dev/null || echo 777)"
  if [[ -f "$CONSENT_HOST" && ! -L "$CONSENT_HOST" && -O "$CONSENT_HOST" && -r "$CONSENT_HOST" ]] \
    && (( (8#$CONSENT_MODE & 8#077) == 0 )); then
    CONSENT_MOUNT=(--mount "type=bind,src=$CONSENT_HOST,dst=/field-trials/consent.json,readonly")
    CONSENT_ARG=(--consent /field-trials/consent.json)
    if [[ "$CONSENT_HOST" == "$PRIVATE_OUT/$CONSENT_NAME" ]]; then
      CONSENT_EXEC_ARG=(--consent "/home/node/Remudero/state/field-trials/$CONSENT_NAME")
    fi
  else
    echo "field-trials-refresh: consent file is not an owner-only regular file; release withheld" >&2
  fi
fi
harden_private_output() {
  find "$PRIVATE_OUT" -type d -exec chmod 700 {} +
  find "$PRIVATE_OUT" -type f ! -path "$PRIVATE_OUT/$CONSENT_NAME" -exec chmod 600 {} +
}
harden_private_output
# Also cover a failed or old image that writes a broad-mode temporary file before exiting.
trap harden_private_output EXIT

LOCK="$CORE/state/field-trials-refresh.lock"
exec 9>"$LOCK"
if ! flock -n 9; then echo "field-trials-refresh: another pass is active"; exit 0; fi
IMAGE="$(docker inspect remudero-daemon --format '{{.Image}}')"
test -n "$IMAGE" || { echo "field-trials-refresh: core image unavailable" >&2; exit 2; }
# Review local evidence BEFORE GitHub collection: a remote outage cannot suppress the daily
# routing review. Use the mounted installation checkout, whose main branch can satisfy the normal
# freshness guard; serving generations are deliberately detached.
routing_review() {
docker run --rm --network none --volumes-from remudero-daemon \
  --mount "type=bind,src=$SITE/state,dst=/field-trials/site,readonly" \
  --mount "type=bind,src=$CONSOLE/state,dst=/field-trials/console,readonly" \
  --workdir /home/node/Remudero/daemon-install --entrypoint /bin/sh "$IMAGE" \
  -c 'umask 077; exec "$@"' routing-daily-review /usr/local/bin/node \
  --import tsx scripts/private-routing-daily-review.mjs \
  --source core=/home/node/Remudero/state --source site=/field-trials/site --source console=/field-trials/console \
  --out-dir /home/node/Remudero/state/field-trials/routing-daily
}
ROUTING_EXIT=0
routing_review || ROUTING_EXIT=$?
APP_ID=""; INSTALLATION_ID=""; KEY_PATH=""
credentials() {
  APP_ID="$(docker exec remudero-daemon printenv GH_APP_ID)" || return $?
  INSTALLATION_ID="$(docker exec remudero-daemon printenv GH_APP_INSTALLATION_ID)" || return $?
  KEY_PATH="$(docker exec remudero-daemon printenv GH_APP_PRIVATE_KEY_PATH)" || return $?
  test -n "$APP_ID" && test -n "$INSTALLATION_ID" && test -n "$KEY_PATH"
}
CREDENTIAL_EXIT=0
credentials || CREDENTIAL_EXIT=$?
if (( CREDENTIAL_EXIT != 0 )); then echo "field-trials-refresh: GitHub App credentials unavailable" >&2; fi

CASE_MOUNT=()
CASE_ARG=(--case-files /home/node/Remudero/state/field-trials/case-files-latest.json)
CASE_EXIT=0
if [[ -n "${RMD_FIELD_TRIALS_CASE_FILES:-}" ]]; then
  CASE_MOUNT=(--mount "type=bind,src=$RMD_FIELD_TRIALS_CASE_FILES,dst=/field-trials/cases.json,readonly")
  CASE_ARG=(--case-files /field-trials/cases.json)
  CASE_EXIT=skipped
else
  collect_cases() {
    if (( CREDENTIAL_EXIT != 0 )); then return "$CREDENTIAL_EXIT"; fi
  docker run --rm --network host --volumes-from remudero-daemon \
    --env "GH_APP_ID=$APP_ID" --env "GH_APP_INSTALLATION_ID=$INSTALLATION_ID" \
    --env "GH_APP_PRIVATE_KEY_PATH=$KEY_PATH" \
    --env RMD_FIELD_TRIALS_REPO_ROOT=/home/node/Remudero/daemon-install \
    --workdir /home/node/Remudero/daemon-install --entrypoint /bin/sh "$IMAGE" \
    -c 'umask 077; exec "$@"' field-trials-refresh /usr/local/bin/node \
    --import tsx scripts/private-field-trials-case-files.mjs
  }
  collect_cases || CASE_EXIT=$?
  if [[ "$CASE_EXIT" != 0 ]]; then
    if test -r "$PRIVATE_OUT/case-files-latest.json"; then
      echo "field-trials-refresh: case-file step failed; using previous case-files-latest.json" >&2
    else
      CASE_ARG=()
      echo "field-trials-refresh: case-file step failed; no previous case-file snapshot" >&2
    fi
  fi
fi

SCRIPT_BLOB="$( { printf 'blob %s\0' "$(wc -c < "$0" | tr -d '[:space:]')"; cat "$0"; } | sha1sum | cut -d ' ' -f 1)"
REFRESH_ARG=(--refresh-step "routing-review=$ROUTING_EXIT" --refresh-step "case-files=$CASE_EXIT" --refresh-script-blob "$SCRIPT_BLOB")
collect_snapshot() {
if (( CREDENTIAL_EXIT != 0 )); then
  docker exec --workdir /home/node/Remudero/daemon-install remudero-daemon \
    /bin/sh -c 'umask 077; exec "$@"' field-trials-refresh /home/node/Remudero/daemon-install/bin/rmd field-trials \
    --offline --ledger core=/home/node/Remudero/state --out-dir /home/node/Remudero/state/field-trials \
    "${CASE_ARG[@]}" ${CONSENT_EXEC_ARG[@]+"${CONSENT_EXEC_ARG[@]}"} "${REFRESH_ARG[@]}"
  return $?
fi
docker run --rm --network host --volumes-from remudero-daemon \
  --mount "type=bind,src=$SITE/state,dst=/field-trials/site,readonly" \
  --mount "type=bind,src=$CONSOLE/state,dst=/field-trials/console,readonly" \
  ${CASE_MOUNT[@]+"${CASE_MOUNT[@]}"} ${CONSENT_MOUNT[@]+"${CONSENT_MOUNT[@]}"} \
  --env "GH_APP_ID=$APP_ID" --env "GH_APP_INSTALLATION_ID=$INSTALLATION_ID" \
  --env "GH_APP_PRIVATE_KEY_PATH=$KEY_PATH" \
  --workdir /home/node/Remudero/daemon-install --entrypoint /bin/sh "$IMAGE" \
  -c 'umask 077; exec "$@"' field-trials-refresh /home/node/Remudero/daemon-install/bin/rmd field-trials \
  --source core=craigoley/remudero --source site=craigoley/remudero-site --source console=craigoley/remudero-console \
  --ledger core=/home/node/Remudero/state --ledger site=/field-trials/site --ledger console=/field-trials/console \
  --out-dir /home/node/Remudero/state/field-trials --max-pages "$MAX_PAGES" \
  "${CASE_ARG[@]}" ${CONSENT_ARG[@]+"${CONSENT_ARG[@]}"} "${REFRESH_ARG[@]}"
}
SNAPSHOT_EXIT=0
collect_snapshot || SNAPSHOT_EXIT=$?
if (( SNAPSHOT_EXIT != 0 )); then
  RECORD_EXIT=0
  if (( CREDENTIAL_EXIT != 0 )); then
    docker exec --workdir /home/node/Remudero/daemon-install remudero-daemon \
      /bin/sh -c 'umask 077; exec "$@"' field-trials-refresh /home/node/Remudero/daemon-install/bin/rmd field-trials \
      --ledger core=/home/node/Remudero/state --out-dir /home/node/Remudero/state/field-trials \
      "${REFRESH_ARG[@]}" --refresh-step "snapshot=$SNAPSHOT_EXIT" --refresh-record-only || RECORD_EXIT=$?
  else
  docker run --rm --network host --volumes-from remudero-daemon \
    --env "GH_APP_ID=$APP_ID" --env "GH_APP_INSTALLATION_ID=$INSTALLATION_ID" \
    --env "GH_APP_PRIVATE_KEY_PATH=$KEY_PATH" \
    --workdir /home/node/Remudero/daemon-install --entrypoint /bin/sh "$IMAGE" \
    -c 'umask 077; exec "$@"' field-trials-refresh /home/node/Remudero/daemon-install/bin/rmd field-trials \
    --ledger core=/home/node/Remudero/state --out-dir /home/node/Remudero/state/field-trials \
    "${REFRESH_ARG[@]}" --refresh-step "snapshot=$SNAPSHOT_EXIT" --refresh-record-only || RECORD_EXIT=$?
  fi
  if (( RECORD_EXIT != 0 )); then echo "field-trials-refresh: outcome recording failed ($RECORD_EXIT)" >&2; fi
fi
if [[ "$ROUTING_EXIT" != 0 || ( "$CASE_EXIT" != 0 && "$CASE_EXIT" != skipped ) || "$SNAPSHOT_EXIT" != 0 || "$CREDENTIAL_EXIT" != 0 ]]; then exit 1; fi
