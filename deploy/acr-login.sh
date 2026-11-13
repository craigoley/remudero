#!/usr/bin/env bash
# W1-T5319: source for deploy authentication; --refresh also publishes the host's latest result.

rmd_acr_login() {
  local registry="${1:-${REGISTRY:-synthwatcholey0620}}" output config identity_reason code
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
        identity_reason="managed identity registry login failed (exit $code) for $registry"
        case "$output" in
          *[Dd][Ee][Nn][Ii][Ee][Dd]*|*[Uu]nauthorized*|*Forbidden*|*403*|*401*)
            identity_reason="managed identity is missing AcrPull on registry $registry (registry refused login)" ;;
        esac
      fi
    else
      code=$?
      identity_reason="managed identity unavailable: Azure login failed (exit $code)"
      if [ "$code" -eq 124 ] || [ "$code" -eq 137 ]; then
        identity_reason="managed identity unavailable: Azure login timed out"
      fi
    fi
    rm -rf -- "$config"
  fi
  if output="$(az acr login -n "$registry" 2>&1)"; then
    RMD_ACR_LOGIN_METHOD="stored-login"
    return 0
  else
    code=$?
  fi
  # Emit only classified diagnostics; arbitrary CLI output can contain credentials.
  RMD_ACR_LOGIN_REASON="$identity_reason; stored login failed (exit $code) for $registry"
  case "$output" in
    *AADSTS700082*|*expired*|*Expired*) RMD_ACR_LOGIN_REASON="$identity_reason; stored login expired for $registry; run az login" ;;
  esac
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
