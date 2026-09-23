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

# 5) merge or arm a pull request from inside a worker. The worker authors and repairs a PR; the
#    orchestrator alone owns the merge decision after CI and semantic review. Before this rule,
#    rule 9 explicitly classified `gh pr merge` as a productive write and let it pass, so a worker
#    holding the ordinary GH_TOKEN could merge its own green PR without leaving the orchestrator's
#    automerge receipts. Cover the CLI command and its two common `gh api` equivalents. This stays
#    a tripwire, not a credential boundary: an indirectly assembled request can evade command-text
#    matching, exactly as the file header documents.
if printf '%s' "$cmd" | grep -Eq 'gh([[:space:]]+(-R|--repo)(=|[[:space:]])[^[:space:]]+)*[[:space:]]+pr[[:space:]]+merge([[:space:]]|$)'; then
  deny "a worker may author or repair a PR, but only the orchestrator may merge or arm it"
fi
if printf '%s' "$cmd" | grep -Eq 'gh[[:space:]]+api([[:space:]]|$)'; then
  if printf '%s' "$cmd" | grep -Eq '(-X|--method)(=|[[:space:]])PUT([[:space:]]|$)' &&
     printf '%s' "$cmd" | grep -Eq 'repos/[^[:space:]]+/pulls/[0-9]+/merge([?[:space:]]|$)'; then
    deny "gh api PUT to a pull-request merge endpoint"
  fi
  if printf '%s' "$cmd" | grep -Eq '(mergePullRequest|enablePullRequestAutoMerge)[[:space:]]*\('; then
    deny "gh api GraphQL mutation that merges or arms a pull request"
  fi
fi

# 6) operator's machine-specific protected paths (one glob/substring per line).
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

# 7) an inline polling loop against `gh` (W1-T1066 — THE NINETY-MINUTE LOCKOUT). A
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

# 8) a `git push` whose refspec names the shared cross-host pause namespace (W1-T2262 —
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

# 9) an installing package manager where THIS PROJECT'S `node_modules` is a symlink
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

# 11) A BRANCH SWITCH IN THE OPERATOR CHECKOUT (W1-T4082). The operator checkout (a repo whose `.git`
#    is a DIRECTORY, i.e. not a worktree, with the remudero origin) stays on `main`: `rmd`, `serve` and
#    other sessions read it as main. OBSERVED 2026-09-22: an interactive session left it on
#    run-W1-T4051-… and later run-W1-T4063-… while another session relied on it being main. Refused:
#    `git checkout <ref>` / `-b` / `-B` / `--orphan` and `git switch` to anything but main/master, and
#    `git branch -m|-M`. Allowed: returning to main, `git checkout -- <path>`, restoring an existing
#    path, pulls — and everything in a worktree. Resolve the target from `git -C <dir>`, the last
#    `cd <dir>` before it, or the hook's own cwd; then resolve the repository root so subdirectory
#    commands still identify the operator checkout.
case "$cmd" in *"git "*checkout*|*"git "*switch*|*"git "*branch*) op_scan=1 ;; *) op_scan=0 ;; esac
if [ "$op_scan" -eq 1 ]; then
  op_last_cd="${hook_cwd:-$PWD}"
  op_segments="$(printf '%s\n' "$cmd" | awk '{ gsub(/&&|\|\||;/, "\n"); print }')"
  while IFS= read -r op_seg; do
    op_seg="$(printf '%s' "$op_seg" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    case "$op_seg" in
      cd\ *) op_dir="${op_seg#cd }"; op_dir="${op_dir%% *}"; op_dir="${op_dir%\"}"; op_dir="${op_dir#\"}"
             case "$op_dir" in "~"*) op_dir="$HOME${op_dir#\~}" ;; /*) : ;; *) op_dir="$op_last_cd/$op_dir" ;; esac
             op_last_cd="$op_dir"; continue ;;
    esac
    case "$op_seg" in git\ *) : ;; *) continue ;; esac
    op_target="$op_last_cd"
    op_rest="${op_seg#git }"
    if [ "${op_rest#-C }" != "$op_rest" ]; then
      op_rest="${op_rest#-C }"
      case "$op_rest" in
        \"*) op_quoted="${op_rest#\"}"; op_target="${op_quoted%%\"*}"; op_rest="${op_quoted#*\"}"; op_rest="${op_rest# }" ;;
        \'*) op_quoted="${op_rest#\'}"; op_target="${op_quoted%%\'*}"; op_rest="${op_quoted#*\'}"; op_rest="${op_rest# }" ;;
        *) op_target="${op_rest%% *}"; op_rest="${op_rest#"$op_target"}"; op_rest="${op_rest# }" ;;
      esac
      case "$op_target" in
        "~"*) op_target="$HOME${op_target#\~}" ;;
        /*) : ;;
        *) op_target="$op_last_cd/$op_target" ;;
      esac
    fi
    op_verb="${op_rest%% *}"; op_args=""; [ "$op_rest" != "$op_verb" ] && op_args="${op_rest#* }"
    op_switch=0
    case "$op_verb" in
      checkout)
        case " $op_args " in *" -- "*) op_switch=0 ;;
          *" -b "*|*" -B "*|*" --orphan "*|*" --detach "*) op_switch=1 ;;
          *) op_ref=""; for op_a in $op_args; do case "$op_a" in -*) ;; *) op_ref="$op_a"; break ;; esac; done
             case "$op_ref" in ""|main|master|origin/main) op_switch=0 ;;
               *) if [ -e "$op_target/$op_ref" ]; then op_switch=0; else op_switch=1; fi ;; esac ;;
        esac ;;
      switch)
        case " $op_args " in *" -c "*|*" -C "*|*" --detach "*|*" --orphan "*) op_switch=1 ;;
          *) op_ref=""; for op_a in $op_args; do case "$op_a" in -*) ;; *) op_ref="$op_a"; break ;; esac; done
             case "$op_ref" in main|master) op_switch=0 ;; *) op_switch=1 ;; esac ;;
        esac ;;
      branch) case " $op_args " in *" -m "*|*" -M "*) op_switch=1 ;; esac ;;
    esac
    [ "$op_switch" -eq 1 ] || continue
    # Resolve from subdirectories too: git -C /repo/src and `cd /repo/src && git switch ...`
    # still act on the operator checkout. A linked worktree's .git is a FILE, not a directory.
    op_root="$(git -C "$op_target" rev-parse --show-toplevel 2>/dev/null || true)"
    [ -n "$op_root" ] || continue
    [ -d "$op_root/.git" ] || continue
    op_origin="$(git -C "$op_root" remote get-url origin 2>/dev/null || true)"
    case "$op_origin" in *"/remudero"|*"/remudero.git"|*":remudero"|*":remudero.git") : ;; *) continue ;; esac
    deny "a branch switch in the operator checkout ($op_root) — it stays on main (W1-T4082). Use a worktree: git worktree add ../wt-<name> -b <branch> origin/main"
  done <<EOF_OP
$op_segments
EOF_OP
fi

# 10) READ-SHAPED `gh` CALLS, TOO CLOSE TOGETHER (W1-T3275 — THE SECONDARY LIMIT COUNTS CADENCE).
#    Rule 6 refuses the SHAPE of a poll — loop keyword + wait + `gh`. That is not how the budget
#    gets burned. MEASURED 2026-09-09: a session tripped the secondary limit TWICE with no loop
#    anywhere, just separate status reads seconds apart, each legal alone. At the 403,
#    `gh api rate_limit` read core 5000/5000 — the ceiling was the SECONDARY limit, which counts
#    RATE, NOT VOLUME. CLAUDE.md has carried "CADENCE IS THE BUDGET, NOT INTENT" since the
#    ninety-minute lockout; prose did not bind it.
#
#    ORDINARY WRITES ARE NEVER PACED — creating or updating a PR is the productive path and is
#    self-limiting. Rule 5 above still REFUSES the one write workers do not own: merging or arming.
#    Only READS are paced, because a read is what a session repeats while waiting. `gh api
#    rate_limit` and `gh auth status` are exempt BY NAME: they cost no quota and are how a session
#    learns to stop.
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
      # Match src/lib/github-transport.ts exactly. RMD_GH_CACHE_HOME is the explicit host-wide
      # override; XDG/HOME remain the normal fallback for existing installs.
      gh_state_dir="${RMD_GH_CACHE_HOME:-${XDG_CACHE_HOME:-$HOME/.cache}}/remudero"
      # W1-T4085: AN APP-TOKEN-ROUTED READ GETS ITS OWN STAMP, NEVER THE SHARED ONE. This hook
      # cannot mint an installation token itself — the file header's own contract is "no network"
      # — so minting stays in src/lib/github-transport.ts's `routeInteractiveGhRead`, which hands
      # its caller an inline `GH_TOKEN=<minted token> gh …` to run. What THIS hook must still get
      # right is accounting: a call already carrying that inline assignment is spending the fleet
      # App's own separate secondary-limit budget, not the operator's, so pacing it against the
      # SAME `gh-last-read` stamp as every other interactive session would just rename which read
      # burns the shared window — the exact tax this task exists to stop paying. Detected the same
      # way rule 7's `RMD_GH_COOLDOWN_S=` override is: from the command TEXT, because an env-only
      # signal never reaches this spawned-fresh process. A command with no such prefix is entirely
      # unaffected and paces on the shared stamp exactly as it did before this task (design iii).
      gh_bucket=""
      if printf '%s' "$cmd" | grep -Eq '(^|[;&|]|[[:space:]])GH_TOKEN=[^[:space:]]+[[:space:]]+gh([[:space:]]|$)'; then
        gh_bucket="-app"
      fi
      gh_stamp="$gh_state_dir/gh-last-read${gh_bucket}"
      mkdir -p "$gh_state_dir" 2>/dev/null || true
      gh_now="$(date +%s 2>/dev/null || echo 0)"
      # Serialize the read/check/stamp section with the in-process transport. Without this two
      # workers can both see an old stamp and both spend the same secondary-limit slot. mkdir is
      # atomic; failure to acquire within one second is deliberately fail-open. A stale lock from
      # a killed hook is reclaimed after 30 seconds.
      gh_lock="$gh_stamp.lock"
      gh_lock_owned=0
      gh_lock_started="$gh_now"
      while ! mkdir "$gh_lock" 2>/dev/null; do
        gh_lock_mtime="$(stat -c %Y "$gh_lock" 2>/dev/null || true)"
        case "$gh_lock_mtime" in ''|*[!0-9]*) gh_lock_mtime="$(stat -f %m "$gh_lock" 2>/dev/null || true)" ;; esac
        case "$gh_lock_mtime" in ''|*[!0-9]*) gh_lock_mtime=0 ;; esac
        gh_now="$(date +%s 2>/dev/null || echo 0)"
        [ "$gh_now" -gt 0 ] 2>/dev/null || break
        if [ "$gh_lock_mtime" -gt 0 ] && [ "$gh_now" -gt 0 ] && [ $(( gh_now - gh_lock_mtime )) -gt 30 ]; then
          rmdir "$gh_lock" 2>/dev/null || true
          continue
        fi
        if [ "$gh_now" -gt 0 ] && [ "$gh_lock_started" -gt 0 ] && [ $(( gh_now - gh_lock_started )) -ge 1 ]; then
          break
        fi
        sleep 0.025
      done
      [ -d "$gh_lock" ] && gh_lock_owned=1
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
          [ "$gh_lock_owned" -eq 1 ] && rmdir "$gh_lock" 2>/dev/null || true
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
      [ "$gh_lock_owned" -eq 1 ] && rmdir "$gh_lock" 2>/dev/null || true
    fi
  fi
fi

exit 0
