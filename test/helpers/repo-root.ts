import assert from "node:assert/strict";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Fixed depth from this helper's real location, independent of the caller and working directory. */
export const REPO_ROOT = join(dirname(realpathSync(fileURLToPath(import.meta.url))), "..", "..");

assert.equal(JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")).name, "remudero",
  `test repo root must contain remudero's package.json: ${REPO_ROOT}`);

export function repoRoot(): string {
  return REPO_ROOT;
}
