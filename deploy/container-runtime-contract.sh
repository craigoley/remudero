#!/usr/bin/env bash
# Verify the bind-mount runtime contract of one running Remudero container.
#
# This is deliberately host-side, read-only, and independent of Node, jq, GitHub and provider
# endpoints. It prints exactly one bounded JSON verdict. Expected source paths are used only for
# comparison and are never printed: they can identify credential homes even when their contents
# remain secret.
#
# Usage:
#   container-runtime-contract.sh --container <name> \
#     --expect <host-source> <container-destination> rw [--expect ...]
#
# Exit 0 = healthy, 1 = drift, 2 = Docker inspection unreadable, 64 = invalid invocation.

set -u -o pipefail

CONTAINER=""
EXPECT_SOURCES=()
EXPECT_DESTINATIONS=()
MAX_EXPECTATIONS=16

json_escape() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '%s' "${value}"
}

safe_argument() {
  local value="$1"
  local max_bytes="$2"
  [ "${#value}" -le "${max_bytes}" ] || return 1
  ! printf '%s' "${value}" | LC_ALL=C grep -q '[[:cntrl:]]'
}

usage_error() {
  printf '{"status":"invalid","container":"","checked":0,"drift":[]}\n'
  exit 64
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --container)
      [ "$#" -ge 2 ] || usage_error
      CONTAINER="$2"
      shift 2
      ;;
    --expect)
      [ "$#" -ge 4 ] || usage_error
      [ "$4" = "rw" ] || usage_error
      [ "${#EXPECT_SOURCES[@]}" -lt "${MAX_EXPECTATIONS}" ] || usage_error
      safe_argument "$2" 4096 || usage_error
      safe_argument "$3" 512 || usage_error
      EXPECT_SOURCES+=("$2")
      EXPECT_DESTINATIONS+=("$3")
      shift 4
      ;;
    -h|--help)
      sed -n '1,14p' "$0"
      exit 0
      ;;
    *) usage_error ;;
  esac
done

[ -n "${CONTAINER}" ] || usage_error
safe_argument "${CONTAINER}" 128 || usage_error
[ "${#EXPECT_SOURCES[@]}" -gt 0 ] || usage_error

MOUNTS_OUTPUT=""
if ! MOUNTS_OUTPUT="$(docker inspect --format '{{range .Mounts}}{{printf "%s\t%s\t%t\n" .Source .Destination .RW}}{{end}}' "${CONTAINER}" 2>/dev/null)"; then
  printf '{"status":"unreadable","container":"%s","checked":%s,"drift":[]}\n' \
    "$(json_escape "${CONTAINER}")" "${#EXPECT_SOURCES[@]}"
  exit 2
fi

DRIFT_JSON=""
DRIFT_COUNT=0
index=0
while [ "${index}" -lt "${#EXPECT_SOURCES[@]}" ]; do
  expected_source="${EXPECT_SOURCES[${index}]}"
  expected_destination="${EXPECT_DESTINATIONS[${index}]}"
  found_destination=0
  found_source=0
  found_exact=0

  while IFS=$'\t' read -r actual_source actual_destination actual_rw; do
    [ "${actual_destination:-}" = "${expected_destination}" ] || continue
    found_destination=1
    [ "${actual_source:-}" = "${expected_source}" ] || continue
    found_source=1
    if [ "${actual_rw:-}" = "true" ]; then
      found_exact=1
      break
    fi
  done <<EOF_MOUNTS
${MOUNTS_OUTPUT}
EOF_MOUNTS

  if [ "${found_exact}" -ne 1 ]; then
    if [ "${found_destination}" -ne 1 ]; then
      reason="missing"
    elif [ "${found_source}" -ne 1 ]; then
      reason="wrong_source"
    else
      reason="read_only"
    fi
    if [ "${DRIFT_COUNT}" -gt 0 ]; then DRIFT_JSON="${DRIFT_JSON},"; fi
    DRIFT_JSON="${DRIFT_JSON}{\"destination\":\"$(json_escape "${expected_destination}")\",\"reason\":\"${reason}\"}"
    DRIFT_COUNT=$((DRIFT_COUNT + 1))
  fi
  index=$((index + 1))
done

if [ "${DRIFT_COUNT}" -gt 0 ]; then
  printf '{"status":"drift","container":"%s","checked":%s,"drift":[%s]}\n' \
    "$(json_escape "${CONTAINER}")" "${#EXPECT_SOURCES[@]}" "${DRIFT_JSON}"
  exit 1
fi

printf '{"status":"healthy","container":"%s","checked":%s,"drift":[]}\n' \
  "$(json_escape "${CONTAINER}")" "${#EXPECT_SOURCES[@]}"
