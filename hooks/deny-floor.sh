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

# DOES THIS COMMAND ACTUALLY INVOKE `gh`? (W1-T3275)
#
# A bare substring test matches every command that merely MENTIONS the tool: a grep about this very
# rule was refused twice while it was being written, and a floor that refuses a grep about itself
# gets disabled the same afternoon. Requiring `gh` after a SEPARATOR was worse — it silently stopped
# rule 6 refusing `…; do gh pr view; sleep 20; done`, since `do` is not a separator, and that mutant
# passed every existing test. So: strip quoted text, then match `gh` that is not part of a longer
# word or a path. This is a TRIPWIRE, not a parser; an indirectly-named invocation escapes it, and
# that limit is asserted in test/gh-read-cadence-floor.test.ts rather than papered over.
invokes_gh() {
  # A COMMAND SUBSTITUTION INSIDE QUOTES IS STILL AN INVOCATION. W1-T1066's own recorded poll,
  # `until [ "$(gh run view …)" = completed ]; do sleep 20; done`, became ALLOWED under a
  # quotes-only strip. Substitution forms are matched on the RAW text first.
  if printf '%s' "$1" | grep -Eq '[$`]\([[:space:]]*gh[[:space:]]|`[[:space:]]*gh[[:space:]]'; then
    return 0
  fi
  printf '%s' "$1" \
    | sed -e "s/'[^']*'//g" -e 's/"[^"]*"//g' \
    | grep -Eq '(^|[^A-Za-z0-9_/.-])gh[[:space:]]'
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
    if invokes_gh "$cmd"; then
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

# 9) READ-SHAPED `gh` CALLS, TOO CLOSE TOGETHER (W1-T3275 — THE SECONDARY LIMIT COUNTS CADENCE).
#    Rule 6 refuses the SHAPE of a poll — loop keyword + wait + `gh`. That is not how the budget
#    gets burned. MEASURED 2026-09-09: a session tripped the secondary limit TWICE with no loop
#    anywhere, just separate status reads seconds apart, each legal alone. At the 403,
#    `gh api rate_limit` read core 5000/5000 — the ceiling was the SECONDARY limit, which counts
#    RATE, NOT VOLUME. CLAUDE.md has carried "CADENCE IS THE BUDGET, NOT INTENT" since the
#    ninety-minute lockout; prose did not bind it.
#
#    WRITES ARE NEVER REFUSED — creating a PR, posting a review, arming a merge is the productive
#    path and is self-limiting; a floor blocking it would be routed around inside a week. Only READS
#    are paced, because a read is what a session repeats while waiting. `gh api rate_limit` and
#    `gh auth status` are exempt BY NAME: they cost no quota and are how a session learns to stop.
if [ -n "$cmd" ] && invokes_gh "$cmd"; then
  gh_is_write=0
  printf '%s' "$cmd" | grep -Eq '(-X|--method)[[:space:]]+(POST|PATCH|PUT|DELETE)' && gh_is_write=1
  printf '%s' "$cmd" | grep -Eq 'gh[[:space:]]+(pr|issue)[[:space:]]+(create|merge|edit|close|reopen|comment|review|ready|lock|unlock)' && gh_is_write=1
  printf '%s' "$cmd" | grep -Eq 'gh[[:space:]]+(run[[:space:]]+(rerun|cancel|delete)|workflow[[:space:]]+(run|enable|disable)|release[[:space:]]+(create|edit|delete)|label[[:space:]]+(create|edit|delete)|secret[[:space:]]+set)' && gh_is_write=1

  gh_is_exempt=0
  printf '%s' "$cmd" | grep -Eq 'gh[[:space:]]+api[[:space:]]+rate_limit|gh[[:space:]]+auth[[:space:]]+status' && gh_is_exempt=1

  if [ "$gh_is_write" -eq 0 ] && [ "$gh_is_exempt" -eq 0 ]; then
    # FAIL OPEN THROUGHOUT. A cadence floor that errors must never block work, so every failure
    # path below falls through to allowing the call.
    # THE OVERRIDE COMES FROM THE COMMAND, NOT THIS PROCESS'S ENV. A PreToolUse hook is spawned by
    # the harness, so an inline `RMD_GH_COOLDOWN_S=0 gh …` never reaches this process's env — an
    # env-only override would be a documented escape hatch that silently does nothing. Reading it
    # from `$cmd` also keeps it visible to a reviewer. The env form still works session-wide.
    gh_window="${RMD_GH_COOLDOWN_S-180}"
    gh_inline="$(printf '%s' "$cmd" | sed -n 's/.*RMD_GH_COOLDOWN_S=\([0-9][0-9]*\).*/\1/p' | head -1)"
    [ -n "$gh_inline" ] && gh_window="$gh_inline"
    case "$gh_window" in ''|*[!0-9]*) gh_window=180 ;; esac
    if [ "$gh_window" -gt 0 ] 2>/dev/null; then
      gh_state_dir="${XDG_CACHE_HOME:-$HOME/.cache}/remudero"
      gh_stamp="$gh_state_dir/gh-last-read"
      mkdir -p "$gh_state_dir" 2>/dev/null || true
      gh_now="$(date +%s 2>/dev/null || echo 0)"
      gh_prev=0
      if [ -f "$gh_stamp" ]; then
        # `stat` is not portable, and CHAINING ON EXIT STATUS DOES NOT WORK HERE — that is what made
        # this floor inert on the host it runs on. GNU/Linux `stat -f` is VALID: it means
        # --file-system, so it SUCCEEDS and prints "  File: ..." instead of failing through to -c.
        # The non-numeric result was then sanitised to 0 below, gh_prev > 0 was false, and no read
        # was ever refused on Linux. MEASURED via `bash -x`: gh_prev='  File: "…/gh-last-read"'.
        # So SELECT ON THE SHAPE OF THE OUTPUT, not on exit status: take the first form that yields
        # digits. Order no longer matters, and a future platform that succeeds with prose is caught.
        gh_prev="$(stat -c %Y "$gh_stamp" 2>/dev/null || true)"
        case "$gh_prev" in ''|*[!0-9]*) gh_prev="$(stat -f %m "$gh_stamp" 2>/dev/null || true)" ;; esac
      fi
      case "$gh_prev" in ''|*[!0-9]*) gh_prev=0 ;; esac
      if [ "$gh_now" -gt 0 ] && [ "$gh_prev" -gt 0 ]; then
        gh_age=$(( gh_now - gh_prev ))
        if [ "$gh_age" -lt "$gh_window" ]; then
          printf 'deny-floor: blocked - a read-shaped `gh` call %ss after the last one (floor %ss, W1-T3275).\n' "$gh_age" "$gh_window" >&2
          printf '  The SECONDARY rate limit counts CADENCE, not volume: a run of cheap reads trips it while\n' >&2
          printf '  `gh api rate_limit` still reads 5000/5000. Report what you already know and stop -- a wait\n' >&2
          printf '  is the operator to schedule. Writes (create/merge/review/POST) are never refused, and\n' >&2
          printf '  `gh api rate_limit` is exempt. Deliberate burst: RMD_GH_COOLDOWN_S=0, a choice on the record.\n' >&2
          exit 2
        fi
      fi
      # Stamped only on an ALLOWED read, so a refusal never extends its own window.
      : > "$gh_stamp" 2>/dev/null || true
    fi
  fi
fi

exit 0
