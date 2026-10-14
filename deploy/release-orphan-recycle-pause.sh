#!/usr/bin/env bash
# release-orphan-recycle-pause — release a recycle's PAUSE once its writer is PROVABLY gone and nothing
# was stopped. Run by the watchdog tick (deploy/install-host-units.sh's rmd-relaunch) in its
# container-running branch, before the unchanged-tick exit, the same way it runs memory-high-tuner.sh.
#
#   deploy/release-orphan-recycle-pause.sh --container <name> --state-dir <config.root>
#
# W1-T9409. OBSERVED 2026-10-14: the watchdog's recycle (pid 405262) wrote state/PAUSE at 08:12:24Z and
# exited rc=2 one second later in its wait phase, before `docker stop`. Its only EXIT trap cleaned temp
# files, so the PAUSE held all core dispatch for ~2h45m with remudero-daemon still the old container. No
# trap covers SIGKILL either (the OOM killer on a thrashing host), so a check from OUTSIDE the writer is
# the only complete answer, and this host tick is the one actor that sees host pids and docker.

set -u

# NO TIMER AND NO THRESHOLD. A PAUSE is moved aside only when ALL of these hold:
#   (a) it parses and its `reason` is EXACTLY the recycle's. Anything else is an operator hold (W1-T4197)
#       and is kept, with no ledger row;
#   (b) `phase` is "waiting". After "stopping" the replacement path owns the PAUSE (W1-T5281);
#   (c) `host` is this host. Another host's pid cannot be judged here;
#   (d) the writer is dead: no process has `pid`, or the one that has it started at another time than
#       `writerStart` (the pid was reused);
#   (e) docker reports the recorded `container` Id running under `containerName`.
# Any unreadable input (docker or ps failing, a field missing) means KEEP. A release re-reads the body
# byte-for-byte, MOVES it to state/PAUSE.orphaned-recycle-<pid> (never deletes it) and appends one
# `recycle.orphan_pause_released` ledger row naming the evidence for (d) and (e).
#
# AN OLD-SHAPE BODY (no container, phase or writerStart, like 2026-10-14's) IS NEVER RELEASED. When its
# writer is dead on this host the tick ledgers `recycle.orphan_pause_unverifiable` once per body, for a
# human to act on.
#
# NEVER FATAL to the tick: every path exits 0 except a usage error.
ORP_REASON="container recycle (deploy/recycle-container.sh)"

# The writer's start time, in the exact normalised form deploy/recycle-container.sh records: C locale
# and UTC, so a session's LANG or TZ can never make a live writer read as a reused pid.
orp_lstart() {
  LC_ALL=C TZ=UTC ps -o lstart= -p "$1" 2>/dev/null | tr -s ' \t' '  ' | sed 's/^ *//; s/ *$//'
}

# "No process has this pid" needs TWO readings: ps shows nothing AND the kernel answers ESRCH. A pid
# hidden from ps (hidepid, another user) answers EPERM to `kill -0`, and that is a live process.
orp_no_such_process() {
  local out
  out="$(LC_ALL=C kill -0 "$1" 2>&1)" && return 1
  case "${out}" in *"No such process"*) return 0 ;; *) return 1 ;; esac
}

# A string field of the one-line JSON body (the recycle writes no spaces between tokens).
orp_str_field() {
  printf '%s\n' "$1" | sed -n 's/.*"'"$2"'":"\([^"]*\)".*/\1/p' | head -n 1
}
orp_has_field() {
  case "$1" in *"\"$2\":"*) return 0 ;; *) return 1 ;; esac
}

orp_json_escape() { printf '%s' "$1" | tr -d '"\\' | tr '\n\t' '  '; }

orp_ledger() {
  local ledger="$1" step="$2" fields="$3"
  printf '{"ts":"%s","run_id":"RECYCLE-ORPHAN-PAUSE","task_id":"RECYCLE","step":"%s","lane":"deploy",%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" "${step}" "${fields}" >> "${ledger}"
}

release_orphan_recycle_pause() {
  local container="" state_root=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --container) container="${2:-}"; shift 2 || shift ;;
      --state-dir) state_root="${2:-}"; shift 2 || shift ;;
      *) echo "release-orphan-recycle-pause: unknown argument $1" >&2; return 2 ;;
    esac
  done
  [ -n "${container}" ] && [ -n "${state_root}" ] ||
    { echo "release-orphan-recycle-pause: --container and --state-dir are required" >&2; return 2; }

  local state="${state_root}/state" pause body reason pid host this_host requested phase writer_start rec_id rec_name
  local self_start now_start writer_evidence inspect live_id running container_evidence aside again noted sum
  pause="${state}/PAUSE"
  [ -f "${pause}" ] || return 0
  body="$(cat "${pause}" 2>/dev/null)" || { echo "release-orphan-recycle-pause: keep — PAUSE unreadable"; return 0; }

  # (a) ONLY THE RECYCLE'S OWN ONE-LINE BODY. An operator hold is not ours to judge, and says nothing.
  case "${body}" in *$'\n'*) return 0 ;; esac
  reason="$(orp_str_field "${body}" reason)"
  [ "${reason}" = "${ORP_REASON}" ] || return 0

  pid="$(printf '%s\n' "${body}" | sed -n 's/.*"pid":\([0-9][0-9]*\).*/\1/p' | head -n 1)"
  host="$(orp_str_field "${body}" host)"
  requested="$(orp_str_field "${body}" requestedAt)"
  this_host="$(hostname 2>/dev/null || true)"
  if [ -z "${pid}" ] || [ -z "${host}" ] || [ -z "${this_host}" ]; then
    echo "release-orphan-recycle-pause: keep — the recycle PAUSE names no readable pid/host"
    return 0
  fi
  # (c) another host's pid cannot be judged from here.
  if [ "${host}" != "${this_host}" ]; then
    echo "release-orphan-recycle-pause: keep — the recycle PAUSE was written on ${host}, not ${this_host}"
    return 0
  fi

  # Positive control for (d): ps must be able to read THIS process's start time, or an empty answer
  # about the writer proves nothing.
  self_start="$(orp_lstart "$$")"
  if [ -z "${self_start}" ]; then
    echo "release-orphan-recycle-pause: keep — ps cannot read a start time on this host"
    return 0
  fi
  now_start="$(orp_lstart "${pid}")"

  # (4) AN OLD-SHAPE BODY IS NEVER RELEASED; a dead writer's is named once for a human.
  if ! orp_has_field "${body}" container || ! orp_has_field "${body}" phase || ! orp_has_field "${body}" writerStart; then
    if [ -z "${now_start}" ] && orp_no_such_process "${pid}"; then
      sum="$(printf '%s' "${body}" | cksum | tr -s ' ' ' ')"
      noted="$(cat "${state}/PAUSE.unverifiable-noted" 2>/dev/null || true)"
      if [ "${noted}" != "${sum}" ]; then
        orp_ledger "${state}/ledger.ndjson" recycle.orphan_pause_unverifiable \
          "\"writer_pid\":${pid},\"host\":\"$(orp_json_escape "${host}")\",\"requested_at\":\"$(orp_json_escape "${requested}")\",\"writer_evidence\":\"no process has pid ${pid}\",\"why\":\"the PAUSE predates W1-T9409 and records no container, phase or writerStart; a human must confirm nothing was stopped and move it aside\"" &&
          printf '%s\n' "${sum}" > "${state}/PAUSE.unverifiable-noted" 2>/dev/null
      fi
      echo "release-orphan-recycle-pause: keep — old-shape recycle PAUSE from dead pid ${pid}; it cannot be verified, so a human must release it" >&2
    else
      echo "release-orphan-recycle-pause: keep — old-shape recycle PAUSE; pid ${pid} is still a running process"
    fi
    return 0
  fi

  # (b) after "stopping" the old container may already be down; the replacement path owns the PAUSE.
  phase="$(orp_str_field "${body}" phase)"
  if [ "${phase}" != "waiting" ]; then
    echo "release-orphan-recycle-pause: keep — the recycle PAUSE is in phase '${phase:-unreadable}', not waiting"
    return 0
  fi

  # (d) the writer is dead: no process at the pid, or a different process reusing it.
  writer_start="$(orp_str_field "${body}" writerStart)"
  if [ -z "${writer_start}" ]; then
    echo "release-orphan-recycle-pause: keep — the recycle PAUSE records an empty writerStart"
    return 0
  fi
  if [ -z "${now_start}" ] && orp_no_such_process "${pid}"; then
    writer_evidence="no process has pid ${pid}"
  elif [ -z "${now_start}" ]; then
    echo "release-orphan-recycle-pause: keep — ps cannot read pid ${pid}, but the kernel says a process has it"
    return 0
  elif [ "${now_start}" != "${writer_start}" ]; then
    writer_evidence="pid ${pid} started ${now_start}, not the writer's ${writer_start} (reused)"
  else
    echo "release-orphan-recycle-pause: keep — the recycle writing it (pid ${pid}, started ${writer_start}) is still running"
    return 0
  fi

  # (e) the recorded container is still the running one, so nothing was stopped.
  rec_id="$(orp_str_field "${body}" container)"
  rec_name="$(orp_str_field "${body}" containerName)"
  if [ -z "${rec_id}" ] || [ -z "${rec_name}" ]; then
    echo "release-orphan-recycle-pause: keep — the recycle PAUSE records no container"
    return 0
  fi
  if [ "${rec_name}" != "${container}" ]; then
    echo "release-orphan-recycle-pause: keep — the recycle PAUSE names ${rec_name}, not this tick's ${container}"
    return 0
  fi
  if ! inspect="$(docker inspect --format '{{.Id}} {{.State.Running}}' "${rec_name}" 2>/dev/null)"; then
    echo "release-orphan-recycle-pause: keep — docker inspect ${rec_name} failed"
    return 0
  fi
  read -r live_id running _ <<< "${inspect}"
  if [ "${live_id}" != "${rec_id}" ] || [ "${running}" != "true" ]; then
    echo "release-orphan-recycle-pause: keep — ${rec_name} is ${live_id:-unreadable} running=${running:-unreadable}, not the recorded ${rec_id} running"
    return 0
  fi
  container_evidence="${rec_name} is still ${rec_id}, running"

  # Release: the body must still be byte-for-byte the one judged, and it is moved, never deleted.
  again="$(cat "${pause}" 2>/dev/null)" || return 0
  if [ "${again}" != "${body}" ]; then
    echo "release-orphan-recycle-pause: keep — the PAUSE changed while it was being judged"
    return 0
  fi
  aside="${state}/PAUSE.orphaned-recycle-${pid}"
  [ ! -e "${aside}" ] || aside="${aside}.$(date -u +%s)"
  if ! mv "${pause}" "${aside}" 2>/dev/null; then
    echo "release-orphan-recycle-pause: keep — could not move the PAUSE aside" >&2
    return 0
  fi
  orp_ledger "${state}/ledger.ndjson" recycle.orphan_pause_released \
    "\"writer_pid\":${pid},\"host\":\"$(orp_json_escape "${host}")\",\"writer_start\":\"$(orp_json_escape "${writer_start}")\",\"container\":\"$(orp_json_escape "${rec_id}")\",\"container_name\":\"$(orp_json_escape "${rec_name}")\",\"requested_at\":\"$(orp_json_escape "${requested}")\",\"writer_evidence\":\"$(orp_json_escape "${writer_evidence}")\",\"container_evidence\":\"$(orp_json_escape "${container_evidence}")\",\"moved_to\":\"$(orp_json_escape "${aside}")\"" ||
    echo "release-orphan-recycle-pause: the ledger row could not be written" >&2
  echo "release-orphan-recycle-pause: RELEASED the recycle PAUSE of dead pid ${pid} (${writer_evidence}; ${container_evidence}) — moved to ${aside}"
  return 0
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  release_orphan_recycle_pause "$@"
fi
