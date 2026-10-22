#!/bin/bash
# W1-T10279: install this Mac account's GitHub read broker as a per-account launchd agent that keeps
# `rmd gh-broker serve` running. Installed like the Mac janitor: account-local, never fleet runtime,
# nothing on Azure changes. --dry-run prints the agent and the launchctl commands and changes nothing.
#
# W1-T10302: it also records the GitHub login this account's gh reads as and joins the per-login SHARED PACE
# directory, /Users/Shared/remudero/gh-pace/<login>/, that every Mac account reading as that login shares. It
# holds timing numbers and refusal counts only (never a response, a header value or a token). Mode 0700 plus an
# ACL naming exactly the accounts this installer was run for; never world-writable. The first account creates
# it; a later account JOINS it by adding itself to the ACL (which needs the directory's owner or sudo: running
# the installer on that account is the operator's approval). Each account keeps its own broker, socket, cache.
set -euo pipefail
umask 077
label=com.remudero.gh-read-broker
rmd="${REMUDERO_RMD_BIN:-$HOME/Remudero/remudero/bin/rmd}"
dry_run=0
pace_root="${REMUDERO_GH_PACE_ROOT:-/Users/Shared/remudero/gh-pace}"
login="${REMUDERO_GH_LOGIN:-}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=1; shift ;;
    --login) [ "$#" -ge 2 ] && [ -n "$2" ] || { printf 'the login is required\n' >&2; exit 2; }; login="$2"; shift 2 ;;
    --rmd) [ "$#" -ge 2 ] && [ -n "$2" ] || { printf 'the rmd path is required\n' >&2; exit 2; }; rmd="$2"; shift 2 ;;
    *) printf 'usage: %s [--rmd /abs/path/to/bin/rmd] [--login <github login>] [--dry-run]\n' "$0" >&2; exit 2 ;;
  esac
done
case "$rmd" in /*) ;; *) printf 'the rmd path must be absolute (launchd runs it with no shell and no PATH search)\n' >&2; exit 2 ;; esac
[ -x "$rmd" ] || { printf 'not executable: %s\n' "$rmd" >&2; exit 2; }
agents="$HOME/Library/LaunchAgents"
plist="$agents/$label.plist"
logs="$HOME/Library/Logs"
uid="$(id -u)"
account="$(id -un)"
acl_entry="user:$account allow list,add_file,search,add_subdirectory,delete_child,readattr,writeattr,readextattr,writeextattr,readsecurity,file_inherit,directory_inherit"
codex_version="none found"
if command -v codex >/dev/null 2>&1; then codex_version="$(codex --version 2>/dev/null | head -n 1 || true)"; fi
valid_login() { printf '%s' "$1" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9-]*$'; }
# launchd's own PATH omits Homebrew, where gh lives on this Mac.
path_env="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
xml_escape() { printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'; }
body="<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$rmd")</string>
    <string>gh-broker</string>
    <string>serve</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$path_env</string>
    <key>HOME</key><string>$(xml_escape "$HOME")</string>
  </dict>
  <key>KeepAlive</key><true/>
  <key>RunAtLoad</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$(xml_escape "$logs/remudero-gh-read-broker.out.log")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$logs/remudero-gh-read-broker.err.log")</string>
</dict>
</plist>"
if [ "$dry_run" -eq 1 ]; then
  printf '%s\n' "$body"
  printf 'would write %s\n' "$plist"
  printf 'would run: launchctl bootout gui/%s/%s (ignored if absent)\n' "$uid" "$label"
  printf 'would run: launchctl bootstrap gui/%s %s\n' "$uid" "$plist"
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
mkdir -p "$agents" "$logs"
printf '%s\n' "$body" > "$plist.tmp.$$"
mv -f "$plist.tmp.$$" "$plist"
launchctl bootout "gui/$uid/$label" 2>/dev/null || true
launchctl bootstrap "gui/$uid" "$plist"
printf 'Installed %s; check it with: %s gh-broker status\n' "$plist" "$rmd"
sharing="$(ls -lde "$pace_dir" | sed -n 's/.*user:\([A-Za-z0-9._-]*\) allow.*/\1/p' | sort -u | tr '\n' ' ')"
printf 'login: %s; pace directory %s %s; accounts sharing this pacer: %s; codex-cli: %s\n' "$login" "$pace_dir" "$pace_action" "${sharing:-$account}" "$codex_version"
