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

# W1-T5016: settings/worker.json passes `--confine-file-tools`; the interactive lane's
# .claude/settings.json does not, so rule 14 below binds workers only.
confine_file_tools=0
case "${1:-}" in --confine-file-tools) confine_file_tools=1 ;; esac

# Pull the fields we police out of the tool-call JSON. Bash carries `command`;
# Write/Edit/Read carry `file_path`. Fall back to raw input if jq is absent.
if command -v jq >/dev/null 2>&1; then
  have_jq=1
  cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // ""')"
  path="$(printf '%s' "$input" | jq -r '.tool_input.file_path // ""')"
  hook_cwd="$(printf '%s' "$input" | jq -r '.cwd // ""')"
else
  have_jq=0
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

# 1) a push whose DESTINATION is a default branch (main/master), judged per command SEGMENT (W1-T4588)
#    by its PARSED refspecs (W1-T5352), never by substrings. Two loose greps -- a force flag anywhere
#    in the segment AND `main` anywhere in it -- refused a forced push of `run-fix-main-gate-1` and let
#    `+HEAD:main`, `--force-with-lease origin main`, `-fu`, `:main` and `--delete main` through.
#    `push_refusal` finds `git [-C x|-c k=v|--git-dir x|--work-tree x]* push`, then walks its words:
#    force = --force | --force-with-lease[=..] | --force-if-includes | a short cluster holding `f` | a
#    `+refspec`; delete = --delete | a cluster holding `d` | a `:dst` refspec; --mirror/--all/--branches
#    = every branch, forced. The first positional word is the remote, every later one a refspec, and its
#    destination is the text after the last `:` minus `+` and `refs/heads/`. Only a destination of
#    EXACTLY main or master is refused -- a run branch merely NAMED like main passes. A bare `HEAD` and a
#    push with no refspec stay allowed: the hook cannot know the upstream. Quoted text holding a space
#    or separator is blanked first (a commit message that says "git push origin main" is not a push);
#    a quoted single word is unquoted. Still a tripwire: a refspec assembled indirectly (`"$ref"`)
#    escapes it, as the file header says. It FAILS CLOSED: if the split or the parse errors, the push
#    is refused as unparseable rather than waved through.
push_refusal() {
  local words n i w k c sub rest dst force=0 del=0 every=0 hit=0 hit_del=0 remote_seen=0 endopts=0
  IFS=$' \t' read -r -a words <<< "$1"
  n=${#words[@]}
  i=0
  while [ "$i" -lt "$n" ]; do
    w="${words[$i]}"
    i=$((i + 1))
    case "$w" in git|*/git|*'('git|*'`'git) ;; *) continue ;; esac
    sub=""
    while [ "$i" -lt "$n" ]; do
      w="${words[$i]}"
      i=$((i + 1))
      case "$w" in
        -C|-c|--git-dir|--work-tree|--namespace|--config-env|--super-prefix) i=$((i + 1)) ;;
        -*) ;;
        *) sub="$w"; break ;;
      esac
    done
    [ "$sub" = push ] || continue
    force=0 del=0 every=0 hit=0 hit_del=0 remote_seen=0 endopts=0
    while [ "$i" -lt "$n" ]; do
      w="${words[$i]}"
      i=$((i + 1))
      case "$w" in '#'*|'&') break ;; esac
      if [ "$endopts" -eq 0 ]; then
        case "$w" in
          --) endopts=1; continue ;;
          --force|--force-with-lease|--force-with-lease=*|--force-if-includes) force=1; continue ;;
          --delete) del=1; continue ;;
          --mirror|--all|--branches) every=1; continue ;;
          --repo|--push-option|--receive-pack|--exec|--recurse-submodules) i=$((i + 1)); continue ;;
          --*) continue ;;
          -?*)
            k=1
            while [ "$k" -lt "${#w}" ]; do
              c="${w:$k:1}"
              k=$((k + 1))
              case "$c" in
                f) force=1 ;;
                d) del=1 ;;
                o) [ "$k" -ge "${#w}" ] && i=$((i + 1)); break ;;
              esac
            done
            continue ;;
        esac
      fi
      case "$w" in
        '>'|'>>'|'<'|[0-9]'>'|[0-9]'>>'|[0-9]'<'|'&>'|'&>>') i=$((i + 1)); continue ;;
        '>'*|'<'*|[0-9]'>'*|[0-9]'<'*|'&>'*) continue ;;
      esac
      while :; do
        case "$w" in *')'|*'`'|*'&') w="${w%?}" ;; *) break ;; esac
      done
      if [ "$remote_seen" -eq 0 ]; then
        remote_seen=1
        continue
      fi
      case "$w" in '+'*) force=1; w="${w#+}" ;; esac
      if [ "$w" = ":" ]; then
        every=1
        continue
      fi
      dst="${w##*:}"
      dst="${dst#refs/heads/}"
      case "$dst" in
        main|master)
          hit=1
          case "$w" in :*) hit_del=1 ;; esac ;;
      esac
    done
    if [ "$every" -eq 1 ]; then
      printf '%s\n' "git push --force to a default branch"
      return 0
    fi
    if [ "$hit" -eq 1 ]; then
      if [ "$del" -eq 1 ] || [ "$hit_del" -eq 1 ]; then
        printf '%s\n' "deleting a default branch"
      elif [ "$force" -eq 1 ]; then
        printf '%s\n' "git push --force to a default branch"
      else
        printf '%s\n' "a push to a default branch — open a PR"
      fi
      return 0
    fi
  done
  return 0
}
case "$cmd" in
  *push*)
    r1_text="$(printf '%s\n' "$cmd" | awk '
      BEGIN { RS = "\001"; qre = "[\"\047]" }
      {
        rest = $0; out = ""
        while ((p = match(rest, qre)) > 0) {
          out = out substr(rest, 1, p - 1); qc = substr(rest, p, 1); rest = substr(rest, p + 1)
          e = index(rest, qc)
          if (e == 0) { out = out "QSTR"; rest = ""; break }
          inner = substr(rest, 1, e - 1); rest = substr(rest, e + 1)
          if (inner ~ /[ \t\n;&|]/) out = out "QSTR"; else out = out inner
        }
        out = out rest
        gsub(/&&|\|\||;|\|/, "\n", out)
        printf "%s\n", out
      }')" || deny "an unparseable git push — rule 1 fails closed"
    while IFS= read -r seg; do
      case "$seg" in *git*push*) ;; *) continue ;; esac
      r1_reason="$(push_refusal "$seg")" || deny "an unparseable git push — rule 1 fails closed"
      if [ -n "$r1_reason" ]; then
        deny "$r1_reason"
      fi
    done <<< "$r1_text"
    ;;
esac

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

# 12) ONE FULL TEST SUITE AT A TIME PER WORKTREE (W1-T4106). MEASURED 2026-09-23: a fix-rung worker
#    backgrounded four `node --experimental-test-coverage ... --test` parents at once — ~28 test
#    processes on a 15.6 GiB host — and the swap storm took the console down. Node refuses
#    --test-concurrency in NODE_OPTIONS, so only this floor sees it. A FULL run is a `node ... --test`
#    with no --test-name-pattern and not exactly one test file; those two shapes stay allowed.
#    Refused: two full runs overlapping in one command (`&` without a `wait`), a loop that
#    backgrounds a run, `xargs -P`/`parallel` driving one, and a full run while another is live with
#    its /proc/<pid>/cwd under this hook's cwd. No /proc (macOS) means no live check — never a refusal.
tr_kind="" tr_par=0
tr_classify() {  # one simple command -> tr_kind=none|scoped|full, tr_par=1 under xargs -P / parallel
  local node=0 test=0 skip=0 scoped=0 npos=0 last="" xargs=0 want_p=0 tok
  tr_kind=none tr_par=0
  set -f
  for tok in $1; do
    if [ "$want_p" -eq 1 ]; then want_p=0; [ "$tok" = 1 ] || tr_par=1; continue; fi
    if [ "$node" -eq 0 ]; then
      case "$tok" in
        node|*/node) node=1 ;;
        xargs|*/xargs) xargs=1 ;;
        parallel|*/parallel) tr_par=1 ;;
        -P) [ "$xargs" -eq 1 ] && want_p=1 ;;
        -P*|--max-procs=*) [ "$xargs" -eq 1 ] && case "$tok" in -P1|--max-procs=1) ;; *) tr_par=1 ;; esac ;;
      esac
      continue
    fi
    if [ "$skip" -eq 1 ]; then skip=0; continue; fi
    case "$tok" in
      --test) test=1 ;;
      --test-name-pattern) scoped=1; skip=1 ;;
      --test-name-pattern=*) scoped=1 ;;
      --import|--require|-r|--loader|--experimental-loader|--test-reporter|--test-reporter-destination|\
      --test-skip-pattern|--test-concurrency|--test-shard|--test-coverage-include|--test-coverage-exclude|\
      --test-timeout|--env-file|--conditions|-C) skip=1 ;;
      -*) ;;
      *\>|*\<) skip=1 ;;
      *\>*|*\<*) ;;
      *) npos=$((npos + 1)); last="$tok" ;;
    esac
  done
  set +f
  [ "$test" -eq 1 ] || return 0
  tr_kind=full
  [ "$scoped" -eq 1 ] && tr_kind=scoped
  if [ "$npos" -eq 1 ]; then
    case "$last" in *\**) ;; *.ts|*.js|*.mjs|*.cjs|*.mts|*.cts) tr_kind=scoped ;; esac
  fi
  return 0
}
case "$cmd" in *node*--test*) tr_scan=1 ;; *) tr_scan=0 ;; esac
if [ "$tr_scan" -eq 1 ]; then
  tr_route="run suites one after another, or scope this run to one file or --test-name-pattern; for CI-shaped coverage use \`rmd preflight --coverage\`, which runs the shards sequentially"
  tr_loop=0
  printf '%s' "$cmd" | grep -Eq '(^|[^A-Za-z0-9_])(for|while|until)[[:space:]]' && tr_loop=1
  # Quotes dropped so `eval '...'`/`bash -c "..."` bodies are seen; `2>&1`/`&>` are not a background `&`.
  tr_segments="$(printf '%s\n' "$cmd" | tr -d "'\"()" | sed -e 's/>&/>/g' -e 's/&>/>/g' \
    | awk '{ gsub(/&&|\|\||;|\|/, "\n"); gsub(/&/, "&\n"); print }')"
  tr_full=0 tr_bg_full=0
  while IFS= read -r tr_seg; do
    tr_bg=0
    case "$tr_seg" in *\&) tr_bg=1; tr_seg="${tr_seg%&}" ;; esac
    case " $tr_seg " in *" wait "*) tr_bg_full=0 ;; esac
    tr_classify "$tr_seg"
    [ "$tr_kind" = none ] && continue
    if [ "$tr_par" -eq 1 ] || { [ "$tr_bg" -eq 1 ] && [ "$tr_loop" -eq 1 ]; } || \
       { [ "$tr_kind" = full ] && [ "$tr_bg_full" -eq 1 ]; }; then
      deny "one command starting more than one \`node --test\` run at once (W1-T4106) — parallel suites swap-thrashed the fleet host; $tr_route"
    fi
    if [ "$tr_kind" = full ]; then
      tr_full=$((tr_full + 1))
      [ "$tr_bg" -eq 1 ] && tr_bg_full=1
    fi
  done <<EOF_TR
$tr_segments
EOF_TR
  tr_proc="${RMD_DENY_FLOOR_PROC_ROOT:-/proc}"
  tr_cwd="${hook_cwd%/}"
  if [ "$tr_full" -gt 0 ] && [ -n "$tr_cwd" ] && [ -d "$tr_proc" ]; then
    for tr_f in $(grep -alF -e '--test' "$tr_proc"/[0-9]*/cmdline 2>/dev/null || true); do
      tr_pid_dir="${tr_f%/cmdline}"
      # Only a process whose executable IS node: a shell whose command text merely names
      # `node --test` (measured on the fleet: an ssh `bash -c` wrapper) is not a live run.
      tr_argv0=""; IFS= read -r -d '' tr_argv0 < "$tr_f" 2>/dev/null || true
      case "${tr_argv0##*/}" in node|nodejs) : ;; *) continue ;; esac
      tr_pcwd="$(readlink "$tr_pid_dir/cwd" 2>/dev/null || true)"
      case "$tr_pcwd/" in "$tr_cwd"/*) : ;; *) continue ;; esac
      tr_classify "$(tr '\0' ' ' < "$tr_f" 2>/dev/null || true)"
      [ "$tr_kind" = full ] || continue
      deny "a full \`node --test\` run is already live in this worktree (pid ${tr_pid_dir##*/}, W1-T4106) — a second one beside it swap-thrashes the host; wait for it to finish, or $tr_route"
    done
  fi
fi

# 13) A HAND-RUN COVERAGE SUITE WITHOUT CI'S `--enable-source-maps` (W1-T4915). MEASURED 2026-09-30: 6
#    of 41 diff-coverage runs in one session ran `node --experimental-test-coverage ...` by hand with no
#    `--enable-source-maps`, got `DA:` lines located against the tsx-transpiled JS, and read every changed
#    line as uncovered; the 35 that had read the flag or `npm run diff-coverage:local` never did. Judged
#    per command segment at the PROGRAM position (through env assignments, `timeout <n>`, `time`, `env`,
#    `nice`), so a grep, pgrep, echo, commit message or heredoc body that only NAMES the flag is never
#    refused. `npm run` and `node scripts/diff-coverage-local.mjs` never carry the flag themselves.
cov_segments() {  # stdin: a command -> one simple command per line; heredoc bodies and comments dropped
  awk '
    function flush() { print seg; seg = "" }
    BEGIN { q = ""; seg = ""; hd = 0 }
    {
      if (hd) { line = $0; if (hdtab) sub(/^\t+/, "", line); if (line == hdword) hd = 0; next }
      n = length($0); cont = 0; pend = 0
      for (i = 1; i <= n; i++) {
        c = substr($0, i, 1)
        if (q == "\047") { if (c == "\047") q = ""; seg = seg c; continue }
        if (c == "\\") { if (i == n) { cont = 1; seg = seg " " } else { seg = seg c substr($0, i + 1, 1) }; i++; continue }
        if (q == "\"") { if (c == "\"") q = ""; seg = seg c; continue }
        if (c == "\047" || c == "\"") { q = c; seg = seg c; continue }
        if (c == "#" && (seg == "" || seg ~ /[ \t]$/)) break
        if (c == "<" && substr($0, i, 2) == "<<" && substr($0, i, 3) != "<<<") {
          j = i + 2; tab = 0
          if (substr($0, j, 1) == "-") { tab = 1; j++ }
          while (substr($0, j, 1) == " ") j++
          d = substr($0, j, 1)
          if (d ~ /[A-Za-z_\047"\\]/) {
            while (substr($0, j, 1) ~ /[\047"\\]/) j++
            w = ""
            while (j <= n && substr($0, j, 1) !~ /[\047" \t;&|()<>\\]/) { w = w substr($0, j, 1); j++ }
            hdword = w; hdtab = tab; pend = 1; i = j - 1; continue
          }
        }
        if (c == ";" || c == "&" || c == "|" || c == "(" || c == ")" || c == "`") { flush(); continue }
        seg = seg c
      }
      if (q != "") seg = seg " "
      else if (!cont) flush()
      if (pend) hd = 1
    }
    END { flush() }'
}
case "$cmd" in *--experimental-test-coverage*) cov_scan=1 ;; *) cov_scan=0 ;; esac
if [ "$cov_scan" -eq 1 ]; then
  cov_sm=0
  while IFS= read -r cov_seg; do
    case "$cov_seg" in *NODE_OPTIONS=*--enable-source-maps*) cov_sm=1 ;; esac
    cov_state=pre cov_skip=0 cov_dur=0 cov_flag=0
    set -f
    for cov_tok in $cov_seg; do
      if [ "$cov_state" = pre ]; then
        if [ "$cov_skip" -gt 0 ]; then cov_skip=$((cov_skip - 1)); continue; fi
        if [ "$cov_dur" -eq 1 ]; then
          case "$cov_tok" in -k|-s|--signal|--kill-after) cov_skip=1; continue ;; -*) continue ;; esac
          cov_dur=0; continue
        fi
        case "$cov_tok" in
          [A-Za-z_]*=*|do|then|else|elif|if|while|until|"!"|"{"|time|nohup|exec|command|env|nice) continue ;;
          timeout) cov_dur=1 ;;
          -n|-u|-C|-S) cov_skip=1 ;;
          -*) ;;
          node|*/node|nodejs) cov_state=node ;;
          *) break ;;
        esac
      elif [ "$cov_tok" = "--experimental-test-coverage" ]; then
        cov_flag=1
      fi
    done
    set +f
    [ "$cov_state" = node ] && [ "$cov_flag" -eq 1 ] || continue
    case "$cov_seg" in *--enable-source-maps*) continue ;; esac
    [ "$cov_sm" -eq 1 ] && continue
    deny "a coverage run without --enable-source-maps (W1-T4915) — its \`DA:\` lines are located against the tsx-transpiled JS, so every changed line reads uncovered. Run \`npm run diff-coverage:local -- <test files>\`, which spawns CI's own invocation (flags read out of ci.yml)"
  done < <(printf '%s\n' "$cmd" | cov_segments)
fi

# 15) A HAND-RUN `node --test` WITHOUT THE SETUP PRELOAD (W1-T6030). MEASURED 2026-10-06: without
#    `--import ./test/setup/tmp-hygiene.ts` a suite has no gh refusal stub, live push URLs, the shell's real
#    GH_TOKEN and no gc-disable; run-task failed 8/324 and git-fixture-gc-hygiene 3/6 as ordinary reds.
#    Every scripted run passes the preload; a hand-typed one had no check. Parsed like rule 13 (segments,
#    program position). Refused: a `node ... --test` naming a test/ path or glob with no `--import X` or
#    `--import=X` (nor NODE_OPTIONS) ending in test/setup/tmp-hygiene.ts — only where that file exists in
#    the payload cwd or a leading `cd <dir>` target, so other repos are never refused. One -f per run.
pl_has_preload() { case "$1" in *test/setup/tmp-hygiene.ts) return 0 ;; esac; return 1; }
case "$cmd" in *node*--test*) pl_scan=1 ;; *) pl_scan=0 ;; esac
if [ "$pl_scan" -eq 1 ]; then
  pl_dir="${hook_cwd%/}" pl_env=0
  while IFS= read -r pl_seg; do
    case "$pl_seg" in *NODE_OPTIONS=*test/setup/tmp-hygiene.ts*) pl_env=1 ;; esac
    pl_state=pre pl_skip=0 pl_dur=0 pl_test=0 pl_names=0 pl_pre=0 pl_val=0 pl_cd=0
    set -f
    for pl_tok in $pl_seg; do
      pl_t="${pl_tok//[\"\']/}"
      if [ "$pl_state" = pre ]; then
        if [ "$pl_skip" -gt 0 ]; then pl_skip=$((pl_skip - 1)); continue; fi
        if [ "$pl_dur" -eq 1 ]; then
          case "$pl_t" in -k|-s|--signal|--kill-after) pl_skip=1; continue ;; -*) continue ;; esac
          pl_dur=0; continue
        fi
        case "$pl_t" in
          [A-Za-z_]*=*|do|then|else|elif|if|while|until|"!"|"{"|time|nohup|exec|command|env|nice) continue ;;
          timeout) pl_dur=1 ;;
          -n|-u|-C|-S) pl_skip=1 ;;
          -*) ;;
          cd) pl_state=cd ;;
          node|*/node|nodejs) pl_state=node ;;
          *) break ;;
        esac
      elif [ "$pl_state" = cd ]; then
        case "$pl_t" in -L|-P|-e|-@) continue ;; esac
        pl_cd=1
        case "$pl_t" in
          /*) pl_dir="$pl_t" ;;
          "~") pl_dir="$HOME" ;;
          "~/"*) pl_dir="$HOME/${pl_t#\~/}" ;;
          -) pl_dir="" ;;
          *) [ -n "$pl_dir" ] && pl_dir="$pl_dir/$pl_t" ;;
        esac
        break
      elif [ "$pl_val" -eq 1 ]; then
        pl_val=0; pl_has_preload "$pl_t" && pl_pre=1
      elif [ "$pl_skip" -gt 0 ]; then
        pl_skip=0
      else
        case "$pl_t" in
          -e|--eval|-p|--print|--eval=*|--print=*) pl_state=none; break ;;
          --test) pl_test=1 ;;
          --import) pl_val=1 ;;
          --import=*) pl_has_preload "${pl_t#--import=}" && pl_pre=1 ;;
          --require|-r|--loader|--experimental-loader|--test-reporter|--test-reporter-destination|\
          --test-name-pattern|--test-skip-pattern|--test-concurrency|--test-shard|--test-timeout|\
          --test-coverage-include|--test-coverage-exclude|--env-file|--conditions|-C) pl_skip=1 ;;
          -*) ;;
          *\>*|*\<*) ;;
          test/*|./test/*|*/test/*) pl_names=1 ;;
        esac
      fi
    done
    set +f
    [ "$pl_state" = cd ] && [ "$pl_cd" -eq 0 ] && pl_dir="$HOME"
    [ "$pl_state" = node ] && [ "$pl_test" -eq 1 ] && [ "$pl_names" -eq 1 ] || continue
    [ "$pl_pre" -eq 1 ] || [ "$pl_env" -eq 1 ] && continue
    [ -n "$pl_dir" ] && [ -f "$pl_dir/test/setup/tmp-hygiene.ts" ] || continue
    deny "a hand-run \`node --test\` without the setup preload (W1-T6030) — it runs uncontained (no gh refusal stub, live push URLs, the shell's real GH_TOKEN, no gc-disable) and its reds are not regressions. Add \`--import ./test/setup/tmp-hygiene.ts\` after \`--import tsx\`: node --test --import tsx --import ./test/setup/tmp-hygiene.ts <files>"
  done < <(printf '%s\n' "$cmd" | cov_segments)
fi

# 14) WORKER FILE TOOLS STAY IN THE ASSIGNED WORKTREE (W1-T5016). OBSERVED at c94c2bf49: workers run
#    under bypassPermissions, this hook read `file_path` and `cwd` and never compared them, and the worker
#    matcher omitted Read — a scratch-hook test allowed an Edit in a sibling checkout. Worker-lane only
#    (`--confine-file-tools`, passed by settings/worker.json). The assigned worktree is CLAUDE_PROJECT_DIR
#    (the CLI sets it on every hook to the session's launch dir, i.e. spawnWorker's cwd), else the payload
#    cwd. Both sides are canonicalized physically — every symlink on the way, dangling ones included —
#    before they are compared. Allowed: the worktree; READS through its own node_modules link (writes
#    there would land in the shared tree, W1-T2312); the scratch root ${TMPDIR:-/tmp}; a `worker-home*`
#    HOME; and this session's own ~/.claude/projects/<sanitized project dir>, where the CLI persists large
#    tool output. FAIL CLOSED on no path, no worktree, a `..` component, an unresolvable path, or no jq.
#    Bash is NOT confined here: the OS sandbox is that boundary.
#    W1-T5354: Grep (content mode returns file bodies) and Glob are judged the same way, with the node_modules
#    read allowance. Their `path` is the target; ABSENT means the session cwd, never a refusal. An absolute Glob
#    `pattern` is judged by its literal prefix up to the last `/` before its first metacharacter, and a `..`
#    anywhere in a pattern is refused. Codex's own edit tool reaches this hook as `apply_patch` (captured from
#    codex-cli 0.159.0, routed by the `Edit`/`Write` aliases too), with the patch in `command`: every
#    Add/Update/Delete File and Move to header is a write target, and a patch naming none fails closed.
ft_canon() {  # absolute path -> physical path, resolving every symlink component (dangling included)
  local rest="${1#/}" out="" comp link hops=0
  while [ -n "$rest" ]; do
    comp="${rest%%/*}"
    if [ "$comp" = "$rest" ]; then rest=""; else rest="${rest#*/}"; fi
    case "$comp" in ''|.) continue ;; ..) out="${out%/*}"; continue ;; esac
    if [ -L "$out/$comp" ]; then
      hops=$((hops + 1)); [ "$hops" -le 40 ] || return 1
      link="$(readlink "$out/$comp")" || return 1
      case "$link" in /*) out=""; rest="${link#/}${rest:+/$rest}" ;; *) rest="$link${rest:+/$rest}" ;; esac
    else
      out="$out/$comp"
    fi
  done
  printf '%s\n' "${out:-/}"
}
ft_under() {  # is physical path $1 at or below physical root $2?
  [ -n "$2" ] || return 1
  [ "$2" = "/" ] && return 0
  case "$1/" in "$2"/*) return 0 ;; esac
  return 1
}
ft_check() {  # deny unless tool $1's target $2 is inside the worktree or an allowed root
  local tool="$1" target="$2" real ok=0 nm tmp home proj slug
  case "$target" in '~'*) deny "$tool of a \`~\` path ($target) — name it by its absolute path inside the assigned worktree (W1-T5016, W1-T5354)" ;; esac
  case "$target" in
    /*) : ;;
    *) case "$hook_cwd" in /*) target="$hook_cwd/$target" ;; *) deny "$tool of a relative path with no cwd (W1-T5016)" ;; esac ;;
  esac
  case "/$target/" in */../*) deny "$tool of a path with a \`..\` component ($target) — name the file by its absolute path inside the assigned worktree (W1-T5016)" ;; esac
  real="$(ft_canon "$target")" || deny "$tool target does not resolve ($target, W1-T5016)"
  ft_under "$real" "$ft_root" && ok=1
  if [ "$ok" -eq 0 ] && [ -L "$ft_root/node_modules" ]; then
    case "$tool" in Read|Grep|Glob) nm="$(ft_canon "$ft_root/node_modules")" && ft_under "$real" "$nm" && ok=1 ;; esac
  fi
  if [ "$ok" -eq 0 ]; then
    tmp="$(ft_canon "${TMPDIR:-/tmp}")" && ft_under "$real" "$tmp" && ok=1
  fi
  if [ "$ok" -eq 0 ] && [ -n "${HOME:-}" ]; then
    case "${HOME%/}" in
      */worker-home*) home="$(ft_canon "$HOME")" && ft_under "$real" "$home" && ok=1 ;;
    esac
    for slug in "${ft_anchor//[^A-Za-z0-9]/-}" "${ft_root//[^A-Za-z0-9]/-}"; do
      [ "$ok" -eq 1 ] && break
      proj="$(ft_canon "$HOME/.claude/projects/$slug")" && ft_under "$real" "$proj" && ok=1
    done
  fi
  [ "$ok" -eq 1 ] || deny "$tool outside the assigned worktree ($target resolves to $real; worktree $ft_root, W1-T5016, W1-T5354) — file tools stay inside the worktree, and scratch goes under ${TMPDIR:-/tmp}"
}
if [ "$confine_file_tools" -eq 1 ]; then
  if [ "$have_jq" -eq 0 ]; then
    if printf '%s' "$input" | grep -Eq '"tool_name"[[:space:]]*:[[:space:]]*"(Read|Write|Edit|MultiEdit|NotebookEdit|Grep|Glob|apply_patch)"'; then
      deny "a file tool with no jq to read its target — confinement fails closed (W1-T5016)"
    fi
  else
    ft_tool="$(printf '%s' "$input" | jq -r '.tool_name // ""')"
    case "$ft_tool" in
      Read|Write|Edit|MultiEdit|NotebookEdit|Grep|Glob|apply_patch)
        ft_target="$path"
        [ "$ft_tool" = NotebookEdit ] && ft_target="$(printf '%s' "$input" | jq -r '.tool_input.notebook_path // ""')"
        case "$ft_tool" in
          Grep|Glob|apply_patch) : ;;
          *) [ -n "$ft_target" ] || deny "$ft_tool names no path, so it cannot be checked against the assigned worktree (W1-T5016)" ;;
        esac
        ft_anchor="${CLAUDE_PROJECT_DIR:-$hook_cwd}"
        case "$ft_anchor" in /*) : ;; *) deny "$ft_tool with no absolute assigned worktree to compare against (W1-T5016)" ;; esac
        ft_root="$(ft_canon "$ft_anchor")" || deny "the assigned worktree does not resolve (W1-T5016)"
        [ -d "$ft_root" ] || deny "the assigned worktree ($ft_anchor) is not a directory (W1-T5016)"
        case "$ft_tool" in
          Grep|Glob)
            ft_target="$(printf '%s' "$input" | jq -r '.tool_input.path // ""')"
            [ -n "$ft_target" ] || ft_target="${hook_cwd:-$ft_anchor}"
            ft_check "$ft_tool" "$ft_target"
            if [ "$ft_tool" = Glob ]; then
              ft_pat="$(printf '%s' "$input" | jq -r '.tool_input.pattern // ""')"
              case "/$ft_pat/" in */../*) deny "Glob pattern with a \`..\` component ($ft_pat) climbs out of its path (W1-T5354)" ;; esac
              case "$ft_pat" in
                /*) ft_pre="${ft_pat%%[*?[{]*}"; ft_pre="${ft_pre%/*}"; ft_check Glob "${ft_pre:-/}" ;;
              esac
            fi
            ;;
          apply_patch)
            ft_n=0
            while IFS= read -r ft_line; do
              ft_line="${ft_line#"${ft_line%%[![:space:]]*}"}"
              ft_line="${ft_line%"${ft_line##*[![:space:]]}"}"
              case "$ft_line" in
                '*** Add File: '* | '*** Update File: '* | '*** Delete File: '*) ft_target="${ft_line#*File: }" ;;
                '*** Move to: '*) ft_target="${ft_line#*Move to: }" ;;
                *) continue ;;
              esac
              ft_target="${ft_target#"${ft_target%%[![:space:]]*}"}"
              [ -n "$ft_target" ] || deny "apply_patch with an empty file header (W1-T5354)"
              ft_check apply_patch "$ft_target"
              ft_n=$((ft_n + 1))
            done < <(printf '%s\n' "$cmd")
            [ "$ft_n" -gt 0 ] || deny "apply_patch names no file, so it cannot be checked against the assigned worktree (W1-T5354)"
            ;;
          *) ft_check "$ft_tool" "$ft_target" ;;
        esac
        ;;
    esac
  fi
fi

# 16) HOUSE RULES THE PROMPTS DID NOT HOLD (operator ruling 2026-10-10: in one day sessions ran `git stash`
#    twice, `--no-verify` once and `pkill -f` over `ssh remudero` once). Refused, naming rule and alternative:
#    stash: `git stash` in any form but the read-only `list`/`show`. no-verify: `--no-verify` on commit, push
#    or merge, `git commit -n`, and any core.hooksPath override (`-c`, `--config-env`, `GIT_CONFIG_*`, or
#    `git config` setting it to anything but `hooks`, unsetting it, or removing `core`); `git push -n` is
#    --dry-run and passes. host: kill/pkill/killall (not `kill -0`/`-l`), docker restart/stop/kill/rm/rmi/
#    down/prune/pause, systemctl restart/stop/kill, rm -r/-f and `git worktree prune` sent to `ssh remudero`,
#    also via `sh -c`, `docker exec`, a heredoc, a here-string or a pipe into it. Read-only queries pass.
#    Judged at the PROGRAM position of each quote-aware simple command, so text that only NAMES a shape (a
#    grep, an echo, a commit message) runs. Bash tool only; inert without jq; a tripwire (file header).
#    OPERATOR OVERRIDE, A CHOICE ON THE RECORD: RMD_HOUSE_RULE_OVERRIDE=<stash|no-verify|host>[,...] in the
#    session's LAUNCH environment; agents never set it. Unlike RMD_GH_COOLDOWN_S it is NOT read from the
#    command text, so an inline assignment is refused: the agent typing it is who must not hold it.
#    FALSIFIER: test/the-house-rules-are-refused-at-the-floor.test.ts.
hr_tokens() {  # shell text -> per simple command: <`|` after a pipe, else `-`>\037<word>\037...; heredoc body = \036<body>
  awk '
    function endtok() { if (have) { seg = seg US tok; segn++ } tok = ""; have = 0 }
    function flush(nsep) { endtok(); if (segn) out[++no] = sep seg; seg = ""; segn = 0; sep = nsep }
    function emit(   k) { for (k = 1; k <= no; k++) print out[k]; no = 0 }
    function attach(b) { if (segn || have) { seg = seg US HB b; segn++ } else if (no) out[no] = out[no] US HB b }
    BEGIN { US = "\037"; HB = "\036"; NL = "\035"; q = ""; tok = ""; have = 0; seg = ""; segn = 0; sep = "-"; no = 0; nh = 0; hi = 0; body = "" }
    {
      L = $0
      if (hi) {
        line = L; if (htab[hi]) sub(/^\t+/, "", line)
        if (line == hword[hi]) {
          attach(body); body = ""
          if (++hi > nh) { hi = 0; nh = 0; if (q == "") emit() }
        } else body = body (body == "" ? "" : NL) L
        next
      }
      r = L
      while ((p = match(r, /<<-?[ \t]*[\047"\\]*[A-Za-z_][A-Za-z0-9_]*/)) > 0) {
        if (p > 1 && substr(r, p - 1, 1) == "<") { r = substr(r, p + RLENGTH); continue }
        w = substr(r, p, RLENGTH); t = (w ~ /^<<-/); sub(/^<<-?[ \t]*[\047"\\]*/, "", w)
        hword[++nh] = w; htab[nh] = t
        r = substr(r, p + RLENGTH)
      }
      n = length(L); cont = 0
      for (i = 1; i <= n; i++) {
        c = substr(L, i, 1)
        if (q == "\047") { if (c == "\047") q = ""; else tok = tok c; continue }
        if (q == "\"") {
          if (c == "\\" && i < n && substr(L, i + 1, 1) ~ /[\\"$`]/) { tok = tok substr(L, i + 1, 1); i++; continue }
          if (c == "\"") q = ""; else tok = tok c
          continue
        }
        if (c == "\\") { if (i == n) { cont = 1; break } tok = tok substr(L, i + 1, 1); have = 1; i++; continue }
        if (c == "\047" || c == "\"") { q = c; have = 1; continue }
        if (c == " " || c == "\t") { endtok(); continue }
        if (c == "#" && !have) break
        if (substr(L, i, 3) == "<<<") { endtok(); tok = "<<<"; have = 1; endtok(); i += 2; continue }
        if (substr(L, i, 2) == "<<") {
          endtok(); tok = "<<"; have = 1; endtok()
          j = i + 2; if (substr(L, j, 1) == "-") j++
          while (substr(L, j, 1) ~ /[ \t]/) j++
          while (j <= n && substr(L, j, 1) !~ /[ \t;&|()<>]/) j++
          i = j - 1; continue
        }
        if (c == ">" && substr(L, i + 1, 1) == "&") { tok = tok ">&"; have = 1; i++; continue }
        if (c == "&" && substr(L, i + 1, 1) == ">") { tok = tok "&>"; have = 1; i++; continue }
        if (c == "$" && substr(L, i + 1, 1) == "(") { flush("-"); i++; continue }
        if (c == "|") { if (substr(L, i + 1, 1) == "|") { flush("-"); i++ } else flush("|"); continue }
        if (c == ";" || c == "&" || c == "(" || c == ")" || c == "`") { if (c == "&" && substr(L, i + 1, 1) == "&") i++; flush("-"); continue }
        tok = tok c; have = 1
      }
      if (q != "") tok = tok NL
      else if (cont) endtok()
      else flush("-")
      if (nh) hi = 1
      else if (q == "" && !cont) emit()
    }
    END { flush("-"); emit() }'
}
HR_STASH="git stash (house rule: never stash: a stash lives outside every branch, is invisible to every other session sharing this clone, and is lost when its worktree is reaped). Commit by explicit path instead (git add <path> && git commit), or copy the file aside (cp <file> <scratch>/) to prove a falsifier, then copy it back. The read-only \`git stash list\` and \`git stash show\` still run."
HR_NOVERIFY="git commit/push/merge with --no-verify, or \`git commit -n\` (house rule: never --no-verify: the hooks are this repo's gates). Fix what the hook reports, then commit or push again."
HR_HOOKSPATH="a core.hooksPath override (house rule: never bypass the hooks: pointing core.hooksPath anywhere but \`hooks\` disarms pre-commit, commit-msg and pre-push). Fix what the hook reports; the only value this repo sets is \`git config core.hooksPath hooks\`."
HR_HOST="the fleet host is READ-ONLY for sessions (house rule)"
hr_override="${RMD_HOUSE_RULE_OVERRIDE-}"
hr_refuse() {  # $1 = rule (stash|no-verify|host), $2 = message. deny exits; an override records and returns.
  case ",$hr_override," in
    *",$1,"*)
      printf 'deny-floor: house rule "%s" OVERRIDDEN by RMD_HOUSE_RULE_OVERRIDE (an operator choice on the record): %s\n' "$1" "$2" >&2
      return 0 ;;
  esac
  deny "$2"
}
hr_host_refuse() {  # $1 = the destructive command as parsed
  hr_refuse host "destructive process control sent to the fleet host over ssh (\`$1\`): $HR_HOST. Read-only queries (ps, docker ps/inspect/logs, systemctl status, journalctl, cat, ls) still run. Report to the operator with the exact command you would have run, and stop."
}
hr_is_hookspath() {  # config keys are case-insensitive
  case "$1" in [cC][oO][rR][eE].[hH][oO][oO][kK][sS][pP][aA][tT][hH]) return 0 ;; esac
  return 1
}
hr_decode() { printf '%s' "${1//$'\035'/$'\n'}"; }
hr_rest() {  # the words t[i..] of the caller's segment, space-joined (heredoc bodies left out)
  local k="$i" s=""
  while [ "$k" -lt "$n" ]; do
    case "${t[$k]}" in $'\036'*) ;; *) s="$s ${t[$k]}" ;; esac
    k=$((k + 1))
  done
  printf '%s' "${s# }"
}
hr_skipopts() {  # step the caller's i past the wrapper word at t[i] and its options; $1 = options taking a value
  i=$((i + 1))
  while [ "$i" -lt "$n" ]; do
    case "${t[$i]}" in
      --) i=$((i + 1)); break ;;
      -*) case " $1 " in *" ${t[$i]} "*) i=$((i + 2)) ;; *) i=$((i + 1)) ;; esac ;;
      *) break ;;
    esac
  done
  return 0
}
hr_env_split_words() {  # split env -S text into literal argv words without interpreting shell separators or expansions
  local input="$1" len pos=0 ch next quote="" word="" have=0 out="" us=$'\037'
  len=${#input}
  while [ "$pos" -lt "$len" ]; do
    ch="${input:$pos:1}"
    if [ "$quote" = "'" ]; then
      if [ "$ch" = "'" ]; then quote=""; else word="$word$ch"; have=1; fi
      pos=$((pos + 1))
      continue
    fi
    if [ "$quote" = '"' ]; then
      case "$ch" in
        '"') quote="" ;;
        \\)
          if [ $((pos + 1)) -lt "$len" ]; then
            next="${input:$((pos + 1)):1}"
            case "$next" in '"'|\\) word="$word$next"; pos=$((pos + 1)) ;; *) word="$word$ch" ;; esac
          else word="$word$ch"; fi ;;
        *) word="$word$ch" ;;
      esac
      have=1
      pos=$((pos + 1))
      continue
    fi
    case "$ch" in
      ' '|$'\t'|$'\n')
        if [ "$have" -eq 1 ]; then out="${out}${word}${us}"; word=""; have=0; fi ;;
      "'"|'"') quote="$ch"; have=1 ;;
      \\)
        if [ $((pos + 1)) -ge "$len" ]; then return 1; fi
        next="${input:$((pos + 1)):1}"
        case "$next" in
          c) pos=$len; continue ;;
          _) word="$word " ;;
          *) word="$word$next" ;;
        esac
        have=1
        pos=$((pos + 1)) ;;
      *) word="$word$ch"; have=1 ;;
    esac
    pos=$((pos + 1))
  done
  [ -z "$quote" ] || return 1
  if [ "$have" -eq 1 ]; then out="${out}${word}${us}"; fi
  printf '%s' "$out"
}
hr_env_check() {  # inspect env argv, expanding split-string options as literal argv
  local previous="$1" mode="$2" depth="$3" j w encoded split_arg rounds=0 command_line us=$'\037'
  local -a argv=() split=()
  for ((j = i + 1; j < n; j++)); do argv+=("${t[$j]}"); done

  # env allows its split-string option before the executable. Expand it in place; the
  # resulting words are argv, not shell syntax (so a semicolon inside one stays data).
  j=0
  while [ "$j" -lt "${#argv[@]}" ]; do
    w="${argv[$j]}"
    case "$w" in
      --) break ;;
      -u|--unset|-C|--chdir|-P|--path|-a|--argv0) j=$((j + 2)); continue ;;
      -S|--split-string)
        [ $((j + 1)) -lt "${#argv[@]}" ] || deny "env -S has no split-string argument; run the command without env -S so the house-rule floor can inspect it"
        split_arg="${argv[$((j + 1))]}"
        encoded="$(hr_env_split_words "$split_arg")" || deny "env -S has malformed split-string quoting; run the command without env -S so the house-rule floor can inspect it"
        split=()
        if [ -n "$encoded" ]; then IFS=$'\037' read -r -a split <<< "$encoded"; fi
        argv=("${argv[@]:0:j}" "${split[@]}" "${argv[@]:j+2}")
        rounds=$((rounds + 1))
        [ "$rounds" -le 8 ] || deny "env -S nesting exceeds the house-rule parser limit; run the command without nested env -S"
        continue ;;
      --split-string=*)
        split_arg="${w#--split-string=}"
        encoded="$(hr_env_split_words "$split_arg")" || deny "env --split-string has malformed quoting; run the command without env -S so the house-rule floor can inspect it"
        split=()
        if [ -n "$encoded" ]; then IFS=$'\037' read -r -a split <<< "$encoded"; fi
        argv=("${argv[@]:0:j}" "${split[@]}" "${argv[@]:j+1}")
        rounds=$((rounds + 1))
        [ "$rounds" -le 8 ] || deny "env -S nesting exceeds the house-rule parser limit; run the command without nested env -S"
        continue ;;
      -S?*)
        split_arg="${w#-S}"
        encoded="$(hr_env_split_words "$split_arg")" || deny "env -S has malformed split-string quoting; run the command without env -S so the house-rule floor can inspect it"
        split=()
        if [ -n "$encoded" ]; then IFS=$'\037' read -r -a split <<< "$encoded"; fi
        argv=("${argv[@]:0:j}" "${split[@]}" "${argv[@]:j+1}")
        rounds=$((rounds + 1))
        [ "$rounds" -le 8 ] || deny "env -S nesting exceeds the house-rule parser limit; run the command without nested env -S"
        continue ;;
      --unset=*|--chdir=*|--path=*|--argv0=*|-u?*|-C?*|-P?*|-a?*|-i|-v|-0|--ignore-environment|--null|--debug|--help|--version|-[iv0]*)
        j=$((j + 1)); continue ;;
      [A-Za-z_][A-Za-z0-9_]*=*)
        j=$((j + 1)); continue ;;
      *) break ;;
    esac
    j=$((j + 1))
  done

  # Locate env's executable after its own options and NAME=value operands.
  j=0
  while [ "$j" -lt "${#argv[@]}" ]; do
    w="${argv[$j]}"
    case "$w" in
      --) j=$((j + 1)); break ;;
      -u|--unset|-C|--chdir|-P|--path|-a|--argv0) j=$((j + 2)) ;;
      --unset=*|--chdir=*|--path=*|--argv0=*|-i|--ignore-environment|-0|--null|-v|--debug|--help|--version|-[iv0]*) j=$((j + 1)) ;;
      -u?*|-C?*|-P?*|-a?*) j=$((j + 1)) ;;
      [A-Za-z_][A-Za-z0-9_]*=*) j=$((j + 1)) ;;
      -*) deny "env option '$w' is not recognized by the house-rule parser; run the command without that env option so its executable can be inspected" ;;
      *) break ;;
    esac
  done
  [ "$j" -lt "${#argv[@]}" ] || return 0

  # Feed a serialized token segment directly: no shell parsing of env's literal argv.
  command_line="-"
  w="${argv[$j]}"
  if [ "${w##*/}" = env ] && [ "$depth" -ge 4 ]; then
    deny "nested env wrappers exceed the house-rule parser limit; run the command without nested env wrappers"
  fi
  while [ "$j" -lt "${#argv[@]}" ]; do
    command_line="${command_line}${us}${argv[$j]}"
    j=$((j + 1))
  done
  hr_segment "$command_line" "$previous" "$mode" $((depth + 1))
  return 0
}
hr_check() {  # $1 = shell text, $2 = local|host, $3 = depth
  local hr_line hr_prev=""
  [ "$3" -le 4 ] || return 0
  while IFS= read -r hr_line; do
    hr_segment "$hr_line" "$hr_prev" "$2" "$3"
    hr_prev="$hr_line"
  done < <(printf '%s\n' "$1" | hr_tokens)
  return 0
}
hr_git_c() {  # one `git -c key[=value]`
  local key="${1%%=*}" val=""
  case "$1" in *=*) val="${1#*=}" ;; esac
  if hr_is_hookspath "$key" && [ "$val" != hooks ]; then hr_refuse no-verify "$HR_HOOKSPATH"; fi
  return 0
}
hr_git_noverify() {  # $1 = commit|merge|push; the caller's t[i..] are the subcommand's words
  local w k c vals
  case "$1" in
    commit) vals=" -m -F -C -c -t --message --file --reuse-message --reedit-message --template --author --date --cleanup --fixup --squash --trailer --pathspec-from-file " ;;
    merge) vals=" -m -F -s -X --message --file --strategy --strategy-option --cleanup --into-name " ;;
    *) vals=" -o --repo --push-option --receive-pack --exec " ;;
  esac
  while [ "$i" -lt "$n" ]; do
    w="${t[$i]}"
    i=$((i + 1))
    case "$vals" in *" $w "*) i=$((i + 1)); continue ;; esac
    case "$w" in
      --) break ;;
      '<<<') i=$((i + 1)) ;;
      --no-veri|--no-verif|--no-verify) hr_refuse no-verify "$HR_NOVERIFY" ;;
      --*) ;;
      -?*)
        [ "$1" = commit ] || continue
        k=1
        while [ "$k" -lt "${#w}" ]; do
          c="${w:$k:1}"
          k=$((k + 1))
          case "$c" in
            n) hr_refuse no-verify "$HR_NOVERIFY" ;;
            m|F|C|c|t) if [ "$k" -ge "${#w}" ]; then i=$((i + 1)); fi; break ;;
            S|u) break ;;
          esac
        done ;;
    esac
  done
  return 0
}
hr_git_config() {  # the caller's t[i..] are `git config`'s words
  local w verb="" key=0 read=0 unset=0 val="" have_val=0
  while [ "$i" -lt "$n" ]; do
    w="${t[$i]}"
    i=$((i + 1))
    case "$w" in
      $'\036'*) ;;
      --get|--get-all|--get-regexp|--get-urlmatch|-l|--list) read=1 ;;
      --unset|--unset-all) unset=1 ;;
      --remove-section|--rename-section)
        case "${t[$i]-}" in [cC][oO][rR][eE]) hr_refuse no-verify "$HR_HOOKSPATH" ;; esac
        i=$((i + 1)) ;;
      -f|--file|--blob|--type|--default|--comment|--value|-t) i=$((i + 1)) ;;
      -*) ;;
      *)
        if [ -z "$verb" ] && [ "$key" -eq 0 ]; then
          case "$w" in
            get|list) verb="$w"; read=1; continue ;;
            set|unset|edit|rename-section|remove-section) verb="$w"; continue ;;
          esac
        fi
        case "$verb" in
          rename-section|remove-section)
            case "$w" in [cC][oO][rR][eE]) hr_refuse no-verify "$HR_HOOKSPATH" ;; esac
            return 0 ;;
        esac
        if [ "$key" -eq 0 ]; then
          hr_is_hookspath "$w" || return 0
          key=1
        elif [ "$have_val" -eq 0 ]; then
          val="$w"; have_val=1
        fi ;;
    esac
  done
  [ "$key" -eq 1 ] || return 0
  [ "$read" -eq 0 ] || return 0
  if [ "$unset" -eq 1 ] || [ "$verb" = unset ]; then hr_refuse no-verify "$HR_HOOKSPATH"; return 0; fi
  [ "$have_val" -eq 1 ] || return 0
  if [ "$val" != hooks ]; then hr_refuse no-verify "$HR_HOOKSPATH"; fi
  return 0
}
hr_git() {  # $1 = mode, $2 = depth; the caller's t[i..] are git's words after the program
  local w sub="" pos=""
  while [ "$i" -lt "$n" ]; do
    w="${t[$i]}"
    i=$((i + 1))
    case "$w" in
      -c) hr_git_c "${t[$i]-}"; i=$((i + 1)) ;;
      --config-env) w="${t[$i]-}"; if hr_is_hookspath "${w%%=*}"; then hr_refuse no-verify "$HR_HOOKSPATH"; fi; i=$((i + 1)) ;;
      --config-env=*) w="${w#--config-env=}"; if hr_is_hookspath "${w%%=*}"; then hr_refuse no-verify "$HR_HOOKSPATH"; fi ;;
      -C|--git-dir|--work-tree|--namespace|--super-prefix) i=$((i + 1)) ;;
      -*) ;;
      *) sub="$w"; break ;;
    esac
  done
  case "$sub" in
    stash) case "${t[$i]-}" in list|show) ;; *) hr_refuse stash "$HR_STASH" ;; esac ;;
    commit|merge|push) hr_git_noverify "$sub" ;;
    config) hr_git_config ;;
    worktree)
      if [ "$1" = host ]; then
        while [ "$i" -lt "$n" ]; do
          case "${t[$i]}" in -*) i=$((i + 1)) ;; *) pos="${t[$i]}"; break ;; esac
        done
        if [ "$pos" = prune ]; then hr_host_refuse "git worktree prune"; fi
      fi ;;
  esac
  return 0
}
hr_ssh() {  # $1 = depth, $2 = the previous segment; the caller's t[i..] are ssh's words
  local w k c dest="" host remote="" j
  local -a p
  while [ "$i" -lt "$n" ]; do
    w="${t[$i]}"
    i=$((i + 1))
    case "$w" in
      --) ;;
      -?*)
        k=1
        while [ "$k" -lt "${#w}" ]; do
          c="${w:$k:1}"
          k=$((k + 1))
          case "$c" in [BbcDEeFIiJLlmOoPpQRSWw]) if [ "$k" -ge "${#w}" ]; then i=$((i + 1)); fi; break ;; esac
        done ;;
      *) dest="$w"; break ;;
    esac
  done
  host="${dest#ssh://}"; host="${host##*@}"; host="${host%%:*}"
  [ "$host" = remudero ] || return 0
  while [ "$i" -lt "$n" ]; do
    w="${t[$i]}"
    i=$((i + 1))
    case "$w" in
      $'\036'*) hr_check "$(hr_decode "${w#?}")" host $(( $1 + 1 )) ;;
      '<<') ;;
      '<<<') hr_check "$(hr_decode "${t[$i]-}")" host $(( $1 + 1 )); i=$((i + 1)) ;;
      '<'|'>'|'>>'|[0-9]'>'|[0-9]'>>'|'&>') i=$((i + 1)) ;;
      '<'*|'>'*|[0-9]'>'*|'&>'*) ;;
      *) remote="$remote $w" ;;
    esac
  done
  if [ -n "$remote" ]; then hr_check "$(hr_decode "$remote")" host $(( $1 + 1 )); fi
  case "${t[0]}" in
    '|')
      [ -n "$2" ] || return 0
      IFS=$'\037' read -r -a p <<< "$2"
      j=1
      while [ "$j" -lt "${#p[@]}" ]; do
        w="${p[$j]}"
        hr_check "$(hr_decode "${w#$'\036'}")" host $(( $1 + 1 ))
        j=$((j + 1))
      done ;;
  esac
  return 0
}
hr_docker() {  # $1 = depth; host mode only; the caller's t[i..] are docker's words
  local w sub="" sub2=""
  while [ "$i" -lt "$n" ]; do
    w="${t[$i]}"
    i=$((i + 1))
    case "$w" in
      -H|--host|--context|-c|--config|-l|--log-level) i=$((i + 1)) ;;
      -*) ;;
      *) sub="$w"; break ;;
    esac
  done
  case "$sub" in
    container|compose|image|volume|network|system|builder|buildx)
      while [ "$i" -lt "$n" ]; do
        w="${t[$i]}"
        i=$((i + 1))
        case "$w" in
          -f|--file|-p|--project-name|--profile|--env-file|--project-directory) i=$((i + 1)) ;;
          -*) ;;
          *) sub2="$w"; break ;;
        esac
      done ;;
    *) sub2="$sub"; sub="" ;;
  esac
  case "$sub2" in
    restart|stop|kill|rm|rmi|down|prune|pause|remove) hr_host_refuse "docker ${sub:+$sub }$sub2" ;;
    exec)
      while [ "$i" -lt "$n" ]; do
        w="${t[$i]}"
        i=$((i + 1))
        case "$w" in
          -e|--env|--env-file|-u|--user|-w|--workdir|--detach-keys|--index) i=$((i + 1)) ;;
          -*) ;;
          *) break ;;
        esac
      done
      hr_check "$(hr_decode "$(hr_rest)")" host $(( $1 + 1 )) ;;
  esac
  return 0
}
hr_segment() {  # $1 = one hr_tokens line, $2 = the previous line, $3 = local|host, $4 = depth
  local -a t
  local n i=1 w prog k c
  IFS=$'\037' read -r -a t <<< "$1"
  n=${#t[@]}
  for w in "${t[@]}"; do
    case "$w" in
      GIT_CONFIG*=*[cC][oO][rR][eE].[hH][oO][oO][kK][sS][pP][aA][tT][hH]*) hr_refuse no-verify "$HR_HOOKSPATH" ;;
    esac
  done
  while [ "$i" -lt "$n" ]; do
    case "${t[$i]}" in
      [A-Za-z_]*=*|do|then|else|elif|if|while|until|'!'|'{'|time|nohup|exec|command|builtin) i=$((i + 1)) ;;
      sudo|*/sudo) hr_skipopts "-u -g -h -p -C -D -r -t -U -T" ;;
      env|*/env) hr_env_check "$2" "$3" "$4"; return 0 ;;
      nice|*/nice) hr_skipopts "-n" ;;
      timeout|*/timeout) hr_skipopts "-s -k --signal --kill-after"; i=$((i + 1)) ;;
      xargs|*/xargs) hr_skipopts "-I -n -P -L -d -a -E -s --max-args --max-procs --max-lines --delimiter --arg-file" ;;
      *) break ;;
    esac
  done
  [ "$i" -lt "$n" ] || return 0
  prog="${t[$i]##*/}"
  i=$((i + 1))
  case "$prog" in
    git) hr_git "$3" "$4" ;;
    ssh) hr_ssh "$4" "$2" ;;
    bash|sh|zsh|dash|ksh)
      while [ "$i" -lt "$n" ]; do
        w="${t[$i]}"
        i=$((i + 1))
        case "$w" in
          $'\036'*) hr_check "$(hr_decode "${w#?}")" "$3" $(( $4 + 1 )) ;;
          '<<<') hr_check "$(hr_decode "${t[$i]-}")" "$3" $(( $4 + 1 )); i=$((i + 1)) ;;
          --*) ;;
          -*c*) hr_check "$(hr_decode "${t[$i]-}")" "$3" $(( $4 + 1 )); i=$((i + 1)) ;;
        esac
      done ;;
    eval) hr_check "$(hr_decode "$(hr_rest)")" "$3" $(( $4 + 1 )) ;;
  esac
  [ "$3" = host ] || return 0
  case "$prog" in
    kill) case "${t[$i]-}" in -0|-l|-L) ;; *) hr_host_refuse "kill $(hr_rest)" ;; esac ;;
    pkill|killall) hr_host_refuse "$prog $(hr_rest)" ;;
    docker) hr_docker "$4" ;;
    systemctl)
      while [ "$i" -lt "$n" ]; do
        w="${t[$i]}"
        i=$((i + 1))
        case "$w" in
          -H|--host|-M|--machine|-p|--property|-t|--type|-s|--signal|-n|--lines|-o|--output|--state) i=$((i + 1)) ;;
          -*) ;;
          restart|stop|kill|try-restart|reload-or-restart|try-reload-or-restart|condrestart) hr_host_refuse "systemctl $w"; break ;;
          *) break ;;
        esac
      done ;;
    rm)
      k="$i"
      while [ "$k" -lt "$n" ]; do
        w="${t[$k]}"
        k=$((k + 1))
        case "$w" in
          --) break ;;
          --recursive|--force) hr_host_refuse "rm $w"; break ;;
          --*) ;;
          -*[rRf]*) hr_host_refuse "rm $w"; break ;;
        esac
      done ;;
  esac
  return 0
}
hr_tool=""
[ "$have_jq" -eq 1 ] && hr_tool="$(printf '%s' "$input" | jq -r '.tool_name // ""')"
case "$hr_tool" in
  apply_patch|Write|Edit|MultiEdit|NotebookEdit|Read|Grep|Glob) ;;
  *)
    if [ "$have_jq" -eq 1 ]; then
      case "$cmd" in *git*|*ssh*|*GIT_CONFIG*) hr_check "$cmd" local 0 ;; esac
    fi ;;
esac

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
