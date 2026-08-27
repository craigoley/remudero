#!/usr/bin/env bash
# Remudero deny-floor — PreToolUse tripwire (<1s, no network, no forks beyond jq).
#
# Exit 2 = block the tool call (Claude Code treats a non-zero PreToolUse exit as
# a denial and feeds stderr back to the model). This is the deterministic floor
# that must hold even under bypassPermissions. It is a tripwire, NOT a sandbox —
# the OS sandbox (§4A) is the real boundary; this catches a small, explicit set
# of never-do operations and appends the operator's machine-specific protected
# paths from ~/.config/remudero/deny.local (never committed to the public tree).
set -euo pipefail

input="$(cat)"

# Pull the fields we police out of the tool-call JSON. Bash carries `command`;
# Write/Edit/Read carry `file_path`. Fall back to raw input if jq is absent.
if command -v jq >/dev/null 2>&1; then
  cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // ""')"
  path="$(printf '%s' "$input" | jq -r '.tool_input.file_path // ""')"
  hook_cwd="$(printf '%s' "$input" | jq -r '.cwd // ""')"
else
  cmd="$input"
  path="$input"
  hook_cwd=""
fi
haystack="$cmd $path"

deny() {
  printf 'deny-floor: blocked — %s\n' "$1" >&2
  exit 2
}

# 1) force-push to the default branch (main/master).
if printf '%s' "$cmd" | grep -Eq 'git[[:space:]]+push[[:space:]].*(--force|-f)([[:space:]]|=|$)'; then
  if printf '%s' "$cmd" | grep -Eq '(origin[[:space:]]+)?(main|master|HEAD:main|HEAD:master)'; then
    deny "git push --force to a default branch"
  fi
fi

# 2) gh auth mutation (login/logout/refresh/token/setup-git).
if printf '%s' "$cmd" | grep -Eq 'gh[[:space:]]+auth[[:space:]]+(login|logout|refresh|token|setup-git)'; then
  deny "gh auth mutation"
fi

# 3) the planted probe path.
if printf '%s' "$haystack" | grep -Eq '(^|[^A-Za-z0-9_])FORBIDDEN_PROBE'; then
  deny "FORBIDDEN_PROBE path"
fi

# 4) POST a commit status via `gh api` (W1-T203 — THE FORGE ATTACK). `gh` runs
#    outside the OS sandbox with the operator's own ambient credential, so any
#    worker (implementer, reviewer, anything spawned) that can reach this floor
#    could otherwise post its own remudero-review=success and satisfy its own
#    merge gate. The ORCHESTRATOR's own poster (postReviewStatus, src/lib/
#    review.ts) calls `gh` via execFileSync directly from the `rmd run-task`
#    process — never through a Claude Code Bash tool call — so it never
#    reaches this hook at all; only a spawned worker's Bash call does. Matches
#    regardless of flag order (`-X POST` vs `--method POST` vs the args before
#    or after the endpoint) and regardless of context (not just
#    remudero-review — any commit status is the same forge surface).
if printf '%s' "$cmd" | grep -Eq 'gh[[:space:]]+api\b'; then
  if printf '%s' "$cmd" | grep -Eq '(-X|--method)[[:space:]]+POST'; then
    if printf '%s' "$cmd" | grep -Eq 'repos/[^[:space:]]*/statuses(/|[[:space:]]|$)'; then
      deny "gh api POST to a commit-status endpoint (remudero-review provenance, W1-T203)"
    fi
  fi
fi

# 5) operator's machine-specific protected paths (one glob/substring per line).
deny_local="${HOME}/.config/remudero/deny.local"
if [ -f "$deny_local" ]; then
  while IFS= read -r pat || [ -n "$pat" ]; do
    [ -z "$pat" ] && continue
    case "$pat" in \#*) continue ;; esac
    if printf '%s' "$haystack" | grep -Fq -- "$pat"; then
      deny "protected path (deny.local)"
    fi
  done < "$deny_local"
fi

# 6) an inline polling loop against `gh` (W1-T1066 — THE NINETY-MINUTE LOCKOUT). A
#    single command that carries a loop keyword (for/while/until) AND `sleep` AND a
#    `gh` invocation is the exact shape that exhausted the SECONDARY rate limit (which
#    counts cadence, not volume) and locked the operator out of his own repo for ~90
#    minutes: `for i in $(seq 1 25); do gh pr view …; sleep 20; done` and
#    `until [ "$(gh run view …)" = completed ]; do sleep 20; done` both match. A bare
#    `gh` call, a bare `sleep`, and a loop that never touches `gh` (e.g. waiting on a
#    local file) are all left alone — this refuses the ACT of polling `gh` in one
#    inline command, not `gh` itself and not waiting in general.
if printf '%s' "$cmd" | grep -Eq '\b(for|while|until)\b'; then
  if printf '%s' "$cmd" | grep -Eq '\bsleep\b'; then
    if printf '%s' "$cmd" | grep -Eq '\bgh\b'; then
      deny "inline polling loop against gh (W1-T1066) — a wait is the operator's to schedule; report what you know and stop"
    fi
  fi
fi

# 7) a `git push` whose refspec names the shared cross-host pause namespace (W1-T2262 —
#    `refs/rmd-pause/hold`, `src/lib/fleet-control.ts`). `writeSharedPause`/`clearSharedPause`
#    push straight to that ref with the SAME `GH_TOKEN` every worker holds, and rule 1 above only
#    ever looks at `--force`-to-default-branch — no rule named this namespace at all. Matches the
#    literal ref text anywhere in a `git push` command, so `git push origin <sha>:refs/rmd-pause/
#    hold` and `git push origin :refs/rmd-pause/hold` (a delete) both trip it, regardless of
#    force/lease flags. THIS IS A TRIPWIRE, NOT A BOUNDARY (see the file header): a refspec
#    assembled indirectly — `ref=refs/rmd-pause/hold; git push origin "$anchor:$ref"` — never
#    puts the literal text in `$cmd` and is NOT caught here; that limitation is asserted, not
#    papered over, by test/pause-hold-is-attributable.test.ts. The durable remedy is a server-side
#    rule on who may write that ref (recorded in W1-T2262's rationale, not solved by this hook).
if printf '%s' "$cmd" | grep -Eq 'git[[:space:]]+push\b'; then
  if printf '%s' "$cmd" | grep -Eq 'refs/rmd-pause/'; then
    deny "git push naming the shared pause namespace (refs/rmd-pause/, W1-T2262)"
  fi
fi

# 8) an installing package manager where THIS PROJECT'S `node_modules` is a symlink
#    (W1-T2312 — the 2026-08-05/08-11 outages). `linkWorktreeNodeModules` (src/lib/
#    worker.ts) symlinks every worker worktree's `node_modules` to the canonical
#    checkout's real tree ON PURPOSE, so the deps are already present via the link.
#    `SymlinkInstallRefusal` (src/run-task.ts, `ensureInstallFresh`) guards rmd's OWN
#    install path, but a raw `npm ci`/`npm install` typed straight into a Bash tool
#    call executes npm directly and never reaches that in-process gate — this hook is
#    the only surface that sees it. The symlink test is the discriminator, and it is
#    what keeps this from crying wolf: a checkout whose `node_modules` is REAL or
#    ABSENT still installs normally (the legitimate case `ensureInstallFresh` itself
#    already carves out), and non-installing verbs (`npm run`, `npm test`, `npm ls`,
#    ...) never match the command pattern at all. `cwd` is read from the hook's own
#    JSON payload (`BaseHookInput.cwd`, present on every PreToolUse call — worker and
#    interactive lanes alike) rather than `$PWD`, since the hook process's own
#    directory is not guaranteed to track the session's.
if printf '%s' "$cmd" | grep -Eq '\b(npm|pnpm)[[:space:]]+(ci|install|i|add)\b|\byarn[[:space:]]+(install|add)\b'; then
  if [ -L "${hook_cwd:-.}/node_modules" ]; then
    deny "an install here empties the shared node_modules through the symlink for every live run (W1-T2312) — the deps are already linked, so just run typecheck/test; a genuinely newer dependency comes from refreshing the canonical checkout, not installing in this worktree"
  fi
fi

exit 0
