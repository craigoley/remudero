#!/bin/bash
# Install the account's standalone provisioner; enable only future materializations.
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
NODE="${RMD_SEED_NODE:-$(command -v node)}"
TOOL_VERSION=$("$NODE" - "$HERE" <<'JS'
const fs=require('node:fs'), crypto=require('node:crypto'), path=require('node:path');
const hash=crypto.createHash('sha256');
for (const file of ['src/lib/dependency-seeds.ts','src/lib/clock.ts','scripts/dependency-seeds.mjs','deploy/dependency-seed-guard.sh']) hash.update(fs.readFileSync(path.join(process.argv[2],file))).update('\0');
console.log(hash.digest('hex'));
JS
)
TOOL="$HOME/.local/share/remudero/dependency-seed-tools/$TOOL_VERSION"
mkdir -p "$HOME/.local/bin"
if [ ! -d "$TOOL" ]; then
  mkdir -p "$(dirname "$TOOL")"
  TOOL_STAGE=$(mktemp -d "$(dirname "$TOOL")/.install-XXXXXXXX")
  trap 'rmdir "$TOOL_STAGE/scripts" "$TOOL_STAGE/src/lib" "$TOOL_STAGE/src" "$TOOL_STAGE" 2>/dev/null || true' EXIT
  mkdir -p "$TOOL_STAGE/scripts" "$TOOL_STAGE/src/lib"
  install -m 0644 "$HERE/src/lib/dependency-seeds.ts" "$TOOL_STAGE/src/lib/dependency-seeds.ts"
  install -m 0644 "$HERE/src/lib/clock.ts" "$TOOL_STAGE/src/lib/clock.ts"
  install -m 0755 "$HERE/scripts/dependency-seeds.mjs" "$TOOL_STAGE/scripts/dependency-seeds.mjs"
  install -m 0755 "$HERE/deploy/dependency-seed-guard.sh" "$TOOL_STAGE/dependency-seed-guard.sh"
  "$NODE" - "$TOOL_STAGE" "$TOOL" <<'JS'
const fs=require('node:fs');
fs.renameSync(process.argv[2],process.argv[3]);
JS
fi
# Refuse interrupted older installs before replacing the working wrapper.
"$NODE" - "$HERE" "$TOOL" <<'JS'
const fs=require('node:fs'),path=require('node:path');
for (const file of ['src/lib/dependency-seeds.ts','src/lib/clock.ts','scripts/dependency-seeds.mjs','deploy/dependency-seed-guard.sh']) {
  const installed=path.join(process.argv[3],file.replace(/^deploy\//,''));
  if (!fs.readFileSync(installed).equals(fs.readFileSync(path.join(process.argv[2],file)))) throw new Error('incomplete dependency tool version: '+installed);
}
JS
# A stable wrapper does not depend on the source checkout surviving janitor cleanup.
"$NODE" - "$HOME/.local/bin/remudero-dependencies" "$NODE" "$TOOL/scripts/dependency-seeds.mjs" <<'JS'
const fs = require('node:fs'), {randomUUID}=require('node:crypto');
const [dest, node, tool] = process.argv.slice(2);
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
const stage=dest+'.'+randomUUID();
fs.writeFileSync(stage, '#!/bin/sh\nexec ' + quote(node) + ' ' + quote(tool) + ' "$@"\n', {mode: 0o755,flag:'wx'});
fs.renameSync(stage,dest);
JS
if [ ! -e "$HOME/.config/remudero/dependency-seeds.json" ]; then
  if [ -n "${RMD_DEPENDENCY_SEED_ROOT:-}" ]; then "$NODE" "$TOOL/scripts/dependency-seeds.mjs" enable --root "$RMD_DEPENDENCY_SEED_ROOT"
  else "$NODE" "$TOOL/scripts/dependency-seeds.mjs" enable; fi
fi
echo "installed account dependency seeds: $HOME/.local/bin/remudero-dependencies"
