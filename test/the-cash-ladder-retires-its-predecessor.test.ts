import assert from "node:assert/strict";
import { test } from "node:test";
import { loadMounts, mountsPath } from "#src/lib/mounts.js";
import {
  OPENWEIGHT_CONTEXT_WINDOWS,
  OPENWEIGHT_PRICES,
  OPENWEIGHT_RESPONSE_FORMATS,
  OPENWEIGHT_TEMPERATURE,
  openWeightDeploymentReady,
  selectOpenWeightModel,
} from "#src/lib/worker-provider.js";
import { repoRoot } from "#test/helpers/repo-root.js";

// W1-T4081: gpt-6-luna has served the cash lane (44 distinct days in the cash ledger, read 2026-11-25),
// so its predecessors gpt-5.6-luna and gpt-5.6-terra leave the cash rows and their four per-deployment tables.
// The Azure deployments the operator may now delete (this task deletes nothing on Azure): gpt-5.6-luna, gpt-5.6-terra.

const RETIRED = ["gpt-5.6-luna", "gpt-5.6-terra"] as const;
const NOW = Date.parse("2026-11-25T00:00:00.000Z");

function cashRows() {
  const cash = loadMounts(mountsPath(repoRoot())).capabilities?.cash;
  assert.ok(cash, "the cash ladder is declared");
  return cash;
}

test("W1-T4081: the cash ladder no longer names its predecessors", () => {
  const cash = cashRows();
  let rows = 0;
  for (const [tier, efforts] of Object.entries(cash)) {
    for (const [effort, candidates] of Object.entries(efforts as Record<string, string[]>)) {
      rows++;
      for (const retired of RETIRED) {
        assert.ok(!candidates.includes(retired), `${tier}.${effort} still names ${retired}`);
      }
      assert.ok(candidates.length >= 2, `${tier}.${effort} keeps two or more candidates, has ${candidates.length}`);
    }
  }
  assert.equal(rows, 9, "all nine cash rows were inspected");
  for (const retired of RETIRED) {
    assert.equal(retired in OPENWEIGHT_PRICES, false, `${retired} price row is gone`);
    assert.equal(retired in OPENWEIGHT_CONTEXT_WINDOWS, false, `${retired} context row is gone`);
    assert.equal(retired in OPENWEIGHT_TEMPERATURE, false, `${retired} temperature row is gone`);
    assert.equal(retired in OPENWEIGHT_RESPONSE_FORMATS, false, `${retired} structured-output row is gone`);
    assert.equal(openWeightDeploymentReady(retired, NOW), false, `${retired} is no longer a ready cash deployment`);
  }
});

test("W1-T4081: the retirement waits for seven days of service", () => {
  // The seven-day ledger precondition is checked by the worker before it edits; what the repository
  // can prove is that its OUTCOME is safe: the successor is fully configured, so removing the
  // predecessors never strips a row of its only usable candidate.
  const ladder = loadMounts(mountsPath(repoRoot())).capabilities;
  assert.ok(ladder);
  assert.equal(openWeightDeploymentReady("gpt-6-luna", NOW), true, "the successor is priced, shaped and sized");
  assert.ok(OPENWEIGHT_PRICES["gpt-6-luna"] && OPENWEIGHT_CONTEXT_WINDOWS["gpt-6-luna"], "price and context rows exist");
  assert.ok("gpt-6-luna" in OPENWEIGHT_TEMPERATURE, "its temperature row exists");
  assert.equal(selectOpenWeightModel(ladder, "opus", "high").model, "gpt-6-luna", "the successor leads the frontier row");
  assert.equal(selectOpenWeightModel(ladder, "opus", "high", undefined, { cashSqueezed: true }).model, "gpt-6-luna");
  assert.equal(selectOpenWeightModel(ladder, "haiku", "low").model, "gpt-oss-120b", "cheap work stays cheap");
  for (const [tier, efforts] of Object.entries(cashRows())) {
    for (const [effort, candidates] of Object.entries(efforts as Record<string, string[]>)) {
      const ready = candidates.filter((c) => openWeightDeploymentReady(c, NOW));
      assert.ok(ready.length >= 2, `${tier}.${effort} keeps two READY candidates, has ${ready.length}`);
    }
  }
});
