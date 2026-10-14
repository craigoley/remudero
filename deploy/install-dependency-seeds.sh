#!/bin/bash
# Install the account's standalone provisioner; enable only future materializations.
set -euo pipefail
HERE=$(cd "$(dirname "$0")/.." && pwd)
NODE="${RMD_SEED_NODE:-$(command -v node)}"
TOOL="$HOME/.local/share/remudero/dependency-seed-tool"
mkdir -p "$TOOL/scripts" "$TOOL/src/lib" "$HOME/.local/bin"
install -m 0644 "$HERE/src/lib/dependency-seeds.ts" "$TOOL/src/lib/dependency-seeds.ts"
install -m 0755 "$HERE/scripts/dependency-seeds.mjs" "$TOOL/scripts/dependency-seeds.mjs"
install -m 0755 "$HERE/deploy/dependency-seed-guard.sh" "$TOOL/dependency-seed-guard.sh"
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
