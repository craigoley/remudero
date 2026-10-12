#!/usr/bin/env bash
# Shared by the recycler and embedded into rendered launchers; never reads key contents.
app_private_key_mount_args() {
  local host="$1" destination="$2" path
  APP_PRIVATE_KEY_ARGS=()
  for path in "$host" "$destination"; do
    case "$path" in
      /*) : ;;
      *) echo "App key mount: REFUSING -- host and container paths must be absolute." >&2; return 1 ;;
    esac
    case "$path" in
      *','*|*'"'*|*'/../'*|*'/./'*|*/..|*/.|*'//'*|*/)
        echo "App key mount: REFUSING -- unsupported path syntax." >&2; return 1 ;;
    esac
    if printf '%s' "$path" | LC_ALL=C grep -q '[[:cntrl:]]'; then
      echo "App key mount: REFUSING -- control characters in a path." >&2; return 1
    fi
  done
  case "$destination" in
    /home|/home/node|/home/node/.claude|/home/node/.codex|/home/node/Remudero|/home/node/.config|/home/node/.config/remudero|/home/node/.claude/.credentials.json|/home/node/.claude.json|/tmp|/run)
      echo "App key mount: REFUSING -- destination overlaps a runtime directory or OAuth store." >&2; return 1 ;;
  esac
  if [ ! -f "$host" ] || [ ! -s "$host" ] || [ ! -r "$host" ]; then
    echo "App key mount: REFUSING -- declared host key must be a readable nonempty regular file." >&2
    return 1
  fi
  # Callers consume this shared array in their Docker invocation.
  # shellcheck disable=SC2034
  APP_PRIVATE_KEY_ARGS=(--mount "type=bind,source=$host,target=$destination,readonly")
}
