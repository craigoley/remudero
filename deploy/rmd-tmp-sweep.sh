#!/usr/bin/env bash
# Hourly adapter for the host janitor's single guarded temp-cleanup implementation.
# Keep the old /etc/cron.d/rmd-tmp-sweep cadence, but do not use shallow mtime + rm -rf.
set -euo pipefail

CLEANUP_SCRIPT="${RMD_HOST_CLEANUP_SCRIPT:-/home/craigoleyagent/rmd-host-cleanup.sh}"
if [ ! -x "$CLEANUP_SCRIPT" ]; then
  echo "rmd-tmp-sweep: host janitor is missing or not executable: $CLEANUP_SCRIPT" >&2
  exit 2
fi

export IDLE_MINUTES="${IDLE_MINUTES:-360}"
export RMD_CLEANUP_ONLY_TMP=1
export RMD_CLEANUP_TMP_ROOTS="${RMD_CLEANUP_TMP_ROOTS:-/tmp:/home/craigoleyagent/rmd-state2/tmp:/mnt/rmd/tmp:/mnt/scratch/tmp}"
export RMD_CLEANUP_TMP_GLOBS="${RMD_CLEANUP_TMP_GLOBS:-rmd-* node-coverage-*}"
# Scratch roots are NOT exported here: the janitor defaults them to /mnt/scratch only for a root
# pass, so running this wrapper as a user cannot opt a blind (non-root lsof) pass into them.
export RMD_CLEANUP_COVERAGE_PATHS="${RMD_CLEANUP_COVERAGE_PATHS:-/home/craigoleyagent/.remudero-coverage:/tmp/.remudero-coverage:/tmp/.rmd-coverage}"

exec "$CLEANUP_SCRIPT"
