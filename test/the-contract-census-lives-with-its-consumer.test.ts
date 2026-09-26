// W1-T4583: scripts/contract-coverage-ratchet.mjs (W1-T3174) counted /v1 routes an IN-REPO client
// called that openapi/daemon.yaml did not declare. W1-T4563 and W1-T4566 deleted both in-repo
// consoles, leaving it a declared-empty census that still cost a CI step, a gardener probe and a
// gate-posture row. The question now lives on both sides of the boundary: W1-T4579 checks every
// SERVED route against the spec, and CONSOLE-T84 checks the live console's calls against a pin of it.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadGateProbes } from "../src/lib/gate-gardener.js";

const ROOT = join(import.meta.dirname, "..");
const read = (path: string): string => readFileSync(join(ROOT, path), "utf8");

test("W1-T4583: no CI step, gardener probe or gate-posture row runs the retired contract-coverage census", async () => {
  assert.equal(existsSync(join(ROOT, "scripts", "contract-coverage-ratchet.mjs")), false, "the script is gone");
  assert.equal(existsSync(join(ROOT, "scripts", "contract-coverage-baseline.json")), false, "and its baseline");
  assert.doesNotMatch(read(".github/workflows/ci.yml"), /contract-coverage/, "no ci.yml step, outcome or report argument");
  assert.doesNotMatch(read("src/lib/gate-posture.ts"), /contract-coverage-ratchet/, "no gate-posture row");
  const probes = await loadGateProbes(ROOT);
  assert.equal("cc" in probes, false, "the gardener loads no contract-coverage probe");

  // The replacement is live: the producer-side census over the served table.
  assert.ok(existsSync(join(ROOT, "test", "every-served-route-is-in-the-contract.test.ts")), "W1-T4579's census replaces it");
});
