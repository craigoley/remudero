#!/bin/bash
# W1-T10279: install this Mac account's GitHub read broker as a per-account launchd agent that keeps
# `rmd gh-broker serve` running. Installed like the Mac janitor: account-local, never fleet runtime,
# nothing on Azure changes. --dry-run prints the copy, the agent and the launchctl commands and changes nothing.
#
# W1-T10302: it also records the GitHub login this account's gh reads as and joins the per-login SHARED PACE
# directory, /Users/Shared/remudero/gh-pace/<login>/, that every Mac account reading as that login shares. It
# holds timing numbers and refusal counts only (never a response, a header value or a token). Mode 0700 plus an
# ACL naming exactly the accounts this installer was run for; never world-writable. The first account creates
# it; a later account JOINS it by adding itself to the ACL (which needs the directory's owner or sudo: running
# the installer on that account is the operator's approval). Each account keeps its own broker, socket, cache.
#
# W1-T12938: THE AGENT RUNS A PRIVATE COPY, NEVER THE CHECKOUT. Until this task the agent ran `--rmd` in place,
# so retiring the worktree it named (2026-11-11) left the broker down for four days and every session on the
# shared 180 s read floor. Now `--rmd` (default: the checkout this installer sits in) only names the checkout to
# copy FROM. Its committed tree at HEAD, less test/, and its installed node_modules go to
#   ~/Library/Application Support/remudero/gh-read-broker/<source sha>/
# and the agent runs <that copy>/bin/rmd. Tracked changes that are not committed are refused by name: the copy
# is the commit. Replacement is two-phase: the new copy is built, the agent is started on it, and the previous
# copy is removed only once the new agent has written a heartbeat. With no heartbeat the previous copy and
# agent are put back and the exit is non-zero, naming the agent's log. `current` beside the copies records the
# sha that is serving. The whole tree is copied because the CLI reads plan/policy.yaml as it loads; the narrow
# entry of W1-T10369 will let a later change shrink the copy.
#
# W1-T13171: AN AGENT IS STARTED ONLY ONCE LAUNCHD HAS LET GO OF THE ONE BEFORE IT. `launchctl bootout` returns
# before the service is gone, and a `launchctl bootstrap` in that window fails with "5: Input/output error"
# (2026-11-16: the first reinstall over a running broker failed that way). So after a stop, the install and
# its roll-back both poll `launchctl print` until it fails, for at most the --heartbeat-wait seconds. An old
# agent still listed then ends the install before anything is replaced, naming the service. With no agent
# file there is no previous agent, and nothing is waited for.
set -euo pipefail
umask 077
label=com.remudero.gh-read-broker
here="$(cd "$(dirname "$0")" && pwd -P)"
rmd="${REMUDERO_RMD_BIN:-$here/../../bin/rmd}"
dry_run=0
heartbeat_wait=60
pace_root="${REMUDERO_GH_PACE_ROOT:-/Users/Shared/remudero/gh-pace}"
login="${REMUDERO_GH_LOGIN:-}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=1; shift ;;
    --login) [ "$#" -ge 2 ] && [ -n "$2" ] || { printf 'the login is required\n' >&2; exit 2; }; login="$2"; shift 2 ;;
    --rmd) [ "$#" -ge 2 ] && [ -n "$2" ] || { printf 'the rmd path is required\n' >&2; exit 2; }; rmd="$2"; shift 2 ;;
    --heartbeat-wait)
      [ "$#" -ge 2 ] || { printf 'the heartbeat wait needs a number of seconds\n' >&2; exit 2; }
      case "$2" in ''|*[!0-9]*) printf 'the heartbeat wait needs a number of seconds\n' >&2; exit 2 ;; esac
      heartbeat_wait="$2"; shift 2 ;;
    *) printf 'usage: %s [--rmd /abs/path/to/<checkout>/bin/rmd] [--login <github login>] [--heartbeat-wait <seconds>] [--dry-run]\n' "$0" >&2; exit 2 ;;
  esac
done
case "$rmd" in /*) ;; *) printf 'the rmd path must be absolute (it names the checkout the broker is copied from)\n' >&2; exit 2 ;; esac
[ -x "$rmd" ] || { printf 'not executable: %s\n' "$rmd" >&2; exit 2; }
agents="$HOME/Library/LaunchAgents"
plist="$agents/$label.plist"
logs="$HOME/Library/Logs"
err_log="$logs/remudero-gh-read-broker.err.log"
copies="$HOME/Library/Application Support/remudero/gh-read-broker"
# The agent's environment is HOME and PATH alone, so its broker writes its heartbeat under HOME's cache.
heartbeat="$HOME/.cache/remudero/gh-broker/heartbeat"
uid="$(id -u)"
service="gui/$uid/$label"
account="$(id -un)"
acl_entry="user:$account allow list,add_file,search,add_subdirectory,delete_child,readattr,writeattr,readextattr,writeextattr,readsecurity,file_inherit,directory_inherit"
codex_version="none found"
if command -v codex >/dev/null 2>&1; then codex_version="$(codex --version 2>/dev/null | head -n 1 || true)"; fi
valid_login() { printf '%s' "$1" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9-]*$'; }
# launchd's own PATH omits Homebrew, where gh lives on this Mac.
path_env="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }

# THE SOURCE: the checkout `--rmd` belongs to, read at its HEAD commit. Whatever makes it unusable is one
# sentence in `refusal`: an install stops on it, a dry run prints it and goes on to show the plan.
src="$(cd -P "$(dirname "$rmd")/.." && pwd -P)"
src_git() { (unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE; git -C "$src" "$@"); }
refusal=""
sha=""
top="$(src_git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -n "$top" ]; then top="$(cd -P "$top" 2>/dev/null && pwd -P || true)"; fi
if [ -z "$top" ] || [ "$top" != "$src" ]; then
  refusal="$src is not the root of a git checkout: the broker is copied from a commit, so --rmd must be <checkout>/bin/rmd"
else
  sha="$(src_git rev-parse --verify --quiet 'HEAD^{commit}' 2>/dev/null || true)"
  if ! printf '%s' "$sha" | grep -Eq '^[0-9a-f]{40,64}$'; then
    sha=""
    refusal="$src has no commit at HEAD to copy"
  else
    dirty="$(src_git status --porcelain --untracked-files=no 2>/dev/null || true)"
    if [ -n "$dirty" ]; then
      refusal="$src has uncommitted changes to tracked files, and the copy is commit $sha, so they would be left out; commit them or install from a clean worktree. Changed: $(printf '%s\n' "$dirty" | sed -n '1,5p' | sed -e 's/^...//' | tr '\n' ' ')"
    elif [ ! -d "$src/node_modules" ]; then
      refusal="$src has no node_modules to copy; install its dependencies first"
    fi
  fi
fi
new="$copies/${sha:-<source sha>}"

# The first ProgramArguments string of an agent file this installer wrote: the program the agent runs.
plist_program() {
  sed -n '/<key>ProgramArguments<\/key>/,/<\/array>/p' "$1" 2>/dev/null | sed -n 's/.*<string>\(.*\)<\/string>.*/\1/p' |
    sed -n '1p' | sed -e 's/&lt;/</g' -e 's/&gt;/>/g' -e 's/&amp;/\&/g'
}
prev_body=""
prev_prog=""
prev_copy=""
if [ -f "$plist" ]; then
  prev_body="$(cat "$plist")"
  prev_prog="$(plist_program "$plist" || true)"
fi
# A previous COPY is a directory directly under $copies whose bin/rmd the agent ran; any other program path is
# an in-place install from before this task, which has no copy to keep or remove.
case "$prev_prog" in
  "$copies"/*/bin/rmd)
    prev_copy="${prev_prog%/bin/rmd}"
    [ "${prev_copy%/*}" = "$copies" ] || prev_copy="" ;;
esac

body="<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$new/bin/rmd")</string>
    <string>gh-broker</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$path_env</string>
    <key>HOME</key><string>$(xml_escape "$HOME")</string>
    <key>RMD_SELF_SYNC_DONE</key><string>1</string>
  </dict>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$(xml_escape "$logs/remudero-gh-read-broker.out.log")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$err_log")</string>
</dict>
</plist>"
if [ "$dry_run" -eq 1 ]; then
  printf '%s\n' "$body"
  if [ -n "$refusal" ]; then printf 'would refuse: %s\n' "$refusal"; fi
  printf 'would copy %s at %s (its committed tree less test/, plus node_modules) to %s\n' "$src" "${sha:-<source sha>}" "$new"
  if [ -n "$prev_copy" ]; then
    printf 'would keep the previous copy %s until the new agent has written a heartbeat, then remove it\n' "$prev_copy"
  elif [ -n "$prev_prog" ]; then
    printf 'would replace the agent that runs %s in place (no previous copy to remove)\n' "$prev_prog"
  else
    printf 'no previous agent: nothing to keep or remove\n'
  fi
  printf 'would write %s\n' "$plist"
  printf 'would run: launchctl bootout gui/%s/%s (ignored if absent)\n' "$uid" "$label"
  if [ -n "$prev_body" ]; then
    printf 'would wait up to %ss for launchd to stop listing %s (polling `launchctl print`) before the copy or the agent file is replaced; still listed then, nothing is replaced\n' "$heartbeat_wait" "$service"
  fi
  printf 'would run: launchctl bootstrap gui/%s %s\n' "$uid" "$plist"
  printf 'would wait up to %ss for a fresh heartbeat at %s, then record %s in %s\n' "$heartbeat_wait" "$heartbeat" "${sha:-<source sha>}" "$copies/current"
  printf 'would record the broker source paths in %s\n' "$new/source-paths"
  if [ -n "$login" ]; then
    valid_login "$login" || { printf 'not a GitHub login: %s\n' "$login" >&2; exit 2; }
    if [ -d "$pace_root/$login" ]; then
      printf 'would join the shared pace directory %s (add to its ACL: %s)\n' "$pace_root/$login" "$acl_entry"
    else
      printf 'would create the shared pace directory %s (mode 0700, ACL: %s)\n' "$pace_root/$login" "$acl_entry"
    fi
  else
    printf 'would detect the login this account reads as (gh api user), then create or join %s/<login>\n' "$pace_root"
  fi
  printf 'login: %s; account: %s; codex-cli: %s\n' "${login:-<detected at install>}" "$account" "$codex_version"
  exit 0
fi

# Everything that can refuse does so here, before a directory, a copy or the running agent is touched.
[ -z "$refusal" ] || { printf 'refusing to install: %s\n' "$refusal" >&2; exit 2; }
command -v launchctl >/dev/null 2>&1 || { printf 'launchctl not found: this installs a macOS launchd agent and runs on a Mac only\n' >&2; exit 2; }
# Read the chosen commit's exported list as data. Older commits use the installer's checkout list.
broker_source_paths() {
  sed -n '/^export const GH_READ_BROKER_SOURCE_PATHS = `$/,/^`;$/ { /^export /d; /^`;$/d; p; }'
}
source_paths="$(src_git show "$sha:src/lib/gh-read-broker.ts" 2>/dev/null | broker_source_paths)" || source_paths=""
if [ -z "$source_paths" ]; then
  source_paths="$(broker_source_paths < "$here/../../src/lib/gh-read-broker.ts")"
fi
[ -n "$source_paths" ] || { printf 'could not read the broker source path list\n' >&2; exit 1; }
enable_hint="launchctl enable gui/$uid/$label"
# A service launchd holds DISABLED cannot be bootstrapped, and launchctl says only "5: Input/output error"
# (2026-11-15: every com.remudero agent on the operator Mac was disabled). Name the state and its one command.
if launchctl print-disabled "gui/$uid" 2>/dev/null | grep -F "\"$label\"" | grep -Eq '=> *(disabled|true)'; then
  printf 'launchd has %s DISABLED for this account, so it cannot be started and nothing was changed.\n' "$label" >&2
  printf 'Enable it, then run this installer again: %s\n' "$enable_hint" >&2
  exit 1
fi

if [ -z "$login" ]; then login="$(gh api user --jq .login 2>/dev/null || true)"; fi
valid_login "$login" || { printf 'could not determine the GitHub login this account reads as; pass --login <login>\n' >&2; exit 2; }
pace_dir="$pace_root/$login"
# The parents are search-only for other accounts (0711); the login directory is 0700 plus the ACL.
mkdir -p "$pace_root"
chmod 711 "$(dirname "$pace_root")" "$pace_root"
if [ -d "$pace_dir" ]; then
  pace_action=joined
else
  mkdir "$pace_dir"
  chmod 700 "$pace_dir"
  pace_action=created
fi
if ! ls -lde "$pace_dir" | grep -Fq "user:$account allow"; then
  if [ -O "$pace_dir" ]; then chmod +a "$acl_entry" "$pace_dir"; else sudo chmod +a "$acl_entry" "$pace_dir"; fi
fi

# Removes one copy this installer made: a real directory directly under $copies with a name it writes.
# Anything else is left alone and said so, so a bad path can never widen what is deleted.
remove_copy() {
  local dir="$1" name
  name="${dir##*/}"
  if [ "$dir" != "$copies/$name" ] || ! printf '%s' "$name" | grep -Eq '^(\.stage\.[0-9]+|(\.previous\.[0-9]+\.)?[0-9a-f]{40,64})$'; then
    printf 'not removing %s: it is not a copy this installer made under %s\n' "$dir" "$copies" >&2
    return 1
  fi
  if [ -L "$dir" ] || [ ! -d "$dir" ]; then return 0; fi
  rm -rf "$dir"
}

# Fills an empty directory with what `rmd gh-broker serve` runs from: the committed tree at $sha less test/,
# and the checkout's node_modules (an APFS clone on a Mac, as the dependency seed tool materializes one).
build_copy() {
  local stage="$1" entry modules stray
  local -a tree
  tree=()
  while IFS= read -r -d '' entry; do
    [ "$entry" = test ] || tree[${#tree[@]}]="$entry"
  done < <(src_git ls-tree -z --name-only "$sha")
  [ "${#tree[@]}" -gt 0 ] || { printf 'commit %s lists no files to copy\n' "$sha" >&2; return 1; }
  src_git archive --format=tar "$sha" -- "${tree[@]}" | tar -x -f - -C "$stage" || { printf 'could not export commit %s from %s\n' "$sha" "$src" >&2; return 1; }
  modules="$(cd -P "$src/node_modules" && pwd -P)" || { printf 'could not read %s/node_modules\n' "$src" >&2; return 1; }
  if [ "$(uname -s)" = Darwin ]; then
    /bin/cp -cRP "$modules" "$stage/node_modules" || { printf 'could not clone %s\n' "$modules" >&2; return 1; }
  else
    cp -RP "$modules" "$stage/node_modules" || { printf 'could not copy %s\n' "$modules" >&2; return 1; }
  fi
  # A link back to an absolute path would leave the copy depending on a tree that can be retired.
  stray="$(find "$stage/node_modules" -maxdepth 2 -type l -lname '/*' -print 2>/dev/null | sed -n '1p' || true)"
  [ -z "$stray" ] || { printf 'the copied node_modules links outside the copy (%s); install real dependencies in %s first\n' "$stray" "$src" >&2; return 1; }
  [ -x "$stage/bin/rmd" ] || { printf 'commit %s has no executable bin/rmd\n' "$sha" >&2; return 1; }
  printf '%s\n' "$source_paths" > "$stage/source-paths" || return 1
  printf 'sha=%s\nsource=%s\n' "$sha" "$src" > "$stage/.gh-read-broker-source" || return 1
}

# "<inode> <mtime>" of the heartbeat, or nothing. The broker writes each beat as a new file renamed into place,
# so any beat changes this. The first stat form that prints only digits wins (GNU -c, then BSD -f).
heartbeat_identity() {
  local s
  s="$(stat -c '%i %Y' "$heartbeat" 2>/dev/null || true)"
  case "$s" in ''|*[!0-9\ ]*) s="$(stat -f '%i %m' "$heartbeat" 2>/dev/null || true)" ;; esac
  case "$s" in ''|*[!0-9\ ]*) s="" ;; esac
  printf '%s' "$s"
}

write_plist() {
  printf '%s\n' "$1" > "$plist.tmp.$$"
  mv -f "$plist.tmp.$$" "$plist"
}

# Stops the agent, then waits until launchd no longer lists the service: `launchctl bootout` returns before
# that, and a bootstrap while it is still listed fails with "5: Input/output error". It looks, sleeps a quarter
# second and looks again, for at most the --heartbeat-wait seconds the caller chose for this install.
# 0 once the service is gone; 1 if launchd still lists it when the seconds are up.
looks_per_second=4
stop_agent() {
  local looked=0 limit
  limit=$(( 10#$heartbeat_wait * looks_per_second ))
  launchctl bootout "$service" 2>/dev/null || true
  while launchctl print "$service" >/dev/null 2>&1; do
    [ "$looked" -lt "$limit" ] || return 1
    sleep 0.25
    looked=$(( looked + 1 ))
  done
  return 0
}

mkdir -p "$agents" "$logs" "$copies"
stage="$copies/.stage.$$"
[ ! -e "$stage" ] || { printf 'a staging directory is already there: %s\n' "$stage" >&2; exit 1; }
mkdir "$stage"
if ! build_copy "$stage"; then
  remove_copy "$stage" || true
  printf 'nothing was changed: the agent and any previous copy are as they were\n' >&2
  exit 1
fi

# PHASE ONE: stop the agent, wait until launchd has let go of it, put the new copy in place, start the agent on
# it. The previous copy stays. Nothing is moved or written until the old agent is gone.
if [ -z "$prev_body" ]; then
  # No agent file: no previous agent to wait for. A stray service is told to stop, as before, and that is all.
  launchctl bootout "$service" 2>/dev/null || true
elif ! stop_agent; then
  remove_copy "$stage" || true
  printf 'launchd still lists %s %ss after it was told to stop it: the old agent is still loaded, so nothing was replaced.\n' "$service" "$heartbeat_wait" >&2
  printf 'The agent file %s and the program it runs, %s, are as they were, but that agent was told to stop and may not be serving.\n' "$plist" "$prev_prog" >&2
  printf 'Once `launchctl print %s` fails, run this installer again, or start the old agent with: launchctl bootstrap gui/%s %s\n' "$service" "$uid" "$plist" >&2
  exit 1
fi
kept=""
if [ -n "$prev_copy" ] && [ -d "$prev_copy" ]; then
  if [ "$prev_copy" = "$new" ]; then
    # The same commit again: the serving copy steps aside under another name, so it can still come back.
    kept="$copies/.previous.$$.$sha"
    mv "$new" "$kept"
  else
    kept="$prev_copy"
  fi
fi
# What is left under the new name now is a copy no agent runs: an install that stopped part-way.
[ ! -e "$new" ] || remove_copy "$new"
mv "$stage" "$new"
write_plist "$body"
# The stopped agent's last beat, read once it is gone: a heartbeat that differs from it was written since.
before="$(heartbeat_identity)"
bootstrapped=1
boot_error="$(launchctl bootstrap "gui/$uid" "$plist" 2>&1)" || bootstrapped=0

# PHASE TWO: only a heartbeat written since the start proves the new copy serves.
fresh=0
waited=0
if [ "$bootstrapped" -eq 1 ]; then
  while :; do
    now_beat="$(heartbeat_identity)"
    if [ -n "$now_beat" ] && [ "$now_beat" != "$before" ]; then fresh=1; break; fi
    [ "$waited" -lt "$heartbeat_wait" ] || break
    sleep 1
    waited=$(( waited + 1 ))
  done
fi
if [ "$fresh" -eq 1 ]; then
  if [ -n "$kept" ]; then remove_copy "$kept" || printf 'the previous copy is still on disk: %s\n' "$kept" >&2; fi
  printf '%s\n' "$sha" > "$copies/current.tmp.$$"
  mv -f "$copies/current.tmp.$$" "$copies/current"
  printf 'Installed %s; it runs the copy %s (commit %s of %s); check it with: %s gh-broker status\n' "$plist" "$new" "$sha" "$src" "$new/bin/rmd"
  sharing="$(ls -lde "$pace_dir" | sed -n 's/.*user:\([A-Za-z0-9._-]*\) allow.*/\1/p' | sort -u | tr '\n' ' ')"
  printf 'login: %s; pace directory %s %s; accounts sharing this pacer: %s; codex-cli: %s\n' "$login" "$pace_dir" "$pace_action" "${sharing:-$account}" "$codex_version"
  exit 0
fi

if [ "$bootstrapped" -eq 0 ]; then
  printf 'launchctl bootstrap failed: %s\n' "$boot_error" >&2
  printf 'If `launchctl print-disabled gui/%s` lists %s as disabled, enable it and run this installer again: %s\n' "$uid" "$label" "$enable_hint" >&2
else
  printf 'the new agent wrote no heartbeat at %s within %ss\n' "$heartbeat" "$heartbeat_wait" >&2
fi
printf 'the agent log says why: %s\n' "$err_log" >&2
# Go back only to something that can run: a kept copy, or an in-place program that is still there.
if [ -n "$prev_body" ] && { [ -n "$kept" ] || { [ -n "$prev_prog" ] && [ -z "$prev_copy" ] && [ -x "$prev_prog" ]; }; }; then
  # The service stopped here is the new agent, or the old one still on its way out: the previous agent can
  # be started only once launchd has let go of it, exactly as in phase one.
  gone=1
  stop_agent || gone=0
  remove_copy "$new" || true
  if [ -n "$kept" ] && [ "$kept" != "$prev_copy" ]; then mv "$kept" "$prev_copy"; fi
  write_plist "$prev_body"
  if launchctl bootstrap "gui/$uid" "$plist" 2>/dev/null; then
    printf 'the previous agent is back, running %s\n' "$prev_prog" >&2
  elif [ "$gone" -eq 0 ]; then
    printf 'the previous agent file is back (%s) but launchd still lists %s %ss after it was told to stop it, so the previous agent is NOT running\n' "$prev_prog" "$service" "$heartbeat_wait" >&2
    printf 'Once `launchctl print %s` fails, start it with: launchctl bootstrap gui/%s %s\n' "$service" "$uid" "$plist" >&2
  else
    printf 'the previous agent file is back (%s) but launchctl would not start it\n' "$prev_prog" >&2
  fi
else
  printf 'there is no previous install to go back to: the new agent and its copy %s stay in place\n' "$new" >&2
fi
exit 1
