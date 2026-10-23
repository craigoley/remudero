#!/usr/bin/env bash
# rmd-session-reaper: the Azure host's hourly session and process reaper, run as root.
# Why it exists: deploy/mac/JANITOR.md, "Session and process reaper" (the 2026-10-20 incident).
#
# 1. Leaked processes. SIGTERM, then SIGKILL after the grace, only a process that:
#    - lives in a session-*.scope whose session is closing, unknown to logind, or has a dead
#      leader (nothing outside session scopes is read);
#    - has PID 1 as its parent, or descends from such a process inside the same scope;
#    - is not sshd, systemd or logind, and has no terminal multiplexer above it (a detached tmux
#      is the operator's live work);
#    - has a deleted cwd, or provably used no CPU for six hours (the janitor's idle window): by
#      the kernel's se.exec_start for every thread, or by utime+stime unchanged since this
#      reaper's own observation six hours earlier.
#    A descendant of a root stopped this pass follows it when its stdout reaches nobody outside
#    the subtree; an existing file or an outside reader keeps it (stdout_verdict).
# 2. Orphan sessions. A proven orphan is closing, its scope is gone (not-found, or inactive with no
#    tasks, and no /proc cgroup member), and no process but logind holds its ref fifo. One proven
#    orphan means logind lost PID 1's signals: restart logind once, then verify it is active and
#    the session count dropped, or REFUSE. There is no count threshold.
# Every decision is one line (KEEP, STOP, ORPHAN, RESTART, REFUSE), then one summary line. Only
# comm and exe are logged, never a cmdline or environment. DRY_RUN=1 signals, restarts and writes
# nothing. Exit 0 done, 1 any REFUSE, 2 cannot run. Scheduled by deploy/install-host-units.sh
# (rmd-session-reaper.timer); pinned by test/deploy/the-session-reaper-*.test.ts.
set -uo pipefail
# Overrides, so a test drives a fixture: RMD_REAPER_{LOGINCTL,SYSTEMCTL,JOURNALCTL,KILL,FLOCK}
# (commands), RMD_REAPER_PROC (/proc), RMD_REAPER_SESSIONS_DIR (/run/systemd/sessions),
# RMD_REAPER_STATE_DIR (/var/lib/rmd-session-reaper), RMD_REAPER_UID, RMD_REAPER_NOW (epoch
# seconds) and RMD_REAPER_TERM_GRACE_S (10).
TAG="rmd-session-reaper"
IDLE_SECONDS=21600 # six hours: the janitor's IDLE window (operator ruling). Deliberately not an override.
DRY_RUN="${DRY_RUN:-0}"
LOGINCTL="${RMD_REAPER_LOGINCTL:-loginctl}"
SYSTEMCTL="${RMD_REAPER_SYSTEMCTL:-systemctl}"
JOURNALCTL="${RMD_REAPER_JOURNALCTL:-journalctl}"
KILL_CMD="${RMD_REAPER_KILL:-kill}"
FLOCK_CMD="${RMD_REAPER_FLOCK:-flock}"
PROC="${RMD_REAPER_PROC:-/proc}"
SESSIONS_DIR="${RMD_REAPER_SESSIONS_DIR:-/run/systemd/sessions}"
STATE_DIR="${RMD_REAPER_STATE_DIR:-/var/lib/rmd-session-reaper}"
STATE_FILE="$STATE_DIR/observations"
RUN_UID="${RMD_REAPER_UID:-$(id -u)}"
NOW="${RMD_REAPER_NOW:-$(date +%s)}"
TERM_GRACE="${RMD_REAPER_TERM_GRACE_S:-10}"
LOGIND_UNIT="systemd-logind.service"
TAB="$(printf '\t')"

log() { printf '%s\n' "$*"; }

case "$DRY_RUN" in 0|1) ;; *) log "REFUSE pass: DRY_RUN must be 0 or 1, not '$DRY_RUN'"; exit 2 ;; esac
case "$NOW" in ''|*[!0-9]*) log "REFUSE pass: RMD_REAPER_NOW is not epoch seconds: '$NOW'"; exit 2 ;; esac
case "$TERM_GRACE" in ''|*[!0-9]*) log "REFUSE pass: RMD_REAPER_TERM_GRACE_S is not whole seconds: '$TERM_GRACE'"; exit 2 ;; esac

log "$TAG: pass $(date -u +%Y-%m-%dT%H:%M:%SZ) uid=$RUN_UID dry_run=$DRY_RUN pid=$$"
if [ "$RUN_UID" != 0 ]; then
  log "REFUSE pass: not root (uid $RUN_UID); another user's processes and fds are invisible, so nothing can be proven"
  exit 2
fi

# A pass that dies before its summary (bash 3.2 even exits 0 on an unbound name in arithmetic) is
# not a success: it is reported and fails.
PASS_DONE=0
on_exit() {
  local rc=$?
  if [ "$PASS_DONE" != 1 ] && [ "$rc" = 0 ]; then log "REFUSE pass: ended before its summary line"; exit 1; fi
}
trap on_exit EXIT

REFUSED=0
refuse() { log "REFUSE $*"; REFUSED=$(( REFUSED + 1 )); }

# One pass at a time. A pass wedged on an unanswering logind must not be joined by the next one.
if [ "$DRY_RUN" != 1 ]; then
  if ! ( umask 077; mkdir -p "$STATE_DIR" ) 2>/dev/null; then
    log "REFUSE pass: cannot create state directory $STATE_DIR"; exit 2
  fi
  if command -v "$FLOCK_CMD" >/dev/null 2>&1; then
    if ! exec 9>>"$STATE_DIR/lock"; then log "REFUSE pass: cannot open lock $STATE_DIR/lock"; exit 2; fi
    if ! "$FLOCK_CMD" -n 9 </dev/null; then
      log "REFUSE pass: another pass still holds $STATE_DIR/lock"
      log "$TAG: sessions unknown; logind not restarted; processes stopped 0, kept 0; last Removed session unknown"
      exit 1
    fi
  fi
fi

fmt_age() {
  local s="$1"
  if [ "$s" -ge 86400 ]; then printf '%sd %sh' "$(( s / 86400 ))" "$(( s % 86400 / 3600 ))"
  elif [ "$s" -ge 3600 ]; then printf '%sh %sm' "$(( s / 3600 ))" "$(( s % 3600 / 60 ))"
  else printf '%sm' "$(( s / 60 ))"; fi
}

# ── logind's view ─────────────────────────────────────────────────────────────────────────────────
# `show-session` prints properties in its own order, one blank-line-separated block per session,
# and aborts the batch at the first id that vanished meanwhile; missing ids are re-asked one by one.
parse_sessions() {
  awk 'BEGIN { RS = ""; FS = "\n" }
    { id = ""; st = ""; sc = ""; ld = ""
      for (i = 1; i <= NF; i++) {
        k = substr($i, 1, index($i, "=") - 1); v = substr($i, index($i, "=") + 1)
        if (k == "Id") id = v; else if (k == "State") st = v; else if (k == "Scope") sc = v; else if (k == "Leader") ld = v
      }
      if (id != "") print id "\t" (st == "" ? "-" : st) "\t" (sc == "" ? "-" : sc) "\t" (ld == "" ? "0" : ld) }'
}
# batched <cmd> <args...>: run cmd over stdin's ids, 256 at a time. Each batch ends in a blank line:
# without it the last block of one batch and the first of the next parse as one, losing a unit.
batched() { xargs -n 256 sh -c '"$0" "$@"; rc=$?; echo; exit "$rc"' "$@"; }
list_ids() { "$LOGINCTL" list-sessions --no-legend --no-pager </dev/null 2>/dev/null | awk '$1 ~ /^[[:alnum:]]+$/ { print $1 }'; }

if ! SESSION_IDS="$(list_ids)"; then
  refuse "pass: logind did not answer list-sessions"
  log "$TAG: sessions unknown; logind not restarted; processes stopped 0, kept 0; last Removed session unknown"
  exit 1
fi
SESSIONS=""
if [ -n "$SESSION_IDS" ]; then
  SESSIONS="$(printf '%s\n' "$SESSION_IDS" | batched "$LOGINCTL" show-session -p Id -p State -p Scope -p Leader 2>/dev/null | parse_sessions)"
  missing="$(printf '%s\n--\n%s\n' "$SESSIONS" "$SESSION_IDS" | awk -F'\t' '$0 == "--" { ids = 1; next } !ids { seen[$1] = 1; next } !($1 in seen)')"
  for id in $missing; do
    row="$("$LOGINCTL" show-session -p Id -p State -p Scope -p Leader "$id" </dev/null 2>/dev/null | parse_sessions)"
    [ -n "$row" ] && SESSIONS="${SESSIONS:+$SESSIONS
}$row"
  done
fi
SESSION_COUNT="$(printf '%s\n' "$SESSION_IDS" | awk 'NF { n++ } END { print n + 0 }')"
CLOSING_COUNT="$(printf '%s\n' "$SESSIONS" | awk -F'\t' '$2 == "closing" { n++ } END { print n + 0 }')"

session_row() { printf '%s\n' "$SESSIONS" | awk -F'\t' -v id="$1" '$1 == id { print; exit }'; }

# Journal signal: when did logind last finalise a session? Read before any restart writes new lines.
LAST_REMOVED="unknown"
jline="$("$JOURNALCTL" -r -u "$LOGIND_UNIT" --grep 'Removed session' -n 1 -o short-unix --no-pager -q </dev/null 2>/dev/null | head -n 1)"
jepoch="${jline%%[. ]*}"
case "$jepoch" in
  ''|*[!0-9]*) [ -z "$jline" ] || LAST_REMOVED="unknown (unparsed journal line)" ;;
  *) if [ "$NOW" -ge "$jepoch" ]; then LAST_REMOVED="$(fmt_age $(( NOW - jepoch ))) ago"; else LAST_REMOVED="in the future (clock skew)"; fi ;;
esac
log "$TAG: logind last logged 'Removed session' ${LAST_REMOVED}"

# ── the kernel's view ─────────────────────────────────────────────────────────────────────────────
# "<pid><TAB><scope>" for every process whose cgroup ends in a session scope. Nothing else is read.
scope_members() {
  grep -H -E '/session-[[:alnum:]]+\.scope$' "$PROC"/[0-9]*/cgroup 2>/dev/null | awk '
    { f = $0; sub(/:.*/, "", f); sub(/\/cgroup$/, "", f); pid = f; sub(/.*\//, "", pid)
      scope = $0; sub(/.*\//, "", scope); if (pid ~ /^[0-9]+$/) print pid "\t" scope }' | sort -u
}

# proc_start <pid> -> the start time (field 22), empty when the pid is gone or a zombie.
proc_start() {
  local st rest
  IFS= read -r st 2>/dev/null < "$PROC/$1/stat" || return 1
  rest="${st##*) }"
  set -f; set -- $rest; set +f
  [ "$#" -ge 20 ] || return 1
  [ "$1" != Z ] || return 1
  printf '%s' "${20}"
}

# ── 1. leaked processes ───────────────────────────────────────────────────────────────────────────
MEMBERS="$(scope_members)"
PROCS=""   # pid ppid scope ticks start comm exe cwd_deleted
while IFS="$TAB" read -r pid scope; do
  [ -n "$pid" ] || continue
  IFS= read -r st 2>/dev/null < "$PROC/$pid/stat" || continue
  rest="${st##*) }"
  set -f; set -- $rest; set +f
  [ "$#" -ge 20 ] || continue
  [ "$1" != Z ] || continue
  case "$2:${12}:${13}:${20}" in *[!0-9:]*) continue ;; esac
  ppid="$2"; ticks=$(( ${12} + ${13} )); start="${20}"
  comm=""; IFS= read -r comm 2>/dev/null < "$PROC/$pid/comm"
  comm="${comm//[[:space:]]/_}"; [ -n "$comm" ] || comm="?"
  exe="$(readlink "$PROC/$pid/exe" 2>/dev/null)"; exe="${exe//$TAB/_}"; [ -n "$exe" ] || exe="?"
  cwd="$(readlink "$PROC/$pid/cwd" 2>/dev/null)"
  case "$cwd" in *" (deleted)") deleted=1 ;; *) deleted=0 ;; esac
  PROCS="${PROCS}${pid}${TAB}${ppid}${TAB}${scope}${TAB}${ticks}${TAB}${start}${TAB}${comm}${TAB}${exe}${TAB}${deleted}
"
done <<EOF
$MEMBERS
EOF

# Walk each process up its ppid chain while the parent is in the SAME scope: the top of that chain
# is its root; it is re-parented when the root's parent is PID 1. A multiplexer anywhere on the
# chain (self included) guards the whole subtree.
CHAINS="$(printf '%s' "$PROCS" | awk -F'\t' '
  function base(e) { sub(/ \(deleted\)$/, "", e); sub(/.*\//, "", e); return e }
  function mux(c, e,   b) { b = base(e)
    return c ~ /^(tmux|screen|SCREEN|zellij|dtach|abduco|mosh-server)/ || b ~ /^(tmux|screen|zellij|dtach|abduco|mosh-server)$/ }
  NF >= 8 { pp[$1] = $2; sc[$1] = $3; cm[$1] = $6; ex[$1] = $7; order[n++] = $1 }
  END { for (i = 0; i < n; i++) { p = order[i]; cur = p; guard = "-"; hops = 0
      while (1) {
        if (guard == "-" && mux(cm[cur], ex[cur])) guard = cm[cur] "(" cur ")"
        par = pp[cur]
        if ((par in sc) && sc[par] == sc[p] && hops < 4096) { cur = par; hops++ } else break
      }
      print p "\t" (pp[cur] == 1 ? 1 : 0) "\t" guard "\t" cur } }')"

# last_on_cpu_ms <pid>: the newest se.exec_start over the process's threads, empty when unreadable.
last_on_cpu_ms() {
  awk '/^se\.exec_start[[:space:]]/ { v = $NF; sub(/\..*/, "", v); if (v ~ /^[0-9]+$/) { if (v + 0 > m + 0) m = v; n++ } }
    END { if (n) print m }' "$PROC/$1"/task/*/sched 2>/dev/null
}
SCHED_NOW_MS="$(awk '/^se\.exec_start[[:space:]]/ { v = $NF; sub(/\..*/, "", v); if (v ~ /^[0-9]+$/) print v; exit }' "$PROC/self/sched" 2>/dev/null)"

OLD_OBS=""; [ -r "$STATE_FILE" ] && OLD_OBS="$(cat "$STATE_FILE" 2>/dev/null)"
NEW_OBS=""
STOPS=""   # pid start
PENDING="" # descendants kept so far: pid start root what whence seen
stop_one() {
  if [ "$DRY_RUN" = 1 ]; then log "STOP $3: $4 (dry run: not signalled)"; else log "STOP $3: $4"; fi
  STOPS="${STOPS}$1 $2
"
  STOPPED=$(( STOPPED + 1 ))
}
STOPPED=0; KEPT=0
VERDICTS=""  # "<sid><TAB><verdict>" cache: gone:<why> | live:<why>

# session_verdict <sid> sets VERDICT (no subshell, so the cache survives across processes).
VERDICT=""
session_verdict() {
  local sid="$1" cached row state leader out
  cached="$(printf '%s' "$VERDICTS" | awk -F'\t' -v s="$sid" '$1 == s { print $2; exit }')"
  if [ -n "$cached" ]; then VERDICT="$cached"; return; fi
  row="$(session_row "$sid")"
  if [ -n "$row" ]; then
    state="$(printf '%s' "$row" | cut -f2)"; leader="$(printf '%s' "$row" | cut -f4)"
    if [ "$state" = closing ]; then cached="gone:session $sid is closing"
    elif [ "$leader" != 0 ] && [ -n "$leader" ] && ! proc_start "$leader" >/dev/null; then cached="gone:session $sid leader $leader is dead"
    else cached="live:session $sid is $state with leader $leader alive"; fi
  else
    # Absent from the listing. Only logind's own "No session" answer proves absence; a failure to
    # answer at all is not proof, and the processes stay.
    out="$("$LOGINCTL" show-session -p State "$sid" </dev/null 2>&1)"
    case "$out" in
      *"No session"*) cached="gone:session $sid is unknown to logind" ;;
      State=*) cached="live:session $sid is ${out#State=}" ;;
      *) cached="live:session $sid could not be confirmed absent" ;;
    esac
  fi
  VERDICTS="${VERDICTS}${sid}${TAB}${cached}
"
  VERDICT="$cached"
}

while IFS="$TAB" read -r pid ppid scope ticks start comm exe deleted; do
  [ -n "$pid" ] || continue
  what="pid=$pid comm=$comm exe=$exe scope=$scope"
  sid="${scope#session-}"; sid="${sid%.scope}"
  session_verdict "$sid"; verdict="$VERDICT"
  case "$verdict" in live:*) log "KEEP $what: ${verdict#live:}"; KEPT=$(( KEPT + 1 )); continue ;; esac
  why="${verdict#gone:}"
  exe_base="${exe% (deleted)}"; exe_base="${exe_base##*/}"
  case "$comm" in sshd*|systemd*|"(sd-pam)") log "KEEP $what: $comm is never stopped"; KEPT=$(( KEPT + 1 )); continue ;; esac
  case "$exe_base" in sshd*|systemd*) log "KEEP $what: $exe_base is never stopped"; KEPT=$(( KEPT + 1 )); continue ;; esac
  chain="$(printf '%s\n' "$CHAINS" | awk -F'\t' -v p="$pid" '$1 == p { print $2 "\t" $3 "\t" $4; exit }')"
  reparented="$(printf '%s' "$chain" | cut -f1)"; guard="$(printf '%s' "$chain" | cut -f2)"; root="$(printf '%s' "$chain" | cut -f3)"
  if [ "$guard" != "-" ] && [ -n "$guard" ]; then
    log "KEEP $what: under terminal multiplexer $guard, the operator's detached work"; KEPT=$(( KEPT + 1 )); continue
  fi
  if [ "$reparented" != 1 ]; then
    log "KEEP $what: its chain in $scope does not reach a process re-parented to PID 1"; KEPT=$(( KEPT + 1 )); continue
  fi
  if [ "$root" = "$pid" ]; then lineage="re-parented to PID 1"; else lineage="descends from re-parented pid $root"; fi
  prev="$(printf '%s\n' "$OLD_OBS" | awk -v p="$pid" -v s="$start" '$1 == p && $2 == s { print $3 " " $4; exit }')"
  since="$NOW"; seen="first observation"
  if [ -n "$prev" ]; then
    if [ "${prev%% *}" = "$ticks" ]; then since="${prev#* }"; seen="no CPU since an observation $(fmt_age $(( NOW - since ))) ago"
    else seen="used CPU since the last observation"; fi
  fi
  case "$since" in ''|*[!0-9]*) since="$NOW" ;; esac
  NEW_OBS="${NEW_OBS}${pid} ${start} ${ticks} ${since}
"
  # The kernel's own record of the same fact: se.exec_start is when a thread last went on a CPU, in
  # the scheduler clock that the reading process's own entry dates "now" in. The newest of all the
  # process's threads counts. It lets the first pass act on a process idle for days.
  ran_ago=""
  last_ms="$(last_on_cpu_ms "$pid")"
  if [ -n "$last_ms" ] && [ -n "$SCHED_NOW_MS" ] && [ "$SCHED_NOW_MS" -ge "$last_ms" ]; then
    ran_ago=$(( (SCHED_NOW_MS - last_ms) / 1000 ))
  fi
  if [ "$deleted" = 1 ]; then
    reason="cwd deleted"
  elif [ -n "$ran_ago" ] && [ "$ran_ago" -ge "$IDLE_SECONDS" ]; then
    reason="not on a CPU for $(fmt_age "$ran_ago") by the kernel's scheduler record (window 6h)"
  elif [ $(( NOW - since )) -ge "$IDLE_SECONDS" ]; then
    reason="no CPU for $(fmt_age $(( NOW - since ))) (window 6h)"
  else
    [ -z "$ran_ago" ] || seen="$seen, last on a CPU $(fmt_age "$ran_ago") ago"
    if [ "$root" != "$pid" ]; then   # judged again below, once it is known whether its root stops
      PENDING="${PENDING}${pid}${TAB}${start}${TAB}${root}${TAB}${what}${TAB}${why}, ${lineage}${TAB}${seen} (window 6h)
"
      continue
    fi
    log "KEEP $what: $why, $lineage, $seen (window 6h)"; KEPT=$(( KEPT + 1 )); continue
  fi
  stop_one "$pid" "$start" "$what" "$why, $lineage, $reason"
done <<EOF
$PROCS
EOF

# stdout_verdict <pid> <root>: "stop:<why>" when the process's stdout (fd 1) reaches nobody outside
# its root's subtree (a pipe or socket no outside process holds, a deleted file, a gone tty), else
# "keep:<why>". An existing regular file or an outside reader is a deliberate watcher, and stays.
stdout_verdict() {
  local pid="$1" root="$2" t pat subtree holder hp
  t="$(readlink "$PROC/$pid/fd/1" 2>/dev/null)"
  case "$t" in
    '') echo "keep:its stdout is unreadable" ;;
    pipe:\[*\]|socket:\[*\])
      subtree="$(printf '%s\n' "$CHAINS" | awk -F'\t' -v r="$root" '$4 == r { print $1 }')"
      pat="${t//\[/\\[}"; pat="${pat//\]/\\]}"
      for holder in $(find "$PROC"/[0-9]*/fd -mindepth 1 -maxdepth 1 -lname "$pat" 2>/dev/null); do
        hp="${holder#"$PROC"/}"; hp="${hp%%/*}"
        # A case match, not `printf | grep -q`: under pipefail, grep's early exit SIGPIPEs printf
        # and the pipeline reads as "no match", calling a subtree member an outside holder.
        case "
$subtree
" in *"
$hp
"*) ;; *) echo "keep:its stdout $t is held by pid $hp outside the subtree"; return ;; esac
      done
      echo "stop:its stdout $t has no holder outside the subtree of stopped pid $root" ;;
    *" (deleted)") echo "stop:its stdout is a deleted file" ;;
    /dev/pts/*|/dev/tty*) if [ -e "$t" ]; then echo "keep:its stdout is the tty $t"; else echo "stop:its stdout tty $t no longer exists"; fi ;;
    *) echo "keep:its stdout is $t" ;;
  esac
}
# A descendant of a root stopped above follows it when its output goes nowhere (the 2026-10-23
# `docker logs -f | tail` pipeline under an idle bash): its own CPU use does not keep it.
while IFS="$TAB" read -r pid start root what whence seen; do
  [ -n "$pid" ] || continue
  if ! printf '%s' "$STOPS" | awk -v r="$root" '$1 == r { f = 1 } END { exit !f }'; then
    log "KEEP $what: $whence, $seen"; KEPT=$(( KEPT + 1 )); continue
  fi
  out="$(stdout_verdict "$pid" "$root")"
  case "$out" in
    stop:*) stop_one "$pid" "$start" "$what" "$whence, ${out#stop:}" ;;
    *) log "KEEP $what: $whence, $seen; its root $root stops, but ${out#keep:}"; KEPT=$(( KEPT + 1 )) ;;
  esac
done <<EOF
$PENDING
EOF

# Signal: TERM every stop at once, wait out one grace, KILL whatever remains. A pid is signalled
# only while its start time still matches, so a recycled pid is never hit.
alive() { [ "$(proc_start "$1")" = "$2" ]; }
wait_gone() {
  local waited=0 pid start any
  while :; do
    any=0
    while read -r pid start; do [ -n "$pid" ] && alive "$pid" "$start" && any=1; done <<EOF
$STOPS
EOF
    [ "$any" = 1 ] && [ "$waited" -lt "$TERM_GRACE" ] || break
    sleep 1; waited=$(( waited + 1 ))
  done
}
if [ "$DRY_RUN" != 1 ] && [ -n "$STOPS" ]; then
  while read -r pid start; do
    [ -n "$pid" ] && alive "$pid" "$start" && "$KILL_CMD" -TERM "$pid" </dev/null 2>/dev/null
  done <<EOF
$STOPS
EOF
  wait_gone
  while read -r pid start; do
    if [ -n "$pid" ] && alive "$pid" "$start"; then
      log "STOP pid=$pid: still running ${TERM_GRACE}s after SIGTERM; sending SIGKILL"
      "$KILL_CMD" -KILL "$pid" </dev/null 2>/dev/null
    fi
  done <<EOF
$STOPS
EOF
  wait_gone
  while read -r pid start; do
    if [ -n "$pid" ] && alive "$pid" "$start"; then refuse "pid=$pid: still running after SIGKILL"; fi
  done <<EOF
$STOPS
EOF
fi

if [ "$DRY_RUN" != 1 ]; then
  if ( umask 077; printf '%s' "$NEW_OBS" > "$STATE_FILE.tmp.$$" ) 2>/dev/null && mv -f "$STATE_FILE.tmp.$$" "$STATE_FILE"; then :
  else rm -f "$STATE_FILE.tmp.$$"; refuse "observations: cannot write $STATE_FILE"; fi
fi

# ── 2. orphan sessions ────────────────────────────────────────────────────────────────────────────
# Read AFTER the stops, so a scope they just emptied is judged as it is now.
MEMBERS="$(scope_members)"
CLOSING_SCOPES="$(printf '%s\n' "$SESSIONS" | awk -F'\t' '$2 == "closing" && $3 != "-" { print $3 }')"
SCOPES=""
if [ -n "$CLOSING_SCOPES" ]; then
  SCOPES="$(printf '%s\n' "$CLOSING_SCOPES" | batched "$SYSTEMCTL" show -p Id -p LoadState -p ActiveState -p TasksCurrent 2>/dev/null | awk '
    BEGIN { RS = ""; FS = "\n" }
    { id = ""; ld = ""; ac = ""; tk = ""
      for (i = 1; i <= NF; i++) {
        k = substr($i, 1, index($i, "=") - 1); v = substr($i, index($i, "=") + 1)
        if (k == "Id") id = v; else if (k == "LoadState") ld = v; else if (k == "ActiveState") ac = v; else if (k == "TasksCurrent") tk = v
      }
      gsub(/[[:space:]]/, "_", tk)
      if (id != "") print id "\t" (ld == "" ? "?" : ld) "\t" (ac == "" ? "?" : ac) "\t" (tk == "" ? "?" : tk) }')"
fi
# "<ref path><TAB><pid><TAB><comm>" for every session ref fifo held by a process other than logind,
# which holds the read end of every live session's fifo and so proves nothing.
HELD=""
for fd in $(find "$PROC"/[0-9]*/fd -mindepth 1 -maxdepth 1 -lname "$SESSIONS_DIR/*.ref" 2>/dev/null); do
  hp="${fd#"$PROC"/}"; hp="${hp%%/*}"
  hc=""; IFS= read -r hc 2>/dev/null < "$PROC/$hp/comm"
  [ "$hc" = systemd-logind ] && continue
  HELD="${HELD}$(readlink "$fd" 2>/dev/null)${TAB}${hp}${TAB}${hc//[[:space:]]/_}
"
done

# One join over the four views, so ~3,000 closing sessions cost one awk, not three per session.
ORPHAN_LINES="$({
  printf '%s\n' "$SESSIONS" | sed "s/^/S$TAB/"
  printf '%s\n' "$SCOPES" | sed "s/^/U$TAB/"
  printf '%s\n' "$MEMBERS" | sed "s/^/M$TAB/"
  printf '%s' "$HELD" | sed "s/^/H$TAB/"
} | awk -F'\t' -v refdir="$SESSIONS_DIR" '
  $1 == "S" && $3 == "closing" { ids[++n] = $2; scope[$2] = $4; next }
  $1 == "U" { load[$2] = $3; act[$2] = $4; tasks[$2] = $5; next }
  $1 == "M" { members[$3]++; next }
  $1 == "H" { if (!($2 in holder)) holder[$2] = $4 "(" $3 ")"; next }
  END { for (i = 1; i <= n; i++) { id = ids[i]; u = scope[id]
      if (u == "-" || u == "") { print "KEEP session " id ": closing with no scope recorded"; continue }
      if (!(u in load)) { print "KEEP session " id ": systemd did not report " u; continue }
      if (load[u] != "not-found" && !((act[u] == "inactive" || act[u] == "failed") && (tasks[u] == "0" || tasks[u] == "[not_set]"))) {
        print "KEEP session " id ": closing, but " u " is " load[u] "/" act[u] " with " tasks[u] " tasks"; continue }
      if (members[u] > 0) { print "KEEP session " id ": closing, " u " is " load[u] ", but " members[u] " process(es) are still in its cgroup"; continue }
      r = refdir "/" id ".ref"
      if (r in holder) { print "KEEP session " id ": closing, but its ref fifo is held by " holder[r]; continue }
      print "ORPHAN session " id ": closing, " u " " load[u] "/" act[u] ", no process in its cgroup, ref fifo unheld" } }')"
[ -z "$ORPHAN_LINES" ] || log "$ORPHAN_LINES"
ORPHANS="$(printf '%s\n' "$ORPHAN_LINES" | awk '/^ORPHAN / { n++ } END { print n + 0 }')"

LOGIND_RESULT="not restarted (no proven orphan)"
if [ "$ORPHANS" -gt 0 ]; then
  if [ "$DRY_RUN" = 1 ]; then
    log "RESTART $LOGIND_UNIT: $ORPHANS proven orphan session(s) (dry run: not restarted)"
    LOGIND_RESULT="restart skipped (dry run)"
  else
    before="$(list_ids | awk 'NF { n++ } END { print n + 0 }')"
    "$SYSTEMCTL" restart "$LOGIND_UNIT" </dev/null 2>/dev/null; rc=$?
    state="$("$SYSTEMCTL" is-active "$LOGIND_UNIT" </dev/null 2>/dev/null)"
    if [ "$rc" != 0 ] || [ "$state" != active ]; then
      refuse "$LOGIND_UNIT: restart for $ORPHANS proven orphan(s) left it ${state:-unknown} (exit $rc)"
      LOGIND_RESULT="restart FAILED (${state:-unknown})"
    elif ! after_ids="$(list_ids)"; then
      refuse "$LOGIND_UNIT: restarted, but it does not answer list-sessions"
      LOGIND_RESULT="restarted, unreadable after"
    else
      after="$(printf '%s\n' "$after_ids" | awk 'NF { n++ } END { print n + 0 }')"
      if [ "$after" -lt "$before" ]; then
        log "RESTART $LOGIND_UNIT: $ORPHANS proven orphan session(s); sessions $before -> $after"
        LOGIND_RESULT="restarted ($before -> $after)"
      else
        refuse "$LOGIND_UNIT: restarted for $ORPHANS proven orphan(s), but sessions $before -> $after did not drop"
        LOGIND_RESULT="restarted, count did not drop ($before -> $after)"
      fi
    fi
  fi
fi

log "$TAG: sessions $SESSION_COUNT (closing $CLOSING_COUNT, orphans $ORPHANS); logind $LOGIND_RESULT; processes stopped $STOPPED, kept $KEPT; last Removed session $LAST_REMOVED"
PASS_DONE=1
[ "$REFUSED" -eq 0 ] || exit 1
exit 0
