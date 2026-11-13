#!/usr/bin/env bash
# W1-T5319: source for deploy authentication; --refresh also publishes the host's latest result.

rmd_acr_failure_cause() {
  local output code="$2"
  output="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  # Only emit fixed descriptions: CLI output may include tokens, headers or credential paths.
  case "$output" in
    *permission\ denied*) printf '%s' 'local credential/configuration permission denied' ;;
    *error*saving*credentials*|*error*storing*credentials*|*credential*helper*)
      printf '%s' 'local credentials could not be saved or read' ;;
    *no\ managed\ identity*|*identity*not*found*|*identity*not*assigned*|*no\ access\ was\ configured\ for\ the\ vm*)
      printf '%s' 'no managed identity on this host' ;;
    *aadsts700082*|*expired*) printf '%s' 'Azure login expired; run az login' ;;
    *nameresolutionerror*|*failed\ to\ resolve*|*name\ or\ service\ not\ known*|*name\ resolution*|*getaddrinfo*)
      printf '%s' 'DNS resolution failed' ;;
    *timed\ out*|*timeout*) printf '%s' 'request timed out' ;;
    *connection*failed*|*connection*refused*|*connection*reset*|*connectionerror*|*failed\ to\ connect*|*could\ not\ connect*|*network\ is\ unreachable*)
      printf '%s' 'network connection failed' ;;
    *requested\ access\ to\ the\ resource\ is\ denied*|*unauthorized:\ authentication\ required*|*access\ to\ registry*was\ denied*|*does\ not\ have\ authorization*microsoft.containerregistry/*)
      printf '%s' 'registry authorization refused' ;;
    *authorizationfailed*|*forbidden*|*unauthorized*|*access\ denied*)
      printf '%s' 'Azure authorization refused' ;;
    *aadsts*|*please\ run*az\ login*|*not\ logged\ in*) printf '%s' 'Azure authentication failed; run az login' ;;
    *)
      if [ "$code" -eq 124 ] || [ "$code" -eq 137 ]; then
        printf '%s' 'request timed out'
      else
        printf 'unclassified Azure CLI failure (exit %s)' "$code"
      fi ;;
  esac
}

rmd_acr_login() {
  local registry="${1:-${REGISTRY:-synthwatcholey0620}}" output config identity_reason cause code
  RMD_ACR_LOGIN_REASON=""
  RMD_ACR_LOGIN_METHOD="none"
  if ! command -v az >/dev/null 2>&1; then
    RMD_ACR_LOGIN_REASON="the Azure CLI is not installed on this host"
    printf 'acr-login: %s\n' "$RMD_ACR_LOGIN_REASON" >&2
    return 127
  fi
  identity_reason="managed identity unavailable: could not create an isolated Azure config"
  if config="$(mktemp -d "${TMPDIR:-/tmp}/rmd-acr-identity.XXXXXX")"; then
    # Keep identity credentials separate from the host owner's active Azure account (W1-T12177).
    if output="$(AZURE_CONFIG_DIR="$config" timeout --kill-after=2s 15s az login --identity --output none 2>&1)"; then
      if output="$(AZURE_CONFIG_DIR="$config" timeout --kill-after=2s 15s az acr login -n "$registry" 2>&1)"; then
        rm -rf -- "$config"
        RMD_ACR_LOGIN_METHOD="managed-identity"
        return 0
      else
        code=$?
        cause="$(rmd_acr_failure_cause "$output" "$code")"
        identity_reason="managed identity registry login failed for $registry: $cause"
        if [ "$cause" = 'registry authorization refused' ]; then
          identity_reason="managed identity is missing AcrPull on registry $registry (registry refused login)"
        fi
      fi
    else
      code=$?
      identity_reason="managed identity unavailable: $(rmd_acr_failure_cause "$output" "$code")"
    fi
    rm -rf -- "$config"
  fi
  if output="$(az acr login -n "$registry" 2>&1)"; then
    RMD_ACR_LOGIN_METHOD="stored-login"
    return 0
  else
    code=$?
  fi
  RMD_ACR_LOGIN_REASON="$identity_reason; stored login failed for $registry: $(rmd_acr_failure_cause "$output" "$code")"
  printf 'acr-login: %s\n' "$RMD_ACR_LOGIN_REASON" >&2
  return 1
}

rmd_acr_json_string() {
  local value="$1"
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  value="${value//$'\n'/\\n}"
  value="${value//$'\r'/\\r}"
  value="${value//$'\t'/\\t}"
  value="${value//$'\b'/\\b}"
  value="${value//$'\f'/\\f}"
  printf '"%s"' "$value"
}

rmd_acr_refresh() {
  local registry="${REGISTRY:-synthwatcholey0620}" root result status=0 path temp ts
  root="${RMD_ROOT:-${RMD_STATE_DIR:-}}"
  if [ -z "$root" ] && [ -r "${HOME}/.config/remudero/config.json" ]; then
    root="$(grep -o '"root"[[:space:]]*:[[:space:]]*"[^"]*"' "${HOME}/.config/remudero/config.json" | head -n 1 | sed 's/.*"\([^"]*\)"$/\1/')"
  fi
  root="${root:-${HOME}/Remudero}"
  if rmd_acr_login "$registry"; then
    result=ok
  else
    status=$?
    if [ "$status" -eq 127 ]; then result=unavailable; status=0; else result=failed; fi
  fi
  path="${root}/state/acr-login.json"
  mkdir -p "$(dirname "$path")" || return 1
  temp="$(mktemp "${path}.XXXXXX")" || return 1
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  if ! printf '{"result":"%s","ts":"%s","registry":%s,"reason":%s,"method":%s}\n' \
    "$result" "$ts" "$(rmd_acr_json_string "$registry")" "$(rmd_acr_json_string "$RMD_ACR_LOGIN_REASON")" \
    "$(rmd_acr_json_string "$RMD_ACR_LOGIN_METHOD")" > "$temp"; then
    rm -f "$temp"
    return 1
  fi
  mv -f "$temp" "$path" || { rm -f "$temp"; return 1; }
  return "$status"
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  case "${1:-}" in
    --refresh) rmd_acr_refresh ;;
    --probe)
      status=0
      rmd_acr_login "${2:-}" || status=$?
      printf '{"status":%s,"method":%s,"reason":%s}\n' "$status" \
        "$(rmd_acr_json_string "$RMD_ACR_LOGIN_METHOD")" "$(rmd_acr_json_string "$RMD_ACR_LOGIN_REASON")"
      ;;
    *) echo 'acr-login: use --refresh, or source this helper and call rmd_acr_login' >&2; exit 2 ;;
  esac
fi
