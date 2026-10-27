import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempDir } from "#src/lib/tmp.js";
import type { Config } from "#src/lib/config.js";

/**
 * The real merge effectors fence every write on PRESENT, untorn operator-hold evidence (it fails
 * CLOSED on an absent ledger). A test that drives the real `realArmDeps` bodies against a stubbed gh
 * therefore needs a config whose ledger exists and is empty — "no hold recorded" — instead of the
 * host's own config root. `dispose()` removes the temp root.
 */
export function emptyHoldLedger(): { config: () => Config; root: string; dispose: () => void } {
  const root = makeTempDir("empty-hold-ledger");
  mkdirSync(join(root, "state"));
  writeFileSync(join(root, "state", "ledger.ndjson"), "");
  return { config: () => ({ root }) as Config, root, dispose: () => rmSync(root, { recursive: true, force: true }) };
}
