#!/usr/bin/env bash
# phase: stopped
# codex-sessions-to-data-disk — move this instance's Codex sessions onto the persistent data disk (W1-T9071).
#
# Runs in the recycle's stopped window, so this instance's container is gone and writes nothing.
# Copies <codex_dir>/sessions ADDITIVELY into RMD_CODEX_SESSIONS_DIR (default /mnt/rmd/codex-sessions,
# the persistent data disk; /mnt/scratch is wiped by a deallocate), proves every settled file arrived,
# then writes <state-dir>/codex-sessions.ready so this instance's launchers bind it
# (deploy/codex-sessions-mount.sh). The source is pruned only when no other live container still
# writes it: one that binds the same codex dir without the new sessions bind.
# Exit 0 = done; anything else leaves the instance exactly as it was.
set -u

state_dir="${1:?state dir}"
codex_dir="${RECYCLE_ACTION_CODEX_DIR:-}"
src="${codex_dir}/sessions"
dst="${RMD_CODEX_SESSIONS_DIR:-/mnt/rmd/codex-sessions}"
docker_bin="${RMD_CODEX_SESSIONS_DOCKER:-docker}"

say() { printf 'codex-sessions-to-data-disk: %s\n' "$*"; }
stat_bin="${RMD_CODEX_SESSIONS_STAT:-stat}"
fs_id() { "${stat_bin}" -c %d "$1" 2>/dev/null || "${stat_bin}" -f %d "$1"; }

case "${codex_dir}" in /*) ;; *) say "REFUSED: no absolute codex dir"; exit 2 ;; esac
case "${dst}" in /*) ;; *) say "REFUSED: ${dst} is not absolute"; exit 2 ;; esac
[ -d "${src}" ] || { say "REFUSED: no sessions directory at ${src}"; exit 3; }
mkdir -p "${dst}" || { say "REFUSED: cannot create ${dst}"; exit 4; }
if [ "$(fs_id "${src}")" = "$(fs_id "${dst}")" ]; then
  say "REFUSED: ${dst} shares ${src}'s filesystem, so moving there frees nothing"; exit 5
fi
need_kb=$(( $(du -sk "${src}" | cut -f1) * 12 / 10 ))
free_kb="$(df -Pk "${dst}" | awk 'NR == 2 { print $4 }')"
[ "${free_kb:-0}" -gt "${need_kb}" ] || { say "REFUSED: ${dst} has ${free_kb:-0} KB free, needs ${need_kb} KB"; exit 6; }
# The recycle may run as root; the container user must own what it will write into.
if [ "$(id -u)" = 0 ]; then
  chown "$(stat -c %u:%g "${src}" 2>/dev/null || stat -f %u:%g "${src}")" "${dst}" || { say "REFUSED: cannot hand ${dst} to the sessions owner"; exit 4; }
fi

rsync -a "${src}/" "${dst}/" || { say "FAILED: copy into ${dst}"; exit 7; }
# Another live instance may still be writing the source; prove every SETTLED file (untouched for ten
# minutes) arrived intact, and let the next pass carry anything still growing.
missing=0
while IFS= read -r -d '' f; do
  rel="${f#"${src}"/}"
  if ! cmp -s "${f}" "${dst}/${rel}"; then missing=$((missing + 1)); fi
done < <(find "${src}" -type f -mmin +10 -print0)
[ "${missing}" -eq 0 ] || { say "FAILED: ${missing} settled file(s) differ in ${dst}"; exit 8; }
printf '%s\n' "${dst}" > "${state_dir}/codex-sessions.ready" || { say "FAILED: cannot write the ready file"; exit 9; }
say "copied ${src} into ${dst}; this instance binds it from its next launch"

# Prune only when nothing else writes the source. A container binding this codex dir at
# /home/node/.codex without ${dst} at its sessions path still writes there; an unreadable docker
# keeps everything.
writers=""
if ! names="$("${docker_bin}" ps --format '{{.Names}}' 2>/dev/null)"; then
  say "kept the source: docker could not be read"; exit 0
fi
for c in ${names}; do
  mounts="$("${docker_bin}" inspect --format '{{range .Mounts}}{{.Source}}={{.Destination}};{{end}}' "${c}" 2>/dev/null)" || { writers="${writers} ${c}(unreadable)"; continue; }
  case ";${mounts}" in
    *";${codex_dir}=/home/node/.codex;"*)
      case ";${mounts}" in *";${dst}=/home/node/.codex/sessions;"*) ;; *) writers="${writers} ${c}" ;; esac ;;
  esac
done
if [ -n "${writers}" ]; then
  say "kept the source: still written by${writers}"; exit 0
fi
rsync -a --remove-source-files "${src}/" "${dst}/" || { say "kept the source: the pruning pass failed"; exit 0; }
say "pruned ${src}: every file is in ${dst}"
exit 0
