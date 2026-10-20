#!/bin/bash
# W1-T10279: install this Mac account's GitHub read broker as a per-account launchd agent that keeps
# `rmd gh-broker serve` running. Installed like the Mac janitor: account-local, never fleet runtime,
# nothing on Azure changes. --dry-run prints the agent and the launchctl commands and changes nothing.
set -euo pipefail
umask 077
label=com.remudero.gh-read-broker
rmd="${REMUDERO_RMD_BIN:-$HOME/Remudero/remudero/bin/rmd}"
dry_run=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=1; shift ;;
    --rmd) [ "$#" -ge 2 ] && [ -n "$2" ] || { printf 'the rmd path is required\n' >&2; exit 2; }; rmd="$2"; shift 2 ;;
    *) printf 'usage: %s [--rmd /abs/path/to/bin/rmd] [--dry-run]\n' "$0" >&2; exit 2 ;;
  esac
done
case "$rmd" in /*) ;; *) printf 'the rmd path must be absolute (launchd runs it with no shell and no PATH search)\n' >&2; exit 2 ;; esac
[ -x "$rmd" ] || { printf 'not executable: %s\n' "$rmd" >&2; exit 2; }
agents="$HOME/Library/LaunchAgents"
plist="$agents/$label.plist"
logs="$HOME/Library/Logs"
uid="$(id -u)"
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
  exit 0
fi
mkdir -p "$agents" "$logs"
printf '%s\n' "$body" > "$plist.tmp.$$"
mv -f "$plist.tmp.$$" "$plist"
launchctl bootout "gui/$uid/$label" 2>/dev/null || true
launchctl bootstrap "gui/$uid" "$plist"
printf 'Installed %s; check it with: %s gh-broker status\n' "$plist" "$rmd"
