import assert from "node:assert/strict";
import { test } from "node:test";

// @ts-ignore executable module has no declaration file.
import { censusParityViolations } from "#scripts/census-precheck.mjs";

test("W1-T10798: parity precheck names unregistered suites and stale baseline rows before push", () => {
  const baselinePath = "scripts/census-precheck-parity-baseline.json";
  const known = "test/fixture-existing-census.test.ts";
  const added = "test/fixture-new-census.test.ts";
  const gone = "test/fixture-removed-census.test.ts";
  const evaluate = (population: string[], baseline: string[]) => censusParityViolations({
    changed: [baselinePath], population,
    readHead: (path: string) => path === baselinePath ? JSON.stringify({ ciOnly: baseline }) : null,
  }) as string[];

  assert.deepEqual(evaluate([known], [known]), [], "registered CI-only suites pass");
  const unasked = evaluate([known, added], [known]);
  assert.equal(unasked.length, 1);
  assert.ok(unasked[0]!.includes(added));
  assert.match(unasked[0]!, /model it in PRECHECK_PARITY/);
  const stale = evaluate([known], [known, gone]);
  assert.equal(stale.length, 1);
  assert.ok(stale[0]!.includes(gone));
  assert.match(stale[0]!, /delete the row/);
});
