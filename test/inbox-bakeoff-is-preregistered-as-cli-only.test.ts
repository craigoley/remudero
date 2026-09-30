import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const parity = await import(pathToFileURL(join(root, "scripts", "console-parity-ratchet.mjs")).href) as {
  BASELINE_PATH: string;
  CLI_ONLY: Record<string, string>;
  classifyVerbs: (verbs: readonly string[], routes: readonly { method: string; path: string }[], routeMatch?: Record<string, string>, cliOnly?: Record<string, string>) => { cliOnlyVerbs: string[]; unmapped: string[] };
  ratchetVerdict: (cliOnlyVerbs: readonly string[], baselineVerbs: readonly string[]) => { ok: boolean; added: string[]; removed: string[] };
};

test("inbox-bakeoff is pre-registered as operator-only because it spends to measure", () => {
  const baseline = JSON.parse(readFileSync(join(root, parity.BASELINE_PATH), "utf8")) as { uncoveredVerbs: string[] };
  const classification = parity.classifyVerbs(["inbox-bakeoff"], [], {}, parity.CLI_ONLY);
  assert.deepEqual(classification.cliOnlyVerbs, ["inbox-bakeoff"]);
  assert.deepEqual(classification.unmapped, []);
  assert.match(parity.CLI_ONLY["inbox-bakeoff"] ?? "", /paid local worker spawns/i);
  const verdict = parity.ratchetVerdict(classification.cliOnlyVerbs, baseline.uncoveredVerbs);
  assert.equal(verdict.ok, true);
  assert.deepEqual(verdict.added, []);
});
