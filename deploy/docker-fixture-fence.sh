#!/usr/bin/env bash
# Install as /usr/local/bin/docker on a host whose real Docker client is /usr/bin/docker.
# The test fixtures set either variable below to bypass the in-container marker or
# point a recycle at a disposable checkout. An older checkout may lack the fixture's
# Docker stub, so refuse its mutating Docker calls before it can stop a live daemon.
# This is an accidental-invocation fence, not a substitute for Docker socket access control.
set -euo pipefail

REAL_DOCKER=/usr/bin/docker
fixture_context=false
if [ -n "${RMD_RECYCLE_DOCKERENV_PATH:-}" ]; then
  fixture_context=true
fi
case "${RMD_STATE_DIR:-}" in
  /tmp/*|/private/tmp/*|/mnt/rmd/tmp/*) fixture_context=true ;;
esac

if [ "${fixture_context}" = true ]; then
  operation="${1:-}"
  refuse=false
  case "${operation}" in
    ps|inspect|images|logs|top|port|stats|info|version|help|--help|--version) ;;
    container|image|volume|network|system)
      case "${operation}:${2:-}" in
        container:ls|container:inspect|image:ls|image:inspect|volume:ls|volume:inspect|network:ls|network:inspect|system:df|system:info) ;;
        *) refuse=true ;;
      esac
      ;;
    *) refuse=true ;;
  esac
  if [ "${refuse}" = true ]; then
    echo "docker-fixture-fence: REFUSING docker ${operation} from a recycle test fixture" >&2
    exit 97
  fi
fi

exec "${REAL_DOCKER}" "$@"
