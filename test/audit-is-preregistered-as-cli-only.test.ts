/**
 * `audit` must be classified before its COMMANDS entry lands. The console-parity ratchet permits
 * a baseline to sit ahead of the live registry as a reported shrink, so this instrument-only
 * prerequisite keeps the product PR out of Rule 25 entanglement — the same shape
 * test/ledger-compact-is-preregistered-as-cli-only.test.ts established for `ledger-compact`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const mod = (await import(pathToFileURL(join(ROOT, "scripts", "console-parity-ratchet.mjs")).href)) as {
  BASELINE_PATH: string;
  CLI_ONLY: Record<string, string>;
  classifyVerbs: (
    verbs: readonly string[],
    routes: readonly { method: string; path: string }[],
    routeMatch?: Record<string, string>,
    cliOnly?: Record<string, string>,
  ) => { cliOnlyVerbs: string[]; unmapped: string[] };
  ratchetVerdict: (
    cliOnlyVerbs: readonly string[],
    baselineVerbs: readonly string[],
  ) => { ok: boolean; added: string[]; removed: string[] };
};

test("audit is pre-registered as cli-only without requiring its product command", () => {
  const baseline = JSON.parse(readFileSync(join(ROOT, mod.BASELINE_PATH), "utf8")) as {
    uncoveredVerbs: string[];
  };
  const classification = mod.classifyVerbs(["audit"], [], {}, mod.CLI_ONLY);

  assert.deepEqual(classification.cliOnlyVerbs, ["audit"]);
  assert.deepEqual(classification.unmapped, [], "the future command already has a stated CLI-only reason");
  assert.match(mod.CLI_ONLY["audit"] ?? "", /grades a written audit against a checked-in fixture/i);

  const verdict = mod.ratchetVerdict(classification.cliOnlyVerbs, baseline.uncoveredVerbs);
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.added, [], "the future command is already recorded in the ratchet baseline");
});
