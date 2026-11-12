#!/bin/bash
# Install maintained account-aware code; legacy admission retirement is explicit.
set -euo pipefail
umask 022
src=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
shared=0
shared_root=/Users/Shared
retire_legacy=0
code_only=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --shared) shared=1; shift ;;
    --shared-root) [ "$#" -ge 2 ] && [ -n "$2" ] || { printf 'shared root is required\n' >&2; exit 2; }; shared=1; shared_root="$2"; shift 2 ;;
    --retire-legacy-sweeper) retire_legacy=1; shift ;;
    --code-only) code_only=1; shift ;;
    *) printf 'usage: %s [--shared | --shared-root PATH] [--retire-legacy-sweeper | --code-only]\n' "$0" >&2; exit 2 ;;
  esac
done
[ "$code_only" = 0 ] || [ "$retire_legacy" = 0 ] || { printf -- '--code-only cannot retire the legacy sweeper\n' >&2; exit 2; }
if [ "$shared" = 1 ]; then
  case "$shared_root" in /*) ;; *) printf 'shared root must be absolute\n' >&2; exit 2 ;; esac
  dest="$shared_root/remudero-mac"
  [ ! -L "$shared_root" ] && [ ! -L "$dest" ] || { printf 'shared install must not follow a directory symlink\n' >&2; exit 2; }
else
  dest="${REMUDERO_JANITOR_INSTALL_DIR:-$HOME/bin}"
fi
# Validate the complete source set before replacing any installed file.
for file in "$src/../workspace-retirement-guard.sh" "$src/../dependency-seed-guard.sh" \
  "$src/tmp-reclaim.sh" "$src/remudero-janitor.sh" "$src/remudero-mac-janitor.sh" \
  "$src/cache-reclaim.py" "$src/retire-legacy-sweeper.py" "$src/preserve-retire.py"; do
  [ -r "$file" ] || { printf 'missing maintained source: %s\n' "$file" >&2; exit 2; }
done
mkdir -p "$dest"
for name in workspace-retirement-guard.sh dependency-seed-guard.sh; do
  install -m 0755 "$src/../$name" "$dest/$name.tmp.$$"
  mv -f "$dest/$name.tmp.$$" "$dest/$name"
done
# The regular janitor owns generated-cache discovery as well as workspace
# retirement; keep its delegated cache-only helper on the same installed source.
install -m 0755 "$src/tmp-reclaim.sh" "$dest/tmp-reclaim.sh.tmp.$$"
mv -f "$dest/tmp-reclaim.sh.tmp.$$" "$dest/tmp-reclaim.sh"
for name in cache-reclaim.py retire-legacy-sweeper.py preserve-retire.py; do
  install -m 0755 "$src/$name" "$dest/$name.tmp.$$"
  mv -f "$dest/$name.tmp.$$" "$dest/$name"
done
target="$dest/remudero-janitor.sh"
if [ -f "$target" ] && ! cmp -s "$src/remudero-janitor.sh" "$target"; then
  cp -p "$target" "$target.pre-install-$(date -u +%Y%m%dT%H%M%SZ)"
fi
install -m 0755 "$src/remudero-janitor.sh" "$target.tmp.$$"
mv -f "$target.tmp.$$" "$target"
# --code-only (the scheduled refresh) replaces the code in $dest only: no launcher, no
# legacy retirement, and the install-source record stays as the first install wrote it.
if [ "$code_only" = 1 ]; then
  printf 'Installed code in %s; schedules and launcher unchanged.\n' "$dest"
  exit 0
fi
if [ "$shared" = 1 ]; then
  launcher="$shared_root/remudero-mac-janitor.sh"
  if [ -f "$launcher" ] && ! cmp -s "$src/remudero-mac-janitor.sh" "$launcher"; then
    cp -p "$launcher" "$launcher.pre-install-$(date -u +%Y%m%dT%H%M%SZ)"
  fi
  install -m 0755 "$src/remudero-mac-janitor.sh" "$launcher.tmp.$$"
  mv -f "$launcher.tmp.$$" "$launcher"
  printf 'Installed shared entry point %s (caller HOME/UID retained).\n' "$launcher"
fi
# Written last, after every copy: the checkout and layout that a scheduled refresh reads.
layout=home-bin; [ "$shared" = 0 ] || layout=shared
if common=$(unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR; cd "$src" && top=$(git rev-parse --show-toplevel 2>/dev/null) &&
  cd "$top" && gd=$(git rev-parse --git-common-dir 2>/dev/null) && cd "$gd" && pwd -P); then
  case "$common" in */.git) checkout=${common%/.git} ;; *) checkout=$common ;; esac
  origin=$(unset GIT_DIR GIT_WORK_TREE; git -C "$checkout" remote get-url origin 2>/dev/null) || origin=''
  printf 'checkout=%s\nlayout=%s\norigin=%s\n' "$checkout" "$layout" "$origin" > "$dest/install-source.tmp.$$"
  mv -f "$dest/install-source.tmp.$$" "$dest/install-source"
  printf 'Recorded install-source: %s (%s).\n' "$checkout" "$layout"
else
  printf 'No install-source written: %s is not in a Git checkout; scheduled refresh stays off.\n' "$src"
fi
if [ "$retire_legacy" = 1 ]; then
  printf 'Installed %s; cron entries unchanged; checking explicit legacy retirement.\n' "$target"
  python3 "$dest/retire-legacy-sweeper.py" --apply
else
  printf 'Installed %s; schedules unchanged. Run with --dry-run first.\n' "$target"
fi
