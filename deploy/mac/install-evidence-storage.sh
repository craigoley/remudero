#!/bin/bash
# Explicit source installer only. No schedule, configuration activation or workload.
set -euo pipefail
umask 077
source_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)
install_home="$HOME"
if [ "$#" != 0 ]; then
  [ "$#" = 2 ] && [ "$1" = --prefix ] || { printf 'usage: %s [--prefix ACCOUNT_OWNED_DIRECTORY]\n' "$0" >&2; exit 2; }
  install_home="$2"
fi
case "$install_home" in /*) ;; *) printf 'Absolute install prefix required\n' >&2; exit 2 ;; esac
[ -d "$install_home" ] && [ -O "$install_home" ] && [ ! -L "$install_home" ] && [ "$install_home" != / ] || { printf 'Owned physical prefix required\n' >&2; exit 2; }
[ "$(cd "$install_home" && pwd -P)" = "$install_home" ] || { printf 'Physical prefix required\n' >&2; exit 2; }
node_path=$(command -v node) || { printf 'Node is required\n' >&2; exit 2; }
case "$node_path" in /*) ;; *) printf 'Absolute Node executable required\n' >&2; exit 2 ;; esac
node_major=$("$node_path" -p 'process.versions.node.split(".")[0]')
[ "$node_major" -ge 24 ] || { printf 'Node 24 or later required\n' >&2; exit 2; }
version=$("$node_path" --input-type=module -e 'import {readFileSync} from "node:fs"; import {createHash} from "node:crypto"; const h=createHash("sha256");for(const p of process.argv.slice(1))h.update(readFileSync(p));console.log(h.digest("hex"));' "$source_root/scripts/maintain-evidence-storage.mjs" "$source_root/scripts/lib/evidence-storage.mjs" "$source_root/scripts/lib/evidence-fd-snapshot.py" "$source_root/scripts/lib/evidence-fd-exchange.py")
dest="$install_home/.local/share/remudero/evidence-tools/$version"
bin="$install_home/.local/bin"
config="$install_home/.config/remudero"
for path in "$install_home/.local" "$install_home/.local/share" "$install_home/.local/share/remudero" "$install_home/.local/share/remudero/evidence-tools" "$dest" "$bin" "$install_home/.config" "$config"; do
  [ ! -L "$path" ] || { printf 'Refuse linked install path\n' >&2; exit 2; }
done
mkdir -p "$dest/lib" "$bin" "$config"
for script in maintain-evidence-storage.mjs lib/evidence-storage.mjs lib/evidence-fd-snapshot.py lib/evidence-fd-exchange.py; do
  if [ -e "$dest/$script" ] || [ -L "$dest/$script" ]; then
    [ ! -L "$dest/$script" ] && cmp -s "$source_root/scripts/$script" "$dest/$script" || { printf 'Existing version changed; refusing overwrite\n' >&2; exit 2; }
  else
    install -m 0600 "$source_root/scripts/$script" "$dest/$script"
  fi
done
wrapper="$bin/remudero-storage-maintenance.new.$$"
# Quote in the maintained Node runtime rather than relying on Bash substitution.
"$node_path" --input-type=module -e 'import fs from "node:fs"; const q=String.fromCharCode(39), quote=s=>q+s.split(q).join(q+"\\"+q+q)+q; fs.writeFileSync(process.argv[3],"#!/bin/sh\nexec /usr/bin/nice -n 10 "+quote(process.argv[1])+" "+quote(process.argv[2])+" \"$@\"\n",{flag:"wx",mode:0o755});' "$node_path" "$dest/maintain-evidence-storage.mjs" "$wrapper"
chmod 0755 "$wrapper"
/bin/sh -n "$wrapper"
mv "$wrapper" "$bin/remudero-storage-maintenance"
if [ ! -e "$config/evidence-storage.json" ] && [ ! -L "$config/evidence-storage.json" ]; then
  (set -o noclobber; printf '%s\n' '{"schema":"rmd-evidence-storage/v1","enabled":false,"roots":[]}' > "$config/evidence-storage.json")
fi
printf 'Installed %s; policy remains unchanged/default-off; schedules unchanged.\n' "$dest"
