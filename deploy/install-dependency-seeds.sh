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
  mkdir -p "$TOOL/scripts" "$TOOL/src/lib"
  install -m 0644 "$HERE/src/lib/dependency-seeds.ts" "$TOOL/src/lib/dependency-seeds.ts"
  install -m 0644 "$HERE/src/lib/clock.ts" "$TOOL/src/lib/clock.ts"
  install -m 0755 "$HERE/scripts/dependency-seeds.mjs" "$TOOL/scripts/dependency-seeds.mjs"
  install -m 0755 "$HERE/deploy/dependency-seed-guard.sh" "$TOOL/dependency-seed-guard.sh"
fi
# A stable wrapper does not depend on the source checkout surviving janitor cleanup.
"$NODE" - "$HOME/.local/bin/remudero-dependencies" "$NODE" "$TOOL/scripts/dependency-seeds.mjs" <<'JS'
const fs = require('node:fs');
const [dest, node, tool] = process.argv.slice(2);
const quote = s => "'" + s.replaceAll("'", "'\\''") + "'";
fs.writeFileSync(dest, '#!/bin/sh\nexec ' + quote(node) + ' ' + quote(tool) + ' "$@"\n', {mode: 0o755});
JS
if [ ! -e "$HOME/.config/remudero/dependency-seeds.json" ]; then
  if [ -n "${RMD_DEPENDENCY_SEED_ROOT:-}" ]; then "$NODE" "$TOOL/scripts/dependency-seeds.mjs" enable --root "$RMD_DEPENDENCY_SEED_ROOT"
  else "$NODE" "$TOOL/scripts/dependency-seeds.mjs" enable; fi
fi
echo "installed account dependency seeds: $HOME/.local/bin/remudero-dependencies"
