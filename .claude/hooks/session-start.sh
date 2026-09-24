#!/bin/bash
# .claude/hooks/session-start.sh — turn this repo's git hooks on in a Claude Code on the web session.
#
# hooks/pre-commit, hooks/pre-push and hooks/commit-msg only run where core.hooksPath=hooks. The
# fleet sets that per worktree (worker.ts worktreeAdd); a web session's fresh clone never had it,
# so every commit and push there skipped the local gates. MEASURED 2026-09-24: #6986 went red on
# mkdtemp-callsite-check, which hooks/pre-commit would have refused before the commit existed.
#
# WEB SESSIONS ONLY: on the fleet host the operator checkout is the canonical repo, and a shared
# core.hooksPath there would arm the gates on every harness lane. An existing value is never
# overridden.
set -euo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "${CLAUDE_PROJECT_DIR:-.}"
git rev-parse --git-dir >/dev/null 2>&1 || exit 0
[ -n "$(git config --get core.hooksPath || true)" ] && exit 0
git config core.hooksPath hooks
